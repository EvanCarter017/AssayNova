"""Fixed-value result, contact and actual one-page PDF/SVG layout checks."""
from __future__ import annotations

import copy
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from PIL import Image
from pypdf import PdfReader
from reportlab.graphics.shapes import Drawing, Group, Image as DrawingImage, Path as VectorPath, Rect, String

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("layout_renderer", ROOT / "conference" / "render_report.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)
master = renderer.master
EXPECTED_STATEMENT = (
    "The peptide purity analysis reported here was conducted using LCMS/MS under standard laboratory conditions. "
    "This analysis is intended for informational purposes only and is specific to the sample(s) provided. "
    "The peptides tested are intended for research use only and are not approved for human or veterinary use, "
    "diagnostic, therapeutic, or clinical applications. Results should be interpreted by qualified professionals "
    "within the scope of the intended research. The accuracy and reliability of the test may be influenced by "
    "sample integrity, handling, and other experimental variables."
)


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

    def contact_nodes(self, drawing, contact=None):
        contact = contact or master.load_contact()
        values = {contact["title"], contact["email"], contact["phone"], *contact["addressLines"]}
        return [node for node in self.strings(drawing) if node.text in values and node.y <= 112]

    def contact_icons(self, drawing):
        return [node for node in drawing.contents if isinstance(node, Group) and node.contents
                and all(isinstance(child, (Rect, VectorPath)) for child in node.contents)
                and node.getBounds()[3] <= 118 and node.getBounds()[2] - node.getBounds()[0] < 10]

    def assert_contact_geometry(self, drawing, contact):
        nodes = self.contact_nodes(drawing, contact)
        right = master.PAGE_W - 36 - 78 - 12
        widest = max(master.pdfmetrics.stringWidth(node.text, node.fontName, node.fontSize) for node in nodes)
        expected_x = right - widest
        self.assertTrue(all(abs(node.x - expected_x) < .000001 for node in nodes))
        self.assertAlmostEqual(max(self.bounds(node)[2] for node in nodes), right)
        self.assertAlmostEqual(master.REPORT_QR_FRAME_BOUNDS[0] - right, 12)
        icons = self.contact_icons(drawing)
        self.assertEqual(len(icons), 2 if contact["phone"] else 1)
        details = [node for node in nodes if node.fontSize == 8.5]
        for icon, line in zip(icons, details):
            x0, y0, x1, y1 = icon.getBounds()
            self.assertAlmostEqual(x0, expected_x - 14)
            self.assertAlmostEqual(x1 - x0, 9)
            self.assertAlmostEqual(y1 - y0, 7.5)
            self.assertAlmostEqual(line.x - x1, 5)
            self.assertAlmostEqual((y0 + y1) / 2, (self.bounds(line)[1] + self.bounds(line)[3]) / 2)
            self.assertGreater(x0 - .375, 204)
            self.assertGreater(y0 - .375, 55.5)
            self.assertLess(x1 + .375, master.REPORT_QR_FRAME_BOUNDS[0])
            self.assertTrue(all(child.strokeColor == master.TEAL and child.strokeWidth == .75 for child in icon.contents))
            self.assertTrue(all(isinstance(child, (Rect, VectorPath)) for child in icon.contents))
        self.assertEqual(sum(isinstance(node, DrawingImage) for node in drawing.contents), 3)
        return nodes

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
        self.assertIn(EXPECTED_STATEMENT, " ".join(contents.split()))
        self.assertNotRegex(contents, r"Sample [12]|Reported summary|Coming soon")
        fonts = [value.get_object() for value in page["/Resources"]["/Font"].values()]
        self.assertTrue(any("/FontFile2" in font.get("/FontDescriptor", {}).get_object() for font in fonts if "/FontDescriptor" in font))
        source = Path(svg).read_text(encoding="utf-8")
        self.assertNotRegex(source, r"<(?:script|text)\b|href=\"https?://")
        document = ET.fromstring(source)
        self.assertEqual((document.attrib["width"], document.attrib["height"]), ("210mm", "297mm"))
        self.assertEqual(len(list(document.iter("{http://www.w3.org/2000/svg}image"))), 3)
        self.assertIn(EXPECTED_STATEMENT, " ".join(" ".join(document.itertext()).split()))

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
            self.assertEqual(next(n.y for n in nodes if n.text == "Chief Chemist"), 64)
            signature = next(n for n in drawing.contents if isinstance(n, DrawingImage) and "signature" in str(n.path))
            self.assertAlmostEqual(signature.y + signature.height, 117)
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
            default = self.assert_contact_geometry(drawing, master.load_contact())
            self.assertEqual([n.text for n in default], ["reports@assaynovalabs.com", "+1-681-334-3721"])
            self.assertAlmostEqual(default[0].x, 346.8183151605562)
            self.assertEqual([n.y for n in default], [96, 84])
            self.assertTrue(all(n.fontSize == 8.5 and n.fontName == "SampleVera" for n in default))
            self.assertNotIn("Contact the laboratory", [n.text for n in self.strings(drawing)])
            # The compact group sits between complete Method text and statement,
            # with balanced white space instead of crowding either block.
            method = [node for node in self.strings(drawing) if node.x == 315 and node.y in (141, 131)]
            statement = [node for node in self.strings(drawing) if node.fontSize == 6.75]
            top_gap = min(self.bounds(node)[1] for node in method) - max(self.bounds(node)[3] for node in default)
            bottom_gap = min(self.bounds(node)[1] for node in default) - max(self.bounds(node)[3] for node in statement)
            self.assertGreater(top_gap, 25)
            self.assertGreater(bottom_gap, 25)
            self.assertLess(abs(top_gap - bottom_gap), 1)
            drawing = self.drawing(dynamic, contact=self.full_contact)
            footer = self.assert_contact_geometry(drawing, self.full_contact)
            self.assertEqual([n.y for n in footer], [112, 100.5, 88.5, 76.5, 64.5])
            self.assert_disjoint(footer)
            for node in footer:
                left, bottom, right, top = self.bounds(node)
                self.assertGreater(bottom, 55.5)
                self.assertLessEqual(right, master.PAGE_W - 36 - 78 - 12)
                self.assertLess(top, 121)
                self.assertGreaterEqual(node.fontSize, 8)
            empty_phone = dict(self.full_contact, title="", phone="", addressLines=["Fixture address line one"])
            drawing = self.drawing(dynamic, contact=empty_phone)
            contact = self.assert_contact_geometry(drawing, empty_phone)
            self.assertEqual([node.text for node in contact], [empty_phone["email"], "Fixture address line one"])
            self.assertEqual([node.y for node in contact], [96, 84])
            expanded = dict(self.full_contact, title="")
            drawing = self.drawing(dynamic, contact=expanded)
            contact = self.assert_contact_geometry(drawing, expanded)
            self.assertEqual([node.y for node in contact], [112, 100, 88, 76])
        path = self.directory / "contact.json"
        with patch.object(master, "CONTACT_FILE", path):
            for email in ("first@example.test", "second@example.test"):
                path.write_text(json.dumps(dict(self.full_contact, email=email)), encoding="utf-8")
                self.assertIn(email, [n.text for n in self.strings(self.drawing(True))])

    def test_contact_retains_the_entire_original_accepted_line_width(self):
        master.register_fonts()
        old_width = master.PAGE_W - 36 - 315
        def longest(prefix, suffix, font, size):
            candidates = [prefix + "W" * count + suffix for count in range(1, 41)]
            return max((value for value in candidates if master.pdfmetrics.stringWidth(value, font, size) <= old_width), key=len)
        title = longest("", "", "SampleVeraBold", 9)
        detail = longest("", "", "SampleVera", 8.5)
        email = longest("", "@example.test", "SampleVera", 8.5)
        config = {"title": title, "email": email, "phone": detail, "addressLines": [detail, detail]}
        self.assertEqual(master.load_contact(config), config)
        self.assertAlmostEqual(master.CONTACT_WIDTH, old_width)
        for dynamic in (False, True):
            drawing = self.drawing(dynamic, contact=config)
            contact = self.assert_contact_geometry(drawing, config)
            self.assertEqual([n.text for n in contact], [title, email, detail, detail, detail])
            self.assertEqual([n.y for n in contact], [112, 100.5, 88.5, 76.5, 64.5])
            self.assert_disjoint(contact)
            for node in contact:
                self.assertLessEqual(self.bounds(node)[2], master.PAGE_W - 36 - 78 - 12)
                self.assertGreater(self.bounds(node)[2], master.PAGE_W - 36 - 78 - 22)
        with self.assertRaises(ValueError):
            master.load_contact(dict(config, title=title + "W"))
        with self.assertRaises(ValueError):
            master.load_contact(dict(config, addressLines=[detail + "W"]))

    def test_exact_statement_uses_four_measured_outlined_lines_below_all_footer_blocks(self):
        self.assertEqual(len(EXPECTED_STATEMENT), 588)
        for dynamic in (False, True):
            drawing = self.drawing(dynamic, contact=self.full_contact)
            paragraph = [node for node in self.strings(drawing) if node.fontSize == 6.75]
            self.assertEqual(len(paragraph), 4)
            self.assertEqual(" ".join(node.text for node in paragraph), EXPECTED_STATEMENT)
            self.assertEqual([round(paragraph[0].y - node.y, 5) for node in paragraph], [0, 8.25, 16.5, 24.75])
            bounds = [self.bounds(node) for node in paragraph]
            self.assertAlmostEqual(min(box[1] for box in bounds), 24)
            self.assertAlmostEqual(max(box[3] for box in bounds), 55.5)
            for node, box in zip(paragraph, bounds):
                self.assertEqual((node.x, node.fontName, node.fillColor), (36, "SampleVera", master.MUTED))
                self.assertLessEqual(box[2], master.PAGE_W - 36)
            footer = [node for node in self.strings(drawing) if node.y <= 118 and node not in paragraph]
            self.assertGreater(min(self.bounds(node)[1] for node in footer), 55.5)
            self.assert_disjoint(paragraph + footer)
            signature = next(node for node in drawing.contents if isinstance(node, DrawingImage) and "signature" in str(node.path))
            asset_name = "dylan-greene-signature.png" if dynamic else "sample-signature.png"
            expected_size = (2164, 727) if dynamic else (2166, 726)
            expected_alpha = (0, 254) if dynamic else (0, 255)
            with Image.open(master.ROOT / "assets" / asset_name) as source:
                self.assertEqual((source.mode, source.size), ("RGBA", expected_size))
                self.assertEqual(source.getextrema()[-1], expected_alpha)
                scale = min(150 / source.width, 44 / source.height)
                self.assertAlmostEqual(signature.width, source.width * scale)
                self.assertAlmostEqual(signature.height, source.height * scale)
            self.assertAlmostEqual(signature.x + signature.width / 2, 120)
            self.assertEqual((signature.y, signature.y + signature.height), (73, 117))
            self.assertGreater(signature.y, 55.5)
            self.assertEqual(next(node.y for node in footer if node.text == "Chief Chemist"), 64)
            # Check real exported SVG path data, not only its accessible wording.
            _, svg = renderer.render(drawing, "AN-TEST-0001", "Statement fixture") if dynamic else master.render(drawing, "AN-TEST-0001")
            expected = Drawing(master.PAGE_W, master.PAGE_H)
            for node in paragraph:
                expected.add(master.outline_text(node))
            outlined = ET.fromstring(master.renderSVG.drawToString(expected))
            actual = ET.fromstring(svg)
            paths = lambda root: Counter(node.attrib["d"] for node in root.iter("{http://www.w3.org/2000/svg}path"))
            self.assertGreater(sum(paths(outlined).values()), 400)
            self.assertFalse(paths(outlined) - paths(actual))

    def test_new_signature_asset_and_actual_svg_embedding_preserve_pixels(self):
        import base64
        from io import BytesIO
        assets = (
            (False, "sample-signature.png", "FCE35C06765CCC174835105CE0D127D6B9B460A0E51CA0D4F12725144B507323"),
            (True, "dylan-greene-signature.png", "A06D10367C433B6EA951F6DBCB1E1AA16A20B0681F5B5D16CC4E8A99FA7A8158"),
        )
        for dynamic, filename, expected_sha in assets:
            signature = master.ROOT / "assets" / filename
            self.assertEqual(hashlib.sha256(signature.read_bytes()).hexdigest().upper(), expected_sha)
            with Image.open(signature) as source:
                expected = source.tobytes()
                expected_size = source.size
            drawing = self.drawing(dynamic)
            _, svg = renderer.render(drawing, "AN-TEST-0001", "Signature fixture") if dynamic else master.render(drawing, "AN-TEST-0001")
            root = ET.fromstring(svg)
            embedded = []
            for node in root.iter("{http://www.w3.org/2000/svg}image"):
                data = node.attrib.get("href", node.attrib.get("{http://www.w3.org/1999/xlink}href"))
                self.assertTrue(data.startswith("data:image/png;base64,"))
                with Image.open(BytesIO(base64.b64decode(data.split(",", 1)[1]))) as image:
                    if image.size == expected_size:
                        embedded.append(image.tobytes())
            self.assertEqual(embedded, [expected])

    def test_lower_analytical_shapes_only_translate_eighteen_points(self):
        # Pinned 713e4f57 drawings first match the original 81871fb9 golden after
        # subtracting 18 pt. Only the six authorized PCR/fentanyl String slots
        # are then excluded; every rule, chart point and other screening remains.
        expected = {(False, 4): (359, "6694AC668D731233BAA073789961134C8EC41050C68B4016ED0E7B6616D615D3"),
                    (True, 1): (104, "7CD236746436DA9FC96E294FD8C37A4F35F401DB950D26BF26308A5515994B55"),
                    (True, 4): (247, "BC52EB879B2C1B695847B2D883AED4929AC7E3F1F8040C9663D1E803CD3C9C7B")}
        def canonical(node, offset):
            props = node.getProperties().copy()
            if isinstance(node, Group):
                props["contents"] = [canonical(child, 0) for child in node.contents]
                transform = list(props["transform"])
                transform[5] -= offset
                props["transform"] = transform
            else:
                for key in ("y", "y1", "y2"):
                    if key in props:
                        props[key] -= offset
                if "points" in props:
                    props["points"] = [value - (offset if index % 2 else 0) for index, value in enumerate(props["points"])]
            def clean(value):
                if isinstance(value, float): return round(value, 6)
                if isinstance(value, dict): return {key: clean(item) for key, item in value.items()}
                if isinstance(value, (list, tuple)): return [clean(item) for item in value]
                if isinstance(value, (str, int, bool)) or value is None: return value
                return str(value)
            return [type(node).__name__, clean(props)]
        for (dynamic, count), fingerprint in expected.items():
            record = copy.deepcopy(self.records["AN-7K9Q-2M4X"])
            record["composition"] = record["composition"][:count]
            record["spectra"] = record["spectra"][:count]
            drawing = self.drawing(dynamic, record, self.full_contact)
            start = next(i for i, node in enumerate(drawing.contents) if isinstance(node, String) and node.text == "HPLC-UV chromatogram")
            end = next(i for i, node in enumerate(drawing.contents) if isinstance(node, String) and node.text == "Method")
            nodes = drawing.contents[start:end]
            changed = [node for node in nodes if isinstance(node, String) and node.x == 315 and node.y in (285, 267, 251, 223, 205, 189)]
            self.assertEqual([(node.text, node.y, node.fontSize) for node in changed], [
                ("Microbial Screening (PCR)", 285, 9), ("No microbial DNA detected", 267, 9),
                ("Fentanyl Screening", 223, 9), ("Not detected", 205, 9)])
            self.assertTrue(all(node.fontName == "SampleVeraBold" for node in changed))
            for node in changed:
                self.assertLessEqual(self.bounds(node)[2], master.PAGE_W - 36)
            filtered = [node for node in nodes if node not in changed]
            content = json.dumps([canonical(node, 18) for node in filtered], sort_keys=True, separators=(",", ":"))
            self.assertEqual((len(filtered), hashlib.sha256(content.encode()).hexdigest().upper()), fingerprint)
            self.assertEqual(drawing.contents[start].y, 498)
            self.assertLess(self.bounds(drawing.contents[start])[3], 508)
            frames = [node for node in nodes if isinstance(node, Rect)]
            hplc = next(node for node in frames if node.width == 265 and node.height == 96)
            self.assertEqual((hplc.x, hplc.y), (36, 386))
            if dynamic and count == 1:
                self.assertTrue(any(node.width == 265 and node.height == 160 and node.y == 158 for node in frames))
            else:
                self.assertEqual(sorted(node.y for node in frames if node.width == 126.5 and node.height == 76), [121, 121, 239, 239])

    def test_screening_presentation_is_status_aware_pure_and_idempotent(self):
        cases = [
            ({"test": "Microbial analysis (PCR)", "result": "Not detected", "details": "Target microbial DNA not detected."}, {"test": "Microbial Screening (PCR)", "result": "No microbial DNA detected", "details": ""}),
            ({"test": "Microbial Screening (PCR)", "result": "Not assessed", "details": "No result supplied"}, {"test": "Microbial Screening (PCR)", "result": "Not assessed", "details": ""}),
            ({"test": "Fentanyl", "result": "Not detected", "details": "Target signal not detected in the screen."}, {"test": "Fentanyl Screening", "result": "Not detected", "details": ""}),
            ({"test": "Fentanyl Screening", "result": "Not assessed", "details": "No result supplied"}, {"test": "Fentanyl Screening", "result": "Not assessed", "details": ""}),
        ]
        for label, canonical in (("Microbial analysis (PCR)", "Microbial Screening (PCR)"), ("Fentanyl", "Fentanyl Screening")):
            for result, details in (("Detected", "Detected target; confirm identity"), ("Pass", "No result supplied"), ("Pending", "Method review is pending"), ("Not detected", "LOD 0.5 ng/mL; method LC-MS"), ("Not detected", "Positive signal requires review"), ("Detected", "Target microbial DNA not detected."), ("No microbial DNA detected", "Target microbial DNA not detected."), ("Not detected", "")):
                raw = {"test": label, "result": result, "details": details}
                expected = dict(raw, test=canonical, result="No microbial DNA detected" if label == "Microbial analysis (PCR)" and result == "Not detected" else result)
                cases.append((raw, expected))
        unknown = {"test": "Other screening", "result": "Not detected", "details": "Target signal not detected in the screen."}
        cases.append((unknown, unknown.copy()))
        for row, expected in cases:
            with self.subTest(row=row):
                before = copy.deepcopy(row)
                presented = master.screening_presentation(row)
                self.assertIsNot(presented, row)
                self.assertEqual(presented, expected)
                self.assertEqual(row, before)
                self.assertEqual(master.screening_presentation(presented), presented)
                drawing = Drawing(master.PAGE_W, master.PAGE_H)
                master.draw_screening_outcome(drawing, row, 315, 285, master.PAGE_W - 36 - 315)
                strings = self.strings(drawing)
                self.assertEqual([node.text for node in strings], [expected["test"], expected["result"]] + ([expected["details"]] if expected["details"] else []))
                self.assertEqual([node.y for node in strings], [285, 267] + ([251] if expected["details"] else []))

    def test_actual_static_screening_exports_use_clear_labels_without_redundant_notes(self):
        from io import BytesIO
        for code in master.STEMS:
            record = self.records[code]
            before = copy.deepcopy(record)
            drawing = self.drawing(False, record)
            pdf, svg = master.render(drawing, code)
            text = PdfReader(BytesIO(pdf)).pages[0].extract_text()
            for expected in ("Microbial Screening (PCR)", "No microbial DNA detected", "Fentanyl Screening"):
                self.assertIn(expected, text)
            for old in ("Microbial analysis (PCR)", "Target microbial DNA not detected.", "Target signal not detected in the screen."):
                self.assertNotIn(old, text)
                self.assertNotIn(old, svg.decode())
            self.assertEqual(record, before)

    def test_invalid_contact_preserves_outputs_for_both_builders(self):
        request = {"lookupCode": "AN-TEST-0001", "seed": "contact-fixture", "product": {"id": "bpc", "name": "BPC-157 10mg", "imagePath": str(self.photo), "components": [{"name": "BPC-157", "nominal": 10, "unit": "mg"}], "unit": "mg"}, "fields": {"client": "Fixture", "received": "2026-11-01", "reported": "2026-11-05"}}
        invalid = [dict(self.full_contact, extra="unexpected"), dict(self.full_contact, title=" "), dict(self.full_contact, title=None),
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
            expected = [amount, "Measured content", "Two determinations of the same sample", "reports@assaynovalabs.com", "+1-681-334-3721", "Chief Chemist"]
            self.assert_actual_exports(ROOT / "dist" / "reports" / (stem + ".pdf"), ROOT / "dist" / "reports" / (stem + ".svg"), expected)
            pdf, svg = master.build(code, self.directory / stem)
            self.assert_actual_exports(pdf, svg, expected)
            self.assertEqual(pdf.read_bytes(), (ROOT / "dist" / "reports" / (stem + ".pdf")).read_bytes())
            self.assertEqual(svg.read_text(encoding="utf-8"), (ROOT / "dist" / "reports" / (stem + ".svg")).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
