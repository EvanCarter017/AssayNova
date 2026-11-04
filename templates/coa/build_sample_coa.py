#!/usr/bin/env python3
"""Build the two public placeholder COA masters; never reads private report data.

Usage: python build_sample_coa.py --lookup-code AN-7K9Q-2M4X --output-dir ../../dist/reports
Optional --product-image accepts a PNG/JPEG to replace the generic vector vial.
"""
from __future__ import annotations

import argparse
import copy
from io import BytesIO
import os
from pathlib import Path
import re
import struct
import tempfile
import xml.etree.ElementTree as ET

from PIL import Image as PILImage
from reportlab.graphics import renderPDF, renderSVG
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


def make_drawing(code, product_image=None):
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
    text(drawing, "[Product name]", x, top - 45, 13, True, NAVY)
    text(drawing, "[Appearance]", x, top - 62, 8.5, color=MUTED)
    fields = [("CLIENT", "[Client name]"), ("LOT", "[Lot number]"), ("ACCESSION NO.", "[Accession no.]"), ("COA LOOKUP CODE", code), ("RECEIVED", "[YYYY-MM-DD]"), ("REPORTED", "[YYYY-MM-DD]")]
    for index, (label, value) in enumerate(fields):
        y = top - 82 - index * 28
        text(drawing, label, x, y, 8, True, MUTED)
        text(drawing, value, x, y - 12, 8.5)
    profile_x, profile_width = 208, PAGE_W - MARGIN - 208
    title(drawing, "Analytical results", profile_x, top - 10, profile_width)
    text(drawing, "Purity / HPLC-UV", profile_x, top - 28, 8.5, color=MUTED)
    metric_width = (profile_width - 96) / 3
    for index, label in enumerate(("Sample 1", "Sample 2", "Reported summary")):
        mx = profile_x + index * metric_width
        text(drawing, label, mx, top - 49, 8, color=MUTED)
        text(drawing, "--.--%", mx, top - 72, 17, True, NAVY)
        rule(drawing, mx, top - 83, metric_width - 10, TEAL, .7)
    product(drawing, PAGE_W - MARGIN - 82, top, product_image)
    title(drawing, "Composition", profile_x, top - 115, profile_width, "Net content (mg)")
    table_top, row_height = top - 132, 20
    fractions = (.325, .183, .183, .309)
    widths = [profile_width * fraction for fraction in fractions]
    edges = [profile_x]
    for width in widths:
        edges.append(edges[-1] + width)
    drawing.add(Rect(profile_x, table_top - row_height, profile_width, row_height, fillColor=PALE, strokeColor=None))
    labels = ("Analyte", "Sample 1", "Sample 2", "Reported summary")
    for index, label in enumerate(labels):
        text(drawing, label, edges[index] + 6 if index == 0 else edges[index + 1] - 6, table_top - 14, 8.2, True, anchor="start" if index == 0 else "end")
    for row in range(4):
        baseline = table_top - row_height * (row + 1) - 14
        text(drawing, f"[Analyte {row + 1}]", profile_x + 6, baseline, 9)
        for col in range(1, 4):
            text(drawing, "--.--", edges[col + 1] - 6, baseline, 9, anchor="end")
        rule(drawing, profile_x, table_top - row_height * (row + 2), profile_width)
    if table_top - row_height * 5 < floor:
        raise ValueError("Composition table crosses the upper layout zone")
    figure_width, ledger_x = 265, 315
    title(drawing, "HPLC-UV chromatogram", MARGIN, 480, figure_width)
    drawing.add(Rect(MARGIN, 368, figure_width, 96, fillColor=colors.HexColor("#FAFCFC"), strokeColor=RULE, strokeWidth=.6))
    text(drawing, "[Chromatogram]", MARGIN + figure_width / 2, 412, 9, color=MUTED, anchor="middle")
    title(drawing, "Mass confirmation", MARGIN, 339, figure_width)
    pw = (figure_width - 12) / 2
    for index in range(4):
        px = MARGIN + (index % 2) * (pw + 12)
        label_y = 313 - (index // 2) * 118
        text(drawing, f"[Analyte {index + 1}]", px, label_y, 8.5, True, NAVY)
        drawing.add(Rect(px, label_y - 92, pw, 76, fillColor=colors.HexColor("#FAFCFC"), strokeColor=RULE, strokeWidth=.6))
        text(drawing, "[Spectrum]", px + pw / 2, label_y - 58, 8.5, color=MUTED, anchor="middle")
    title(drawing, "Screening outcomes", ledger_x, 480, PAGE_W - MARGIN - ledger_x)
    screenings = ("Identity (LC-MS)", "Elemental impurities (ICP-MS)", "Endotoxin (LAL)", "Microbial analysis (PCR)", "Fentanyl")
    for index, label in enumerate(screenings):
        y = 453 - index * 62
        text(drawing, label, ledger_x, y, 9, True, NAVY)
        text(drawing, "[Result]", ledger_x, y - 18, 9, True)
        text(drawing, "[Result details]", ledger_x, y - 34, 8.5)
        rule(drawing, ledger_x, y - 46, PAGE_W - MARGIN - ledger_x)
    title(drawing, "Method", ledger_x, 132, PAGE_W - MARGIN - ledger_x)
    text(drawing, "[Analytical method]", ledger_x, 112, 9, color=MUTED)
    text(drawing, "[Authorized signature]", MARGIN, 60, 10, color=MUTED)
    text(drawing, "[Title]", MARGIN, 42, 8.5, color=MUTED)
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
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4, invariant=1, pageCompression=1)
    pdf.setTitle("Placeholder sample COA - " + code)
    pdf.setAuthor("AssayNova")
    pdf.setSubject("Placeholder sample layout; not a valid certificate of analysis")
    class TransparentImageRenderer(renderPDF._PDFRenderer):
        # The stock Drawing renderer uses inline images, losing PNG alpha.
        # This preserves the unchanged logo and any optional product image.
        def drawImage(self, image):
            self._canvas.drawImage(ImageReader(image.path), image.x, image.y,
                                   image.width, image.height, mask="auto")
    TransparentImageRenderer().draw(drawing, pdf, 0, 0)
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
    heading.text = "Placeholder sample COA - " + code
    description = ET.Element("{http://www.w3.org/2000/svg}desc", {"id": "sample-description"})
    description.text = "Single-page portrait sample report with placeholder fields, results, analytical figures and signoff. COA Lookup Code " + code + ". A product image appears beside the analytical result placeholders."
    metadata = ET.Element("{http://www.w3.org/2000/svg}metadata")
    metadata.text = "Font outlines derived from Bitstream Vera; see bitstream-vera-license.txt."
    root.insert(0, heading); root.insert(1, description)
    root.insert(2, metadata)
    return buffer.getvalue(), ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build(lookup_code, output_dir, product_image=None):
    code = lookup_code.strip().upper()
    if not re.fullmatch(r"AN-[A-Z0-9]{4}-[A-Z0-9]{4}", code) or code not in STEMS:
        raise ValueError("Use the exact lookup code assigned to public sample A or C")
    output_dir = Path(output_dir)
    if output_dir.exists() and not output_dir.is_dir():
        raise ValueError("Output directory must be a directory")
    image = None
    if product_image:
        with PILImage.open(product_image) as candidate:
            if candidate.format not in ("PNG", "JPEG"):
                raise ValueError("Product image must be PNG or JPEG")
            candidate.load()
            image = candidate.copy()
    drawing = make_drawing(code, image)
    pdf, svg = render(drawing, code)
    output_dir.mkdir(parents=True, exist_ok=True)
    staged = []
    try:
        for extension, content in (("pdf", pdf), ("svg", svg)):
            with tempfile.NamedTemporaryFile(dir=output_dir, prefix=".sample-", suffix=".tmp", delete=False) as temporary:
                temporary.write(content)
                staged.append((Path(temporary.name), output_dir / (STEMS[code] + "." + extension)))
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
