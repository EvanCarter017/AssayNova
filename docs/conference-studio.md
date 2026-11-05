# AssayNova Admin · Reports

`/admin` is the foundation of the AssayNova management backend. Reports is its first working module: select a product/photo, compose a report, review the portrait preview and open published snapshots. The admin shell remains when generated data are later archived. A password-only server-side gate protects the local admin. Production TLS/access policies, roles, orders, customer management and permanent storage infrastructure remain deferred; there are no usernames, registration or unused management screens.

The current report generator produces synthetic examples, not instrument measurements. That context is visible in the private Reports workspace and private provenance only. Newly generated customer report pages and PDFs keep the ordinary customer COA experience. The two existing static sample reports retain their disclosures.

## Start the integrated local admin

Use the existing bundled Node 20+ and Python runtime. There are no dependencies to install or source files to build. From the checkout containing this implementation:

```powershell
Set-Location D:\Projects\assaynova
.\conference\start.ps1 -PublicOrigin 'http://192.168.0.60:4318'
```

Open `http://127.0.0.1:4317/admin`. On first use, the administrator chooses the password directly in that page; the assistant does not choose or enter the real credential. Later visits require that password. This helper starts the local server with `--watch --port=4317 --conference-reports --admin`; it does not choose another port, kill an existing listener or start 4320. If 4317 is occupied, deliberately stop the verified project-owned local instance first. Before the first handoff from the previous standalone generator, stop its verified 4320 process too: only one admin/generator process may write a store at a time. Do not stop unrelated listeners. Later restarts preserve every existing snapshot.

Equivalent explicit launch:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.mjs --watch --port=4317 --conference-reports --admin --admin-public-origin=http://192.168.0.60:4318
```

The separate LAN customer preview remains read-only:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.mjs --host=0.0.0.0 --port=4318 --conference-reports
```

Use the machine's actual LAN address for the public origin. The admin is reserved under `/admin` on the local server; customer navigation has no admin links. The entire namespace returns 404 unless explicitly enabled. `--admin` requires `--conference-reports`, refuses production and refuses binds other than `127.0.0.1` or `::1`. LAN 4318 never enables it. IPv6 local usage may use `--host=::1`, with the browser address `http://[::1]:4317/admin`. The local password/session gate is not the future production authorization system.

`--admin-images=ABSOLUTE_DIRECTORY` chooses the read-only source folder. The default remains `C:\Users\Administrator\Desktop\COAs_西林瓶图片_按品名剂量`. Its 219 original PNGs become 110 selectable products by grouping terminal ` (NN)` duplicates and preferring the unsuffixed photo. No bulk images are copied into Git or `dist`. `--conference-store=ABSOLUTE_DIRECTORY` selects the existing store for both the public reader and local admin. The helper accepts equivalent `-Images` and `-Store` arguments. Credential storage is separate: default `work/admin-auth/credential.json`, or `--admin-auth-store=ABSOLUTE_DIRECTORY` / helper `-AuthStore`. Never point QA at the real credential directory.

## Reports workflow

1. Use **Create report** to search/select a product, then review its full report preview. Composition uses the selected catalog defaults automatically; there are no manual recipe inputs. Blends split on spaced ` + ` so NAD+ remains intact. KLOW 80mg uses GHK-Cu 50 / BPC-157 10 / TB-500 10 / KPV 10 mg. GLOW 70mg uses GHK-Cu 50 / BPC-157 10 / TB-500 10 mg, confirmed from its photo.
2. Optionally enter client, lot, received/reported dates and replicate purity overrides. Client/lot accept printable ASCII, maximum 64/40 characters. Dates are real `YYYY-MM-DD`, reported on or after received. Purity accepts 99.05–99.95 with at most two decimals. Recipes preserve mg, ml and IU, with no IU-to-mg conversion. Nominal content is separate from HPLC normalized area. Automatic replicate purity shares a per-report baseline; net content varies within ±2%.
3. **Preview only** creates a private unpublished snapshot. Customer lookup cannot find its code and Copy LC/customer-link controls stay hidden. **Generate & publish** generates a new independently randomized immutable snapshot and a fresh LC; it does not promote an earlier preview. Product/form/history controls lock while generating. Errors preserve the prior successful result.
4. Review the published portrait preview, copy its LC, open the normal customer report and download PDF. Partners use ordinary Verify COA. New publication can be queried without refreshing an already open customer page. Direct links, refresh, browser history and copy actions use the stable snapshot.
5. **Published reports** shows stored report history and reopens an existing PDF/preview/customer link. It is a private admin list; there is no customer enumeration endpoint.

## Product names, quote aliases and selected photos

