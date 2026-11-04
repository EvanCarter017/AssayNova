# AssayNova COA output master

This reusable source builds one clean portrait A4 page. The printed page contains
sample information, quantitative results, HPLC, four mass spectra, screening
outcomes, analytical methods and a simple page count. Editorial notes, reference
captions, review labels and provenance footnotes do not appear in the PDF.

This local artifact is a reference-filled output master. Building it does not
issue, sign, publish or independently analyze a laboratory report. Keep the
reference report and its provenance in private bundle documentation. A future
formal issuance workflow requires approved laboratory data and authorized signoff;
this generator implements neither that workflow nor online verification.

Run with Python 3, ReportLab and Pillow:

```powershell
python build_coa.py --data /path/to/report.json --output /path/to/master.pdf
```

The command above remains the default layout: sample-information rail beside
quantitative results, with figures and a screening ledger below. The separate
alternative uses horizontal metadata, shared full-width quantitative and screening
tables, then HPLC on the lower left and four mass spectra on the lower right:

```powershell
python build_coa_alt.py --data /path/to/report.json --output /path/to/alternative.pdf
```

Both commands use the same JSON schema, assets and validation. The alternative
imports the unchanged sibling build_coa.py; keep both scripts together when
moving it. Adding this alternative does not replace or select it as the default.

Private data and analytical figures belong outside this generic source directory.
Image paths resolve relative to the JSON file. The logo and embedded Vera fonts
resolve relative to this script; the whole directory is portable. Include the
unmodified fonts and fonts/bitstream-vera-license.txt. No app or network service
is required.

The JSON structure is:

- source: non-empty issuer, client, accession, lookup_code, received, reported,
  lot. issuer is retained for private provenance and is not printed. Accession and
  report-code fields display existing data without creating links or asserting
  an active verification system.
- product: name and appearance.
- composition: exactly four analyte, sample_1, sample_2, reported rows. Numeric
  entries are two-decimal strings in mg. No totals or averages are computed.
- purity: sample_1, sample_2, reported, two-decimal strings in percent. The
  reported summary is separate from the two sample results.
- screenings: test, outcome, optional details strings. Supply actual analytical
  facts and methods; distinguish sensitivity from measured concentration and
  acceptance thresholds.
- figures.hplc: path and title for the original chromatogram.
- figures.mass: path, title, four panels, each with a label and
  box: [left, top, right, bottom] in original image pixels. Display order is
  top-left, top-right, bottom-left, bottom-right. Crops preserve pixels and aspect.
  For the default sidebar layout, optional max_panel_height_pt accepts a finite int or float greater than 0 and
  at most 100 (booleans and strings are rejected). Omit it to retain the exact
  legacy 100 pt display height. A smaller display, such as 72 pt for a 150-pixel
  panel, reduces enlargement and gives 150 effective pixels per inch. It changes
  only PDF placement/scale; it never resamples, sharpens or reconstructs traces.
- method_notes: actual method statements, printed in the selected layout's Method section.

The default sidebar generator also accepts an optional footer object requiring
only non-empty title and signature strings. The signature path must be relative
to the JSON file. A configured footer places the unchanged signature image with
the 8 pt title immediately underneath; it replaces the page count and bottom
divider. The title is measured before drawing, retains a 24 pt bottom margin and
rejects oversized content. Legacy name and statement fields are optional private
metadata: they are never rendered or measured. The body remains unchanged.

Without a footer object, the existing page-count footer is preserved exactly.
The alternative generator continues to use that legacy footer. A private footer
design asset is not evidence of an actual signing event or authorization; retain
its generation prompt and provenance with the private editable bundle. The
generator does not create digital signatures, certificates or verification links.

Legacy product.label_note and figure caption fields are optional private
metadata. The renderer ignores them entirely; missing or oversized legacy values
cannot introduce printed notes. The renderer does not strip prose prefixes:
prepare approved display wording in the private JSON before building the PDF.

The layout supports four composition rows and four mass panels only. Body text
and the configured footer title are at least 8 pt. Original scientific raster resolution limits plot-label
sharpness; never redraw traces or generate extra analytical detail. Measured zone
guards reject overflow before final output is written, preserving an existing
output on error. The generator never silently shrinks, truncates or adds another
page. After replacing data, validate every result and inspect the rendered page.
For a sharper page preview, render the vector PDF at 300 dpi. Preview resolution
does not add information to the original analytical rasters or change PDF text.

Do not invent methods, numerical limits, overall pass results, signatures,
accreditation, contacts or verification claims. Omit unavailable fields instead
of adding placeholders.

## Public placeholder sample masters

`build_sample_coa.py` is separate from both strict private-data builders above.
It creates a single portrait A4 PDF and matching vector SVG for each public sample:

```powershell
python build_sample_coa.py --lookup-code AN-7K9Q-2M4X --output-dir ../../dist/reports
python build_sample_coa.py --lookup-code AN-8P6R-3N5Y --output-dir ../../dist/reports
```

Only those exact code-to-filename mappings are accepted. Every analytical value,
client/product field, date, plot and signoff is a placeholder. No private JSON,
scientific raster or signature is read. The default product slot contains a
code-native generic vial. Add `--product-image /path/to/image.png` (or a JPEG)
to replace it. The image is validated, fitted proportionally and embedded without
publishing its filesystem path. Rendering is buffered before replacing outputs.

One ReportLab Drawing supplies both formats. PDFs retain embedded Vera text;
SVG text uses self-contained Vera glyph outlines, with no external font fetch or
CSP relaxation. The outlined-font implementation supports printable ASCII/simple
Vera glyphs only and rejects unsupported text. The unchanged logo is embedded;
its alpha channel is preserved. Distribute `bitstream-vera-license.txt` from
`fonts/` with generated reports. The public page shows its fictional sample
disclosure outside the paper. These files are placeholder layouts, not issued
certificates. Rebuild both files after changing the shared geometry.
