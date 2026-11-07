# Google account sign-in

Google sign-in is an optional account identity method, independent of SMTP.
Password, recovery codes and existing mail actions continue to work when it is
disabled. It does not grant ownership of COA reports or merge accounts by email.

## Configuration and activation

`ASSAYNOVA_GOOGLE_CONFIG_FILE` is the sole configuration variable. With no path,
Google is off without reading client credentials or contacting Google. The
explicit private JSON configuration has exactly the field names `version`,
`enabled`, `publicOrigin` and `clientFile`. Disabled configuration uses version 1,
enabled false and null origin/clientFile. Enabled configuration uses the sole
canonical origin `https://assaynovalabs.com` and an explicit absolute private
Google Web-client JSON file. Its `web` object supplies `client_id` and
`client_secret`; downloaded redirect metadata is validated but is not an
authority for any runtime URL. Installed/native clients are not accepted.

Keep both files outside source, release, public, account, administrator and
report stores. They must be regular nonredirected files, private to the service
account (POSIX directory 0700/file 0600; equivalent restricted Windows ACLs).
Never commit, print, hash in evidence, send to a browser or package these files.
Configuration errors are generic and fail before any store opens. Enabled OAuth
requires the existing sole loopback account authority with the explicit HTTPS
origin; an accountless server or LAN account proxy cannot enable it.

Google Console Web-client redirect URI:
`https://assaynovalabs.com/api/account/oauth/google/callback`.
Public privacy URL: `https://assaynovalabs.com/privacy-policy`.
Use matching app branding, support email and verified domain ownership. Only
`openid email profile` scopes are requested. Such apps are exempt from the
Testing test-user allowlist requirement; Workspace administrators may still
restrict them. External Published apps seeking a displayed name/logo require
Google's brand-verification readiness; adding a policy page does not guarantee
approval or warning-free display. See
https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
and https://developers.google.com/identity/branding-guidelines.

## Identity and security behavior

The identity key is Google provider plus signed opaque subject. An existing
Google mapping signs into that exact account without updating its immutable
email, name, company or verification state. An unknown subject with an unused
email creates a Google-only account and returns eight recovery codes once. A
matching existing email never creates a link: sign in using an existing method,
then explicitly link Google from Security using the current password. Linking
or unlinking rotates the security epoch and sessions. Google-only users must
set a password before unlinking their last sign-in method.

Google-only accounts have `password_enabled=0` and independent random reserved
salt/hash values satisfying historical NOT NULL constraints. The flag disables
password authentication and current-password actions, including when the
reserved hash is replaced by a known real hash. Password setup uses fresh
purpose-bound Google confirmation, not a fictitious current password. Verified
email reset or a saved recovery code can also enable a password without removing
the Google identity. Recovery-code regeneration increments its epoch and clears
both Google reauthentication grant fields on every surviving session, even when
Google is disabled. All epoch changes cancel relevant Google flows and mail
actions in the same transaction.

New-account email is considered verified only for a signed verified Gmail
mailbox or a signed Workspace domain exactly matching the email domain. Other
Google emails use AssayNova's own verification when available. Google scopes do
not provide mailbox, Gmail, Drive or Calendar access. Access, refresh and ID
tokens are not stored; no avatar is fetched.

## Redirect and completion

An explicit button click starts state/nonce/PKCE authorization. The host-only
`an_google_flow_[port]` cookie is a random PKCE verifier, Secure, HttpOnly,
SameSite=Lax, scoped to `/api/account/oauth/google`, maximum 10 minutes. Only
purpose-bound hashes are stored. Customer session/CSRF cookies stay Strict.
Only exact raw GET `/api/account/oauth/google/callback` permits cross-site
navigation/query data; it still requires the canonical Host and loopback peer.
No generic boundary, proxy, CORS or query exception exists.

The callback validates bounded native RS256/JWKS/claims, then stores a short-lived
ready flow without logging in. It redirects only to `/google-signin`, with no
identity, code, state or token in that URL. That same-origin page bootstraps
ordinary CSRF and automatically completes the ready explicit intent once. It
does not ask for another Continue after Google consent. Completion rechecks the
original browser challenge or exact originating session, owner, both security
and recovery epochs, mapping and quota atomically. Replays and owner changes
cannot replace an account. After a successful completion acknowledgement, the
client withholds its user and recovery codes until a fresh same-origin session
GET confirms that returned owner. A cross-tab switch or logout drops the private
result and retains the actual session state. Fresh profile, CSRF and capabilities
are kept rather than overwritten by an earlier POST response. Password setup and
Google unlink apply the same post-acknowledgement owner check. An uncertain
response is session-confirmed before offering a bounded manual retry; it never
automatically repeats a consumed completion. Lost recovery-code output is
replaced only after fresh matching Google confirmation.

Native provider requests use fixed Google HTTPS endpoints, normal TLS and
redirect rejection, 5 seconds per request/12 seconds per exchange, 4 concurrent
exchanges, bounded JSON/JWKS/token sizes and a coalesced bounded key cache. Errors
contain no provider response text or credentials. Shutdown aborts/drains exchanges
before closing account storage.

## Schema and operational handoff

Schema 3 adds `password_enabled`, session provenance/grants, identities and flow
tables. Historical `schema-v2.sql` is an immutable source snapshot. Exact schema
1 applies 1→2→3 within one startup transaction; schema 2 applies 2→3; fresh stores
initialize 3. Foreign keys stay enabled and no user/session table is rebuilt.
Failed DDL rolls back; unknown schema fails closed. Native backup accepts exact
schemas 1, 2 and 3 without migrating the source. Existing rows, request JSON,
mail ciphertext and ownership are preserved. Prior releases reject version 3.

For activation the operator must coordinate a sole-authority stop, consistent
native backup, private configuration/key retention and an explicit cutover.
Never copy a live bare SQLite/WAL or silently downgrade schema 3 after new writes.
Keep the previous release and backup for an explicitly approved data-loss
rollback or fix forward. Source tests use synthetic keys/accounts/providers and
fake SMTP only. They are not a real Google browser acceptance test or proof of
live mail delivery. Real authorized Google sign-in and public HTTPS policy/
callback acceptance are separate operational checks.
