#!/usr/bin/env python3
"""Private deterministic report renderer; no writes to the public specimen catalog.

CLI: python -B conference/render_report.py --request ABSJSON --output ABSDIR
The selected photograph is read unchanged. All measurements/traces are synthetic;
the operator service retains provenance privately. Molecular references are not
evidence of an analytical run, accreditation, signing event or product identity.
"""
from __future__ import annotations

import argparse
import copy
from datetime import date
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import random
import re
import sys
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image as PILImage
from reportlab.graphics import renderPDF, renderSVG
from reportlab.graphics.shapes import Drawing, Rect, Line, String, Image, Path as VectorPath
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "templates" / "coa"))
import build_sample_coa as master

PROFILES = json.loads(Path(__file__).with_name("reference-profiles.json").read_text(encoding="utf-8"))
PAGE_W, PAGE_H = master.PAGE_W, master.PAGE_H
MARGIN = master.MARGIN
NAVY, TEAL, INK, MUTED, RULE, PALE, WHITE = (getattr(master, k) for k in ("NAVY", "TEAL", "INK", "MUTED", "RULE", "PALE", "WHITE"))
CODE = re.compile(r"AN-[A-Z0-9]{4}-[A-Z0-9]{4}\Z")
UNITS = {"mg", "ml", "IU"}


class RequestError(ValueError):
    pass


def ascii_text(value, label, maximum=120, default=None):
    if value is None or value == "":
        value = default
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(not 32 <= ord(c) <= 126 for c in value):
        raise RequestError(f"Invalid {label}: use 1-{maximum} printable ASCII characters")
    return value.strip()


def numeric(value, label, minimum, maximum):
    if type(value) not in (int, float, str) or isinstance(value, str) and not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", value):
        raise RequestError(f"Invalid {label}")
    try:
        number = Decimal(str(value))
    except InvalidOperation:
        raise RequestError(f"Invalid {label}") from None
    if not number.is_finite() or not Decimal(str(minimum)) <= number <= Decimal(str(maximum)):
        raise RequestError(f"{label} is outside the allowed range")
    return number


def two(value):
    return str(Decimal(str(value)).quantize(Decimal(".01"), rounding=ROUND_HALF_UP))


def mean(a, b):
    return two((Decimal(str(a)) + Decimal(str(b))) / 2)


