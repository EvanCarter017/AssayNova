# Customer accounts

Customer accounts are enabled by default on Node24.15+. The local server is the account authority; the existing private-LAN launch pair derives a separate account-only bridge from its fixed admin-proxy configuration. The bridge never opens the account database, forwards administrator cookies or changes the administrator password/session implementation. Public Verify LC and published report links remain public. Customer email starts unverified. Explicit mailbox verification enables transactional receipts and password reset, and never assigns any report or catalog customer.

The account pages are `/register`, `/login`, `/account` `/recover-account`, `/verify-email` and `/reset-password`. Registration/login issue new opaque sessions. Profile edits name/company; email is immutable in this revision. Passwords must contain15–128 Unicode code points and at most512 UTF8 bytes. Exact spaces and Unicode are preserved; malformed Unicode is rejected. Passwords use native asynchronous scrypt (N16384,r8,p5,maxmem64MiB, random16-byte salt,32-byte result). At most2 customer password derivations run concurrently, with no unbounded queue. Administrator hashing remains separate.

## Storage and configuration

The default private directory is `<project>/work/customer-accounts`, outside dist, report storage and administrator credentials. SQLite contains only customer accounts, hashed sessions, retained inert legacy recovery-code hashes, rate counters, owned request documents, mail-action hashes and encrypted transactional outbox payloads. The directory must be absolute, outside public/admin/report directories and free of symlink/reparse ancestors or database-file redirects. There is no directory scan or arbitrary file reader. Corrupt/incompatible databases fail closed and are never erased/reseeded or replaced with memory storage.

Use `--account-store=ABS_DIRECTORY` or `ASSAYNOVA_ACCOUNT_STORE` to move this private directory; `--account-origin=CANONICAL_ORIGIN` or `ASSAYNOVA_ACCOUNT_ORIGIN` declares an authority origin. The application does not load `.env` files. Explicit `--no-accounts` closes all `/api/account` methods with404 and omits the account capability marker/entry. Normal launch needs no account flag. A wildcard listener without bridge configuration needs a deliberately configured private origin; it cannot silently become another authority for the current4318 arrangement.

The existing launch pair remains:

```powershell
node server.mjs --watch --port=4317 --conference-reports --admin --admin-public-origin=http://192.168.0.60:4318
node server.mjs --host=0.0.0.0 --port=4318 --conference-reports --admin-proxy=http://127.0.0.1:4317 --admin-proxy-origin=http://192.168.0.60:4318
```

4317 owns the account DB;4318's new customer bridge is independent of its existing administrator bridge. It accepts only its configured LAN Host and127.0.0.1 Host, checks original peers/Origin/Fetch Metadata, and rewrites only the two customer cookies. It never trusts forwarded identity headers. Authority IP counters aggregate the loopback bridge; persistent identity/global/IP limits remain enforced, with an additional bounded bridge-peer limiter. No second writer is started. This plain HTTP mode is a trusted private-LAN preview. Production account authority requires a configured HTTPS origin, loopback bind and real TLS termination; Secure cookies do not depend on untrusted forwarded headers. The existing conference production guard remains unchanged. No domain deployment is supplied here.

## Sessions, recovery and limits

Customer cookies are `an_customer_<port>` and `an_customer_csrf_<port>`, host-only, HttpOnly, SameSite=Strict, Path=/api/account and Secure for HTTPS/production. The session token is256 random bits; only its hash is stored. Authenticated sessions have a24-hour idle and7-day absolute limit, persisted across restart. Preauth CSRF challenges are browser-cookie-bound, expire after10minutes and are capped at2048. Every mutation also requires exact Host/Origin, allowed Fetch Metadata and X-Account-CSRF. Homepage/public report viewing does not bootstrap account cookies; account/request/contact pages do so lazily.

Logout revokes one session; logout-all increments the security epoch and revokes every session. Password change rechecks the security epoch and live originating session after asynchronous derivation, revokes old sessions and issues a new current cookie. Each account retains at most32 sessions, globally8192. Expired sessions are purged. Persistent auth counters cover identity20, peer200 and global1000 attempts per15-minute window, with Retry-After; a counter table is bounded to4096 entries and expired entries are removed. New anonymous challenge minting has separate persistent peer20/global512 limits per10minutes; valid unexpired challenge reuse is not charged. The bridge additionally limits each peer to100 mutations/new-or-unknown challenge bootstrap requests per15minutes and recognizes only bounded hashes of upstream-issued nonces for reuse. The authority sees a reverse proxy as an aggregate peer; these limits do not claim to identify real downstream IPs through untrusted headers. Registration is capped at10000 accounts. These bounded local defaults are not a substitute for a reviewed Internet abuse policy.

