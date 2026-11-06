"""Fixed-value result, contact and actual one-page PDF/SVG layout checks."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from PIL import Image
from pypdf import PdfReader
from reportlab.graphics.shapes import Image as DrawingImage, String

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("layout_renderer", ROOT / "conference" / "render_report.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
master = renderer.master


class ReportLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records = master.load_records()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.photo = self.directory / "photo.png"
        Image.new("RGB", (32, 48), (34, 105, 186)).save(self.photo)
        self.full_contact = {"title": "Contact the laboratory", "email": "layout@example.test",
                             "phone": "+1 202 555 0100", "addressLines": ["Fixture address line one", "Fixture address line two"]}

    def tearDown(self):
        self.temp.cleanup()

    def drawing(self, dynamic, record=None, contact=None):
        record = record or self.records["AN-7K9Q-2M4X"]
        with Image.open(self.photo) as photo:
            return (renderer.make_drawing if dynamic else master.make_drawing)(
                "AN-TEST-0001", record, photo.copy(), contact_config=contact)

    def strings(self, drawing):
        return [node for node in drawing.contents if isinstance(node, String)]

    def bounds(self, node):
        width = master.pdfmetrics.stringWidth(node.text, node.fontName, node.fontSize)
        ascent, descent = master.pdfmetrics.getAscentDescent(node.fontName, node.fontSize)
        left = node.x - (width if node.textAnchor == "end" else width / 2 if node.textAnchor == "middle" else 0)
        return left, node.y + descent, left + width, node.y + ascent

    def assert_disjoint(self, nodes):
        for index, node in enumerate(nodes):
            a = self.bounds(node)
            for other in nodes[:index]:
                b = self.bounds(other)
                self.assertFalse(min(a[2], b[2]) - max(a[0], b[0]) > .1 and min(a[3], b[3]) - max(a[1], b[1]) > .1,
                                 f"Overlapping text: {node.text!r}, {other.text!r}")

    def assert_actual_exports(self, pdf, svg, expected):
        reader = PdfReader(pdf)
        self.assertEqual(len(reader.pages), 1)
        page = reader.pages[0]
        self.assertAlmostEqual(float(page.mediabox.width), master.PAGE_W, places=3)
        self.assertAlmostEqual(float(page.mediabox.height), master.PAGE_H, places=3)
        contents = page.extract_text()
        for value in expected:
            self.assertIn(value, contents)
        self.assertNotRegex(contents, r"Sample [12]|Reported summary|Coming soon")
        fonts = [value.get_object() for value in page["/Resources"]["/Font"].values()]
        self.assertTrue(any("/FontFile2" in font.get("/FontDescriptor", {}).get_object() for font in fonts if "/FontDescriptor" in font))
        source = Path(svg).read_text(encoding="utf-8")
        self.assertNotRegex(source, r"<(?:script|text)\b|href=\"https?://")
        document = ET.fromstring(source)
        self.assertEqual((document.attrib["width"], document.attrib["height"]), ("210mm", "297mm"))
        self.assertEqual(len(list(document.iter("{http://www.w3.org/2000/svg}image"))), 3)

    def test_decimal_totals_use_reported_means_and_preserve_source(self):
        for code, expected in (("AN-7K9Q-2M4X", "80.91"), ("AN-8P6R-3N5Y", "78.35")):
            record = self.records[code]
            before = copy.deepcopy(record)
            self.assertEqual(master.reported_content(record), (expected, "mg"))
            self.assertEqual(record, before)
        record = {"composition": [{"summary": "0.10"}, {"summary": "0.20"}, {"summary": "1.005"}]}
        self.assertEqual(master.reported_content(record), ("1.31", "mg"))
        for unit, value in (("mg", "10.25"), ("IU", "5000.25"), ("ml", "3.15")):
            record = {"product": "Nominal 999999", "purity": ["99.00"] * 3, "contentUnit": unit,
                      "composition": [{"summary": value, "unit": unit}]}
            self.assertEqual(master.reported_content(record), (value, unit))

    def test_invalid_numbers_and_units_reject_and_mixed_has_no_aggregate(self):
        for value in ("NaN", "Infinity", "-1", "not numeric", True, None, float("nan")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                master.reported_content({"composition": [{"summary": value}]})
        for record in ({"contentUnit": "g", "composition": [{"summary": "1.00"}]},
                       {"contentUnit": "mg", "composition": [{"summary": "1.00", "unit": "IU"}]},
                       {"contentUnit": "mixed", "composition": [{"summary": "1.00"}]},
                       {"contentUnit": "mixed", "composition": [{"summary": "1.00", "unit": "mg"}]}):
            with self.assertRaises(ValueError):
                master.reported_content(record)
        record = copy.deepcopy(self.records["AN-7K9Q-2M4X"])
        record["contentUnit"] = "mixed"
        for row, unit in zip(record["composition"], ("mg", "IU", "ml", "mg")):
            row["unit"] = unit
        self.assertEqual(master.reported_content(record), (None, "mixed"))
        drawing = self.drawing(True, record)
        values = [node.text for node in self.strings(drawing)]
        self.assertIn("See table", values)
        self.assertIn("Per-analyte results", values)
        self.assertNotIn("80.91", values)
        for label in ("GHK-Cu (mg)", "KPV (IU)", "BPC-157 (ml)"):
            self.assertIn(label, values)

    def test_both_drawers_share_main_results_and_leave_signature_and_figures(self):
        for dynamic in (False, True):
            drawing = self.drawing(dynamic)
            nodes = self.strings(drawing)
            values = [node.text for node in nodes]
            for expected in ("80.91", "99.32%", "(mg/vial)", "Replicate 1: 99.31% / Replicate 2: 99.33%", "Two determinations of the same sample", "Replicate 1", "Replicate 2", "Mean", "Chief Chemist"):
                self.assertIn(expected, values)
            self.assertEqual([(n.text, n.fontSize) for n in nodes if n.fontSize == 17], [("99.32%", 17), ("80.91", 17)])
            self.assertEqual(next(n.y for n in nodes if n.text == "Chief Chemist"), 42)
            signature = next(n for n in drawing.contents if isinstance(n, DrawingImage) and "signature" in str(n.path))
            self.assertAlmostEqual(signature.y + signature.height, 97)
            self.assertEqual(sum(isinstance(n, DrawingImage) for n in drawing.contents), 3)
            self.assertIn("HPLC-UV chromatogram", values)
            self.assertTrue(any(value.startswith("Mass ") for value in values))
            self.assert_disjoint([n for n in nodes if n.x >= 208 and n.y >= 508])
            self.assertTrue(all(n.fontSize >= 8 for n in nodes if n.y >= 508))
            for row in self.records["AN-7K9Q-2M4X"]["composition"]:
                for key in ("sample1", "sample2", "summary"):
                    self.assertIn(row[key], values)

    def test_contact_empty_fields_omitted_full_block_fits_and_configuration_is_fresh(self):
        for dynamic in (False, True):
            drawing = self.drawing(dynamic)
            default = [n for n in self.strings(drawing) if n.x == 315 and n.y <= 92]
            self.assertEqual([n.text for n in default], ["Contact the laboratory", "reports@assaynova.com"])
            drawing = self.drawing(dynamic, contact=self.full_contact)
            footer = [n for n in self.strings(drawing) if n.x == 315 and n.y <= 141]
            self.assertEqual([n.y for n in footer[-5:]], [92, 80.5, 68.5, 56.5, 44.5])
            self.assert_disjoint(footer)
            for node in footer:
                left, bottom, right, top = self.bounds(node)
                self.assertGreaterEqual(left, 315)
                self.assertGreaterEqual(bottom, 42)
                self.assertLessEqual(right, master.PAGE_W - master.MARGIN)
                self.assertLess(top, 159)
                self.assertGreaterEqual(node.fontSize, 8)
        path = self.directory / "contact.json"
        with patch.object(master, "CONTACT_FILE", path):
            for email in ("first@example.test", "second@example.test"):
                path.write_text(json.dumps(dict(self.full_contact, email=email)), encoding="utf-8")
                self.assertIn(email, [n.text for n in self.strings(self.drawing(True))])

    def test_invalid_contact_preserves_outputs_for_both_builders(self):
        request = {"lookupCode": "AN-TEST-0001", "seed": "contact-fixture", "product": {"id": "bpc", "name": "BPC-157 10mg", "imagePath": str(self.photo), "components": [{"name": "BPC-157", "nominal": 10, "unit": "mg"}], "unit": "mg"}, "fields": {"client": "Fixture", "received": "2026-11-01", "reported": "2026-11-05"}}
        invalid = [dict(self.full_contact, extra="unexpected"), dict(self.full_contact, title=""),
                   dict(self.full_contact, email="invalid email"), dict(self.full_contact, phone="bad\nline"),
                   dict(self.full_contact, addressLines=["a", "b", "c"]),
                   dict(self.full_contact, addressLines=["W" * 90]), dict(self.full_contact, title="Laborato\u00e9rio")]
        for dynamic in (False, True):
            output = self.directory / str(dynamic)
            output.mkdir()
            sentinel = output / ("report.pdf" if dynamic else "sample-a.pdf")
            sentinel.write_bytes(b"existing report")
            for config in invalid:
                with self.assertRaises(ValueError):
                    if dynamic:
                        renderer.build(request, output, contact_config=config)
                    else:
                        master.build("AN-7K9Q-2M4X", output, contact_config=config)
                self.assertEqual(sentinel.read_bytes(), b"existing report")
                self.assertEqual(list(output.iterdir()), [sentinel])

    def test_long_product_client_one_to_four_components_bounds_and_actual_exports(self):
        for count in range(1, 5):
            record = copy.deepcopy(self.records["AN-7K9Q-2M4X"])
            record["product"] = "BPC-157 10mg + GHK-Cu 50mg + TB-500 10mg + KPV 10mg"
            record["client"] = "Northern Analytical Research Laboratory"
            record["composition"] = record["composition"][:count]
            record["spectra"] = record["spectra"][:count]
            record["composition"][0]["analyte"] = "Long measured analyte label for A"
            before = copy.deepcopy(record)
            drawing = self.drawing(True, record, self.full_contact)
            self.assertEqual(record, before)
            nodes = self.strings(drawing)
            self.assert_disjoint([n for n in nodes if n.y >= 508])
            for node in (n for n in nodes if n.y >= 508):
                self.assertGreaterEqual(self.bounds(node)[1], 508)
                self.assertGreaterEqual(node.fontSize, 8)
            pdf, svg = renderer.render(drawing, "AN-TEST-0001", record["label"])
            pdf_path, svg_path = self.directory / f"long-{count}.pdf", self.directory / f"long-{count}.svg"
            pdf_path.write_bytes(pdf)
            svg_path.write_bytes(svg)
            self.assert_actual_exports(pdf_path, svg_path, ["Mean", "Replicate 1", "Fixture address line two", "Chief Chemist"])

    def test_actual_static_mother_assets_and_cli_equivalent_exports(self):
        for code, stem, amount in (("AN-7K9Q-2M4X", "sample-a", "80.91"), ("AN-8P6R-3N5Y", "sample-c", "78.35")):
            expected = [amount, "Measured content", "Two determinations of the same sample", "Contact the laboratory", "reports@assaynova.com", "Chief Chemist"]
            self.assert_actual_exports(ROOT / "dist" / "reports" / (stem + ".pdf"), ROOT / "dist" / "reports" / (stem + ".svg"), expected)
            pdf, svg = master.build(code, self.directory / stem)
            self.assert_actual_exports(pdf, svg, expected)
            self.assertEqual(pdf.read_bytes(), (ROOT / "dist" / "reports" / (stem + ".pdf")).read_bytes())
            self.assertEqual(svg.read_text(encoding="utf-8"), (ROOT / "dist" / "reports" / (stem + ".svg")).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