Search accepts a canonical name or substring, an exact quote SKU (such as `TR10`, `BC10`, `SM10`, `G5k`), or an explicitly mapped family (`TR`, `RT`, `SM`, `BC`, `BB`). Case, fullwidth text, spaces and common dash variants are normalized. Plus signs and DAC / No DAC / Acetate identities remain meaningful. Full SKUs are exact: `SM2` cannot select SM20, `TR100` cannot select TR10, and H10 cannot select HGH 24/40 IU. Optional unit suffixes are accepted only when the quoted code's numeric dose and actual product unit agree.

Family TR / RT includes the original 5mg photo variants. The quote has no TR5 or RT5 SKU, so those exact codes return no result. BC includes only single BPC-157 products; BB includes only the existing two-component BPC-157 + TB-500 combinations (BB10 = 5+5, BB20 = 10+10, BB30 = 15+15 mg). KS includes only Kisspeptin-10 5mg; OT only Oxytocin Acetate 2mg. Generic Kisspeptin 10mg and plain Oxytocin 10mg remain searchable by their canonical names and do not inherit those aliases. No generic G family is inferred from the conflicting HCG/HMG prefix.

Controlled search spellings include BPC157, TB500 with its quote description, GHK-CU, AHK-CU, AOD9604, ARA290, LL37, IGF-1LR3, the source typo Cagriliintide, the long KPV name and HGH191AA(Somatropin). These search equivalents do not rename report chemistry. KLOW80, GLOW70, TI and CP10 map only to their reviewed existing compositions. Numeric/standalone codes such as 375, PMF, HN, PEG and 5AD use explicit entries rather than loose digit matching.

The price-free curated map covers **107 of 202 quote rows / exact SKUs**, targeting **106 of the 110 original-photo products**. Family/name metadata cover 108 products, including the two unquoted 5mg variants. The remaining two products retain canonical-name search. Of the **95 excluded quote rows**, 42 have no exact dose/photo and 43 have no matching canonical product/photo. The remaining 10 are deliberately excluded: BBG70 (two-component description contradicts GLOW), KS10 (unconfirmed Kisspeptin-10 identity), two H15 rows (duplicate/unavailable 15 IU), MT-2 (name says Melanotan I), CS5 / TR20-RT40 / RET60 (unsupported blends), CS10 (contradictory 2.5+2.5 versus total 10mg and no matching photo), and the backtick SKU. Missing doses never select the nearest available product.

Only canonical names, SKU/family/search aliases and source-row references are maintained in the server-side `conference/product-aliases.json`; no prices, workbook paths, full workbook or runtime spreadsheet parser are included. The browser receives additive private alias metadata and the allowlisted `/admin/product-search.mjs` module. The alias JSON itself has no HTTP route.

The canonical selected product appears in a compact summary below search results. A unique match can select itself; multiple matches preserve an already valid selection or prompt for a choice. Changing selection updates the canonical product and its automatic defaults; no results clear selection and disable generation. There is no separate selected-product image preview. The right panel shows the full COA after Preview or Generate, including its original product photo. That separately labelled last generated report remains immutable when product search changes; searching does not automatically generate reports.

## Routes, storage and security

All admin shell assets, session/history/generation APIs, source-photo URLs and private preview/download URLs live under `/admin/`. Legacy global `/api/session`, `/api/history`, `/api/generate`, `/images` and `/bundles` do not open them. Both integrated hosting and the optional compatibility host share one `conference/admin.mjs` handler and the same existing catalog/store implementation.

The compatibility host remains available for isolated tests or an intentional separate local session: `node conference/studio.mjs`, open `http://127.0.0.1:4320/admin` (root redirects there). It is not part of the normal startup workflow and must not run alongside integrated admin against the same store. Its CLI image/store/public-origin options are unchanged; its HTTP routes use the canonical `/admin` namespace.

The handler checks loopback peers and exact Host/Origin before authentication. Only the password page and its minimal login assets are available before unlock; operator scripts/styles, search module, catalog/session/history/generation APIs, original photos and private previews/downloads return 401 without a valid server-side session. A per-run ASCII-hex token remains required for generation and logout, alongside JSON content type, an 8 KiB body bound, no CORS, canonical paths and realpath-contained assets. Both hosts retain 10-second request/header limits; the renderer has its existing 45-second bound. The token is never logged or saved. This is a local password-only management foundation without accounts or production access policies.

The default `work/report-studio` store remains ignored and outside `dist`. No migration or regeneration is performed. Published `AN-9563-6F4E` and every other existing LC keep their same PDF/SVG/JSON bytes. Published folders contain public `bundle.json`, `report.pdf`, `report.svg` plus private `private.json` (seed, synthetic provenance and operator inputs). Previews remain private. A job publishes only after complete outputs; concurrent jobs receive busy status, and failed jobs do not replace earlier reports. Staging cleanup is unchanged.

