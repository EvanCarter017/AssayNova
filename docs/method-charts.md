# Paired analytical method plots

The two large method figures on Our Testing show one synchronized set of three
illustrative runs: KPV, BPC-157 and N-acetyl thymosin beta-4 (43 amino acids).
They are generated instrument-style examples, not issued measurements or report
data. The small hero illustrations and public COA report files are independent.

## Model and reproducibility

`generateMethodSamples(seed)` uses one 32-bit seed to produce immutable run data.
The bootstrap selects a seed once per page load without persistence. Rotation,
manual navigation and responsive redraws reuse those same objects; they never
resample values. No network, cookies, browser storage or clipboard is used.

HPLC covers 0–15 minutes with 901 points. A dominant fitted area of 96.5–99.8%
and 2–6 minor fitted components sum to 100%. Each component is a unit-integral
Gaussian core plus a broader, delayed Gaussian tail; response scaling is shared
across components. Baseline drift and seeded low noise are displayed separately
from integrated component areas. The primary retention time spans 4.2–9.8 minutes.
The y axis is detector response in mAU; the x axis is retention time in minutes.

LC–MS shows a **selected-ion region**, not a full mass scan. Neutral monoisotopic
masses, natural isotope shapes, proton mass and carbon-13 spacing mirror the
public primary references in `templates/coa/analytical-references.json` (PubChem
CIDs 125672, 9941957 and 16132341; NIST constants/isotope abundances). Charge is
2+ for KPV and BPC-157, 5+ for full N-acetyl thymosin beta-4. Ion position is
`neutral mass / charge + proton mass + isotope * carbon13 spacing / charge`,
with a common seeded shift bounded by ±3 ppm. Counts vary per run; natural
envelope ratios remain intact. The displayed monoisotopic m/z is distinct from
the most intense isotope: thymosin beta-4 has its base peak at M+2. These plots
make no copper-complex assignment or pass/fail claim.

## Borderless crossfade presentation

Only the analytical plots are visible: no controls, outer border, mint card,
toolbar or caption row. The short illustrative-data caption remains available to
assistive technology, and SVG titles/descriptions retain scientific context.

Both figures share one 7.5-second timeout. They rotate only while Our Testing
and the document are visible, at least one figure intersects the viewport, and
the user does not prefer reduced motion. Intersection starts unknown and off.
Reduced motion or missing lifecycle observers leaves a static accessible first
plot. Changing the preference back resumes rotation when other gates allow it.
There are no focus/hover interactions or interactive carousel widgets.

Each chart has two persistent layers in the same grid cell. A rotation writes
the next sample only into the incoming layer while retaining the old SVG in the
outgoing layer. Their opacity transitions overlap for 500ms with no translation,
scaling, morphing or completion timer. The layers exchange roles on the next
7.5-second turn. Reduced-motion CSS removes transitions. Automatic changes use
aria-live off, without recreating nodes or moving focus.

Resize redraws both layers with the same current immutable sample and preserves
the active layer. Width follows the actual plot width, keeping numeric labels at
11px. The compact renderer height remains width times 235/520 plus 62.4px, with
a 160px minimum; both layers reserve the same space at every turn. One idempotent
controller owns the timer, observers and media/visibility listeners and releases
them on destroy. Queued old callbacks cannot alter a newly bound controller.
