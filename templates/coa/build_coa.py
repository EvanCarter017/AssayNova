#!/usr/bin/env python3
"""Build a clean single-page COA output master from private JSON.

Usage: python build_coa.py --data /path/to/report.json --output /path/to/proof.pdf
No report values or analytical plots are distributed in this generic template.
"""
from __future__ import annotations

import argparse
from io import BytesIO
import json
import math
from pathlib import Path, PureWindowsPath
import re
from xml.sax.saxutils import escape

from PIL import Image
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parent
PAGE_W, PAGE_H = A4
MARGIN = 36
WIDTH = PAGE_W - 2 * MARGIN
NAVY = colors.HexColor("#12314A")
TEAL = colors.HexColor("#087F8C")
INK = colors.HexColor("#20384A")
MUTED = colors.HexColor("#526574")
RULE = colors.HexColor("#D3E0E5")
PALE = colors.HexColor("#EFF6F7")
WHITE = colors.white


class LayoutError(ValueError):
    """Content requires a layout decision, rather than automatic font reduction."""


def plain(value):
    return escape(str(value))


def style(size=9.2, bold=False, color=INK, leading=None, align=TA_LEFT):
    return ParagraphStyle(
        "cell", fontName="VeraBold" if bold else "Vera", fontSize=size,
        leading=leading or size * 1.32, textColor=color, alignment=align,
        spaceBefore=0, spaceAfter=0, splitLongWords=True,
    )


def para(value, size=9.2, bold=False, color=INK, leading=None, align=TA_LEFT):
    return Paragraph(str(value), style(size, bold, color, leading, align))


def put(c, value, x, top, width, **kwargs):
    p = para(value, **kwargs)
    _, h = p.wrap(width, PAGE_H)
    p.drawOn(c, x, top - h)
    return top - h


def image_size(path):
    with Image.open(path) as im:
        return im.size


def required(obj, key, kind=str):
    value = obj.get(key)
    if not isinstance(value, kind) or (kind is str and not value.strip()):
        raise ValueError(f"Required non-empty {kind.__name__}: {key}")
    return value


