#!/usr/bin/env python3
"""Build the two fixed fictional public sample COAs; never reads private report data.

Usage: python build_sample_coa.py --lookup-code AN-7K9Q-2M4X --output-dir ../../dist/reports
Optional --product-image accepts a PNG/JPEG to replace the per-sample illustrative vial.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import random
import hashlib
from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from io import BytesIO
import os
from pathlib import Path
import re
import struct
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image as PILImage
from reportlab.graphics import renderPDF, renderSVG
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing, Group, Rect, Line, String, Image, Path as VectorPath, Ellipse
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parent
PAGE_W, PAGE_H = A4
MARGIN = 36
STEMS = {"AN-7K9Q-2M4X": "sample-a", "AN-8P6R-3N5Y": "sample-c"}
NAVY = colors.HexColor("#12314A")
TEAL = colors.HexColor("#087F8C")
INK = colors.HexColor("#20384A")
MUTED = colors.HexColor("#526574")
RULE = colors.HexColor("#D3E0E5")
PALE = colors.HexColor("#EFF6F7")
WHITE = colors.white
DATA_FILE = ROOT / "sample_reports.json"
CONTACT_FILE = ROOT / "lab-contact.json"
REPORT_ORIGIN = "https://assaynovalabs.com"
REPORT_QR_BOUNDS = (229, 37, 60, 60)
EXPECTED = {
    "AN-7K9Q-2M4X": ("Reference sample A", "AN-2026-0042", "SAMPLE-2401", "2026-10-26", "2026-10-30", "99.32", "Consistent", "8.42"),
    "AN-8P6R-3N5Y": ("Reference sample C", "AN-2026-0043", "SAMPLE-2402", "2026-10-27", "2026-10-31", "97.84", "Partial match", "9.16")
}


def register_fonts():
    for name, filename in (("SampleVera", "Vera.ttf"), ("SampleVeraBold", "VeraBd.ttf")):
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(ROOT / "fonts" / filename)))


def text(drawing, value, x, y, size=9, bold=False, color=INK, anchor="start"):
    if not value or any(ord(char) < 32 or ord(char) > 126 for char in value):
        raise ValueError("Public master text must use supported printable ASCII")
    font = "SampleVeraBold" if bold else "SampleVera"
    width = pdfmetrics.stringWidth(value, font, size)
    left = x - (width if anchor == "end" else width / 2 if anchor == "middle" else 0)
    ascent, descent = pdfmetrics.getAscentDescent(font, size)
    if size < 8 or left < MARGIN - .01 or left + width > PAGE_W - MARGIN + .01 or y + descent < 24 or y + ascent > PAGE_H - 24:
        raise ValueError(f"Text exceeds measured page bounds: {value}")
    drawing.add(String(x, y, value, fontName=font, fontSize=size, fillColor=color, textAnchor=anchor))


def rule(drawing, x, y, width, color=RULE, thickness=.6):
    drawing.add(Line(x, y, x + width, y, strokeColor=color, strokeWidth=thickness))


def title(drawing, value, x, y, width, right=None):
    text(drawing, value, x, y, 10.5, True, NAVY)
    if right:
        text(drawing, right, x + width, y, 8.5, color=MUTED, anchor="end")


def reported_content(record):
    """Format stored analyte means, never nominal dose or purity-derived content."""
    declared = record.get("contentUnit", "mg")
    if declared not in {"mg", "IU", "ml", "mixed"}:
        raise ValueError("Unsupported measured content unit")
    rows = record.get("composition")
    if not isinstance(rows, list) or not 1 <= len(rows) <= 4:
        raise ValueError("Measured content requires one to four analyte results")
    numbers, units = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid measured content row")
        unit = row.get("unit", declared)
        if unit not in {"mg", "IU", "ml"} or declared != "mixed" and unit != declared:
            raise ValueError("Inconsistent measured content units")
        value = row.get("summary")
        if type(value) not in (str, int, float, Decimal) or len(str(value)) > 32:
            raise ValueError("Invalid reported analyte mean")
        try:
            number = Decimal(str(value))
        except InvalidOperation:
            raise ValueError("Invalid reported analyte mean") from None
        if not number.is_finite() or number < 0:
            raise ValueError("Invalid reported analyte mean")
        numbers.append(number)
        units.add(unit)
    if len(units) > 1:
        if declared != "mixed":
            raise ValueError("Mixed analyte units require mixed content")
        return None, "mixed"
    if declared == "mixed":
        raise ValueError("Mixed content requires distinct analyte units")
    # Sum the displayed means, retaining every row's existing reported value.
    return format(sum(numbers).quantize(Decimal(".01"), rounding=ROUND_HALF_UP), ".2f"), declared


def draw_reported_results(drawing, record, x, top, width):
    amount, unit = reported_content(record)
    title(drawing, "Analytical results", x, top - 10, width)
    text(drawing, "Two determinations of the same sample", x, top - 28, 8.5, color=MUTED)
    metric_width = (width - 96) / 2
    metrics = (("Purity", "(HPLC-UV area%)", record["purity"][2] + "%"),
               ("Measured content", f"({unit}/vial)" if unit != "mixed" else "Per-analyte results", amount if amount is not None else "See table"))
    for index, (label, context, value) in enumerate(metrics):
        mx = x + index * metric_width
        text(drawing, label, mx, top - 47, 8.5, True, NAVY)
        text(drawing, context, mx, top - 59, 8, color=MUTED)
        if pdfmetrics.stringWidth(value, "SampleVeraBold", 17) > metric_width - 10:
            raise ValueError("Reported result exceeds its measured slot")
        text(drawing, value, mx, top - 82, 17, True, NAVY)
        rule(drawing, mx, top - 88, metric_width - 10, TEAL, .7)
    text(drawing, f'Replicate 1: {record["purity"][0]}% / Replicate 2: {record["purity"][1]}%', x, top - 103, 8, color=MUTED)
    title(drawing, "Measured content", x, top - 115, width,
          f"{unit}/vial" if unit != "mixed" else "Per-analyte results")
    return unit


def load_contact(config=None):
    """Read fresh configuration and validate every line before any output writes."""
    if config is None:
        config = json.loads(CONTACT_FILE.read_text(encoding="utf-8"))
    elif isinstance(config, (str, Path)):
        config = json.loads(Path(config).read_text(encoding="utf-8"))
    if not isinstance(config, dict) or set(config) != {"title", "email", "phone", "addressLines"}:
        raise ValueError("Laboratory contact requires title, email, phone and addressLines only")
    register_fonts()
    def line(value, label, maximum, optional=False, bold=False):
        if not isinstance(value, str) or len(value) > maximum or any(not 32 <= ord(c) <= 126 for c in value) or value != value.strip() or not value and not optional:
            raise ValueError("Invalid laboratory contact " + label)
        if pdfmetrics.stringWidth(value, "SampleVeraBold" if bold else "SampleVera", 9 if bold else 8.5) > PAGE_W - MARGIN - 315:
            raise ValueError("Laboratory contact " + label + " exceeds its footer width")
        return value
    heading = line(config["title"], "title", 40, bold=True)
    email = line(config["email"], "email", 100)
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+", email):
        raise ValueError("Invalid laboratory contact email")
    phone = line(config["phone"], "phone", 50, optional=True)
    addresses = config["addressLines"]
    if not isinstance(addresses, list) or len(addresses) > 2:
        raise ValueError("Laboratory contact supports at most two address lines")
    return {"title": heading, "email": email, "phone": phone,
            "addressLines": [line(value, "address line", 90) for value in addresses]}


def draw_contact(drawing, contact):
    text(drawing, contact["title"], 315, 92, 9, True, TEAL)
    lines = [contact["email"]] + ([contact["phone"]] if contact["phone"] else []) + contact["addressLines"]
    for index, value in enumerate(lines):
        text(drawing, value, 315, 80.5 - index * 12, 8.5, color=NAVY)


def report_pdf_url(code):
    """Use the owner's canonical domain, never an operator/LAN request origin."""
    if not isinstance(code, str) or not re.fullmatch(r"AN-[A-Z0-9]{4}-[A-Z0-9]{4}", code):
        raise ValueError("Use an exact uppercase Lookup Code for the report link")
    return REPORT_ORIGIN + "/coa/" + code + "/report.pdf"


