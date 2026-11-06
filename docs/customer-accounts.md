# Customer accounts

Customer accounts are enabled by default on Node24.15+. The local server is the account authority; the existing private-LAN launch pair derives a separate account-only bridge from its fixed admin-proxy configuration. The bridge never opens the account database, forwards administrator cookies or changes the administrator password/session implementation. Public Verify LC and published report links remain public. Customer email is **unverified** and does not assign any report or catalog customer to an account.

The account pages are `/register`, `/login`, `/account` and `/recover-account`. Registration/login issue new opaque sessions. Profile edits name/company; email is immutable in this revision. Passwords must contain15–128 Unicode code points and at most512 UTF8 bytes. Exact spaces and Unicode are preserved; malformed Unicode is rejected. Passwords use native asynchronous scrypt (N16384,r8,p5,maxmem64MiB, random16-byte salt,32-byte result). At most2 customer password derivations run concurrently, with no unbounded queue. Administrator hashing remains separate.

## Storage and configuration

The default private directory is `<project>/work/customer-accounts`, outside dist, report storage and administrator credentials. SQLite contains only customer accounts, hashed sessions/recovery codes, rate counters and owned draft documents. The directory must be absolute, outside public/admin/report directories and free of symlink/reparse ancestors or database-file redirects. There is no directory scan or arbitrary file reader. Corrupt/incompatible databases fail closed and are never erased/reseeded or replaced with memory storage.

Use `--account-store=ABS_DIRECTORY` or `ASSAYNOVA_ACCOUNT_STORE` to move this private directory; `--account-origin=CANONICAL_ORIGIN` or `ASSAYNOVA_ACCOUNT_ORIGIN` declares an authority origin. The application does not load `.env` files. Explicit `--no-accounts` closes all `/api/account` methods with404 and omits the account capability marker/entry. Normal launch needs no account flag. A wildcard listener without bridge configuration needs a deliberately configured private origin; it cannot silently become another authority for the current4318 arrangement.

The existing launch pair remains:

```powershell
node server.mjs --watch --port=4317 --conference-reports --admin --admin-public-origin=http://192.168.0.60:4318
node server.mjs --host=0.0.0.0 --port=4318 --conference-reports --admin-proxy=http://127.0.0.1:4317 --admin-proxy-origin=http://192.168.0.60:4318
```

4317 owns the account DB;4318's new customer bridge is independent of its existing administrator bridge. It accepts only its configured LAN Host and127.0.0.1 Host, checks original peers/Origin/Fetch Metadata, and rewrites only the two customer cookies. It never trusts forwarded identity headers. Authority IP counters aggregate the loopback bridge; persistent identity/global/IP limits remain enforced, with an additional bounded bridge-peer limiter. No second writer is started. This plain HTTP mode is a trusted private-LAN preview. Production account authority requires a configured HTTPS origin, loopback bind and real TLS termination; Secure cookies do not depend on untrusted forwarded headers. The existing conference production guard remains unchanged. No domain deployment is supplied here.

## Sessions, recovery and limits

Customer cookies are `an_customer_<port>` and `an_customer_csrf_<port>`, host-only, HttpOnly, SameSite=Strict, Path=/api/account and Secure for HTTPS/production. The session token is256 random bits; only its hash is stored. Authenticated sessions have a24-hour idle and7-day absolute limit, persisted across restart. Preauth CSRF challenges are browser-cookie-bound, expire after10minutes and are capped at2048. Every mutation also requires exact Host/Origin, allowed Fetch Metadata and X-Account-CSRF. Homepage/public report viewing does not bootstrap account cookies; account/request pages do so lazily.

Logout revokes one session; logout-all increments the security epoch and revokes every session. Password change rechecks the security epoch and live originating session after asynchronous derivation, revokes old sessions and issues a new current cookie. Each account retains at most32 sessions, globally8192. Expired sessions are purged. Persistent auth counters cover identity20, peer200 and global1000 attempts per15-minute window, with Retry-After; a counter table is bounded to4096 entries and expired entries are removed. New anonymous challenge minting has separate persistent peer20/global512 limits per10minutes; valid unexpired challenge reuse is not charged. The bridge additionally limits each peer to100 mutations/new-or-unknown challenge bootstrap requests per15minutes and recognizes only bounded hashes of upstream-issued nonces for reuse. The authority sees a reverse proxy as an aggregate peer; these limits do not claim to identify real downstream IPs through untrusted headers. Registration is capped at10000 accounts. These bounded local defaults are not a substitute for a reviewed Internet abuse policy.

Registration displays **8 one-time recovery codes**. Each has128 random bits, formatted for manual copying; only per-user-bound hashes are stored. A code and new password reset that account, atomically invalidate the entire prior code bundle and all sessions, and display8 replacements. Recovery does not log in automatically. Regenerating codes requires the current password and invalidates the prior bundle. Concurrent reuse has one winner. Keep codes somewhere private; they are not emailed or saved to browser storage. Without both password and recovery codes there is no self-service recovery or automatic Support unlock. Administrator recovery remains its separate owner process.

## Owned request drafts

The request page offers Account and This device destinations. Account saving is a durable draft, **not** laboratory submission, payment or mail delivery. Device drafts stay compatible and are not uploaded on login, navigation or privacy changes. An explicit per-record save to account leaves the local original in place. Optional reference images remain local and their bytes/names/blob URLs are not included in server draft records.

Each server document has an opaque server id, owner id, revision and server timestamps. Its strict current version2 `record.id`/`record.createdAt` remain compatibility display payload; they never establish ownership. All reads/updates/deletes filter account id and server document id. Foreign ids return404. Only50 drafts can be stored per account; quota never deletes the oldest. Exact create retries use a per-owner idempotency key plus canonical payload, so a lost success acknowledgement cannot create a duplicate; different content under the same key gives409. A replay succeeds at quota. At most1000 save-reference keys are retained per account. Updates preserve the original display reference/date and require the expected revision; conflict preserves the caller's input. No legacyv1 or client-supplied owner/role fields are accepted by the server.

Authentication/profile bodies are capped at8KiB. Only exact canonical create/update draft routes accept64KiB JSON; admin/import limits are unchanged. All account responses are no-store/nosniff/no-referrer with no CORS. No raw session/password/code, user payload or SQL exception is logged or included in URLs. Codes appear only in the immediate requested success response/UI. SQLite uses prepared statements, STRICT tables, foreign keys, WAL, synchronous FULL and a3-second busy bound; asynchronous derivations never run inside a SQL transaction.

## Backup and migration

Use the native SQLite backup API, including while the authority is running:

```powershell
node scripts/account-backup.mjs --store=D:\PrivateData\customer-accounts --output=D:\PrivateBackups\accounts-20261107.sqlite
```

The output filename must be new; no overwrite or cleanup is performed. The command verifies integrity and schema. A failed partial destination is retained for owner inspection. Protect the backup as private account data. Do not copy a lone live accounts.sqlite file without its WAL. To move servers, make a verified backup, stop the old account authority, restore it as accounts.sqlite in a private directory on the new host, set the absolute account-store path/origin and run Node24.15+ with HTTPS termination. Do not run two authorities against the copied snapshot. Schema version is checked; there is no automatic downgrade or corrupt-data repair. File modes are0600 and directory modes0700 where honored; Windows deployment must maintain appropriate owner ACLs. No credential/report/customer-photo migration occurs through this command.

Tests use synthetic identities, disposable account directories, real SQLite/HTTP and a native backup/restore. Account tests never open the actual administrator or customer store. The old external-photo catalog QA remains an explicit pre-existing optional skip after the independent photo task; accounts do not modify importer/catalog logic.