def stable_int(value):
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def validate_request(request):
    if not isinstance(request, dict):
        raise RequestError("Request must be an object")
    code = request.get("lookupCode")
    if not isinstance(code, str) or not CODE.fullmatch(code) or code in master.STEMS:
        raise RequestError("Invalid or reserved Lookup Code")
    seed = request.get("seed")
    if type(seed) not in (int, str) or isinstance(seed, str) and not 1 <= len(seed) <= 128:
        raise RequestError("Seed must be a bounded string or integer")
    product = request.get("product")
    if not isinstance(product, dict):
        raise RequestError("Product must be an object")
    name = ascii_text(product.get("name"), "product name", 160)
    product_id = ascii_text(product.get("id"), "product id", 128)
    unit = product.get("unit", "mg")
    if unit not in UNITS and unit != "mixed":
        raise RequestError("Product unit must be mg, ml, IU or mixed")
    components = product.get("components")
    if not isinstance(components, list) or not 1 <= len(components) <= 4:
        raise RequestError("Product requires one to four components")
    parsed = []
    for item in components:
        if not isinstance(item, dict):
            raise RequestError("Component must be an object")
        component_unit = item.get("unit", unit)
        if component_unit not in UNITS:
            raise RequestError("Component unit must be mg, ml or IU")
        parsed.append({"name": ascii_text(item.get("name"), "component name", 100), "nominal": numeric(item.get("nominal"), "nominal content", .01, 100000), "unit": component_unit})
    if len({item["name"].lower() for item in parsed}) != len(parsed):
        raise RequestError("Component names must be distinct")
    unit = parsed[0]["unit"] if len({item["unit"] for item in parsed}) == 1 else "mixed"
    image_path = product.get("imagePath")
    if not isinstance(image_path, str) or not Path(image_path).is_absolute() or not Path(image_path).is_file():
        raise RequestError("Selected product image is unavailable")
    try:
        with PILImage.open(image_path) as candidate:
            if candidate.format not in ("PNG", "JPEG") or candidate.width * candidate.height > 40000000:
                raise RequestError("Product image must be a bounded PNG or JPEG")
            candidate.load()
    except (OSError, PILImage.DecompressionBombError):
        raise RequestError("Selected product image cannot be decoded") from None
    fields = request.get("fields", {})
    if not isinstance(fields, dict):
        raise RequestError("Fields must be an object")
    clean = {"client": ascii_text(fields.get("client"), "client", 90, "Research Client"), "lot": ascii_text(fields.get("lot"), "lot", 48, "LOT-" + code[-4:])}
    for key in ("received", "reported"):
        value = fields.get(key) or date.today().isoformat()
        try:
            if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
                raise ValueError()
        except ValueError:
            raise RequestError(f"Invalid {key} date") from None
        clean[key] = value
    if clean["reported"] < clean["received"]:
        raise RequestError("Reported date must be on or after received date")
    for key in ("purity1", "purity2"):
        if key in fields and fields[key] not in (None, ""):
            clean[key] = numeric(fields[key], key, 99.05, 99.95)
    return {"lookupCode": code, "seed": str(seed), "product": {"id": product_id, "name": name, "imagePath": image_path, "unit": unit, "components": parsed}, "fields": clean}


def formula_atoms(formula):
    return {element: int(count or 1) for element, count in re.findall(r"([A-Z][a-z]?)([0-9]*)", formula)}


def formula_mass(formula):
    return sum(PROFILES["atomicMonoisotopicMass"][element] * count for element, count in formula_atoms(formula).items())


def isotope_envelope(formula):
    # Nominal natural-abundance bins; includes the major +1/+2 substitutions.
    distribution = [1.] + [0.] * 7
    abundances = {"C": [(1, .0107)], "H": [(1, .000115)], "N": [(1, .00364)], "O": [(1, .00038), (2, .00205)], "S": [(1, .0075), (2, .0425), (4, .0001)]}
    for element, count in formula_atoms(formula).items():
        variants = abundances.get(element, [])
        for _ in range(count):
            next_values = [v * (1 - sum(p for _, p in variants)) for v in distribution]
            for index, value in enumerate(distribution):
                for shift, probability in variants:
                    if index + shift < len(distribution):
                        next_values[index + shift] += value * probability
            distribution = next_values
    maximum = max(distribution)
    return [round(value / maximum * 100, 6) for value in distribution]


def profile_for(name):
    key = PROFILES["aliases"].get(name.lower())
    return PROFILES["profiles"].get(key) if key else None