def draw_report_qr(drawing, code):
    target = report_pdf_url(code)
    x, y, width, height = REPORT_QR_BOUNDS
    widget = QrCodeWidget(target, barLevel="M", barBorder=4, barFillColor=NAVY)
    # Expand the widget into vector rectangles shared by PDF and SVG. The
    # 4-module white quiet zone is part of this measured square.
    qr = widget.draw()
    left, bottom, right, top = widget.getBounds()
    qr.transform = (width / (right - left), 0, 0, height / (top - bottom), x, y)
    drawing.add(Rect(x, y, width, height, fillColor=WHITE, strokeColor=None))
    drawing.add(qr)
    text(drawing, "Scan report", x + width / 2, 27.5, 8, color=MUTED, anchor="middle")


def product(drawing, x, top, image=None):
    width, height = 82, 96
    bottom = top - height
    drawing.add(Rect(x, bottom, width, height, rx=5, ry=5, fillColor=PALE, strokeColor=RULE, strokeWidth=.5))
    if image is not None:
        scale = min((width - 12) / image.width, (height - 12) / image.height)
        w, h = image.width * scale, image.height * scale
        drawing.add(Image(x + (width - w) / 2, bottom + (height - h) / 2, w, h, path=image))
        return
    center = x + width / 2
    drawing.add(Ellipse(center, bottom + 12, 17, 3, fillColor=RULE, strokeColor=None))
    drawing.add(Rect(center - 15, bottom + 15, 30, 53, rx=4, ry=4, fillColor=WHITE, strokeColor=colors.HexColor("#88ABB3"), strokeWidth=.8))
    drawing.add(Rect(center - 13, bottom + 18, 26, 18, fillColor=colors.HexColor("#E6F3F4"), strokeColor=None))
    drawing.add(Rect(center - 9, bottom + 68, 18, 8, fillColor=WHITE, strokeColor=colors.HexColor("#88ABB3"), strokeWidth=.8))
    drawing.add(Rect(center - 13, bottom + 76, 26, 11, rx=2, ry=2, fillColor=NAVY, strokeColor=None))
    drawing.add(Rect(center - 13, bottom + 76, 26, 3, fillColor=TEAL, strokeColor=None))
    drawing.add(Rect(center - 11, bottom + 38, 22, 15, fillColor=PALE, strokeColor=RULE, strokeWidth=.4))
    drawing.add(Line(center - 10, bottom + 57, center - 10, bottom + 64, strokeColor=colors.HexColor("#DDECEF"), strokeWidth=1.3))


