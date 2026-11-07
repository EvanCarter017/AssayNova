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

## Public specimen reports

`build_sample_coa.py` remains separate from both strict private-data builders.
The authoritative `sample_reports.json` supplies real peptide names and fixed
synthetic sample fields, measurements and instrument-style traces. Lookup codes,
summary results and dates stay aligned with the published sample fixtures.

```powershell
python build_sample_coa.py --lookup-code AN-7K9Q-2M4X --output-dir ../../dist/reports
python build_sample_coa.py --lookup-code AN-8P6R-3N5Y --output-dir ../../dist/reports
```

Both records are validated before any output is replaced. Each command writes its
portrait A4 PDF/SVG pair and the shared `sample-data.js` module containing both
records. The existing fictional/not-valid disclosure stays outside the paper.
These are complete specimen reports, not evidence of an actual analytical run.

`analytical-references.json` documents public PubChem monoisotopic masses and NIST
constants. Ion m/z values use neutral mass/charge plus proton mass, with fixed
small ppm offsets and carbon-13 spacing/charge. The GHK-Cu panel explicitly shows
GHK ligand ions; these do not establish intact copper-complex identity. Full
N-acetyl 43-aa thymosin beta-4 is used, never the TB-500 fragment. Sample C keeps
its unresolved thymosin signal and Partial match outcome. Composition summaries
are rounded replicate means. Fitted HPLC target areas sum to reported purity;
baseline texture is excluded from component integration.

Monochrome vector traces retain a broad mass scan, sparse peak/charge labels and
supplemental isotope detail. Instrument annotations alone may use 6.5-8 pt inside
bounded chart frames; body typography stays at least 8 pt. One ReportLab Drawing
supplies both formats, with the unchanged self-contained Vera glyph encoder.
PDFs retain embedded text; SVGs require no external fonts or network resources.
Distribute the unchanged `bitstream-vera-license.txt` with the reports.

Both reports use the supplied blue-cap vial with the final user-requested
label redesign: KLOW / 80 mg, real blend names and research-use text in a navy
and teal label. The trademark, QUALITY TESTED / COA available sticker, and old
Sterile / Multi-dose badges are removed. The selected built-in imagegen output
is copied unchanged to assets/sample-vial-product.png and embedded in full.
The user confirmed the KLOW 80mg label choice and subsequent complete redesign.
assets/vial-unbranded.png is an archived intermediate brand-only edit, not the
current deliverable. assets/sample-vials-sources.json records the supplied
source hash, edit hashes and final active selection without asserting copyright
ownership or untouched photographic pixels. Prior Thirdman/Pexels JPEGs and
source/license records remain archived unchanged. Optional --product-image
PNG/JPEG replacement remains available.
Images, logo and the original authorized Dylan Greene signature design are
embedded for offline use. No private source report/client data or scientific
trace pixels are read by this public builder; no digital issuance is performed.

## Current specimen and generated-report result presentation

The current `build_sample_coa.py` master and `conference/render_report.py` share
the result-summary and contact helpers. The two prominent results are the stored
reported purity (HPLC-UV area%) and measured content per vial. The latter sums
the stored, displayed per-analyte means with Decimal arithmetic and rounds the
total to two decimal places using ROUND_HALF_UP. For one analyte it is that
analyte's mean. It never uses the product's nominal label dose or multiplies that
dose by purity. The existing per-analyte means and replicate values stay intact.

The short caption, "Two determinations of the same sample", describes Replicate 1
and Replicate 2. Mean labels the already reported mean. These are parallel
determinations of the same submitted sample, not separate vials, bounds or
confidence intervals. Two values alone do not establish method validation.

Homogeneous results display mg/vial, IU/vial or ml/vial. A mixed-unit report has
no aggregate: its main result says "See table" / "Per-analyte results", and the
table identifies each analyte's unit. mg, IU and ml are never added together.
This presentation changes no stored measurements or chemistry data. The legacy
`build_coa.py` and `build_coa_alt.py` schemas and behavior above remain separate.

### Laboratory contact configuration

`lab-contact.json` is read fresh for each build or generated report. Its only
keys are `title`, `email`, `phone` and `addressLines`. The current approved title
is "Contact the laboratory" and the email is reports@assaynova.com. Phone is an
empty string and addressLines is an empty list until the owner supplies them.
Absent phone/address values print no labels or placeholders. Put the future
formatted address into at most two address lines and the supplied telephone
number into phone. Do not invent contact details.

The borderless block is at the lower right; the unchanged signature and Chief
Chemist title stay at the lower left. The title uses 9 pt and contact lines use
8.5 pt. Configuration accepts bounded printable ASCII supported by the embedded
font, a nonempty title and valid email text. Each line must fit the footer width;
unknown keys, non-ASCII text, oversized lines or more than two address lines fail
before any output is replaced. Python build/make_drawing functions accept an
optional `contact_config` dictionary or JSON path for isolated fixture checks.

The current footer includes a vector QR beside the unchanged signature and
laboratory contact block. Its target is exactly
`https://assaynovalabs.com/coa/<LOOKUP-CODE>/report.pdf`, generated from the
strict uppercase Lookup Code by the shared `report_pdf_url` helper. The QR has
standard dark modules, medium error correction and a four-module white quiet
zone; it stays vector in both PDF and SVG. The PDF QR area is also clickable.
SVG remains self-contained and describes the URL without loading remote assets.

The supplied domain need not be deployed for local building or decode checks.
Local servers expose the same exact path: the two built-in master PDFs are
always available, while generated PDFs require the existing report-reader
opt-in and a published record. Future deployment must route this path and retain
the published store. Runtime localhost/LAN origins never change the encoded URL.
Only rebuilt masters and future generated snapshots gain the QR; existing
immutable reports are not rewritten automatically. A later change of the
canonical domain must deliberately update `REPORT_ORIGIN` and revalidate exports.
