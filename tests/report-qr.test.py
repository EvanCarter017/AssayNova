"""Footer QR geometry, canonical identity and real PDF/SVG export checks."""
from __future__ import annotations

import copy
from io import BytesIO
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from PIL import Image
from pypdf import PdfReader
from reportlab.graphics.shapes import Drawing, Group, Image as DrawingImage, Line, Path as VectorPath, Rect, String

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("qr_renderer", ROOT / "conference" / "render_report.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
master = renderer.master


class ReportQRTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.photo = self.directory / "photo.png"
        Image.new("RGB", (32, 48), (34, 105, 186)).save(self.photo)
        self.records = master.load_records()
        self.contact = {"title": "Contact the laboratory", "email": "layout@example.test", "phone": "+1 202 555 0100", "addressLines": ["Fixture address line one", "Fixture address line two"]}

    def tearDown(self):
        self.temp.cleanup()

    def drawing(self, code, dynamic):
        record = copy.deepcopy(self.records["AN-7K9Q-2M4X"])
        before = copy.deepcopy(record)
        with Image.open(self.photo) as photo:
            drawing = (renderer.make_drawing if dynamic else master.make_drawing)(code, record, photo.copy(), self.contact)
        self.assertEqual(record, before)
        return drawing

    def text_bounds(self, node):
        width = master.pdfmetrics.stringWidth(node.text, node.fontName, node.fontSize)
        ascent, descent = master.pdfmetrics.getAscentDescent(node.fontName, node.fontSize)
        left = node.x - (width / 2 if node.textAnchor == "middle" else 0)
        return left, node.y + descent, left + width, node.y + ascent

    def assert_outside(self, a, b):
        self.assertFalse(min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1]), (a, b))

    def test_strict_canonical_urls_ignore_product_and_operator_origins(self):
        for code in ("AN-7K9Q-2M4X", "AN-8P6R-3N5Y", "AN-TEST-0001", "AN-TEST-0002"):
            self.assertEqual(master.report_pdf_url(code), "https://assaynovalabs.com/coa/" + code + "/report.pdf")
        for code in (None, 1, "an-test-0001", " AN-TEST-0001", "AN-TEST-0001\n", "AN-TEST-0001/report.pdf", "AN-TEST-00/1", "../private", "AN-TEST-0001?host=evil.invalid"):
            with self.subTest(code=code), self.assertRaises(ValueError):
                master.report_pdf_url(code)

    def test_expanded_vectors_quiet_zone_and_footer_clearances(self):
        groups = []
        for code in ("AN-TEST-0001", "AN-TEST-0002"):
            for dynamic in (False, True):
                drawing = self.drawing(code, dynamic)
                vectors = [node for node in drawing.contents if isinstance(node, Group) and len(node.contents) > 100]
                self.assertEqual(len(vectors), 1)
                group = vectors[0]
                left, bottom, right, top = group.getBounds()
                self.assertAlmostEqual(left, master.PAGE_W - 105)
                self.assertAlmostEqual(right, master.PAGE_W - 45)
                self.assertEqual((bottom, top, right - left), (76, 136, 60))
                quiet_box = (left, bottom, right, top)
                self.assertGreater(len(group.contents), 100)
                self.assertTrue(all(not isinstance(node, DrawingImage) for node in group.contents))
                widget = master.QrCodeWidget(master.report_pdf_url(code), barLevel="M", barBorder=4)
                expected = widget.draw()
                self.assertEqual(widget.barBorder, 4)
                self.assertEqual(widget.barLevel, "M")
                self.assertEqual([(node.x, node.y, node.width, node.height) for node in group.contents], [(node.x, node.y, node.width, node.height) for node in expected.contents])
                module = widget.barWidth / (widget.qr.getModuleCount() + 8)
                dark = group.contents[1:]
                self.assertGreaterEqual(min(node.x for node in dark), 4 * module - .001)
                self.assertLessEqual(max(node.x + node.width for node in dark), widget.barWidth - 4 * module + .001)
                self.assertGreaterEqual(min(node.y for node in dark), 4 * module - .001)
                self.assertLessEqual(max(node.y + node.height for node in dark), widget.barHeight - 4 * module + .001)
                strings = [node for node in drawing.contents if isinstance(node, String)]
                frame = next(node for node in drawing.contents if isinstance(node, Rect) and node.width == 78 and node.height == 78)
                self.assertAlmostEqual(master.PAGE_W - (frame.x + frame.width), 36)
                self.assertEqual((frame.y, frame.y + frame.height), (67, 145))
                self.assertEqual((left - frame.x, bottom - frame.y), (9, 9))
                self.assertEqual(frame.fillColor, master.WHITE)
                bands = [node for node in drawing.contents if isinstance(node, Rect) and node.width == 70 and node.height == 7]
                self.assertEqual(sorted(node.y for node in bands), [67, 138])
                for band in bands:
                    self.assertEqual(band.fillColor, master.NAVY)
                    self.assertEqual(band.strokeColor, None)
                    self.assertAlmostEqual(band.x, frame.x + 4)
                    self.assert_outside(band.getBounds(), quiet_box)
                brackets = [node for node in drawing.contents if isinstance(node, Line) and node.y1 <= 145 and node.x1 >= frame.x]
                self.assertEqual(len(brackets), 8)
                for bracket in brackets:
                    self.assertEqual(abs(bracket.x2 - bracket.x1) + abs(bracket.y2 - bracket.y1), 8)
                    self.assertEqual((bracket.strokeWidth, bracket.strokeColor), (1, master.NAVY))
                    bx0, by0, bx1, by1 = bracket.getBounds()
                    inclusive = (bx0 - .5, by0 - .5, bx1 + .5, by1 + .5)
                    self.assertGreaterEqual(inclusive[1], 66.5)
                    self.assertLess(inclusive[3], 146)
                    self.assertGreaterEqual(inclusive[0], frame.x - .5)
                    self.assertLessEqual(inclusive[2], master.PAGE_W - 35.5)
                    self.assert_outside(inclusive, quiet_box)
                for value, band_y in (("Scan report", 138), ("ASSAYNOVA", 67)):
                    label = next(node for node in strings if node.text == value)
                    band = next(node for node in bands if node.y == band_y)
                    self.assertEqual((label.fontSize, label.fontName, label.fillColor), (6, "SampleVeraBold", master.WHITE))
                    self.assertAlmostEqual(label.x, frame.x + 39)
                    lx0, ly0, lx1, ly1 = self.text_bounds(label)
                    self.assertGreaterEqual(lx0, band.x + 2)
                    self.assertLessEqual(lx1, band.x + band.width - 2)
                    self.assertGreaterEqual(ly0, band.y)
                    self.assertLessEqual(ly1, band.y + band.height)
                    self.assert_outside((lx0, ly0, lx1, ly1), quiet_box)
                signature = next(node for node in drawing.contents if isinstance(node, DrawingImage) and "signature" in str(node.path))
                self.assertAlmostEqual(signature.y + signature.height, 117)
                self.assertLessEqual(signature.x + signature.width, 204)
                values = {self.contact["title"], self.contact["email"], self.contact["phone"], *self.contact["addressLines"]}
                contact = [node for node in strings if node.text in values and node.y <= 112]
                self.assertEqual([node.y for node in contact], [112, 100.5, 88.5, 76.5, 64.5])
                self.assertEqual([node.fontSize for node in contact], [9, 8.5, 8.5, 8.5, 8.5])
                self.assertEqual(contact[0].fontName, "SampleVeraBold")
                self.assertTrue(all(node.fontName == "SampleVera" for node in contact[1:]))
                self.assertTrue(all(node.x == contact[0].x for node in contact))
                self.assertAlmostEqual(frame.x - max(self.text_bounds(node)[2] for node in contact), 12)
                icons = [node for node in drawing.contents if isinstance(node, Group) and node.contents
                         and all(isinstance(child, (Rect, VectorPath)) for child in node.contents)
                         and node.getBounds()[3] <= 118 and node.getBounds()[2] - node.getBounds()[0] < 10]
                self.assertEqual(len(icons), 2)
                for icon, line in zip(icons, contact[1:3]):
                    ix0, iy0, ix1, iy1 = icon.getBounds()
                    self.assertAlmostEqual(ix0, line.x - 14)
                    self.assertAlmostEqual(line.x - ix1, 5)
                    self.assertGreater(ix0 - .375, 204)
                    self.assert_outside((ix0 - .375, iy0 - .375, ix1 + .375, iy1 + .375), quiet_box)
                for node in contact:
                    self.assertLessEqual(self.text_bounds(node)[2], frame.x - 12)
                    self.assert_outside(self.text_bounds(node), signature.getBounds())
                body = [node for node in strings if node.x >= 315 and node.y >= 121 and node.fontSize >= 8]
                self.assertTrue(body)
                for node in body:
                    self.assert_outside(self.text_bounds(node), (frame.x - .5, 66.5, frame.x + 78.5, 145.5))
                method = [node for node in body if node.x == 315 and node.y in (141, 131)]
                self.assertEqual(" ".join(node.text for node in method), self.records["AN-7K9Q-2M4X"]["method"])
                for node in method:
                    self.assertLessEqual(self.text_bounds(node)[2], frame.x - 15)
                self.assertEqual(sum(isinstance(node, DrawingImage) for node in drawing.contents), 3)
                groups.append(tuple((node.x, node.y, node.width, node.height) for node in group.contents))
        self.assertEqual(groups[0], groups[1])
        self.assertNotEqual(groups[0], groups[2])

    def test_six_point_label_exception_does_not_relax_body_guard(self):
        master.register_fonts()
        with self.assertRaises(ValueError):
            master.text(Drawing(master.PAGE_W, master.PAGE_H), "Body", 36, 100, 6)
        with self.assertRaises(ValueError):
            master.qr_band_label(Drawing(master.PAGE_W, master.PAGE_H), "Other label", (480, 24, 70, 7))

    def test_actual_exports_have_exact_click_target_and_self_contained_vector_qr(self):
        for dynamic in (False, True):
            for code in ("AN-TEST-0001", "AN-TEST-0002"):
                drawing = self.drawing(code, dynamic)
                pdf, svg = renderer.render(drawing, code, "QR fixture") if dynamic else master.render(drawing, code)
                page = PdfReader(BytesIO(pdf)).pages[0]
                self.assertEqual(len(PdfReader(BytesIO(pdf)).pages), 1)
                self.assertAlmostEqual(float(page.mediabox.width), master.PAGE_W, places=3)
                self.assertAlmostEqual(float(page.mediabox.height), master.PAGE_H, places=3)
                text = page.extract_text()
                for value in (code, "99.32%", "80.91", "Scan report", "ASSAYNOVA", "Chief Chemist", "Fixture address line two"):
                    self.assertIn(value, text)
                annotations = [annotation.get_object() for annotation in page["/Annots"]]
                self.assertEqual(len(annotations), 1)
                self.assertEqual(annotations[0]["/A"]["/URI"], master.report_pdf_url(code))
                actual_rect = [float(value) for value in annotations[0]["/Rect"]]
                for actual, expected in zip(actual_rect, [master.PAGE_W - 105, 76, master.PAGE_W - 45, 136]):
                    self.assertAlmostEqual(actual, expected, places=3)
                document = ET.fromstring(svg)
                self.assertEqual(len(list(document.iter("{http://www.w3.org/2000/svg}image"))), 3)
                self.assertIn(master.report_pdf_url(code), " ".join(document.itertext()))
                self.assertNotRegex(svg.decode(), r"<(?:script|text)\b|href=\"https?://")
                # Each band label becomes its own vector outline group.
                svg_shapes = master.svg_drawing(drawing)
                for label in ("Scan report", "ASSAYNOVA"):
                    index = next(i for i, node in enumerate(drawing.contents) if isinstance(node, String) and node.text == label)
                    outlined = svg_shapes.contents[index]
                    self.assertIsInstance(outlined, Group)
                    self.assertEqual(len(outlined.contents), len(label))
                    self.assertTrue(all(not isinstance(node, DrawingImage) for node in outlined.contents))

    def test_invalid_identity_fails_before_existing_outputs_change(self):
        output = self.directory / "invalid"
        output.mkdir()
        sentinel = output / "report.pdf"
        sentinel.write_bytes(b"existing PDF")
        request = {"lookupCode": "AN-TEST-0001/other", "seed": "fixture", "product": {"id": "bpc", "name": "BPC-157 10mg", "imagePath": str(self.photo), "unit": "mg", "components": [{"name": "BPC-157", "nominal": 10, "unit": "mg"}]}, "fields": {}}
        with self.assertRaises(ValueError):
            renderer.build(request, output)
        self.assertEqual(sentinel.read_bytes(), b"existing PDF")
        self.assertEqual(list(output.iterdir()), [sentinel])
        with self.assertRaises(ValueError):
            self.drawing("AN-TEST-0001\n", True)


if __name__ == "__main__":
    unittest.main()