def load_records():
    """Validate the entire public catalog before any artifact can be replaced."""
    records = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    if not isinstance(records, dict) or set(records) != set(STEMS):
        raise ValueError("Public catalog must contain exactly both sample lookup codes")
    sources = json.loads((ROOT / "assets" / "sample-vials-sources.json").read_text(encoding="utf-8"))
    if {item["file"] for item in sources["files"]} != {"sample-vial-product.png"}: raise ValueError("Expected the approved shared product image")
    for source in sources["files"]:
        file = ROOT / "assets" / source["file"]
        if hashlib.sha256(file.read_bytes()).hexdigest().upper() != source["assetSha256"]: raise ValueError("Approved product image changed")
        with PILImage.open(file) as image:
            crop=source["crop"]
            if image.format != "PNG" or len(crop)!=4 or any(type(v) is not int for v in crop) or not (0<=crop[0]<crop[2]<=image.width and 0<=crop[1]<crop[3]<=image.height): raise ValueError("Invalid product photograph/crop")
            if hashlib.sha256(image.crop(crop).convert("RGB").tobytes()).hexdigest().upper()!=source["usedRGBPixelSha256"]: raise ValueError("Product crop does not match provenance")
    register_fonts()
    keys = {"label", "product", "appearance", "client", "reportId", "accession", "lot", "received", "reported", "purity", "identity", "retentionTime", "composition", "screenings", "method", "spectra", "chromatogram", "signoffTitle", "plotSeed"}
    def printable(value):
        if isinstance(value, str):
            if not value or len(value) > 160 or any(not 32 <= ord(c) <= 126 for c in value):
                raise ValueError("Public record text must be nonempty supported ASCII")
        elif isinstance(value, dict):
            for key, item in value.items(): printable(key); printable(item)
        elif isinstance(value, list):
            for item in value: printable(item)
        elif type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError("Public record contains an unsupported value")
    def decimal(value, maximum):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]{2}", value):
            raise ValueError("Result numbers require two decimal places")
        number = Decimal(value)
        if not 0 <= number <= maximum: raise ValueError("Result is out of range")
        return number
    def mean(values, maximum):
        numbers = [decimal(v, maximum) for v in values]
        if ((numbers[0] + numbers[1]) / 2).quantize(Decimal(".01"), rounding=ROUND_HALF_UP) != numbers[2]:
            raise ValueError("Reported summary must equal the rounded replicate mean")
    def fits(value, width, size=8.5, bold=False):
        if pdfmetrics.stringWidth(value, "SampleVeraBold" if bold else "SampleVera", size) > width:
            raise ValueError("Public record text exceeds its fixed layout slot")
    tests = ["Identity (LC-MS)", "Elemental impurities (ICP-MS)", "Endotoxin (LAL)", "Microbial analysis (PCR)", "Fentanyl"]
    for code, record in records.items():
        if not isinstance(record, dict) or set(record) != keys: raise ValueError("Invalid public record shape")
        printable(record)
        if not isinstance(record["purity"], list) or len(record["purity"]) != 3: raise ValueError("Expected three purity results")
        mean(record["purity"], 100)
        expected = EXPECTED[code]
        actual = tuple(record[k] for k in ("label", "reportId", "lot", "received", "reported")) + (record["purity"][2], record["identity"], record["retentionTime"])
        if actual != expected: raise ValueError("Record conflicts with the immutable published sample summary")
        fits(record["product"], 130, 13, True)
        for key in ("appearance", "client", "accession", "lot", "received", "reported"): fits(record[key], 130)
        if not isinstance(record["composition"], list) or len(record["composition"]) != 4: raise ValueError("Expected four composition rows")
        for row in record["composition"]:
            if not isinstance(row, dict) or set(row) != {"analyte", "sample1", "sample2", "summary"}: raise ValueError("Invalid composition row")
            mean([row[k] for k in ("sample1", "sample2", "summary")], 1000)
            fits(row["analyte"], 102, 9)
        if not isinstance(record["screenings"], list) or len(record["screenings"]) != 5: raise ValueError("Expected five screening outcomes")
        for index, row in enumerate(record["screenings"]):
            if not isinstance(row, dict) or set(row) != {"test", "result", "details"} or row["test"] != tests[index]: raise ValueError("Invalid screening record")
            fits(row["result"], 244, 9, True); fits(row["details"], 244)
        if record["screenings"][0]["result"] != record["identity"]: raise ValueError("Identity outcomes disagree")
        fits(record["method"], 244, 9)
        if record["signoffTitle"] != "Chief Chemist": raise ValueError("Unexpected signoff title")
        references = json.loads((ROOT / "analytical-references.json").read_text(encoding="utf-8"))
        if references["protonMassU"] != 1.0072764665789 or references["carbon13SpacingU"] != 1.00335483507:
            raise ValueError("Unrecognized reference constants")
        if [(r["cid"],r["neutralMonoisotopicMass"]) for r in references["analytes"]] != [(73587,340.18590327),(125672,342.22670545),(9941957,1418.70415882),(16132341,4960.4863169)]: raise ValueError("Unrecognized chemical references")
        chemical_names = ["GHK-Cu", "KPV", "BPC-157", "Thymosin Beta-4"]
        if [r["analyte"] for r in record["composition"]] != chemical_names: raise ValueError("Real analyte order required")
        spectra = record["spectra"]
        if not isinstance(spectra, list) or len(spectra) != 4: raise ValueError("Expected four mass spectra")
        for index, spectrum in enumerate(spectra):
            reference = references["analytes"][index]
            if set(spectrum) != {"analyte", "species", "cid", "neutralMass", "ions", "noise", "scan", "status"}: raise ValueError("Invalid spectrum schema")
            if spectrum["analyte"] != chemical_names[index] or spectrum["species"] != reference["species"] or spectrum["cid"] != reference["cid"] or spectrum["neutralMass"] != reference["neutralMonoisotopicMass"] or spectrum["scan"] != [100,1600]: raise ValueError("Spectrum species differs from chemistry references")
            if [ion["charge"] for ion in spectrum["ions"]] != reference["charges"]: raise ValueError("Unexpected charge states")
            for ion in spectrum["ions"]:
                if set(ion) != {"charge", "label", "mz", "ppm", "intensity", "isotopes"}: raise ValueError("Invalid ion schema")
                z=ion["charge"]
                expected_label=f"[M+{z}H]{z}+" if z>1 else "[M+H]+"
                if ion["label"] != expected_label or type(ion["ppm"]) not in (float,int) or abs(ion["ppm"]) > 5: raise ValueError("Invalid ion annotation")
                mz=(spectrum["neutralMass"]/z+references["protonMassU"])*(1+ion["ppm"]/1e6)
                if abs(ion["mz"]-mz)>1e-6 or not 0 < ion["intensity"] <= 100: raise ValueError("Inconsistent ion mass or response")
                if not 3 <= len(ion["isotopes"]) <= 8: raise ValueError("Invalid isotope envelope")
                for n, isotope in enumerate(ion["isotopes"]):
                    if set(isotope)!={"mz","response"} or abs(isotope["mz"]-(ion["mz"]+n*references["carbon13SpacingU"]/z))>1e-6 or not 0 < isotope["response"] <= ion["intensity"]: raise ValueError("Inconsistent isotope spacing/response")
                    envelope=references["isotopeEnvelopes"][str(spectrum["cid"])]
                    if len(ion["isotopes"]) != len(envelope) or abs(isotope["response"]-ion["intensity"]*envelope[n]/100)>.00051: raise ValueError("Isotope response conflicts with natural-abundance reference")
                if spectrum["cid"] == 9941957 and not .70 <= ion["isotopes"][1]["response"]/ion["isotopes"][0]["response"] <= .80: raise ValueError("BPC-157 isotope ratio conflicts with its unlabeled formula")
            for peak in spectrum["noise"]:
                if set(peak)!={"mz","response"} or not 100 <= peak["mz"] <= 1600 or not 0 <= peak["response"] <= 3: raise ValueError("Invalid minor mass peak")
            unresolved=code=="AN-8P6R-3N5Y" and index==3
            if spectrum["status"] != ("Low signal" if unresolved else "Observed") or unresolved and max(i["intensity"] for i in spectrum["ions"])>10: raise ValueError("Spectrum contradicts the identity outcome")
        peaks=record["chromatogram"]
        if not isinstance(peaks,list) or len(peaks)!=7 or type(record["plotSeed"]) is not int: raise ValueError("Expected four target peaks and three impurity peaks")
        for peak in peaks:
            if set(peak)!={"analyte","kind","time","area","width","tail","response"}: raise ValueError("Invalid chromatographic peak")
            if peak["kind"] not in ("target","impurity") or any(type(peak[k]) not in (int,float) or not math.isfinite(peak[k]) for k in ["time","area","width","tail","response"]): raise ValueError("Invalid chromatographic values")
            if not 0 < peak["time"] < 15 or not 0 < peak["area"] < 100 or not .02 <= peak["width"] <= .15 or not 1 <= peak["tail"] <= 3 or not 0 < peak["response"] <= 100: raise ValueError("Chromatographic peak outside axes")
        targets=[p for p in peaks if p["kind"]=="target"]
        if sorted(p["analyte"] for p in targets)!=sorted(chemical_names) or abs(sum(p["area"] for p in targets)-float(record["purity"][2]))>1e-5 or abs(sum(p["area"] for p in peaks)-100)>1e-5: raise ValueError("Fitted peak areas disagree with purity")
        if max(targets,key=lambda p:p["response"])["time"] != float(record["retentionTime"]): raise ValueError("Principal peak differs from published retention time")
        heights=[p["area"]/(p["width"]*(1+p["tail"])) for p in peaks]
        if any(abs(p["response"]-h/max(heights)*100)>1e-5 for p,h in zip(peaks,heights)): raise ValueError("Peak heights must derive from area and width")
    return records


