# Customer account interface

The shared lazy account client keeps CSRF and session state in memory. Importing modules does not access DOM, storage or network. Exact account routes use same-origin credentials and no-store responses. Password limits, unverified immutable email, profile changes and recovery-code handling are unchanged. Email or company matching never grants report ownership.

## Account request workflow

Testing uses the three-step /submit-sample page. Contact us and Nova Support use their existing validated fields. Each requires a confirmed signed-in session and an explicit Submit request, Submit message or Submit recovery request action. Static or disabled-account views cannot accept submissions. Public testing information, configured contact links and COA lookup remain available.

All three create strict version-3 records through the same owned API. My requests lists Testing, Contact and Report recovery records, their references and status, and provides details, context-appropriate editing and explicit delete confirmation. Submitted means durable receipt by the platform API; it does not imply laboratory acceptance, sample arrival, staff notification, email delivery or a recovered report. Recovery still requires manual identity verification and never searches or attaches reports automatically.

Older account version-2 records display Saved · Not submitted. Review and submit explicitly converts one to version 3 using PUT while preserving its reference, creation time, opaque server ID and expected revision. Reads do not rewrite old records. Legacy browser keys remain untouched: assaynova.prototype.requests.v1, assaynova.contact.enquiry.v1 and assaynova.support.recovery.v1 are never read, saved, restored, cleared or uploaded by active forms. Browser site-data controls may remove them. Old portal actions safely open account management.

A shared in-memory submission intent freezes reference, time, idempotency key and payload before POST. An uncertain create retries that exact tuple before PUT of later edits. Double clicks are blocked; success requires a validated document, payload, owner and revision. Session expiry retains same-owner input and intent; explicit logout or a different account clears private editors. Navigation/close aborts and ignores late acknowledgements. Profiles prefill only pristine blank fields. Images remain local previews; only preference/style is submitted, never bytes, filenames or blob URLs. Object URLs are revoked on replacement, removal, reset, navigation and destruction.

Private reads confirm the captured owner before and after GET. Writes use owner confirmation and session-bound CSRF; acknowledged submissions recheck the owner before release. Private DOM uses data-request-private, escaped text and no personal data in URLs, titles or toasts. Allowed return paths are exactly /account, /submit-sample, /contact and /contact?request=report-recovery. The recovery marker contains no personal data, opens only after session confirmation and is consumed before the modal opens.

Signup and account recovery show eight one-time codes in a private pane. Copy/manual fallback and deliberate acknowledgement remain; leaving clears codes and ignores late clipboard results. Report recovery cannot reset account access. Necessary cookies, consent lifetimes and privacy-controller behavior are unchanged; privacy copy describes retained legacy bytes and explicit account submission.

Tests use disposable synthetic accounts and actual-source controllers. Coverage includes three kinds, owned CRUD, strict payload bounds, escaped/Unicode input, exact retries, revision/owner changes, closed views, legacy preservation, disabled mode, no browser persistence, account security and public COA navigation.