def load_data(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    source = required(data, "source", dict)
    for key in ("issuer", "client", "accession", "lookup_code", "received", "reported", "lot"):
        required(source, key)
    product = required(data, "product", dict)
    for key in ("name", "appearance"):
        required(product, key)
    rows = required(data, "composition", list)
    if len(rows) != 4:
        raise LayoutError("This single-page master requires four composition rows; adapt layout explicitly.")
    decimal = re.compile(r"^\d+\.\d{2}$")
    for row in rows:
        required(row, "analyte")
        for key in ("sample_1", "sample_2", "reported"):
            if not decimal.fullmatch(required(row, key)):
                raise ValueError(f"{key} must be a string preserving two decimal places")
    purity = required(data, "purity", dict)
    for key in ("sample_1", "sample_2", "reported"):
        if not decimal.fullmatch(required(purity, key)):
            raise ValueError(f"Purity {key} must preserve two decimal places")
    screenings = required(data, "screenings", list)
    if not screenings:
        raise ValueError("At least one screening outcome is required")
    for row in screenings:
        required(row, "test")
        required(row, "outcome")
        for detail in row.get("details", []):
            if not isinstance(detail, str) or not detail.strip():
                raise ValueError("Screening details must be non-empty strings")
    figures = required(data, "figures", dict)
    for key in ("hplc", "mass"):
        fig = required(figures, key, dict)
        required(fig, "title")
        file = (path.parent / required(fig, "path")).resolve()
        if not file.is_file():
            raise FileNotFoundError(file)
        fig["resolved_path"] = file
    if "max_panel_height_pt" in figures["mass"]:
        height = figures["mass"]["max_panel_height_pt"]
        if (type(height) not in (int, float) or not 0 < height <= 100
                or not math.isfinite(height)):
            raise ValueError("Mass max_panel_height_pt must be a finite int/float greater than 0 and at most 100")
    panels = required(figures["mass"], "panels", list)
    if len(panels) != 4:
        raise LayoutError("This master requires four mass panels; adapt layout explicitly.")
    iw, ih = image_size(figures["mass"]["resolved_path"])
    for panel in panels:
        required(panel, "label")
        box = required(panel, "box", list)
        if len(box) != 4 or any(type(n) is not int for n in box):
            raise ValueError("Panel box must contain four integer pixel bounds")
        x0, y0, x1, y1 = box
        if not (0 <= x0 < x1 <= iw and 0 <= y0 < y1 <= ih):
            raise ValueError("Panel crop is outside the supplied original image")
    notes = required(data, "method_notes", list)
    for note in notes:
        if not isinstance(note, str) or not note.strip():
            raise ValueError("Method notes must be non-empty strings")
    if "footer" in data:
        configured = required(data, "footer", dict)
        for key in ("title", "signature"):
            required(configured, key)
        signature = Path(configured["signature"])
        windows_signature = PureWindowsPath(configured["signature"])
        if (signature.is_absolute() or signature.root or signature.drive
                or windows_signature.root or windows_signature.drive):
            raise ValueError("Footer signature path must be relative to the JSON file")
        signature = (path.parent / signature).resolve()
        if not signature.is_file():
            raise FileNotFoundError(signature)
        image_size(signature)
        configured["resolved_signature"] = signature
    return data


def header(c, title):
    logo = ROOT / "assets" / "assaynova-logo.png"
    iw, ih = image_size(logo)
    lw = 122
    c.drawImage(ImageReader(str(logo)), MARGIN, PAGE_H - 25 - lw * ih / iw,
                width=lw, height=lw * ih / iw, mask="auto")
    title_x = MARGIN + 172
    title_width = PAGE_W - MARGIN - title_x
    put(c, title, title_x, PAGE_H - 29, title_width,
        size=18.3, bold=True, color=NAVY, leading=24)
    c.setStrokeColor(TEAL)
    c.setLineWidth(.9)
    c.line(MARGIN, PAGE_H - 70, PAGE_W - MARGIN, PAGE_H - 70)
    return PAGE_H - 89


def footer(c, data=None):
    if data is not None and "footer" in data:
        configured_footer(c, data["footer"])
        return
    c.setStrokeColor(RULE)
    c.setLineWidth(0.6)
    c.line(MARGIN, 55, PAGE_W - MARGIN, 55)
    bottom = put(c, "1 / 1", PAGE_W - MARGIN - 55, 40, 55,
                 size=8.5, color=MUTED, leading=10.5, align=TA_RIGHT)
    if bottom < 24:
        raise LayoutError("Page count exceeds footer capacity.")


def configured_footer(c, configured):
    top, left_width = 97, 168
    signature = configured["resolved_signature"]
    iw, ih = image_size(signature)
    scale = min(150 / iw, 44 / ih)
    signature_width, signature_height = iw * scale, ih * scale
    title = para(plain(configured["title"]), size=8.0, color=MUTED,
                 leading=9.6, align=TA_CENTER)
    _, title_height = title.wrap(left_width, PAGE_H)
    title_top = top - signature_height - 4
    if title_top - title_height < 24:
        raise LayoutError("Configured footer exceeds its space; adapt the footer without changing the body.")
    # The title is measured before drawing the unchanged graphic.
    c.drawImage(ImageReader(str(signature)), MARGIN + (left_width - signature_width) / 2,
                top - signature_height, width=signature_width,
                height=signature_height, mask="auto")
    title.drawOn(c, MARGIN, title_top - title_height)


def ensure_bottom(y, label):
    if y < 70:
        raise LayoutError(f"{label} reaches footer ({y:.1f}pt). Shorten content or adapt layout; text was not shrunk.")


def section(c, x, y, width, title, right=None):
    title_width = width * .62 - 6 if right else width
    bottom = put(c, title, x, y, title_width,
                 size=9.5, bold=True, color=NAVY, leading=11.8)
    if right:
        right_bottom = put(c, right, x + width * .62, y - 1, width * .38,
                           size=8.5, color=MUTED, leading=10.5, align=TA_RIGHT)
        bottom = min(bottom, right_bottom)
    return bottom - 7


def draw_table(c, rows, widths, x, y, header_fill=True, padding=8):
    table = Table(rows, colWidths=widths, hAlign="LEFT")
    rules = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
        ("LINEBELOW", (0, 0), (-1, -1), 0.45, RULE),
    ]
    if header_fill:
        rules.append(("BACKGROUND", (0, 0), (-1, 0), PALE))
    table.setStyle(TableStyle(rules))
    _, h = table.wrap(sum(widths), PAGE_H)
    ensure_bottom(y - h, "Table")
    table.drawOn(c, x, y - h)
    return y - h


