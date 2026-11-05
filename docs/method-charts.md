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

## Interaction and lifecycle

Both figures share one 7.5-second timeout. Rotation runs only when Our Testing
and the document are visible, at least one figure intersects the viewport, and
the user has requested playback. Intersection starts unknown and therefore off.
Hover temporarily stops rotation. Focus entry pauses until explicit Start
rotation; focus departure never restarts it. A small icon-only Pause/Start button
beside each caption controls the pair without moving focus or recreating its SVG
icons. There is no dashboard, visible run metadata, counter or manual slide navigation.
Automatic updates do not announce slides. Buttons are bound before being enabled.

Reduced motion starts in manual mode, and a change to reduced motion pauses.
Explicit Start rotation can enable instant, static frame changes even with this
preference; there are no transitions or animated paths. If lifecycle observers or
the media query are unavailable, the accessible plot stays static and its playback
control remains hidden and disabled. One idempotent controller owns observers,
listeners and timer, and releases them on destroy.

SVG width follows the actual plot width through ResizeObserver, keeping 11px
numeric labels at their CSS size instead of shrinking a desktop viewBox. Plot
height follows the original compact figure footprint: the measured width times
235/520 plus 62.4px, with a 160px minimum. Figure padding and brief captions keep
their original proportions. Height is invariant across runs at the same width.
Accessible SVG titles/descriptions retain the analyte, numerical context and position.
Carousel behavior follows the [WAI carousel pattern](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/);
all data-generation, rendering and controller code is original to this project.
