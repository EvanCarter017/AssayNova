"""Deterministic math, chemistry, layout and actual PDF/SVG export checks.

Run with bundled Python: python -B tests/conference-renderer.test.py
No network or server is used. Product-photo fixtures are created in a temp folder.
"""
from __future__ import annotations

import copy
from decimal import Decimal
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from PIL import Image
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("conference_renderer", ROOT / "conference" / "render_report.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class ReportRendererTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.photo = self.root / "selected.png"
        Image.new("RGB", (32, 48), (34, 105, 186)).save(self.photo)
        self.request = {"lookupCode": "AN-TEST-0001", "seed": "persistent-seed-1", "product": {"id": "bpc", "name": "BPC-157 10mg", "imagePath": str(self.photo), "components": [{"name": "BPC-157", "nominal": 10, "unit": "mg"}], "unit": "mg"}, "fields": {"client": "Research Client", "lot": "LOT-123", "received": "2026-11-01", "reported": "2026-11-05"}}

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, request=None):
        return renderer.make_bundle(renderer.validate_request(request or self.request))

    def test_reproducible_seed_and_distinct_run_product_profiles(self):
        first = self.bundle()
        self.assertEqual(first, self.bundle())
        changed = copy.deepcopy(self.request)
        changed["seed"] = "persistent-seed-2"
        second = self.bundle(changed)
        self.assertNotEqual(first["record"]["chromatogram"], second["record"]["chromatogram"])
        self.assertNotEqual(first["record"]["spectra"], second["record"]["spectra"])
        changed["product"]["components"][0]["name"] = "Semaglutide"
        changed["product"]["name"] = "Semaglutide 10mg"
        changed["product"]["id"] = "sema"
        other = self.bundle(changed)
        self.assertNotEqual(first["record"]["retentionTime"], other["record"]["retentionTime"])
        self.assertNotEqual(first["record"]["spectra"][0]["neutralMass"], other["record"]["spectra"][0]["neutralMass"])

    def test_replicates_areas_derived_peak_responses_and_manual_purity(self):
        self.request["fields"].update(purity1="99.05", purity2=99.95)
        record = self.bundle()["record"]
        self.assertEqual(record["purity"], ["99.05", "99.95", "99.50"])
        for row in record["composition"]:
            self.assertEqual(row["summary"], renderer.mean(row["sample1"], row["sample2"]))
        self.assertAlmostEqual(sum(p["area"] for p in record["chromatogram"]), 100, places=5)
        self.assertAlmostEqual(sum(p["area"] for p in record["chromatogram"] if p["kind"] == "target"), float(record["purity"][2]), places=5)
        heights = [p["area"] / (p["width"] * (1 + p["tail"])) for p in record["chromatogram"]]
        for peak, height in zip(record["chromatogram"], heights):
            self.assertAlmostEqual(peak["response"], height / max(heights) * 100, places=5)
        # Numerically integrate the exact analytic signal underlying the vector trace.
        areas = []
        for peak in record["chromatogram"]:
            step = .001
            integrated = sum(peak["response"] * renderer.math.exp(-.5 * ((i * step - peak["time"]) / (peak["width"] * (peak["tail"] if i * step > peak["time"] else 1)))**2) * step for i in range(15001))
            areas.append(integrated)
        for peak, area in zip(record["chromatogram"], areas):
            self.assertAlmostEqual(area / sum(areas) * 100, peak["area"], places=4)

    def test_generated_replicates_share_baseline_across_many_seeds(self):
        summaries = set()
        for index in range(256):
            request = copy.deepcopy(self.request)
            request["seed"] = f"replicate-variation-{index}"
            values = self.bundle(request)["record"]["purity"]
            first, second, summary = map(Decimal, values)
            self.assertTrue(Decimal("99.05") <= first <= Decimal("99.95"))
            self.assertTrue(Decimal("99.05") <= second <= Decimal("99.95"))
            self.assertLessEqual(abs(first - second), Decimal("0.08"))
            self.assertEqual(values[2], renderer.mean(first, second))
            summaries.add(summary)
        self.assertGreater(len(summaries), 50, "Shared replicate baseline must still vary between runs")
        self.request["fields"].update(purity1="99.41", purity2="99.43")
        self.assertEqual(self.bundle()["record"]["purity"], ["99.41", "99.43", "99.42"])
        self.request["fields"].update(purity1="99.05", purity2="99.95")
        self.assertEqual(self.bundle()["record"]["purity"], ["99.05", "99.95", "99.50"])
        self.request["fields"] = dict(self.request["fields"], purity1="99.05")
        del self.request["fields"]["purity2"]
        values = self.bundle()["record"]["purity"]
        self.assertEqual(values[0], "99.05")
        self.assertLessEqual(abs(Decimal(values[1]) - Decimal("99.05")), Decimal("0.04"))

    def test_colliding_retention_regression_is_bounded_and_axis_safe(self):
        request = copy.deepcopy(self.request)
        request["seed"] = "0"
        request["product"].update(id="test", name="Custom blend", components=[{"name": name, "nominal": 10, "unit": "mg"} for name in ("Component 44", "Component 138", "Component 225")])
        # Run the exact previously oscillating request in a bounded child, so a
        # future regression fails this test instead of hanging the entire suite.
        script = "import json,runpy,sys; r=runpy.run_path(sys.argv[1]); print(json.dumps(r['make_bundle'](r['validate_request'](json.load(sys.stdin)))))"
        child = subprocess.run([sys.executable, "-B", "-c", script, str(ROOT / "conference" / "render_report.py")], input=json.dumps(request), text=True, capture_output=True, timeout=2, check=True)
        bundle = json.loads(child.stdout)
        self.assertEqual(bundle, self.bundle(request))
        peaks = bundle["record"]["chromatogram"]
        for index, peak in enumerate(peaks):
            self.assertTrue(0 < peak["time"] < 15)
            for other in peaks[:index]:
                gap = Decimal(".38") if peak["kind"] == other["kind"] == "target" else Decimal(".25")
                self.assertGreaterEqual(abs(Decimal(str(peak["time"])) - Decimal(str(other["time"]))), gap)
        # Impurity collisions near the upper edge must move inward rather than
        # escape the axis; a fully occupied synthetic axis must reject promptly.
        occupied = [{"time": value} for value in (14.89, 14.62, 14.35)]
        placed = renderer.place_retention(14.99, occupied, .25)
        self.assertTrue(0 < placed < 15)
        self.assertTrue(all(abs(Decimal(str(placed)) - Decimal(str(p["time"]))) >= Decimal(".25") for p in occupied))
        with self.assertRaises(renderer.RequestError):
            renderer.place_retention(7.5, [{"time": i / 2} for i in range(31)], .5)

    def test_primary_formula_masses_charge_spacing_and_dose_independence(self):
        for name, expected in [("Semaglutide", 4111.1153759), ("Tirzepatide", 4810.5248574), ("BPC-157", 1418.7041588)]:
            spectrum = renderer.spectrum_for({"name": name}, "fixed-seed")
            self.assertAlmostEqual(spectrum["neutralMass"], expected, places=5)
            for ion in spectrum["ions"]:
                expected_mz = (spectrum["neutralMass"] / ion["charge"] + renderer.PROFILES["protonMassU"]) * (1 + ion["ppm"] / 1e6)
                self.assertAlmostEqual(ion["mz"], expected_mz, places=6)
                spacing = ion["isotopes"][1]["mz"] - ion["isotopes"][0]["mz"]
                self.assertAlmostEqual(spacing, renderer.PROFILES["carbon13SpacingU"] / ion["charge"], places=6)
        first = self.bundle()["record"]["spectra"]
        self.request["product"]["name"] = "BPC-157 20mg"
        self.request["product"]["components"][0]["nominal"] = 20
        self.assertEqual(first, self.bundle()["record"]["spectra"])

    def test_unknown_species_never_receive_theoretical_mass_or_identity(self):
        self.request["product"]["components"][0]["name"] = "TB-500"
        record = self.bundle()["record"]
        self.assertEqual(record["identity"], "Unassigned")
        spectrum = record["spectra"][0]
        self.assertIsNone(spectrum["neutralMass"])
        self.assertIsNone(spectrum["cid"])
        self.assertTrue(all(ion["charge"] == 0 and ion["label"] == "Unassigned" for ion in spectrum["ions"]))
        self.assertTrue(all(len(ion["isotopes"]) == 1 for ion in spectrum["ions"]))

    def test_one_to_four_components_long_blend_and_units(self):
        for unit, nominal in [("mg", 10), ("ml", 3), ("IU", 5000)]:
            request = copy.deepcopy(self.request)
            request["product"].update(unit=unit, name="HCG 5000IU" if unit == "IU" else "BPC-157 10mg")
            request["product"]["components"][0].update(unit=unit, nominal=nominal)
            bundle = self.bundle(request)
            self.assertEqual(bundle["record"]["contentUnit"], unit)
            self.assertEqual(bundle["record"]["composition"][0]["unit"], unit)
            self.assertLess(abs(float(bundle["record"]["composition"][0]["summary"]) / nominal - 1), .025)
            with Image.open(self.photo) as photo:
                renderer.make_drawing(request["lookupCode"], bundle["record"], photo.copy())
        request = copy.deepcopy(self.request)
        names = ["BPC-157", "GHK-Cu", "TB-500", "KPV"]
        request["product"].update(name="BPC-157 10mg + GHK-Cu 50mg + TB-500 10mg + KPV 10mg", components=[{"name": name, "unit": "mg", "nominal": 50 if name == "GHK-Cu" else 10} for name in names])
        bundle = self.bundle(request)
        self.assertEqual(len(bundle["record"]["spectra"]), 4)
        self.assertEqual(bundle["record"]["identity"], "Partial match")
        with Image.open(self.photo) as photo:
            renderer.make_drawing(request["lookupCode"], bundle["record"], photo.copy())

    def test_invalid_request_rejects_before_output_and_preserves_existing(self):
        output = self.root / "output"
        output.mkdir()
        (output / "report.pdf").write_bytes(b"prior PDF")
        for mutate in [lambda r: r.update(lookupCode="../invalid"), lambda r: r.update(lookupCode="AN-7K9Q-2M4X"), lambda r: r["fields"].update(purity1=98), lambda r: r["fields"].update(reported="2026-02-30"), lambda r: r["product"].update(components=[]), lambda r: r["product"]["components"][0].update(unit="g"), lambda r: r["product"]["components"][0].update(nominal=True), lambda r: r["product"].update(imagePath="missing.png")]:
            request = copy.deepcopy(self.request)
            mutate(request)
            with self.assertRaises(renderer.RequestError):
                renderer.build(request, output)
            self.assertEqual((output / "report.pdf").read_bytes(), b"prior PDF")
            self.assertEqual(sorted(p.name for p in output.iterdir()), ["report.pdf"])

    def test_actual_pdf_svg_determinism_a4_embedded_photo_and_clean_public_dto(self):
        first, second = self.root / "first", self.root / "second"
        renderer.build(self.request, first)
        renderer.build(self.request, second)
        for name in ("report.pdf", "report.svg", "bundle.json"):
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes(), name)
        reader = PdfReader(first / "report.pdf")
        self.assertEqual(len(reader.pages), 1)
        self.assertAlmostEqual(float(reader.pages[0].mediabox.width), 595.2756, places=3)
        self.assertAlmostEqual(float(reader.pages[0].mediabox.height), 841.8898, places=3)
        text = reader.pages[0].extract_text()
        for value in ("BPC-157 10mg", self.request["lookupCode"], "Certificate of Analysis", "Chief Chemist"):
            self.assertIn(value, text)
        for value in ("Two determinations of the same sample", "Replicate 1:", "Replicate 2:", "Mean", "Measured content", "mg/vial", "reports@assaynovalabs.com", "+1-681-334-3721"):
            self.assertIn(value, text)
        self.assertNotIn("Contact the laboratory", text)
        self.assertNotRegex(text, r"Sample [12]|Reported summary|Coming soon")
        self.assertNotRegex(text.lower(), r"fictional|demo|conference|sample report|meeting")
        self.assertNotRegex((first / "report.svg").read_text(), r"<(?:script|text)\b|href=\"https?://")
        svg = ET.parse(first / "report.svg").getroot()
        self.assertEqual(svg.attrib["width"], "210mm")
        self.assertEqual(svg.attrib["height"], "297mm")
        images = list(svg.iter("{http://www.w3.org/2000/svg}image"))
        self.assertEqual(len(images), 3)
        # The source photograph appears in full, at unchanged decoded pixels.
        import base64
        from io import BytesIO
        originals = []
        for node in images:
            data = node.attrib.get("href") or node.attrib["{http://www.w3.org/1999/xlink}href"]
            self.assertTrue(data.startswith("data:image/png;base64,"))
            with Image.open(BytesIO(base64.b64decode(data.split(",", 1)[1]))) as photo:
                originals.append((photo.size, photo.convert("RGB").tobytes()))
        with Image.open(self.photo) as selected:
            self.assertIn((selected.size, selected.convert("RGB").tobytes()), originals)
        serialized = (first / "bundle.json").read_text()
        self.assertNotIn(str(self.photo), serialized)
        self.assertNotIn("persistent-seed", serialized)
        self.assertEqual(set(json.loads(serialized)), {"report", "record", "label"})


if __name__ == "__main__":
    unittest.main()