def sample_record(c, data, x, y, width, floor):
    c.setFillColor(PALE)
    c.rect(x, floor, width, y - floor, fill=1, stroke=0)
    x += 12
    width -= 24
    y = put(c, "SAMPLE INFORMATION", x, y - 10, width,
            size=8.5, bold=True, color=TEAL, leading=10)
    y = put(c, plain(data["product"]["name"]), x, y - 9, width,
            size=13.5, bold=True, color=NAVY, leading=16.5)
    y = put(c, plain(data["product"]["appearance"]), x, y - 4, width,
            size=8.6, color=MUTED, leading=10.5) - 9
    s = data["source"]
    cells = [
        ("CLIENT", s["client"]), ("LOT", s["lot"]), ("ACCESSION NO.", s["accession"]),
        ("REPORT CODE", s["lookup_code"]), ("RECEIVED", s["received"]), ("REPORTED", s["reported"]),
    ]
    for label, value in cells:
        y = put(c, label, x, y, width, size=8.2, bold=True,
                color=MUTED, leading=10)
        y = put(c, plain(value), x, y - 2, width,
                size=8.8, leading=10.8) - 5
    if y < floor + 6:
        raise LayoutError("Sample record exceeds its rail; adapt layout without overlapping the lower columns.")
    return y


def draw_page(c, data):
    top = header(c, "Certificate of Analysis")
    upper_floor, lower_top = 508, 490
    rail_width, gap = 154, 18
    profile_width = WIDTH - rail_width - gap
    profile_x = MARGIN + rail_width + gap
    sample_record(c, data, MARGIN, top, rail_width, upper_floor)
    y = section(c, profile_x, top, profile_width, "Analytical results", "Purity / HPLC-UV")
    metric_width = profile_width / 3
    metric_labels = (("sample_1", "Sample 1"), ("sample_2", "Sample 2"), ("reported", "Reported summary"))
    label_heights = [para(label, 8.5, color=MUTED, leading=10.8).wrap(metric_width - 12, PAGE_H)[1]
                     for _, label in metric_labels]
    value_top = y - max(label_heights) - 4
    value_height = max(para(plain(data["purity"][key]) + "%", 16, True, leading=19.5)
                       .wrap(metric_width - 12, PAGE_H)[1] for key, _ in metric_labels)
    metric_rule = value_top - value_height - 6
    for i, (key, label) in enumerate(metric_labels):
        x = profile_x + i * metric_width
        put(c, label, x, y, metric_width - 12, size=8.5, color=MUTED, leading=10.8)
        put(c, plain(data["purity"][key]) + "%", x, value_top, metric_width - 12,
            size=16, bold=True, color=NAVY, leading=19.5)
        c.setStrokeColor(TEAL)
        c.setLineWidth(.8)
        c.line(x, metric_rule, x + metric_width - 12, metric_rule)
    y = section(c, profile_x, metric_rule - 13, profile_width, "Composition", "Net content (mg)")
    rows = [[para("Analyte", 8.5, True, leading=10.8), para("Sample 1", 8.5, True, leading=10.8, align=TA_RIGHT),
             para("Sample 2", 8.5, True, leading=10.8, align=TA_RIGHT), para("Reported summary", 8.5, True, leading=10.8, align=TA_RIGHT)]]
    for row in data["composition"]:
        rows.append([para(plain(row["analyte"]), 9.0, leading=11.5)] +
                    [para(plain(row[k]), 9.0, leading=11.5, align=TA_RIGHT) for k in ("sample_1", "sample_2", "reported")])
    y = draw_table(c, rows, [profile_width * v for v in (.325, .183, .183, .309)], profile_x, y, padding=5)
    if y < upper_floor:
        raise LayoutError("Quantitative profile exceeds its column; adapt layout without overlapping the lower columns.")
    figure_width, gap = 265, 14
    ledger_x = MARGIN + figure_width + gap
    figure_bottom = analytical_figures(c, data, MARGIN, lower_top, figure_width)
    ledger_bottom = screening_ledger(c, data, ledger_x, lower_top, PAGE_W - MARGIN - ledger_x)
    ensure_bottom(figure_bottom, "Analytical figures")
    ensure_bottom(ledger_bottom, "Screening ledger and source method")
    if "footer" in data and min(figure_bottom, ledger_bottom) < 101:
        raise LayoutError("Body overlaps the configured footer; preserve the body and adapt the footer.")
    footer(c, data)
    c.showPage()


