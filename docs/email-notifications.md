# Transactional account email

Submitted acknowledges durable platform storage. Email has a separate lifecycle and is disabled without explicit private configuration. Synthetic tests do not establish live provider acceptance or inbox delivery.

Enabled registration queues verification and displays eight private recovery codes. Verification requires an explicit button at /verify-email and expires after24h. Verified stored mailboxes can request a password reset at /recover-account; links expire after15m. /reset-password requires a new password, revokes sessions/actions and prior codes, shows eight replacements and finishes at sign-in. Merely opening a link does nothing. Saved-code recovery remains available when mail is off, unsupported or inaccessible. Immutable email never assigns reports or catalog ownership.

New v3 testing/contact/report-recovery submissions and explicit v2 resubmissions create stable receipt/support events once. Receipts use only the currently verified stored account mailbox and contain kind/reference/account link without sample details. Support alerts use the fixed configured supports address, with the validated submission snapshot and revision. Claimed form/testing emails are labeled unverified body text, never destinations. Ordinary edits, reads, verification, login, restart and old Submitted rows stay silent. Explicit later admission after a blocked event may capture the current committed revision.

My requests shows receipt/support outcomes outside the strict record: not requested, verification needed, unavailable, unsupported, full queue, queued, retrying, accepted, failed, expired or canceled. **Mail server accepted** means a final SMTP250 was recorded; inbox delivery is not confirmed. Manual Refresh never sends. Retry notifications is owner/CSRF/revision checked and only admits eligible missing/blocked events. Accepted/terminal events do not resend. Mail does not indicate laboratory acceptance, sample receipt, analyst assignment, completed analysis or automatic report recovery.

Optional admin notices are initially disabled. A selected published report has a blank Notification email and explicit confirmation. One event per Lookup Code binds the entered recipient even when blocked; another recipient conflicts. Retry preserves identity after uncertain acknowledgement. Notices contain only the canonical public COA link, without attachment or inferred ownership. No generate hook, history scan, private snapshot or inferred recipient is used. Removal cancels unsent notices; restore does not revive them. Accepted mail cannot be recalled.

## Configuration and encrypted storage

Only accounts/mail-config.mjs reads mail configuration. No ASSAYNOVA_MAIL_CONFIG_FILE path means off with no mail-file read or network. Configuration/password/key paths must be absolute canonical private files outside project/release/account/report/admin-auth directories, without redirected ancestors. Unix directories are0700, files0600 and owned by the service user. On Windows, explicitly restrict owner ACLs and inherited access; Unix mode bits alone do not enforce Windows privacy.

Exact top-level JSON field names: version, enabled, publicOrigin, smtp, outboxKeyFile, reportNoticesEnabled. Exact nested SMTP names: host, port, username, passwordFile, from, supportTo. Version is1. Enabled origin must be canonical HTTPS matching the account authority, and admin origin for notices. SMTP is canonical DNS port587 with verified mandatory STARTTLS; username/From/support destination agree. Password comes from a bounded private file allowing one terminal newline; key is32 random bytes. No working credential values belong in examples, units, command lines, environment values or logs. Explicit disabled configuration has false enabled/reportNoticesEnabled and null publicOrigin/smtp/outboxKeyFile; other shapes fail closed. Duplicate decoded JSON keys are rejected.

Create a persistent key with scripts/mail-key.mjs using its --output option pointing to a new filename in a precreated private directory, such as /var/lib/assaynova-demo/mail/outbox-key. Creation is exclusive0600 and prints no key/hash. Back up that key separately with protected access alongside native database backups. Never regenerate it to restore queued mail. Wrong-key configuration pauses retained ciphertext without attempts or expiry cleanup; tag/AAD tampering fails terminally. Encryption does not promise physical erasure from SQLite/WAL/backups.

AES-256-GCM payloads contain recipient/body/action link; metadata contains only bounded identifiers, hashes and closed statuses. Raw action tokens exist only in memory, outgoing authorized mail and authenticated encrypted payload. Browser fragments clear before async work; no token-info GET, automatic POST, query token, storage, title, toast, clipboard or analytics is used. Reload requires reopening the email.

## Bounds, activation and rollback

One worker runs only in the account authority. Limits are1000 active payloads/32MiB ciphertext/10 per user,120s random leases,6 attempts, persisted30s/2m/10m/30m/2h delays with bounded jitter, and provider cooldown60s–15m. Request/report TTL is24h; auth TTL is token expiry. Rates/tombstones are bounded. Transactions never span SMTP/filesystem work. Native SMTP has10s phase and60s total deadlines. Shutdown drains/aborts transport, retains eligible jobs for restart and closes DB afterward. Lost final acknowledgement can duplicate mail with the same stable Message-ID; exactly-once delivery is not promised.

Schema2 atomically adds nullable verification/submission-marker fields and mail tables without rewriting users or strict legacy JSON. Native backup accepts valid schema1/2 without migration. Root must back up the sole deployed authority, quiesce it, take a final consistent snapshot and retain the prior release. Never copy a lone live SQLite file or start two writers. The local actual account store is outside the deployment procedure.

Root stages the reviewed release, private configuration/password/key outside git/release and a service drop-in containing only the config-file path. Valid HTTPS is required before public links are enabled. Verify synthetic backup/restore/migration/worker restart in separate fixture directories without inspecting real account rows. Keep scoped Nginx query/token/Cookie/Authorization/body exclusions and unrelated services unchanged. Live provider acceptance requires the intended recipient/purpose and remains untested by fake-provider gates or authentication probes.

The historical mail migration introduced schema2. The current schema3 release must not run under schema1/2 code; prefer fix-forward or mail disabled under schema3. Restoring a pre-migration snapshot requires a data-loss decision for intervening writes and matching key/config. Never silently downgrade, overwrite, wipe or repair an unknown database. Mailbox editing, delivery/bounce tracking and marketing remain separate work; optional Google configuration is documented independently.

Public links use supports@assaynovalabs.com through the external mail client; report-master reports@assaynovalabs.com stays unchanged. Optional analytics/marketing consent does not control requested transactional actions. Legacy browser keys and strict v2 bytes remain untouched, with no active local draft reads/writes/deletion/import or upload.

## Optional Google identity interaction

Google configuration is independent of SMTP and outbox encryption. The existing
mail config/transport/queue contracts are unchanged. A new Google account is
mail-verified only for signed verified Gmail or an exactly matching signed
Workspace domain; other addresses use the existing best-effort verification
admission. Linked accounts keep their stored mailbox/verification.

A valid verified-mailbox reset can enable a password on a Google-only account;
code recovery can do the same. Both retain the Google mapping, revoke sessions,
replace recovery codes and invalidate mail/Google actions atomically without
auto-login. Transactional Google sign-in never requires analytics consent.
