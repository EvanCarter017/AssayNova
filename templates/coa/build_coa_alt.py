#!/usr/bin/env python3
"""Build a separate single-page COA alternative with full-width result tables.

Usage: python build_coa_alt.py --data /path/to/report.json --output /path/to/alt.pdf
The sibling build_coa.py remains the unchanged default layout and validation base.
"""
from __future__ import annotations

import argparse
from io import BytesIO
from pathlib import Path

from PIL import Image
import build_coa as base

LayoutError = base.LayoutError


def cell(value, size=8.6, bold=False, align=base.TA_LEFT, leading=10.8):
    return base.para(base.plain(value), size=size, bold=bold, align=align,
                     color=base.INK, leading=leading)


def measured_table(c, rows, widths, top, padding, extra_rules=()):
    table = base.Table(rows, colWidths=widths, hAlign="LEFT")
    table.setStyle(base.TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
        ("BACKGROUND", (0, 0), (-1, 0), base.PALE),
        ("LINEBELOW", (0, 0), (-1, -1), .4, base.RULE),
    ] + list(extra_rules)))
    _, height = table.wrap(sum(widths), base.PAGE_H)
    base.ensure_bottom(top-height, "Alternative table")
    table.drawOn(c, base.MARGIN, top-height)
    return top-height


def sample_header(c, data, top):
    name = base.para(base.plain(data["product"]["name"]), size=13,
                     bold=True, color=base.NAVY, leading=16)
    appearance = base.para(base.plain(data["product"]["appearance"]),
                           size=9, color=base.MUTED, leading=11.5,
                           align=base.TA_RIGHT)
    name_width = 220
    appearance_width = base.WIDTH-name_width-14
    _, name_height = name.wrap(name_width, base.PAGE_H)
    _, appearance_height = appearance.wrap(appearance_width, base.PAGE_H)
    name.drawOn(c, base.MARGIN, top-name_height)
    appearance.drawOn(c, base.MARGIN+name_width+14, top-3-appearance_height)
    y = top-max(name_height, appearance_height+3)-10
    s = data["source"]
    fields = [("CLIENT",s["client"]),("ACCESSION NO.",s["accession"]),("LOT",s["lot"]),
              ("REPORT CODE",s["lookup_code"]),("RECEIVED",s["received"]),("REPORTED",s["reported"])]
    gap = 14
    width = (base.WIDTH-2*gap)/3
    for row in range(2):
        bottoms=[]
        for col in range(3):
            label,value=fields[row*3+col]
            x=base.MARGIN+col*(width+gap)
            bottom=base.put(c,label,x,y,width,size=8,bold=True,color=base.MUTED,leading=9.6)
            bottom=base.put(c,base.plain(value),x,bottom-3,width,size=9,leading=11.4)
            bottoms.append(bottom)
        y=min(bottoms)-7
    return y


def quantitative_table(c, data, top):
    y=base.section(c,base.MARGIN,top,base.WIDTH,"Analytical results")
    rows=[[cell("Analysis / analyte",8.5,True),cell("Sample 1",8.5,True,base.TA_RIGHT),
           cell("Sample 2",8.5,True,base.TA_RIGHT),cell("Reported summary",8.5,True,base.TA_RIGHT)]]
    rows.append([cell("Purity (HPLC-UV)",8.8)] +
                [cell(data["purity"][k]+"%",8.8,False,base.TA_RIGHT,11.4)
                 for k in ["sample_1","sample_2","reported"]])
    rows.append([cell("Net content (mg)",8.3,True),"","",""])
    for row in data["composition"]:
        rows.append([cell(row["analyte"],9,leading=11.5)] +
                    [cell(row[k],9,False,base.TA_RIGHT,11.5)
                     for k in ["sample_1","sample_2","reported"]])
    return measured_table(c,rows,[base.WIDTH*v for v in [.4,.2,.2,.2]],y,3.5,
                          [("SPAN",(0,2),(3,2)),("BACKGROUND",(0,2),(3,2),base.PALE)])


def screening_table(c, data, top):
    y=base.section(c,base.MARGIN,top,base.WIDTH,"Screening outcomes")
    rows=[[cell("Test",8.5,True),cell("Result",8.5,True),cell("Details",8.5,True)]]
    spans=[]
    for i,row in enumerate(data["screenings"],1):
        details=row.get("details",[])
        detail_cell=base.para("<br/>".join(base.plain(s) for s in details),
                              size=8.6,leading=10.8) if details else ""
        rows.append([cell(row["test"],8.5,True,leading=10.6),
                     cell(row["outcome"],8.6,True),detail_cell])
        if not details:
            spans.append(("SPAN",(1,i),(2,i)))
    return measured_table(c,rows,[135,110,base.WIDTH-245],y,3,spans)


def evidence_band(c, data, top):
    left_width,gap=300,14
    right_x=base.MARGIN+left_width+gap
    right_width=base.PAGE_W-base.MARGIN-right_x
    hplc=data["figures"]["hplc"]
    left_y=base.section(c,base.MARGIN,top,left_width,base.plain(hplc["title"]))
    left_y=base.fit_image(c,hplc["resolved_path"],base.MARGIN,left_y,left_width,120)
    left_y=base.section(c,base.MARGIN,left_y-12,left_width,"Method")
    for note in data["method_notes"]:
        left_y=base.put(c,base.plain(note),base.MARGIN,left_y,left_width,
                        size=8.5,color=base.MUTED,leading=11.2)-5
    mass=data["figures"]["mass"]
    y=base.section(c,right_x,top,right_width,base.plain(mass["title"]))
    panel_gap=10
    width=(right_width-panel_gap)/2
    with Image.open(mass["resolved_path"]) as image:
        for row in range(2):
            bottoms=[]
            for col in range(2):
                panel=mass["panels"][row*2+col]
                x=right_x+col*(width+panel_gap)
                label_y=base.put(c,base.plain(panel["label"]),x,y,width,
                                 size=8,bold=True,color=base.NAVY,leading=9.8)
                crop=image.crop(tuple(panel["box"]))
                actual_width=min(width,88*crop.width/crop.height)
                bottom=base.fit_image(c,crop,x+(width-actual_width)/2,
                                      label_y-3,width,88)
                bottoms.append(bottom)
            y=min(bottoms)-8
    base.ensure_bottom(left_y,"Alternative HPLC and method")
    base.ensure_bottom(y,"Alternative mass spectra")


def draw_page(c, data):
    y=base.header(c,"Certificate of Analysis")
    y=sample_header(c,data,y)
    y=quantitative_table(c,data,y)
    y=screening_table(c,data,y-10)
    evidence_band(c,data,y-14)
    base.footer(c)
    c.showPage()


def build(data_path, output):
    data_path,output=Path(data_path).resolve(),Path(output).resolve()
    base.pdfmetrics.registerFont(base.TTFont("Vera",str(base.ROOT/"fonts/Vera.ttf")))
    base.pdfmetrics.registerFont(base.TTFont("VeraBold",str(base.ROOT/"fonts/VeraBd.ttf")))
    base.pdfmetrics.registerFontFamily("Vera",normal="Vera",bold="VeraBold")
    data=base.load_data(data_path)
    buffer=BytesIO()
    c=base.canvas.Canvas(buffer,pagesize=base.A4,invariant=1,pageCompression=1)
    c.setTitle("Certificate of Analysis")
    c.setAuthor("AssayNova")
    c.setSubject("COA output master")
    draw_page(c,data)
    c.save()
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_bytes(buffer.getvalue())


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    build(args.data,args.output)
    print(f"Created alternative single-page COA: {args.output}")


if __name__=="__main__":
    main()
