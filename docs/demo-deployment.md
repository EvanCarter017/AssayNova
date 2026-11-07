# HTTPS demo deployment

This is an explicitly authorized demo environment at https://assaynovalabs.com, with www redirected to the apex. Production conference/admin prohibitions remain unchanged. No development endpoints, source annotations or watchers run in `NODE_ENV=demo`, even if `--watch` is accidentally supplied.

The deployment adds one `assaynova-demo` service and Nginx site. Existing VialCove applications, listeners, certificates and configuration must remain intact. Public Node listeners, an insecure authenticated HTTP site and self-signed public TLS are not supported.

## Runtime and private storage

The service runs as `assaynova-demo`, with a locked system account and private umask. Code is root-owned and read-only under `/srv/assaynova-demo/releases/<reviewed-commit>`; `/srv/assaynova-demo/current` selects the release. Node 24.22.1 and the renderer venv live under `/opt/assaynova-demo`. Python uses Pillow 13.0.0 and ReportLab 4.4.9; bundled COA fonts, assets and master source are required. There is no npm dependency or build step.

Private directories under `/var/lib/assaynova-demo` are `accounts`, `reports`, `admin-auth`, `seed-images` and `backups`. Directories are 0700 and data files 0600. The service can write only its data root and its private temporary directory. The root-owned Node/venv files are readable and executable by the service user. Node binds `127.0.0.1:4330`; Nginx supplies the canonical public Host and preserves the caller's Origin. The application still checks loopback peer, exact Host/Origin, Fetch Metadata, CSRF and ownership. The app-specific Nginx access format excludes query strings, cookies, credentials, request bodies and referrers. Request-context error logging is disabled for this site; use sanitized service status and acceptance checks for diagnostics. HTTPS admin/account cookies are Secure.

Accounts and generated reports start empty. Fixed fictional public sample reports ship as existing source assets. No historical generated report, customer account, session, pending import job or receipt is migrated.

## Catalog-only export

Run the reviewed exporter only after the separately approved actual-data export gate. All five arguments are required, with explicit absolute paths and a new output directory whose parent already exists:

```powershell
node scripts/export-demo-catalog.mjs --source-store=D:/Projects/assaynova/work/report-studio --image-root=C:/Users/Administrator/Desktop/COAs_西林瓶图片_按品名剂量 --target-store=/var/lib/assaynova-demo/reports --target-images=/var/lib/assaynova-demo/seed-images --output=D:/ApprovedNewOutput
```

The exporter reads only `customers/profiles.json`, current referenced revision manifests and declared pictures. Catalog revisions include their complete current records and every declared image, including blocked entries and unused image-pool assets. Legacy image/alias revisions and selected directory PNGs remain supported. IDs, revisions, rows, image bytes and aliases are preserved. Only exported profile directory pointers change to Linux paths. No source data is written. Symlink/reparse paths, traversal, unapproved directory references, missing assets, bad hashes and overwrite attempts fail closed. Partial outputs remain for inspection and do not receive a completed manifest.

The output contains `store/`, optional `images/` and `catalog-manifest.json` with relative file paths, byte counts, SHA256 hashes and summary counts. It excludes credentials, accounts, report snapshots, import staging and receipts. Do not recursively copy `work/` or the report store. Do not construct the source catalog writer for an export.

## Release preparation and installation

This document describes the workflow; source approval alone does not execute remote installation. Review and hash-pin the packaging helpers and artifacts before the remote execution gate. Use SSH/SCP with the supplied key only as an `-i` argument and the pinned known-hosts file with strict host checking. Never read, print, hash or archive the key.

Package only reviewed `server.mjs`, **`report-pdf.mjs`**, `package.json`, `dist/`, `accounts/`, `conference/`, `templates/coa/`, `scripts/` and `deploy/demo/` runtime files. Exclude `.git`, `work`, `plans`, development tools, tests, docs, environment files, credentials and backups. Include `release-manifest.json` with the exact reviewed commit and `files:[{path,bytes,sha256}]`. Check local import closure and actually boot the staged package using disposable synthetic stores before transfer. Syntax checks alone cannot detect an omitted runtime import.

Prepare one new staging directory `/var/tmp/assaynova-demo-<safe-id>` containing verified `release/`, `catalog/` and the separately approved opaque `credential.json`. Transfer only the exact existing administrator credential file via SCP, without inspecting or hashing it, and never include it in either manifest or archive. No sessions migrate. The administrator password stays unchanged. Credential presence is required before service activation; its configured state is checked through the normal runtime login page without password entry.

Run the reviewed installer as root:

```sh
bash /var/tmp/assaynova-demo-TASK/release/deploy/demo/install.sh prepare /var/tmp/assaynova-demo-TASK REVIEWED_40_CHARACTER_COMMIT
```

The prepare phase refuses unknown existing application paths, service accounts or occupied port 4330. It validates both manifests and file inventories, installs private data and the credential, checks the official Node archive against the official HTTPS SHASUMS file, creates the venv and installs only the pinned renderer requirements. Only `python3-venv` may be installed through apt when needed; no full upgrade or global pip installation occurs. Failed installation paths remain for inspection; do not retry around a guard or delete unrelated paths.

Prepare installs a new HTTP vhost for the two exact names. Only the dedicated ACME webroot is served; application routes return 503. Nginx configuration is tested before graceful reload. HTTPS login is not exposed during DNS or certificate setup.

## DNS and TLS gate

The owner configures `A @ 54.144.250.46` and `CNAME www assaynovalabs.com`, with TTL 300/default and DNS-only routing initially. Remove conflicting records, particularly an unrelated AAAA record. After public DNS resolves both names to the reviewed server, run:

```sh
sudo bash /srv/assaynova-demo/current/deploy/demo/install.sh enable-https
```

The installer uses existing Certbot with the dedicated webroot and only the apex/www names. No Nginx-wide Certbot rewrite is used. Certificate validation must pass before the HTTPS configuration is installed. HTTP and www then redirect to the apex; ACME remains reachable. The prior own site configuration is backed up. A renewal hook reloads Nginx only for this certificate lineage after `nginx -t`. DNS/TLS pending is reported as incomplete, never replaced with insecure public authentication.

## Acceptance and rollback

After deployment, verify normal certificate-validated HTTPS for all SPA paths, public COA lookup and fixed sample PDFs. Check admin login only, private 401s, foreign Host/Origin rejection, Secure cookies, `/__dev` 404s and absence of annotations. Check port 4330 remains loopback-only, the service is active after restart, and all unrelated sites remain unchanged.

Use a separate temporary loopback port 4331 and synthetic private account/auth/report/image directories for actual Linux renderer preview, publish, SVG/PDF and canonical PDF-route checks, plus account request CRUD/owner isolation. Preserve the bundled COA master and QR origin. Never enter the real administrator password or use real customer data for these checks. Stop the owned temporary service afterward. Root owns final desktop/mobile browser checks and records actual outcomes.

Rollback affects only this installation: stop/disable `assaynova-demo.service`, restore its backed-up Nginx site and validate before reload, or remove only its reviewed site symlink to close its routes. Keep all private data and immutable releases for inspection. A later release rollback can repoint the app-owned `current` link to a reviewed release while the service is stopped. Never remove another site's configuration, certificate, database or service, and never delete local source catalogs or credentials.