def chart_text(drawing,value,x,y,frame,size=6.5,anchor="start",rotate=False):
    """Small instrument annotations are permitted only within measured chart bounds."""
    if not value or any(not 32 <= ord(c) <= 126 for c in value) or not 6.5 <= size <= 8: raise ValueError("Unsupported chart annotation")
    font="SampleVera"; width=pdfmetrics.stringWidth(value,font,size); ascent,descent=pdfmetrics.getAscentDescent(font,size)
    left=x-(width if anchor=="end" else width/2 if anchor=="middle" else 0)
    box=(x-ascent,y,x-descent,y+width) if rotate else (left,y+descent,left+width,y+ascent)
    fx,fy,fw,fh=frame
    if box[0]<fx-.01 or box[1]<fy-.01 or box[2]>fx+fw+.01 or box[3]>fy+fh+.01: raise ValueError("Chart annotation exceeds its frame: "+value)
    node=String(0 if rotate else x,0 if rotate else y,value,fontName=font,fontSize=size,fillColor=colors.black,textAnchor=anchor)
    if rotate:
        group=Group(node);group.transform=(0,1,-1,0,x,y);drawing.add(group)
    else:drawing.add(node)


def chromatogram(drawing,record):
    frame=(MARGIN,368,265,96); x,y,w,h=frame
    drawing.add(Rect(x,y,w,h,fillColor=WHITE,strokeColor=colors.HexColor("#B8B8B8"),strokeWidth=.35))
    left,bottom,width,height=x+27,y+18,w-35,65
    rule(drawing,left,bottom,width,colors.black,.35)
    drawing.add(Line(left,bottom,left,bottom+height,strokeColor=colors.black,strokeWidth=.35))
    for tick in range(31):
        tx=left+tick/2/15*width
        drawing.add(Line(tx,bottom,tx,bottom-(3 if tick%10==0 else 1.5),strokeColor=colors.black,strokeWidth=.3))
        if tick%10==0:chart_text(drawing,str(tick//2),tx,bottom-10,frame,anchor="middle")
    for tick in range(11):
        ty=bottom+tick/10*height
        drawing.add(Line(left-2,ty,left,ty,strokeColor=colors.black,strokeWidth=.3))
        if tick%5==0:chart_text(drawing,str(tick*10),left-5,ty-2,frame,anchor="end")
    chart_text(drawing,"Rel. UV (%)",x+3,y+h-7,frame)
    chart_text(drawing,"UV trace",x+w-3,y+h-7,frame,anchor="end")
    chart_text(drawing,"min",x+w-3,y+3,frame,anchor="end")
    noise=random.Random(record["plotSeed"]);curve=VectorPath(strokeColor=colors.HexColor("#242424"),strokeWidth=.42,fillColor=None)
    for index in range(1501):
        t=index/100;response=.35+.35*t/15+.08*math.sin(t*3.1)+noise.uniform(-.06,.06)
        for peak in record["chromatogram"]:
            sigma=peak["width"]*(peak["tail"] if t>peak["time"] else 1)
            response+=.985*peak["response"]*math.exp(-.5*((t-peak["time"])/sigma)**2)
        px,py=left+t/15*width,bottom+response/100*height
        (curve.moveTo if index==0 else curve.lineTo)(px,py)
    drawing.add(curve)
    for peak in record["chromatogram"]:
        if peak["kind"]=="target":chart_text(drawing,peak["analyte"],left+peak["time"]/15*width+6,bottom+7,frame,rotate=True)


def spectrum_plot(drawing,spectrum,x,y,width):
    frame=(x,y,width,76)
    drawing.add(Rect(x,y,width,76,fillColor=WHITE,strokeColor=colors.HexColor("#C8C8C8"),strokeWidth=.3))
    left,bottom,plot_width,height=x+13,y+14,width-18,40
    mx=lambda mz:left+(mz-100)/1500*plot_width
    rule(drawing,left,bottom,plot_width,colors.black,.3)
    drawing.add(Line(left,bottom,left,bottom+height,strokeColor=colors.black,strokeWidth=.3))
    for tick in range(100,1601,100):
        tx=mx(tick);drawing.add(Line(tx,bottom,tx,bottom-1.5,strokeColor=colors.black,strokeWidth=.25))
        if tick%500==0:chart_text(drawing,str(tick),tx,bottom-9,frame,anchor="middle")
    chart_text(drawing,"m/z",x+width-2,y+18,frame,anchor="end")
    for peak in spectrum["noise"]:
        drawing.add(Line(mx(peak["mz"]),bottom,mx(peak["mz"]),bottom+peak["response"]/100*height,strokeColor=colors.HexColor("#777777"),strokeWidth=.22))
    for ion in spectrum["ions"]:
        for isotope in ion["isotopes"]:
            drawing.add(Line(mx(isotope["mz"]),bottom,mx(isotope["mz"]),bottom+isotope["response"]/100*height,strokeColor=colors.HexColor("#333333"),strokeWidth=.28))
    primary=spectrum["ions"][0]
    chart_text(drawing,f'{primary["mz"]:.3f}',x+3,y+66,frame)
    chart_text(drawing,primary["label"] if spectrum["status"]=="Observed" else "Low signal",x+3,y+57,frame)
    drawing.add(Line(x+21,y+55,mx(primary["mz"]),bottom+primary["isotopes"][0]["response"]/100*height,strokeColor=colors.HexColor("#777777"),strokeWidth=.25))
    for index,ion in enumerate(spectrum["ions"][1:]):
        lx,ly=(x+4,y+35) if index==0 else (x+52,y+23)
        chart_text(drawing,f'{ion["mz"]:.3f}',lx,ly,frame)
        drawing.add(Line(lx+10,ly-2,mx(ion["mz"]),bottom+ion["isotopes"][0]["response"]/100*height,strokeColor=colors.HexColor("#777777"),strokeWidth=.25))
    # Supplemental isotope detail; the full 100-1600 m/z scan remains underneath.
    ix,iy,iw,ih=x+width-47,y+44,44,23
    drawing.add(Rect(ix,iy,iw,ih,fillColor=WHITE,strokeColor=colors.HexColor("#AAAAAA"),strokeWidth=.25))
    chart_text(drawing,primary["label"],ix+1,y+69,frame)
    cluster=primary["isotopes"];span=cluster[-1]["mz"]-cluster[0]["mz"]
    rule(drawing,ix+3,iy+10,iw-6,colors.black,.25)
    for peak in cluster:
        px=ix+3+(peak["mz"]-cluster[0]["mz"])/span*(iw-6)
        drawing.add(Line(px,iy+10,px,iy+10+peak["response"]/100*(ih-13),strokeColor=colors.black,strokeWidth=.35))
    inset_frame=(ix,iy,iw,ih)
    chart_text(drawing,f'{cluster[0]["mz"]:.1f}',ix+1,iy+2.5,inset_frame)
    chart_text(drawing,f'{cluster[-1]["mz"]:.1f}',ix+iw-1,iy+2.5,inset_frame,anchor="end")
    for tx in (ix+3,ix+iw-3):drawing.add(Line(tx,iy+10,tx,iy+8,strokeColor=colors.black,strokeWidth=.25))


def make_drawing(code, record, product_image=None, contact_config=None):
    report_pdf_url(code)
    contact = load_contact(contact_config)
    register_fonts()
    drawing = Drawing(PAGE_W, PAGE_H)
    drawing.add(Rect(0, 0, PAGE_W, PAGE_H, fillColor=WHITE, strokeColor=None))
    logo = ROOT / "assets" / "assaynova-logo.png"
    with PILImage.open(logo) as image:
        logo_height = 122 * image.height / image.width
    drawing.add(Image(MARGIN, PAGE_H - 25 - logo_height, 122, logo_height, path=str(logo)))
    text(drawing, "Certificate of Analysis", MARGIN + 172, PAGE_H - 47, 18.3, True, NAVY)
    rule(drawing, MARGIN, PAGE_H - 70, PAGE_W - 2 * MARGIN, TEAL, .9)
    top, floor = PAGE_H - 89, 508
    drawing.add(Rect(MARGIN, floor, 154, top - floor, fillColor=PALE, strokeColor=None))
    x = MARGIN + 12
    text(drawing, "SAMPLE INFORMATION", x, top - 18, 9, True, TEAL)
    text(drawing, record["product"], x, top - 45, 13, True, NAVY)
    text(drawing, record["appearance"], x, top - 62, 8.5, color=MUTED)
    fields = [("CLIENT", record["client"]), ("LOT", record["lot"]), ("ACCESSION NO.", record["accession"]), ("LOOKUP CODE", code), ("RECEIVED", record["received"]), ("REPORTED", record["reported"])]
    for index, (label, value) in enumerate(fields):
        y = top - 82 - index * 28
        text(drawing, label, x, y, 8, True, MUTED)
        text(drawing, value, x, y - 12, 8.5)
    profile_x, profile_width = 208, PAGE_W - MARGIN - 208
    draw_reported_results(drawing, record, profile_x, top, profile_width)
    product(drawing, PAGE_W - MARGIN - 82, top, product_image)
    table_top, row_height = top - 132, 20
    fractions = (.40, .20, .20, .20)
    widths = [profile_width * fraction for fraction in fractions]
    edges = [profile_x]
    for width in widths:
        edges.append(edges[-1] + width)
    drawing.add(Rect(profile_x, table_top - row_height, profile_width, row_height, fillColor=PALE, strokeColor=None))
    labels = ("Analyte", "Replicate 1", "Replicate 2", "Mean")
    for index, label in enumerate(labels):
        text(drawing, label, edges[index] + 6 if index == 0 else edges[index + 1] - 6, table_top - 14, 8.2, True, anchor="start" if index == 0 else "end")
    for row in range(4):
        baseline = table_top - row_height * (row + 1) - 14
        text(drawing, record["composition"][row]["analyte"], profile_x + 6, baseline, 9)
        for col in range(1, 4):
            text(drawing, record["composition"][row][("sample1", "sample2", "summary")[col - 1]], edges[col + 1] - 6, baseline, 9, anchor="end")
        rule(drawing, profile_x, table_top - row_height * (row + 2), profile_width)
    if table_top - row_height * 5 < floor:
        raise ValueError("Composition table crosses the upper layout zone")
    figure_width, ledger_x = 265, 315
    title(drawing, "HPLC-UV chromatogram", MARGIN, 480, figure_width)
    chromatogram(drawing, record)
    title(drawing, "Mass confirmation", MARGIN, 339, figure_width)
    pw = (figure_width - 12) / 2
    for index in range(4):
        px = MARGIN + (index % 2) * (pw + 12)
        label_y = 313 - (index // 2) * 118
        text(drawing, record["spectra"][index]["analyte"] + (" / GHK ligand" if index == 0 else ""), px, label_y, 8.5, True, NAVY)
        spectrum_plot(drawing, record["spectra"][index], px, label_y - 92, pw)
    title(drawing, "Screening outcomes", ledger_x, 480, PAGE_W - MARGIN - ledger_x)
    screenings = ("Identity (LC-MS)", "Elemental impurities (ICP-MS)", "Endotoxin (LAL)", "Microbial analysis (PCR)", "Fentanyl")
    for index, label in enumerate(screenings):
        y = 453 - index * 62
        text(drawing, label, ledger_x, y, 9, True, NAVY)
        text(drawing, record["screenings"][index]["result"], ledger_x, y - 18, 9, True)
        text(drawing, record["screenings"][index]["details"], ledger_x, y - 34, 8.5)
        rule(drawing, ledger_x, y - 46, PAGE_W - MARGIN - ledger_x)
    title(drawing, "Method", ledger_x, 141, PAGE_W - MARGIN - ledger_x)
    text(drawing, record["method"], ledger_x, 123, 9, color=MUTED)
    draw_contact(drawing, contact)
    draw_report_qr(drawing, code)
    signature = ROOT / "assets" / "dylan-greene-signature.png"
    with PILImage.open(signature) as image:
        scale = min(150 / image.width, 44 / image.height)
        signature_width, signature_height = image.width * scale, image.height * scale
    drawing.add(Image(MARGIN + (168 - signature_width) / 2, 97 - signature_height,
                      signature_width, signature_height, path=str(signature)))
    text(drawing, record["signoffTitle"], MARGIN + 84, 42, 8.5, color=MUTED, anchor="middle")
    return drawing


def glyph_contours(face, character):
    """Decode only the known Vera simple glyphs; unsupported glyphs fail closed."""
    if not 32 <= ord(character) <= 126:
        raise ValueError("Unsupported non-ASCII glyph")
    glyph = face.charToGlyph[ord(character)]
    start, stop = face.glyphPos[glyph:glyph + 2]
    if start == stop:
        return []
    table, _ = face.get_table_pos("glyf")
    data = face._ttf_data[table + start:table + stop]
    count = struct.unpack_from(">h", data)[0]
    if count < 0:
        raise ValueError("Composite glyphs are not supported by this fixed-font master")
    ends = struct.unpack_from(">" + "H" * count, data, 10)
    pos = 10 + 2 * count
    instruction_length = struct.unpack_from(">H", data, pos)[0]
    pos += 2 + instruction_length
    flags = []
    while len(flags) <= ends[-1]:
        flag = data[pos]; pos += 1
        flags.append(flag)
        if flag & 8:
            repeat = data[pos]; pos += 1
            flags.extend([flag] * repeat)
    coordinates = []
    for short_bit, same_bit in ((2, 16), (4, 32)):
        values, value = [], 0
        for flag in flags:
            if flag & short_bit:
                delta = data[pos]; pos += 1
                value += delta if flag & same_bit else -delta
            elif not flag & same_bit:
                value += struct.unpack_from(">h", data, pos)[0]; pos += 2
            values.append(value)
        coordinates.append(values)
    points = [(coordinates[0][i], coordinates[1][i], bool(flag & 1)) for i, flag in enumerate(flags)]
    contours, begin = [], 0
    for end in ends:
        contours.append(points[begin:end + 1]); begin = end + 1
    return contours


def outline_text(node):
    face = pdfmetrics.getFont(node.fontName).face
    scale = node.fontSize / face.unitsPerEm
    advance = pdfmetrics.stringWidth(node.text, node.fontName, node.fontSize)
    cursor = node.x - (advance if node.textAnchor == "end" else advance / 2 if node.textAnchor == "middle" else 0)
    result = Group()
    for character in node.text:
        path = VectorPath(fillColor=node.fillColor, strokeColor=None)
        for contour in glyph_contours(face, character):
            point = lambda p: (cursor + p[0] * scale, node.y + p[1] * scale)
            if contour[0][2]:
                beginning, sequence = contour[0], contour[1:] + [contour[0]]
            elif contour[-1][2]:
                beginning, sequence = contour[-1], contour[:-1] + [contour[-1]]
            else:
                beginning = ((contour[-1][0] + contour[0][0]) / 2, (contour[-1][1] + contour[0][1]) / 2, True)
                sequence = contour + [beginning]
            current = point(beginning); path.moveTo(*current)
            i = 0
            while i < len(sequence):
                control = sequence[i]
                if control[2]:
                    current = point(control); path.lineTo(*current); i += 1
                else:
                    following = sequence[i + 1]
                    end = following if following[2] else ((control[0] + following[0]) / 2, (control[1] + following[1]) / 2, True)
                    q, destination = point(control), point(end)
                    c1 = (current[0] + (q[0] - current[0]) * 2 / 3, current[1] + (q[1] - current[1]) * 2 / 3)
                    c2 = (destination[0] + (q[0] - destination[0]) * 2 / 3, destination[1] + (q[1] - destination[1]) * 2 / 3)
                    path.curveTo(*c1, *c2, *destination); current = destination
                    i += 2 if following[2] else 1
            path.closePath()
        result.add(path)
        cursor += pdfmetrics.stringWidth(character, node.fontName, node.fontSize)
    return result


def svg_drawing(drawing):
    clone = copy.deepcopy(drawing)
    def convert(group):
        group.contents[:] = [outline_text(node) if isinstance(node, String) else node for node in group.contents]
        for node in group.contents:
            if isinstance(node, Group):
                convert(node)
    convert(clone)
    return clone


def render(drawing, code):
    target = report_pdf_url(code)
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, invariant=1, pageCompression=1)
    pdf.setTitle("Fictional sample COA - " + code)
    pdf.setAuthor("AssayNova")
    pdf.setSubject("Fictional sample data and illustrative plots; not a valid certificate of analysis")
    class TransparentImageRenderer(renderPDF._PDFRenderer):
        # The stock Drawing renderer uses inline images, losing PNG alpha.
        # This preserves the unchanged logo and any optional product image.
        def drawImage(self, image):
            self._canvas.drawImage(ImageReader(image.path), image.x, image.y,
                                   image.width, image.height, mask="auto")
    TransparentImageRenderer().draw(drawing, pdf, 0, 0)
    x, y, width, height = REPORT_QR_BOUNDS
    pdf.linkURL(target, (x, y, x + width, y + height), relative=0, thickness=0)
    pdf.showPage(); pdf.save()
    svg = renderSVG.drawToString(svg_drawing(drawing))
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    ET.register_namespace("xlink", "http://www.w3.org/1999/xlink")
    root = ET.fromstring(svg)
    root.set("width", "210mm")
    root.set("height", "297mm")
    root.set("viewBox", f"0 0 {PAGE_W} {PAGE_H}")
    root.set("role", "img")
    root.set("aria-labelledby", "sample-title sample-description")
    heading = ET.Element("{http://www.w3.org/2000/svg}title", {"id": "sample-title"})
    heading.text = "Fictional sample COA - " + code
    description = ET.Element("{http://www.w3.org/2000/svg}desc", {"id": "sample-description"})
    description.text = "Single-page portrait report with fixed fictional sample data, illustrative chromatogram and mass spectra, and the Dylan Greene handwritten signature at the lower left. Lookup Code " + code + ". An illustrative vial image appears beside the analytical results. Footer QR opens " + target
    metadata = ET.Element("{http://www.w3.org/2000/svg}metadata")
    metadata.text = "Font outlines derived from Bitstream Vera; see bitstream-vera-license.txt."
    root.insert(0, heading); root.insert(1, description)
    root.insert(2, metadata)
    return buffer.getvalue(), ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build(lookup_code, output_dir, product_image=None, contact_config=None):
    code = lookup_code.strip().upper()
    if not re.fullmatch(r"AN-[A-Z0-9]{4}-[A-Z0-9]{4}", code) or code not in STEMS:
        raise ValueError("Use the exact lookup code assigned to public sample A or C")
    output_dir = Path(output_dir)
    if output_dir.exists() and not output_dir.is_dir():
        raise ValueError("Output directory must be a directory")
    records = load_records()
    image_path = product_image or ROOT / "assets" / "sample-vial-product.png"
    image = None
    if image_path:
        with PILImage.open(image_path) as candidate:
            if candidate.format not in ("PNG", "JPEG"):
                raise ValueError("Product image must be PNG or JPEG")
            candidate.load()
            image = candidate.copy()
            if not product_image:
                sources = json.loads((ROOT / "assets" / "sample-vials-sources.json").read_text(encoding="utf-8"))
                source = next(item for item in sources["files"] if item["file"] == image_path.name)
                crop = source["crop"]
                if len(crop) != 4 or any(type(v) is not int for v in crop) or not (0 <= crop[0] < crop[2] <= image.width and 0 <= crop[1] < crop[3] <= image.height): raise ValueError("Invalid product crop")
                image = image.crop(crop)
    drawing = make_drawing(code, records[code], image, contact_config)
    pdf, svg = render(drawing, code)
    module = ("// Generated from templates/coa/sample_reports.json; fixed fictional sample data.\nexport const SAMPLE_REPORT_DATA = " + json.dumps(records, ensure_ascii=True, indent=2) + ";\n").encode("utf-8")
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = []
    try:
        for filename, content in ((STEMS[code] + ".pdf", pdf), (STEMS[code] + ".svg", svg), ("sample-data.js", module)):
            with tempfile.NamedTemporaryFile(dir=output_dir, prefix=".sample-", suffix=".tmp", delete=False) as temporary:
                temporary.write(content)
                staged.append((Path(temporary.name), output_dir / filename))
        for temporary, final in staged:
            os.replace(temporary, final)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)
    return output_dir / (STEMS[code] + ".pdf"), output_dir / (STEMS[code] + ".svg")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lookup-code", required=True, choices=tuple(STEMS))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--product-image", type=Path)
    args = parser.parse_args()
    for output in build(args.lookup_code, args.output_dir, args.product_image):
        print(output)


if __name__ == "__main__":
    main()