def analytical_figures(c, data, x, top, width):
    hplc = data["figures"]["hplc"]
    y = section(c, x, top, width, plain(hplc["title"]))
    y = fit_image(c, hplc["resolved_path"], x, y, width, 105)
    mass = data["figures"]["mass"]
    max_panel_height = mass.get("max_panel_height_pt", 100)
    y = section(c, x, y - 9, width, plain(mass["title"]))
    panel_gap = 12
    pw = (width - panel_gap) / 2
    with Image.open(mass["resolved_path"]) as full:
        for row in range(2):
            bottoms = []
            for col in range(2):
                panel = mass["panels"][row * 2 + col]
                panel_x = x + col * (pw + panel_gap)
                label_bottom = put(c, plain(panel["label"]), panel_x, y, pw,
                                   size=8.5, bold=True, color=NAVY, leading=10.6)
                crop = full.crop(tuple(panel["box"]))
                actual_width = min(pw, max_panel_height * crop.width / crop.height)
                bottom = fit_image(c, crop, panel_x + (pw - actual_width) / 2,
                                   label_bottom - 3, pw, max_panel_height)
                bottoms.append(bottom)
            y = min(bottoms) - 8
    return y


def screening_ledger(c, data, x, y, width):
    y = section(c, x, y, width, "Screening outcomes")
    for row in data["screenings"]:
        y = put(c, plain(row["test"]), x, y, width,
                size=8.8, bold=True, color=NAVY, leading=11.4)
        result = f'<font size="8.8"><b>{plain(row["outcome"])}</b></font>'
        if row.get("details"):
            result += "<br/>" + "<br/>".join(plain(d) for d in row["details"])
        y = put(c, result, x, y - 2, width, size=8.5, leading=11.2)
        c.setStrokeColor(RULE)
        c.setLineWidth(.45)
        c.line(x, y - 5, x + width, y - 5)
        y -= 13
    y = section(c, x, y - 3, width, "Method")
    for note in data["method_notes"]:
        y = put(c, plain(note), x, y, width,
                size=8.5, color=MUTED, leading=11.2) - 5
    return y


def fit_image(c, image, x, top, width, max_height):
    iw, ih = image.size if isinstance(image, Image.Image) else image_size(image)
    height = width * ih / iw
    if height > max_height:
        width = max_height * iw / ih
        height = max_height
    c.drawImage(ImageReader(image) if isinstance(image, Image.Image) else ImageReader(str(image)),
                x, top - height, width=width, height=height, mask="auto")
    return top - height


def build(data_path, output):
    pdfmetrics.registerFont(TTFont("Vera", str(ROOT / "fonts" / "Vera.ttf")))
    pdfmetrics.registerFont(TTFont("VeraBold", str(ROOT / "fonts" / "VeraBd.ttf")))
    pdfmetrics.registerFontFamily("Vera", normal="Vera", bold="VeraBold")
    data = load_data(data_path)
    # Buffer output so a validation/layout failure never leaves a partial final PDF.
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4, invariant=1, pageCompression=1)
    c.setTitle("Certificate of Analysis")
    c.setAuthor("AssayNova")
    c.setSubject("COA output master")
    draw_page(c, data)
    c.save()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(buffer.getvalue())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.data.resolve(), args.output.resolve())
    print(f"Created single-page COA output master: {args.output}")


if __name__ == "__main__":
    main()
