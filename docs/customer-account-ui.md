# Customer account interface

The shared lazy account client keeps CSRF and session state in memory. Importing modules does not access DOM, storage or network. Exact account routes use same-origin credentials and no-store responses. Password limits, immutable email and profile changes remain; recovery-code controls and client methods are removed. Verification truth is a strict boolean; mail capability is separately bounded and defaults off for older fixtures. Email or company matching never grants report ownership.

## Account request workflow

Testing uses the three-step /submit-sample page. Contact us and Nova Support use their existing validated fields. Each requires a confirmed signed-in session and an explicit Submit request, Submit message or Submit recovery request action. Static or disabled-account views cannot accept submissions. Public testing information, configured contact links and COA lookup remain available.

All three create strict version-3 records through the same owned API. My requests lists Testing, Contact and Report recovery records, their references and status, and provides details, context-appropriate editing and explicit delete confirmation. Submitted means durable receipt by the platform API; it does not imply laboratory acceptance, sample arrival, staff notification, email delivery or a recovered report. Recovery still requires manual identity verification and never searches or attaches reports automatically.

Older account version-2 records display Saved · Not submitted. Review and submit explicitly converts one to version 3 using PUT while preserving its reference, creation time, opaque server ID and expected revision. Reads do not rewrite old records. Legacy browser keys remain untouched: assaynova.prototype.requests.v1, assaynova.contact.enquiry.v1 and assaynova.support.recovery.v1 are never read, saved, restored, cleared or uploaded by active forms. Browser site-data controls may remove them. Old portal actions safely open account management.

A shared in-memory submission intent freezes reference, time, idempotency key and payload before POST. An uncertain create retries that exact tuple before PUT of later edits. Double clicks are blocked; success requires a validated document, payload, owner and revision. Session expiry retains same-owner input and intent; explicit logout or a different account clears private editors. Navigation/close aborts and ignores late acknowledgements. Profiles prefill only pristine blank fields. Images remain local previews; only preference/style is submitted, never bytes, filenames or blob URLs. Object URLs are revoked on replacement, removal, reset, navigation and destruction.

Private reads confirm the captured owner before and after GET. Writes use owner confirmation and session-bound CSRF; acknowledged submissions recheck the owner before release. Private DOM uses data-request-private, escaped text and no personal data in URLs, titles or toasts. Allowed return paths are exactly /account, /submit-sample, /contact and /contact?request=report-recovery. The recovery marker contains no personal data, opens only after session confirmation and is consumed before the modal opens.

Signup confirms its returned owner with a fresh same-origin session GET before continuing directly to the safe return page. Fresh profile, CSRF and capabilities win over the POST acknowledgement. A neutral static verification notice is captured before navigation and delivered synchronously afterward; it contains no personal data. Owner/logout/leave races suppress navigation and feedback. No code pane, copy action or saved-code acknowledgement remains. Report recovery cannot reset account access. Necessary cookies, consent lifetimes and privacy-controller behavior are unchanged; privacy copy describes retained legacy bytes and explicit account submission.

Tests use disposable synthetic accounts and actual-source controllers. Coverage includes three kinds, owned CRUD, strict payload bounds, escaped/Unicode input, exact retries, revision/owner changes, closed views, legacy preservation, disabled mode, no browser persistence, account security and public COA navigation.

## Mail actions and status

Mail-enabled registration gives queued/unavailable verification feedback after confirmed navigation. Recovery offers email reset when enabled and linked Google sign-in when available. Provider-off recovery displays unavailable/sign-in guidance without an unusable send form, code fallback or support unlock promise. Verify/reset fragments are captured in volatile memory and removed before fetch or rendered links; exact action pages use no-referrer/no-store. GET/HEAD and opening a page never consume a token; explicit confirmation and CSRF-protected POST are required. Malformed links clear too. Reload/leave/owner change clears private action/password state; a deliberate initial-session Retry retains the same-page volatile token. Reset shows success with a sign-in action, without automatic login or replacement codes. Security retains sign-out-all for password and Google-only accounts in an independent sessions panel.

Security shows verified truth and bounded resend cooldown. My requests shows receipt/support status separately from Submitted. Mail server accepted does not confirm inbox delivery. Manual owner-confirmed Refresh never enqueues; bounded Retry notifications only admits eligible blocked/missing events. There is no polling or historical backfill. Strict record equality and submission-intent replay do not include this external metadata.

## Google and public privacy UI

The official local Google PNG button appears on sign-in, registration and account recovery when the
server capability is enabled. It starts on an explicit user action. The fixed
`/google-signin` result page bootstraps CSRF, checks ready metadata and completes
that original intent once automatically, with no second confirmation, and
navigates directly to the safe return page. Private DOM clears on leave or owner change. A successful completion response is withheld until a fresh
same-origin session GET confirms its returned owner, retaining the latest
session profile/CSRF/capabilities. A post-commit cross-tab owner switch or logout
suppresses the result and navigation. Google password setup and unlink use
the same returned-owner confirmation. Network uncertainty is session-confirmed
before manual retry; consumed completions never replay automatically.
Google-only Security offers password setup and fresh purpose-specific Google
confirmation; it does not require a fictitious current password. Linking/unlinking
for password-enabled accounts requires current-password proof.

`/privacy-policy` is public and linked separately from footer cookie settings.
No Google SDK, remote font, import-time provider request or browser persistence
for unfinished OAuth/form details is introduced. Full external navigation can
discard unsaved in-memory input; saved owned requests are unaffected.
