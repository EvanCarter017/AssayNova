# Customer accounts, request drafts and email boundaries

The customer account foundation supports email/password sign-in, an owned server draft workspace, profile/password changes and8 one-time recovery codes. No mail service is configured. Email remains unverified, account recovery uses saved codes, and saving a draft does not submit it to the laboratory or send email. See [Customer accounts](customer-accounts.md) for storage/session/backup behavior.

## Current boundary

- The request form requires a syntactically valid contact email. It does not verify ownership of that mailbox.
- **Request draft** remains unsent. **This device** saves to the browser; an explicit **Account** choice saves the current signed-in user's server draft. No provider, SMTP connection, SDK or mail-send API exists.
- Contact us uses the configured addresses `hello@assaynova.com` and `reports@assaynova.com`. Its native `mailto` links hand composition to an external mail client when activated; they do not enable application delivery or submit a saved request. Contact form Save and Copy actions prepare a local enquiry only. The addresses, hours and response estimate are maintained in [Contact details and enquiry handling](partner-demo-content.md).
- Device saving retains `assaynova.prototype.requests.v1`, capped at50 records. Existing records/IDs remain compatible and are not automatically uploaded or rewritten. Account saving is explicit, owner-scoped and capped at50 server drafts; uncertain retries use stable idempotency and updates use revisions.
- Confirmation and draft detail show **Draft · Not sent** and say that saving sends no email. Contact details are escaped and remain inside `data-request-private` review/summary regions or existing private `success-details` regions.
- Device **Saved drafts** lists local records; **My account** lists the signed-in user's server drafts. Neither grants a customer report list by email/name/company. Public Verify Lookup Code behavior and published report assets remain unchanged.
- The account API provides durable private storage. It does not deliver requests, tickets, notifications or mail. No existing device draft is uploaded automatically.

Nova Support prepares a report recovery request using the original testing email and company or project name. Save draft stores one versioned record in `assaynova.support.recovery.v1`; Copy request copies the current validated text without saving it. Clear saved draft removes only that recovery record. Nothing is sent, no ticket is created, and no report is matched or disclosed from these details. Additional ownership verification remains a manual requirement.

## Independent sample request page

`/submit-sample` has three steps: testing and samples, contact/report requirements, then review. Continue never saves; the final save uses the explicitly selected destination. A successful account response acknowledges durable draft storage only. Pending/failed/expired-session saves retain entered details and do not silently fall back to device storage. The page retains unfinished state within the SPA; saved drafts are explicitly resumed. Explicit New request resets the in-memory flow.

New version-2 records retain `id`, `createdAt`, `status`, flat contact fields and compatibility projections, plus `samples` and `reportRecipient`. Each sample stores a stable ID, name, service, quantity, batch, form, amount and image preference/style. Nested samples are authoritative: flat `sample` and `service` come from the first entry, and flat `quantity` totals all planned units (up to 1000). The active form and version-2 review/details no longer show batch/lot, stated amount or company/laboratory. Their existing schema keys remain for compatibility, and canonical historical values survive Resume and Save. Report recipient name remains a separate optional field and falls back only to the contact name. Unknown or conflicting version-2 data is not treated as a legacy record. Valid older unversioned drafts remain readable without forced rewriting. Explicit saving uses exact storage readback; editing and re-saving update the same saved ID.

Optional JPEG/PNG/WebP references are previewed locally (up to5MiB each). Only image preference/style is saved to either draft destination, never file bytes, filenames or object URLs. Preview URLs are revoked on replacement, removal, reset or controller destruction. Resume asks for optional image reselection. No customer reference-file upload is implemented. Prices are by quotation and the ~1 Week estimate requires laboratory confirmation.

## Design after a provider is chosen

The following is future work, not an implemented interface or provider adapter:

1. Define an explicit laboratory submission step beyond the existing durable draft API, with clear accepted/failed outcomes and duplicate-submission handling. Keep local drafts compatible and require explicit user action before uploading an old draft.
2. Design transactional operator notifications and customer acknowledgements/status updates around the actual request lifecycle. Make sender identity, recipient handling and notification expectations clear. Never describe delivery as successful before the provider confirms the relevant outcome.
3. Keep provider keys and other secrets in server environment configuration only. Do not place them in browser code, localStorage, committed files or customer-visible diagnostics.
4. Specify delivery retries, idempotency, failure handling and safe operational monitoring. Distinguish a saved request from queued, accepted, delivered or failed mail; provider responses and user-facing status must remain truthful.
5. Add proportionate anti-abuse measures and input limits before exposing a submission/send endpoint. Define retention, access controls and handling of contact details against the real operating requirements.
6. Design secure report links and disclosure rules for real customer reports. Today's public sample COA routes are not customer authorization or a secure-link design; decide expiry, revocation and access rules when the provider and real report workflow are selected.

Transactional request handling must not depend on optional analytics or marketing consent. Do not reuse optional marketing permission as authorization to submit requests or send transactional messages. Any separate marketing use needs its own reviewed purpose and choices. Contact configuration changes do not implement or authorize these future systems.
