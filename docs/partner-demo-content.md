# Contact details and enquiry handling

AssayNova contact addresses and service information are maintained below. The Contact page provides signed-in account enquiries and native email links. Email delivery remains a separate integration.

## Current contact configuration

| Item | Configured value | Source |
| --- | --- | --- |
| Client services address | hello@assaynova.com | dist/index.html, #contact-view .contact-sidebar: visible address and mailto href |
| Nova Support address | reports@assaynova.com | dist/index.html, #contact-view .contact-sidebar: visible address and mailto href |
| Office hours | Monday–Friday · 9:00 am–5:00 pm ET. | dist/index.html, #contact-view .contact-sidebar, Office hours |
| Support response estimate | Typically within 1 business day. | dist/index.html, #contact-view .contact-sidebar, Nova Support response |

Keep visible addresses and their mailto hrefs aligned when changing configuration. Native mailto links open an external mail client only when activated. Configuring an address does not connect a website mail provider or verify mailbox ownership.

The homepage and testing pages use the existing ~1 Week Turnaround estimate. Practical sample requirements, service scope, turnaround and pricing are confirmed with the laboratory; the estimate is not a delivery guarantee.

## Account enquiries and recovery

Contact us submits Name, Email, Topic and Message through the signed-in account with Submit message. Nova Support submits testing email, company/project and optional context with Submit recovery request. Testing retains its three-step review and Submit request action. All three appear in My requests with view, edit and delete. Their Submitted status acknowledges durable platform storage only; no email, staff notification or laboratory processing is simulated.

New records use strict version-3 envelopes. Older account version-2 records display Saved · Not submitted and require explicit review/resubmission. The server preserves ownership, reference, creation time, kind and revisions. No email/company matching attaches reports. Support requests never perform COA lookup; manual identity verification remains necessary.

Existing browser values in assaynova.prototype.requests.v1, assaynova.contact.enquiry.v1 and assaynova.support.recovery.v1 remain untouched and are no longer accessed by active forms. Save, copy, restore, clear, device destination and import actions have been removed. No automatic upload occurs. Browser site-data clearing can remove the old values; privacy choices never read or delete them. Optional reference images are local previews and are not uploaded or persisted.

Static contact and dynamically created recovery submit controls remain disabled until the account-aware controller binds them. Private fields have no native form names, preventing accidental GET disclosure on failed boot. Request editing and retries keep details in memory for the same owner, clear on logout/account replacement and ignore late results after navigation/close.

## Delivery and validation

The existing account API and SQLite schema-1 JSON column persist submitted requests. No mail provider or laboratory integration is configured. Native mailto links remain available independently. See [email-notifications.md](email-notifications.md) for the actual boundaries. Optional consent behavior is unchanged.

Tests and browser review use fabricated accounts, synthetic fields and explicit disposable account/report directories. Actual customer records, account credentials, report stores and administrator data are never used for acceptance checks.
