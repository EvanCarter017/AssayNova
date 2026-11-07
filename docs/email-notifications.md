# Account requests and email boundaries

Testing, Contact us and Nova Support submit persistent requests to the signed-in account through the existing platform API. My requests supports view, edit and delete. Submitted means that the platform durably stored the request; it does not mean email was sent, laboratory acceptance, sample receipt, analyst assignment, staff notification, analysis completion or automatic report recovery.

No mail provider, SMTP connection, SDK or send API is configured. Account email remains unverified. Password recovery uses eight saved one-time codes rather than email reset links. Public mailto links for hello@assaynova.com and reports@assaynova.com open the user's external mail client; they remain independent from account submission. See [contact configuration](partner-demo-content.md) and [account storage](customer-accounts.md).

## Current request handling

New UI submissions use a strict version-3 envelope with kind testing, contact or report-recovery, status Submitted and normalized validated details. The unchanged SQLite schema-1 JSON column stores all three kinds. Each account owns at most 50 requests, and at most 1000 create intent references. Create retries replay an identical frozen reference, timestamp, idempotency key and payload before applying newer edits with an expected revision. Owner/session/CSRF checks remain mandatory.

Older account version-2 records remain exactly readable as Saved · Not submitted. Explicit review/resubmission can convert one without changing its reference, creation date, server ID or kind. No migration or background rewrite occurs. Existing browser values under assaynova.prototype.requests.v1, assaynova.contact.enquiry.v1 and assaynova.support.recovery.v1 are retained without active reads, writes, deletion, restoration or upload. There is no device destination or import UI. Browser site-data clearing remains available to the owner.

The testing page retains three steps, 1–10 samples and 1–100 units per sample. New request resets in-memory state. Contact and recovery retain their existing text limits and validation. Failures retain same-owner input in memory; logout, account replacement and late asynchronous results cannot reveal previous-owner details. Optional JPEG/PNG/WebP images are local previews up to 5 MiB. Records contain only image preference/style, never image bytes, names or preview URLs. Historical company/batch/amount values remain compatible even where the active form omits them.

Recovery requests use the original testing email, company/project and optional context. They do not query COA lookup or attach a report. Manual identity verification is required before any report can be shared. Public COA lookup and existing report/sample disclosures remain unchanged.

## Future integrations

Any laboratory processing, notifications, delivery provider, payments or shipping integration needs its own explicit lifecycle and truthful outcomes. Keep provider secrets on the server, define bounded retries and handling of uncertain results, and do not describe delivery as successful before the actual provider outcome. Transactional handling must not depend on optional analytics or marketing consent. Account submissions do not authorize separate marketing use.