Registration issues no recovery codes and continues to the safe return page only after a fresh session confirms the new owner. With mail enabled, a verified stored mailbox can request an explicit one-use reset link. A successful reset advances both security and recovery epochs, invalidates all sessions and mail/Google actions, and presents sign-in without automatic login. Linked Google sign-in remains available independently of email reset. When mail is unavailable, there is no code fallback or support unlock bypass. The three former code issuance/consumption routes return404. Existing hashed code rows and legacy schema fields remain untouched but unusable; no schema migration or cleanup accompanies this removal. Administrator recovery remains its separate owner process.

## Owned requests

Testing, Contact us and Nova Support require confirmed sign-in and explicit submission through the same account API. New records have {version:3,id,createdAt,kind,status:'Submitted',details}; kind is testing, contact or report-recovery. Submitted acknowledges durable platform receipt only. It does not establish laboratory acceptance, sample receipt, email delivery or report ownership. My requests lists all three kinds with details, editing and confirmed deletion. Reference images remain local previews; only image preference/style enters a request.

Schema2 preserves the existing account_requests JSON bytes. The additive version1→2 migration adds nullable verification/submission-event markers and mail tables atomically; migrated old records receive no notification marker or automatic email. Older strict version-2 account records remain exactly readable and display Saved · Not submitted. Explicit review and PUT can convert one to version 3 while preserving reference, creation time, opaque server ID, kind and expected revision. No historical rewrite is performed. Old browser request/contact/recovery values remain untouched and unenumerated; active forms have no save/restore/clear/import or device destination.

Each document has an opaque server ID, authenticated owner, revision and server timestamps. Display reference/date never establish ownership. Reads, updates and deletes filter both owner and server ID; foreign IDs return 404. Each account can retain 50 requests and 1000 idempotency references; quotas never delete old records. Exact create replay succeeds at quota and cannot create duplicates. Changed payload under the same key returns 409. Updates preserve reference/date/kind and require the expected revision. Session security-version checks remain inside mutation transactions. Legacy unversioned/client owner or role fields are rejected.

Private frontend reads recheck the captured owner before and after GET; writes require owner confirmation and session-bound CSRF. Authentication/profile bodies remain capped at 8 KiB; only exact canonical request create/update routes accept 64 KiB. Strict raw/canonical field limits ensure maximum escaped or Unicode request bodies, including API wrappers, fit that limit. Account responses remain no-store/nosniff/no-referrer with no CORS. No credentials, request bodies or SQL exceptions are logged or put in URLs. SQLite prepared statements, STRICT tables, foreign keys, WAL, synchronous FULL and the 3-second busy bound are unchanged.

## Backup and migration

Use the native SQLite backup API, including while the authority is running:

```powershell
node scripts/account-backup.mjs --store=D:\PrivateData\customer-accounts --output=D:\PrivateBackups\accounts-20261107.sqlite
```

Valid schema1 and2 backups preserve their source version without migration. Protect and retain the matching outbox key separately; wrong-key queues pause rather than discard ciphertext. The output filename must be new; no overwrite or cleanup is performed. The command verifies integrity and schema. A failed partial destination is retained for owner inspection. Protect the backup as private account data. Do not copy a lone live accounts.sqlite file without its WAL. To move servers, make a verified backup, stop the old account authority, restore it as accounts.sqlite in a private directory on the new host, set the absolute account-store path/origin and run Node24.15+ with HTTPS termination. Do not run two authorities against the copied snapshot. Schema version is checked; there is no automatic downgrade or corrupt-data repair. File modes are0600 and directory modes0700 where honored; Windows deployment must maintain appropriate owner ACLs. No credential/report/customer-photo migration occurs through this command.

Tests use synthetic identities, disposable account directories, real SQLite/HTTP and a native backup/restore. Account tests never open the actual administrator or customer store. The old external-photo catalog QA remains an explicit pre-existing optional skip after the independent photo task; accounts do not modify importer/catalog logic.

Transactional verification, reset, notification status, private configuration, key backup, bounded worker and historical schema2 mail activation/rollback are described in [email notifications](email-notifications.md). Current schema3 cutover additionally follows the Google sign-in runbook below; old code cannot reopen a newer schema, and restore is never an implicit downgrade.

## Schema 3 and optional Google identity

Schema 3 preserves existing password salt/hash NOT NULL constraints and adds an
authoritative `password_enabled` flag, identity mappings, short-lived OAuth flows
and session provenance/one-use reauthentication grants. Existing accounts remain
password-enabled. Historical schema 2 is fixed in `accounts/schema-v2.sql`;
1→2→3 is one additive startup transaction with foreign keys on. Native backups
accept exact versions 1–3 without migration.

Google identity is keyed by provider plus subject, never email. Existing email
collisions require password sign-in and explicit linking in Security. No report
ownership is inferred. Every security/recovery epoch change invalidates relevant
Google flows/mail actions and clears both reauthentication fields on every
surviving session, including when Google is off. See [Google sign-in](google-signin.md).