def spectrum_for(component, seed):
    name = component["name"]
    rng = random.Random(stable_int(seed + ":mass:" + name.lower()))
    profile = profile_for(name)
    noise = [{"mz": round(105 + index * 79 + rng.uniform(0, 38), 4), "response": round(rng.uniform(.15, 2.7), 4)} for index in range(18)]
    if not profile:
        # No invented theoretical mass, charge assignment or isotope envelope.
        baseline = random.Random(stable_int(name.lower()))
        ions = []
        for index in range(3):
            mz = round(baseline.uniform(210, 1390) + rng.uniform(-.03, .03), 6)
            intensity = 100. if index == 0 else round(rng.uniform(18, 60), 4)
            ions.append({"charge": 0, "label": "Unassigned", "mz": mz, "ppm": 0, "intensity": intensity, "isotopes": [{"mz": mz, "response": intensity}]})
        return {"analyte": name, "species": "Unassigned signal profile", "cid": None, "neutralMass": None, "ions": ions, "noise": noise, "scan": [100, 1600], "status": "Unassigned"}
    mass = formula_mass(profile["formula"])
    envelope = isotope_envelope(profile["formula"])
    ions = []
    for index, charge in enumerate(profile["charges"]):
        ppm = round(rng.uniform(-2.5, 2.5), 4)
        mz = (mass / charge + PROFILES["protonMassU"]) * (1 + ppm / 1e6)
        intensity = 100. if index == 0 else round(rng.uniform(24, 66), 4)
        ions.append({"charge": charge, "label": f"[M+{charge}H]{charge}+" if charge > 1 else "[M+H]+", "mz": round(mz, 7), "ppm": ppm, "intensity": intensity,
                     "isotopes": [{"mz": round(mz + i * PROFILES["carbon13SpacingU"] / charge, 7), "response": round(intensity * v / 100, 5)} for i, v in enumerate(envelope)]})
    return {"analyte": name, "species": profile["species"], "cid": profile["cid"], "neutralMass": round(mass, 8), "ions": ions, "noise": noise, "scan": [100, 1600], "status": "Observed"}


def place_retention(preferred, peaks, separation):
    """Choose the nearest free centiminute on the open 0-15 minute axis.

    Search each finite candidate once. Integer spacing avoids float rounding
    at the minimum gap, and neither upper-axis reversal nor collision can loop.
    """
    origin = max(1, min(1499, int(round(preferred * 100))))
    occupied = [int(round(peak["time"] * 100)) for peak in peaks]
    gap = int(math.ceil(separation * 100))
    for distance in range(1500):
        candidates = (origin,) if distance == 0 else (origin + distance, origin - distance)
        for candidate in candidates:
            if 1 <= candidate <= 1499 and all(abs(candidate - other) >= gap for other in occupied):
                return candidate / 100
    raise RequestError("Chromatographic peaks cannot fit within the retention-time axis")


