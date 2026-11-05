# Private product report studio

This temporary local tool prepares synthetic product-specific report snapshots for the operator. These are randomized examples, not instrument measurements. That provenance stays in this private interface and ignored store. Newly generated customer report pages and paper follow the ordinary COA experience; the two existing static sample reports retain their disclosures.

No dependencies or build step are required. Use the bundled Node 20+ and Python runtime already supplied on this machine. The original 219 PNGs remain read-only at `C:\Users\Administrator\Desktop\COAs_西林瓶图片_按品名剂量`. The studio groups terminal ` (NN)` filename variants into 110 products and prefers each unsuffixed original. Only the selected original image is loaded; no photo gallery is copied into the repository or `dist`.

## Start the closed loop

Run these commands from the checkout containing this implementation, in separate PowerShell sessions. Change the checkout path when reviewing the isolated candidate.

```powershell
Set-Location D:\Projects\assaynova
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.mjs --watch --conference-reports
```

```powershell
Set-Location D:\Projects\assaynova
.\conference\start.ps1 -PublicOrigin 'http://127.0.0.1:4317'
```

Open `http://127.0.0.1:4320` privately. The operator server always binds `127.0.0.1`; its CLI provides no network-host or port override. No operator links, catalog, images, generation API or history are served by the customer server.

For the customer LAN preview, explicitly start a separate server and use the machine's actual LAN IPv4 address as the studio public origin:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.mjs --host=0.0.0.0 --port=4318 --conference-reports
.\conference\start.ps1 -PublicOrigin 'http://YOUR-LAN-IP:4318'
```

Do not start a duplicate studio when one is already running. Deliberately stop/restart the existing project-owned listener before changing its flags. This guide does not authorize killing unrelated listeners or deploying anything. Both the studio and the customer feature flag refuse `NODE_ENV=production`.

## Operator workflow

1. Search by name/dose, select the product, and inspect its original photo and editable 1–4 component recipe. Split blends only on spaced ` + ` so `NAD+` remains intact. KLOW 80mg uses GHK-Cu 50 / BPC-157 10 / TB-500 10 / KPV 10 mg. The GLOW photo confirms GHK-Cu 50 / BPC-157 10 / TB-500 10 mg.
2. Optionally enter a client, lot, received/reported dates and replicate purity overrides. Client/lot accept printable ASCII, maximum 64/40 characters. Dates use real `YYYY-MM-DD` and reported cannot precede received. Purity accepts 99.05–99.95 with two decimals. Recipes preserve `mg`, `ml` and `IU`; there is no IU-to-mg conversion.
3. **Preview only** creates an unpublished private snapshot. Its LC cannot be queried by customers; its customer link and Copy LC action are hidden. **Generate & publish** creates a fresh, independently randomized immutable snapshot and new LC. It does not promote the earlier preview. Generation locks the product/form controls until completion.
4. Review the portrait preview and published LC. Copy the LC or open the customer report. Partners use ordinary Verify COA, exact LC, report page, PDF download. No page refresh is needed after publishing. Direct links, refresh, browser history and copy actions use the same stable snapshot.

The UI reports errors without replacing prior successful results. A report is exposed only after PDF, SVG and public JSON are all complete. Concurrent generation receives a bounded busy response; a child renderer has a 45-second timeout. Invalid/failed jobs publish nothing and preserve earlier reports.

## Store, privacy and contract

The default store is `work/report-studio`, already covered by the repository's `work/` ignore rule. It is outside `dist`. Published snapshots survive both server restarts. Never commit the store or copy bulk photos into Git. `published/LC` contains `report.pdf`, `report.svg`, `bundle.json`, and private `private.json` (seed, operator inputs and explicit synthetic provenance). `previews/LC` is private. Temporary staging is removed after each completed or failed job.

Only one studio process should write a given store. For isolated QA, use `--conference-store=ABSOLUTE_PATH` on the customer server and `-Store ABSOLUTE_PATH` on `conference/start.ps1`, pointing both at the same ignored directory. The store is not an authentication/accounts backend. The operator mutating route requires an in-memory run token, exact Host and Origin, JSON content type and an 8 KiB body bound; no CORS is enabled. A new run token is issued on every restart and never logged.

The opt-in customer server reads exact normalized codes at `GET/HEAD /__reports/AN-XXXX-XXXX` and its own `report.pdf`/`report.svg` children. There are no enumeration or write endpoints. Public DTOs allow only `report`, existing transcript `record`, `label` and same-origin asset URLs. Original source paths, seed, private provenance and run token are excluded. All responses are `no-store` and carry MIME/nosniff/CSP headers. Normal startup makes no imports or requests for this feature and injects no reader marker.

Renderer CLI: bundled Python `-B conference/render_report.py --request ABSJSON --output ABSDIR`. Request shape:

```json
{"lookupCode":"AN-XXXX-XXXX","seed":"crypto hex","product":{"id":"opaque id","name":"product title","imagePath":"private canonical original","components":[{"name":"BPC-157","nominal":10,"unit":"mg"}],"unit":"mg"},"fields":{"client":"","lot":"","received":"2026-11-05","reported":"2026-11-05","purity1":99.50,"purity2":99.60}}
```

The renderer writes only `report.pdf`, `report.svg`, `bundle.json`. Bundle: `{report,record,label}` with the existing report metadata/transcript arrays plus `record.contentUnit` and optional composition-row `unit`. Replicate means and fitted target area come from the same canonical record. Independent cryptographic seeds vary bounded runs around a product-stable retention profile; nominal content and HPLC normalized area are separate quantities. Unsupported chemistry is unassigned representative data, never a verified theoretical mass; TB-500 is not silently equated with full thymosin beta-4. Unperformed safety/elemental screens remain Not assessed.

## Checks and shutdown/removal

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.mjs
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -B tests/conference-renderer.test.py
```

The automated checks use disposable stores and ports; native browser QA still checks desktop/mobile operator and customer flows and downloads. PDF QA verifies portrait A4, one page, text/record agreement and rendered boundaries with Poppler. Existing sample source files/assets are not regenerated.

Stop the studio with Ctrl+C. Stop and restart customer preview **without** `--conference-reports` to disable generated lookup. Data remain preserved in the store. Before any production work, keep this flag off and the studio stopped. If temporary reports are no longer needed, first stop both processes and archive only the exact `work/report-studio` directory (or the explicitly chosen QA store) outside the project. Inspect its absolute path before any later deletion. Do not remove `work` wholesale, browser localStorage, user drafts, source photos, or existing static reports. No destructive cleanup is performed by this feature.
