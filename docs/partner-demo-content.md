# Contact details and enquiry handling

AssayNova contact addresses and service information are maintained below. The Contact page provides local enquiry preparation and native email links; website message delivery is a separate integration.

## Current contact configuration

| Item | Configured value | Source |
| --- | --- | --- |
| Client services address | hello@assaynova.com | dist/index.html, #contact-view .contact-sidebar: visible address and mailto href |
| Nova Support address | reports@assaynova.com | dist/index.html, #contact-view .contact-sidebar: visible address and mailto href |
| Office hours | Monday–Friday · 9:00 am–5:00 pm ET. | dist/index.html, #contact-view .contact-sidebar, Office hours |
| Support response estimate | Typically within 1 business day. | dist/index.html, #contact-view .contact-sidebar, Nova Support response |

Keep visible addresses and their mailto hrefs aligned when changing configuration. Native mailto links open an external mail client only when activated. Configuring an address does not connect a website mail provider or verify mailbox ownership.

The homepage and testing pages use the existing ~1 Week Turnaround estimate. Practical sample requirements, service scope, turnaround and pricing are confirmed with the laboratory; the estimate is not a delivery guarantee.

## Contact enquiry draft

Contact us provides Name, Email, Topic and Message fields with explicit Save draft, Copy message, Restore saved draft and Clear saved draft controls. One version-1 record is stored in `assaynova.contact.enquiry.v1` only after Save draft and verified read-back. Input and SPA navigation do not persist it. Restore reads only on request; Clear removes only this key and retains current inputs. Copy prepares complete plain text without saving, and failed clipboard access exposes the full manual-copy field. No action sends a message or grants optional consent.

The draft remains until Clear saved draft on Contact us or browser site-data clearing, with no automatic expiry. Static controls have no name attributes and remain disabled until the controller installs its handlers, avoiding native GET disclosure if boot fails.

## Sample requests and report recovery

The independent sample request flow saves only on its final Save request action, using `assaynova.prototype.requests.v1` with up to 50 drafts. Existing records, version-2 multi-sample requests and legacy IDs stay compatible. Drafts remain on this device until browser site-data clearing; image files, filenames and preview URLs are not saved. Saving does not submit to a laboratory, verify an email address or send email.

Nova Support prepares a report recovery request from the original testing email, company or project name and optional context. Save draft stores one versioned record in `assaynova.support.recovery.v1`; Copy request prepares the current text without saving. Clear saved draft removes only that recovery record. It remains until that clear action or browser site-data clearing. No ticket is created and no report is automatically matched or disclosed; additional verification may be needed.

These three local draft keys are independent. Privacy choices neither read their contents nor remove them. Public sample COA records retain their fictional-data and not-valid-certificate disclosures.

## Future delivery integration

No provider, send API, request backend, database, authentication or delivery state is implemented. Adding delivery requires separately authorized server-side validation and storage, explicit customer submission, truthful outcomes, retries, failure handling and server-only secrets; see [email-notifications.md](email-notifications.md). Do not automatically upload or send an existing device draft. Optional marketing consent does not authorize transactional request handling.

## Verification boundary

Production-handler tests use synthetic, ephemeral drafts. Live browser review covers presentation and navigation without mailto activation or Save, Copy, Restore or Clear actions. Isolated QA may use synthetic contact values to verify those local controls, then clears only its test draft through the UI.
