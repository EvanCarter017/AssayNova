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
from reportlab.graphics.shapes import Group, Image as DrawingImage, String

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
                self.assertEqual(tuple(round(v, 6) for v in group.getBounds()), (229, 37, 289, 97))
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
                strings = [node for node in drawing.contents if isinstance(node, String)]
                caption = next(node for node in strings if node.text == "Scan report")
                self.assertEqual((caption.x, caption.y, caption.fontSize), (259, 27.5, 8))
                signature = next(node for node in drawing.contents if isinstance(node, DrawingImage) and "signature" in str(node.path))
                self.assertAlmostEqual(signature.y + signature.height, 97)
                self.assertLess(signature.x + signature.width, 229)
                contact = [node for node in strings if node.x == 315 and node.y <= 92]
                self.assertEqual([node.y for node in contact], [92, 80.5, 68.5, 56.5, 44.5])
                self.assertEqual(sum(isinstance(node, DrawingImage) for node in drawing.contents), 3)
                groups.append(tuple((node.x, node.y, node.width, node.height) for node in group.contents))
        self.assertEqual(groups[0], groups[1])
        self.assertNotEqual(groups[0], groups[2])

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
                for value in (code, "99.32%", "80.91", "Scan report", "Chief Chemist", "Fixture address line two"):
                    self.assertIn(value, text)
                annotations = [annotation.get_object() for annotation in page["/Annots"]]
                self.assertEqual(len(annotations), 1)
                self.assertEqual(annotations[0]["/A"]["/URI"], master.report_pdf_url(code))
                self.assertEqual(list(annotations[0]["/Rect"]), [229, 37, 289, 97])
                document = ET.fromstring(svg)
                self.assertEqual(len(list(document.iter("{http://www.w3.org/2000/svg}image"))), 3)
                self.assertIn(master.report_pdf_url(code), " ".join(document.itertext()))
                self.assertNotRegex(svg.decode(), r"<(?:script|text)\b|href=\"https?://")

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