def make_bundle(clean):
    product, fields, code, seed = clean["product"], clean["fields"], clean["lookupCode"], clean["seed"]
    rng = random.Random(stable_int(seed + ":" + product["id"]))
    generated_base = Decimal(rng.randint(9905, 9995)) / 100
    # Replicates share a run baseline; bounded preparation/injection variation
    # stays within 0.08 percentage points. A supplied replicate anchors the
    # unspecified one, while two explicit manual values remain untouched.
    base = fields.get("purity1", fields.get("purity2", generated_base))
    auto_purity = [max(Decimal("99.05"), min(Decimal("99.95"), base + Decimal(rng.randint(-4, 4)) / 100)) for _ in range(2)]
    purity = [two(fields.get(key, automatic)) for key, automatic in zip(("purity1", "purity2"), auto_purity)]
    purity.append(mean(*purity))
    composition = []
    for component in product["components"]:
        values = [two(component["nominal"] * Decimal(str(rng.uniform(.98, 1.02)))) for _ in range(2)]
        composition.append({"analyte": component["name"], "sample1": values[0], "sample2": values[1], "summary": mean(*values), "unit": component["unit"]})
    # Independent, name-specific UV response factors; areas are not mg or IU.
    weights = [(.65 + (stable_int(item["name"].lower()) % 1000) / 1000) * (float(item["nominal"]) if product["unit"] != "mixed" else 1) for item in product["components"]]
    target_areas = [round(float(purity[2]) * w / sum(weights), 6) for w in weights]
    target_areas[-1] = round(float(purity[2]) - sum(target_areas[:-1]), 6)
    peaks = []
    for component, area in zip(product["components"], target_areas):
        name = component["name"]
        profile = profile_for(name)
        baseline = profile["retention"] if profile else 2.2 + (stable_int(name.lower()) % 980) / 100
        time = place_retention(round(baseline + rng.uniform(-.16, .16), 2), peaks, .38)
        peaks.append({"analyte": name, "kind": "target", "time": time, "area": area, "width": round(rng.uniform(.033, .075), 4), "tail": round(rng.uniform(1.1, 1.8), 3)})
    impurity_total = round(100 - float(purity[2]), 6)
    impurity_weights = [rng.uniform(.3, 1) for _ in range(3)]
    impurity_areas = [round(impurity_total * w / sum(impurity_weights), 6) for w in impurity_weights]
    impurity_areas[-1] = round(impurity_total - sum(impurity_areas[:-1]), 6)
    for index, area in enumerate(impurity_areas):
        time = place_retention(round((1.4, 7.1, 13.2)[index] + rng.uniform(-.4, .4), 2), peaks, .25)
        peaks.append({"analyte": f"Impurity {index + 1}", "kind": "impurity", "time": time, "area": area, "width": round(rng.uniform(.025, .045), 4), "tail": round(rng.uniform(1.1, 1.65), 3)})
    heights = [peak["area"] / (peak["width"] * (1 + peak["tail"])) for peak in peaks]
    for peak, height in zip(peaks, heights):
        peak["response"] = round(height / max(heights) * 100, 6)
    peaks.sort(key=lambda p: p["time"])
    spectra = [spectrum_for(component, seed) for component in product["components"]]
    assigned = sum(spectrum["status"] == "Observed" for spectrum in spectra)
    identity = "Consistent" if assigned == len(spectra) else "Partial match" if assigned else "Unassigned"
    retention = two(max(peaks, key=lambda p: p["response"])["time"])
    appearance = "Clear liquid" if product["unit"] == "ml" else "Lyophilized powder"
    if any("ghk" in item["name"].lower() or "ahk" in item["name"].lower() for item in product["components"]):
        appearance = "Blue lyophilized powder"
    identity_detail = "Reference ions consistent" if assigned == len(spectra) else "Reference assignment pending"
    screenings = [{"test": "Identity (LC-MS)", "result": identity, "details": identity_detail},
                  {"test": "Elemental impurities (ICP-MS)", "result": "Not assessed", "details": "No result supplied"},
                  {"test": "Endotoxin (LAL)", "result": "Not assessed", "details": "No result supplied"},
                  {"test": "Microbial analysis (PCR)", "result": "Not assessed", "details": "No result supplied"},
                  {"test": "Fentanyl", "result": "Not assessed", "details": "No result supplied"}]
    record = {"label": product["name"], "product": product["name"], "appearance": appearance, "client": fields["client"], "reportId": "AN-" + fields["reported"][:4] + "-" + code[3:7] + code[8:], "accession": code[3:7] + code[8:], "lot": fields["lot"], "received": fields["received"], "reported": fields["reported"], "purity": purity, "identity": identity, "retentionTime": retention, "composition": composition, "screenings": screenings, "method": "HPLC-UV; LC-MS profile assessment.", "spectra": spectra, "chromatogram": peaks, "signoffTitle": "Chief Chemist", "plotSeed": stable_int(seed + ":noise") % (2**31), "contentUnit": product["unit"]}
    report = {"id": record["reportId"], "lookupCode": code, "publication": "published", "version": "1.0", "sample": product["name"], "batch": record["lot"], "received": record["received"], "issued": record["reported"], "purity": purity[2] + "%", "identity": identity, "identityOutcome": "matched" if identity == "Consistent" else "partial" if identity == "Partial match" else "neutral", "method": "HPLC / LC-MS", "status": "Completed", "retentionTime": retention + " min"}
    return {"report": report, "record": record, "label": product["name"]}


def wrap(value, width, size, bold=False):
    font = "SampleVeraBold" if bold else "SampleVera"
    words, lines, current = value.split(), [], ""
    for word in words:
        candidate = current + (" " if current else "") + word
        if master.pdfmetrics.stringWidth(candidate, font, size) <= width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = ""
            for character in word:
                if master.pdfmetrics.stringWidth(current + character, font, size) > width:
                    lines.append(current)
                    current = character
                else:
                    current += character
    if current:
        lines.append(current)
    return lines