The public reader is unchanged: `GET/HEAD /__reports/AN-XXXX-XXXX` and its own `report.pdf`/`report.svg` children, enabled only by `--conference-reports`. It exposes exact published snapshots, no listing or writes. DTOs contain only approved report/transcript fields and same-origin public asset URLs. Original photo paths, private provenance, token and seed stay excluded. Admin route prefixes are added to response URLs without modifying stored bundles.

The renderer contract and one-page portrait A4 master are unchanged: bundled Python `-B conference/render_report.py --request ABSJSON --output ABSDIR`, writing `report.pdf`, `report.svg`, `bundle.json`. Unsupported chemistry remains unassigned representative data; no verified theoretical identity is invented, and unperformed screens remain Not assessed.

## Administrator password and sessions

After login, the language selector in Reports switches between English and 中文 immediately. The password page has no language selector; it follows the saved preference or browser-language fallback. It translates only admin controls and messages. Product names, entered values, LC, dates, units and saved COA/PDF/SVG contents stay unchanged. Switching does not reload, refetch, generate a report, change the selection or discard the current preview; it also works during an in-flight operation.

An explicit choice in Reports stores only `en` or `zh-CN` under the browser key `assaynova.admin.locale.v1`. The password page reads that shared preference once without writing it. Without a valid saved value, a Chinese browser language selects Chinese, otherwise English. If browser storage is blocked, Reports still switches in memory; a fresh password page uses the browser-language fallback. No password, session token or form values are stored by the language feature. The exact static `/admin/admin-i18n.mjs` module is allowed before login; other private scripts, APIs, photos and downloads remain protected.

The first password is user-owned and entered only in the local `/admin` page. It must be 10–128 characters and at most 512 UTF-8 bytes; there are no composition rules and its exact text, including spaces, is preserved. No plaintext password is written, logged, placed in a URL or saved in browser storage. The ignored credential file stores only version, random salt and a 32-byte scrypt hash. The fixed native configuration is N=16384, r=8, p=5 with a 64 MiB memory bound; it is not supplied by the credential record. See [Node 20 crypto](https://nodejs.org/docs/latest-v20.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) and [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).

Setup and login require a per-run CSRF challenge and same-origin JSON requests. One shared in-flight password operation bounds hashing across both routes; excess requests receive 429. Five incorrect attempts impose a 60-second cooldown with Retry-After. Only a missing credential file permits setup. Invalid, partial, oversized or unreadable records fail closed with 503; setup never overwrites them. Exclusive file creation protects the first password from concurrent setup, with mode 0600 where the filesystem honors it.

Successful unlock issues a fresh random opaque cookie: HttpOnly, SameSite=Strict, Path=/admin, port-scoped name, and Secure when hosted over HTTPS. The credential itself is not in the cookie. Sessions live only in server memory, with an 8-hour absolute limit and 30-minute idle limit. Valid requests update idle activity. Expired sessions are purged and at most 32 sessions are retained. **Log out** immediately revokes that cookie; a process restart invalidates every old session while preserving the password. The operator redirects expired API requests back to the password page. See [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Report storage and credential storage are independent. Archiving generated reports must not delete `work/admin-auth`, and closing `/admin` does not clear its password. There is no password reset/recovery API. If the local owner must recover a forgotten password or corrupt record, stop the verified admin process first, verify the absolute credential-file path, and archive only that exact `credential.json` outside its auth directory. Restart and let the owner choose the replacement password directly in `/admin`. Do not perform recovery while an admin process is running, do not archive the whole `work` directory, and do not clear report folders or browser drafts. No recovery or cleanup is performed by this change.

## Checks and shutdown

```powershell
$env:ASSAYNOVA_CATALOG_QA='1'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.mjs
Remove-Item Env:\ASSAYNOVA_CATALOG_QA
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -B tests/conference-renderer.test.py
```

Tests use disposable stores and random local ports, including actual integrated Python generation and restart persistence. Native QA checks `/admin`, search, generation, private history, customer lookup/PDF/copy, desktop/mobile layouts and console state. No live report needs regeneration to test the mount.

Stop the local admin with Ctrl+C. Restart local 4317 without `--admin` to close the admin namespace; retain `--conference-reports` if customer lookup should continue. Stopping the admin does not remove published reports. To disable generated customer lookup too, deliberately restart the relevant customer server without `--conference-reports`.

If generated data are no longer needed, first stop the one writer and archive only the verified exact report-store directory. Clearing that data does not remove `/admin` or future management modules. Inspect the resolved absolute store path before any later deletion. Never remove `work` wholesale, browser drafts/localStorage, original product photos, static samples or future real data. No destructive cleanup is performed by this change.
