# Account-free requests and email notifications

Account work is cancelled. The current product uses a contact email and local request drafts; it does not implement accounts, authentication, a database, request delivery or email delivery.

## Current boundary

- The request form requires a syntactically valid contact email. It does not verify ownership of that mailbox.
- **Request draft / On this device** and the contact-email helper describe the local draft boundary. No provider, adapter, credentials, SDK, send API or outgoing request exists in the request flow.
- Contact us contains static `mailto` links for the user-authorized fictional addresses `hello@assaynova.example` and `reports@assaynova.example`. Activating one hands composition to an external mail client; it does not enable application delivery or submit a saved request. The addresses, hours and response estimate are presentation data listed in [partner-demo-content.md](partner-demo-content.md).
- **Save request** validates the form and saves a draft only in this browser's `assaynova.prototype.requests.v1` localStorage key, capped at 50 records. Existing records and IDs remain compatible. Saving is neither laboratory submission nor email delivery.
- Confirmation and draft detail show **Draft · Not sent** and say that saving sends no email. Contact details are escaped and remain inside `data-request-private` review/summary regions or existing private `success-details` regions.
- **Saved drafts** lists only drafts on the current device. It has no Reports tab, account workspace, cloud history or customer-owned report list. Public fictional sample reports remain accessible from the homepage and COA Lookup, with their sample disclaimers.
- The HTTP server remains read-only. No backend, provider connection or account implementation exists. No existing device draft is uploaded automatically.

Nova Support prepares a report recovery request using the original testing email and company or project name. Save draft stores one versioned record in `assaynova.support.recovery.v1`; Copy request copies the current validated text without saving it. Clear saved draft removes only that recovery record. Nothing is sent, no ticket is created, and no report is matched or disclosed from these details. Additional ownership verification remains a manual requirement.

## Independent sample request page

`/submit-sample` has three steps: testing and samples, contact/report requirements, then review. Continue never saves; only the final Save request writes the existing key. The page retains unfinished state while navigating within the SPA, but refresh starts a blank flow unless a saved draft is explicitly resumed. Explicit New request resets only the in-memory flow.

New version-2 records retain `id`, `createdAt`, `status`, flat contact fields and compatibility projections, plus `samples` and `reportRecipient`. Each sample stores a stable ID, name, service, quantity, batch, form, amount and image preference/style. Nested samples are authoritative: flat `sample` and `service` come from the first entry, and flat `quantity` totals all planned units (up to 1000). The active form and version-2 review/details no longer show batch/lot, stated amount or company/laboratory. Their existing schema keys remain for compatibility, and canonical historical values survive Resume and Save. Report recipient name remains a separate optional field and falls back only to the contact name. Unknown or conflicting version-2 data is not treated as a legacy record. Valid older unversioned drafts remain readable without forced rewriting. Explicit saving uses exact storage readback; editing and re-saving update the same saved ID.

Optional JPEG/PNG/WebP references are previewed locally (up to 5 MiB each). Only the image preference/style is saved, never file bytes, filenames or object URLs. Preview URLs are revoked on replacement, removal, reset or controller destruction. Resume asks for optional image reselection. The image CSP permits same-origin blob previews; no remote upload or network handoff is implemented. Prices are by quotation and the ~1 Week estimate requires laboratory confirmation.

## Design after a provider is chosen

The following is future work, not an implemented interface or provider adapter:

1. Define an explicit customer submission step with server-side validation, durable request storage, clear accepted/failed outcomes and duplicate-submission handling. Keep local drafts compatible, and require an explicit user action before uploading any old draft.
2. Design transactional operator notifications and customer acknowledgements/status updates around the actual request lifecycle. Make sender identity, recipient handling and notification expectations clear. Never describe delivery as successful before the provider confirms the relevant outcome.
3. Keep provider keys and other secrets in server environment configuration only. Do not place them in browser code, localStorage, committed files or customer-visible diagnostics.
4. Specify delivery retries, idempotency, failure handling and safe operational monitoring. Distinguish a saved request from queued, accepted, delivered or failed mail; provider responses and user-facing status must remain truthful.
5. Add proportionate anti-abuse measures and input limits before exposing a submission/send endpoint. Define retention, access controls and handling of contact details against the real operating requirements.
6. Design secure report links and disclosure rules for real customer reports. Today's public sample COA routes are not customer authorization or a secure-link design; decide expiry, revocation and access rules when the provider and real report workflow are selected.

Transactional request handling must not depend on optional analytics or marketing consent. Do not reuse optional marketing permission as authorization to submit requests or send transactional messages. Any separate marketing use needs its own reviewed purpose and choices. These presentation content changes do not implement or authorize these future systems.