def wrapped(drawing, value, x, top, width, size=8.5, bold=False, color=INK, leading=None, max_lines=4):
    lines = wrap(value, width, size, bold)
    if len(lines) > max_lines:
        raise RequestError("Text exceeds its allocated report area")
    leading = leading or size * 1.25
    for index, line in enumerate(lines):
        master.text(drawing, line, x, top - index * leading, size, bold, color)
    return top - len(lines) * leading


def chart_text(drawing, value, x, y, size=6.5, anchor="start"):
    drawing.add(String(x, y, value, fontName="SampleVera", fontSize=size, fillColor=colors.black, textAnchor=anchor))


def chromatogram(drawing, record):
    x, y, w, h = MARGIN, 368, 265, 96
    drawing.add(Rect(x, y, w, h, fillColor=WHITE, strokeColor=colors.HexColor("#B8B8B8"), strokeWidth=.35))
    left, bottom, width, height = x + 27, y + 18, w - 35, 65
    master.rule(drawing, left, bottom, width, colors.black, .35)
    drawing.add(Line(left, bottom, left, bottom + height, strokeColor=colors.black, strokeWidth=.35))
    for tick in range(31):
        tx = left + tick / 2 / 15 * width
        drawing.add(Line(tx, bottom, tx, bottom - (3 if tick % 10 == 0 else 1.5), strokeColor=colors.black, strokeWidth=.3))
        if tick % 10 == 0:
            chart_text(drawing, str(tick // 2), tx, bottom - 10, anchor="middle")
    for tick in range(3):
        ty = bottom + tick / 2 * height
        chart_text(drawing, str(tick * 50), left - 5, ty - 2, anchor="end")
    chart_text(drawing, "Rel. UV (%)", x + 3, y + h - 7)
    chart_text(drawing, "min", x + w - 3, y + 3, anchor="end")
    noise = random.Random(record["plotSeed"])
    curve = VectorPath(strokeColor=colors.HexColor("#242424"), strokeWidth=.45, fillColor=None)
    # Area-normalized asymmetric Gaussian: numerical area follows metadata,
    # and response normalization follows the same width/tail parameters.
    for index in range(1501):
        time = index / 100
        response = .24 + .16 * time / 15 + .07 * math.sin(time * 3.1) + noise.uniform(-.045, .045)
        for peak in record["chromatogram"]:
            sigma = peak["width"] * (peak["tail"] if time > peak["time"] else 1)
            response += .993 * peak["response"] * math.exp(-.5 * ((time - peak["time"]) / sigma)**2)
        px, py = left + time / 15 * width, bottom + response / 100 * height
        (curve.moveTo if index == 0 else curve.lineTo)(px, py)
    drawing.add(curve)
    for index, peak in enumerate(p for p in record["chromatogram"] if p["kind"] == "target"):
        # Numbered peak labels fit every long product name without crossing axes.
        chart_text(drawing, str(index + 1), left + peak["time"] / 15 * width + 3, bottom + min(peak["response"], 80) / 100 * height + 3)


def spectrum_plot(drawing, spectrum, x, y, width, height):
    drawing.add(Rect(x, y, width, height, fillColor=WHITE, strokeColor=colors.HexColor("#C8C8C8"), strokeWidth=.3))
    left, bottom, plot_width, plot_height = x + 13, y + 14, width - 20, height - 51
    mx = lambda mz: left + (mz - 100) / 1500 * plot_width
    master.rule(drawing, left, bottom, plot_width, colors.black, .3)
    drawing.add(Line(left, bottom, left, bottom + plot_height, strokeColor=colors.black, strokeWidth=.3))
    for tick in (500, 1000, 1500):
        chart_text(drawing, str(tick), mx(tick), bottom - 9, anchor="middle")
    chart_text(drawing, "m/z", x + width - 3, y + 18, anchor="end")
    for peak in spectrum["noise"]:
        drawing.add(Line(mx(peak["mz"]), bottom, mx(peak["mz"]), bottom + peak["response"] / 100 * plot_height, strokeColor=colors.HexColor("#777777"), strokeWidth=.25))
    for ion in spectrum["ions"]:
        for isotope in ion["isotopes"]:
            if 100 <= isotope["mz"] <= 1600:
                drawing.add(Line(mx(isotope["mz"]), bottom, mx(isotope["mz"]), bottom + isotope["response"] / 100 * plot_height, strokeColor=colors.HexColor("#333333"), strokeWidth=.35))
    primary = spectrum["ions"][0]
    chart_text(drawing, f'{primary["mz"]:.3f}', x + 3, y + height - 10)
    chart_text(drawing, primary["label"], x + 3, y + height - 20)
    if spectrum["status"] == "Observed":
        ix, iy, iw, ih = x + width - 48, y + height - 38, 44, 24
        drawing.add(Rect(ix, iy, iw, ih, fillColor=WHITE, strokeColor=colors.HexColor("#AAAAAA"), strokeWidth=.25))
        cluster = primary["isotopes"]
        span = cluster[-1]["mz"] - cluster[0]["mz"]
        for peak in cluster:
            px = ix + 3 + (peak["mz"] - cluster[0]["mz"]) / span * (iw - 6)
            drawing.add(Line(px, iy + 8, px, iy + 8 + peak["response"] / 100 * 14, strokeColor=colors.black, strokeWidth=.35))
        chart_text(drawing, f'{cluster[0]["mz"]:.1f}', ix + 1, iy + 1, size=6.5)


def make_drawing(code, record, product_image, contact_config=None):
    master.report_pdf_url(code)
    master.register_fonts()
    contact = master.load_contact(contact_config)
    d = Drawing(PAGE_W, PAGE_H)
    d.add(Rect(0, 0, PAGE_W, PAGE_H, fillColor=WHITE, strokeColor=None))
    logo = master.ROOT / "assets" / "assaynova-logo.png"
    with PILImage.open(logo) as image:
        logo_height = 122 * image.height / image.width
    d.add(Image(MARGIN, PAGE_H - 25 - logo_height, 122, logo_height, path=str(logo)))
    master.text(d, "Certificate of Analysis", MARGIN + 172, PAGE_H - 47, 18.3, True, NAVY)
    master.rule(d, MARGIN, PAGE_H - 70, PAGE_W - 2 * MARGIN, TEAL, .9)
    top, floor = PAGE_H - 89, 508
    d.add(Rect(MARGIN, floor, 154, top - floor, fillColor=PALE, strokeColor=None))
    x = MARGIN + 12
    master.text(d, "SAMPLE INFORMATION", x, top - 18, 9, True, TEAL)
    name_bottom = wrapped(d, record["product"], x, top - 40, 130, 10.5, True, NAVY, leading=12.5, max_lines=4)
    # Long product names consume rail height; fields keep measured spacing.
    fields = [("CLIENT", record["client"]), ("LOT", record["lot"]), ("ACCESSION NO.", record["accession"]), ("LOOKUP CODE", code), ("RECEIVED", record["received"]), ("REPORTED", record["reported"])]
    y = wrapped(d, record["appearance"], x, name_bottom - 2, 130, 8.5, color=MUTED, leading=10, max_lines=2) - 7
    sizes = [len(wrap(value, 130, 8.5)) for _, value in fields]
    required_height = sum(13 + n * 10 for n in sizes)
    if y - required_height < floor + 5:
        # 8pt body remains legible for the longest canonical blend/client.
        sizes = [len(wrap(value, 130, 8)) for _, value in fields]
        required_height = sum(11 + n * 9 for n in sizes)
        value_size, value_leading, label_gap = 8, 9, 9
    else:
        value_size, value_leading, label_gap = 8.5, 10, 11
    if y - required_height < floor + 5:
        raise RequestError("Product/client fields exceed the information rail")
    for label, value in fields:
        master.text(d, label, x, y, 8, True, MUTED)
        y = wrapped(d, value, x, y - label_gap, 130, value_size, leading=value_leading, max_lines=4) - 2
    profile_x, profile_width = 208, PAGE_W - MARGIN - 208
    unit = master.draw_reported_results(d, record, profile_x, top, profile_width)
    master.product(d, PAGE_W - MARGIN - 82, top, product_image)
    table_top = top - 132
    widths = [profile_width * f for f in (.40, .20, .20, .20)]
    edges = [profile_x]
    for width in widths:
        edges.append(edges[-1] + width)
    header_height = 20
    d.add(Rect(profile_x, table_top - header_height, profile_width, header_height, fillColor=PALE, strokeColor=None))
    for index, label in enumerate(("Analyte", "Replicate 1", "Replicate 2", "Mean")):
        master.text(d, label, edges[index] + 6 if index == 0 else edges[index + 1] - 6, table_top - 14, 8.2, True, anchor="start" if index == 0 else "end")
    y = table_top - header_height
    for row in record["composition"]:
        label = row["analyte"] + (f' ({row["unit"]})' if unit == "mixed" else "")
        lines = wrap(label, widths[0] - 12, 8.5)
        row_height = max(20, 8 + 10 * len(lines))
        wrapped(d, label, profile_x + 6, y - 13, widths[0] - 12, 8.5, leading=10, max_lines=3)
        for col, key in enumerate(("sample1", "sample2", "summary"), 1):
            master.text(d, row[key], edges[col + 1] - 6, y - 13, 9, anchor="end")
        y -= row_height
        master.rule(d, profile_x, y, profile_width)
    if y < floor + 2:
        raise RequestError("Composition exceeds the portrait layout")
    figure_width, ledger_x = 265, 315
    master.title(d, "HPLC-UV chromatogram", MARGIN, 480, figure_width)
    chromatogram(d, record)
    master.title(d, "Mass profiles", MARGIN, 339, figure_width)
    count = len(record["spectra"])
    if count == 1:
        panels = [(MARGIN, 140, figure_width, 160, 319)]
    else:
        panel_width = (figure_width - 12) / 2
        panels = [(MARGIN + i % 2 * (panel_width + 12), 221 - i // 2 * 118, panel_width, 76, 313 - i // 2 * 118) for i in range(count)]
    for spectrum, (px, py, width, height, label_y) in zip(record["spectra"], panels):
        label = spectrum["analyte"] + (" / ligand" if spectrum["species"] == "GHK (apo ligand)" else "")
        label_lines = wrap(label, width, 8.5, True)
        wrapped(d, label, px, label_y, width, 8.5, True, NAVY, leading=10, max_lines=3)
        if len(label_lines) > 1:
            extra = (len(label_lines) - 1) * 10
            if py - extra < 103:
                height -= extra
            else:
                py -= extra
        spectrum_plot(d, spectrum, px, py, width, height)
    master.title(d, "Screening outcomes", ledger_x, 480, PAGE_W - MARGIN - ledger_x)
    for index, screening in enumerate(record["screenings"]):
        y = 453 - index * 62
        master.text(d, screening["test"], ledger_x, y, 9, True, NAVY)
        master.text(d, screening["result"], ledger_x, y - 18, 9, True)
        master.text(d, screening["details"], ledger_x, y - 34, 8.5)
        master.rule(d, ledger_x, y - 46, PAGE_W - MARGIN - ledger_x)
    master.title(d, "Method", ledger_x, 141, PAGE_W - MARGIN - ledger_x)
    wrapped(d, record["method"], ledger_x, 123, PAGE_W - MARGIN - ledger_x, 8.5, color=MUTED, max_lines=2)
    master.draw_contact(d, contact)
    master.draw_report_qr(d, code)
    signature = master.ROOT / "assets" / "dylan-greene-signature.png"
    with PILImage.open(signature) as image:
        scale = min(150 / image.width, 44 / image.height)
        sw, sh = image.width * scale, image.height * scale
    d.add(Image(MARGIN + (168 - sw) / 2, 97 - sh, sw, sh, path=str(signature)))
    master.text(d, record["signoffTitle"], MARGIN + 84, 42, 8.5, color=MUTED, anchor="middle")
    return d


def render(drawing, code, label):
    target = master.report_pdf_url(code)
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=master.A4, invariant=1, pageCompression=1)
    pdf.setTitle("Certificate of Analysis - " + code)
    pdf.setAuthor("AssayNova")
    pdf.setSubject(label)

    class TransparentImageRenderer(renderPDF._PDFRenderer):
        def drawImage(self, image):
            self._canvas.drawImage(ImageReader(image.path), image.x, image.y, image.width, image.height, mask="auto")

    TransparentImageRenderer().draw(drawing, pdf, 0, 0)
    x, y, width, height = master.REPORT_QR_BOUNDS
    pdf.linkURL(target, (x, y, x + width, y + height), relative=0, thickness=0)
    pdf.showPage()
    pdf.save()
    root = ET.fromstring(renderSVG.drawToString(master.svg_drawing(drawing)))
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    for key, value in {"width": "210mm", "height": "297mm", "viewBox": f"0 0 {PAGE_W} {PAGE_H}", "role": "img", "aria-labelledby": "report-title report-description"}.items():
        root.set(key, value)
    title = ET.Element("{http://www.w3.org/2000/svg}title", {"id": "report-title"})
    title.text = "Certificate of Analysis - " + label
    description = ET.Element("{http://www.w3.org/2000/svg}desc", {"id": "report-description"})
    description.text = "Portrait report with quantitative results, chromatogram, mass profiles, screening outcomes and signoff. Lookup Code " + code + ". Footer QR opens " + target
    metadata = ET.Element("{http://www.w3.org/2000/svg}metadata")
    metadata.text = "Font outlines derived from Bitstream Vera; license distributed with the platform."
    root.insert(0, title)
    root.insert(1, description)
    root.insert(2, metadata)
    return buffer.getvalue(), ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build(request, output, contact_config=None):
    clean = validate_request(request)
    bundle = make_bundle(clean)
    with PILImage.open(clean["product"]["imagePath"]) as selected:
        selected.load()
        image = selected.copy()
    drawing = make_drawing(clean["lookupCode"], bundle["record"], image, contact_config)
    pdf, svg = render(drawing, clean["lookupCode"], bundle["label"])
    payload = json.dumps(bundle, ensure_ascii=True, allow_nan=False, indent=2).encode("utf-8")
    # Validate/draw/render everything before creating output files. The caller
    # publishes this private staging directory as one immutable job only on success.
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    staged = []
    try:
        for name, content in (("report.pdf", pdf), ("report.svg", svg), ("bundle.json", payload)):
            with tempfile.NamedTemporaryFile(dir=output, prefix=".render-", delete=False) as temp:
                temp.write(content)
                staged.append((Path(temp.name), output / name))
        for source, destination in staged:
            os.replace(source, destination)
    finally:
        for source, _ in staged:
            source.unlink(missing_ok=True)
    return bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if not args.request.is_absolute() or not args.output.is_absolute():
            raise RequestError("Request and output paths must be absolute")
        if args.request.stat().st_size > 65536:
            raise RequestError("Request is too large")
        request = json.loads(args.request.read_text(encoding="utf-8"))
        build(request, args.output)
    except (ValueError, OSError, TypeError, KeyError) as error:
        # Paths, source names, source data and stack traces stay out of stderr.
        message = str(error) if isinstance(error, RequestError) else "Report generation failed validation"
        print(json.dumps({"error": "invalid_report", "message": message[:180]}), file=sys.stderr)
        return 1
    print(json.dumps({"ok": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
