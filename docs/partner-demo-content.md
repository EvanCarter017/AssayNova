# Partner presentation content inventory

The user authorized generated, fictional business content for a partner presentation. This inventory is for maintainers; the customer interface has no presentation banner or visitor split. None of these contact details establishes a working mailbox or application delivery service.

## Fictional contact data

| Item | Current presentation value | Source and replacement target |
| --- | --- | --- |
| Client services address | hello@assaynova.example | dist/index.html, #contact-view: replace both visible address and mailto href |
| Report and website support address | reports@assaynova.example | dist/index.html, #contact-view: replace both visible address and mailto href |
| Office hours | Monday–Friday · 9:00 am–5:00 pm ET. | dist/index.html, #contact-view .contact-sidebar, Office hours |
| Support response estimate | Typically within 1 business day. | dist/index.html, #contact-view .contact-sidebar, Nova Support response |

The reserved .example addresses are fictional presentation targets, not verified operating channels. Mailto links open an external mail client only when activated; they are separate from the site's local request form. Review the hours, time zone and response estimate against the actual operating service before replacing this data.

The existing homepage estimates “~1 Week Turnaround” and “~1 Week” in the process handoff remain unchanged by this sweep. They were user-selected presentation estimates, not delivery guarantees; review them alongside actual service timing after the presentation. No prices, qualifications, people, report measurements or additional service promises were generated here.

## Customer copy changed

- The first homepage FAQ answer explains preparing and reopening a saved request draft.
- The About page describes keeping request details together on this device.
- The request form uses “Request draft” and “On this device”, with a contact-address helper and a clear statement that saving sends neither a request nor email.
- Save confirmation, Saved drafts and request detail retain their local, unsent descriptions without configuration-status language.
- The Report a problem FAQ and formal Contact page guidance from the preceding change remain; Contact presents a local enquiry form alongside the fictional services and support information above.

## Actual request boundary

Save request still validates a required contact email and saves only to the existing assaynova.prototype.requests.v1 localStorage key, capped at 50 drafts. It does not verify mailbox ownership, submit to a laboratory, upload old drafts, create an account or send email. Draft · Not sent, Save request, storage-failure feedback, escaped private email regions and legacy draft compatibility remain unchanged.

No provider, send API, request backend, database, authentication or delivery state was added. Existing public COA samples and their validity disclosures are unchanged. Static Contact mailto links are outside the request form and do not grant any new application capability.

## After the presentation

Replace both address labels and hrefs together, confirm the published hours and response estimates, and review the Contact/FAQ/About copy against the actual service. Keep local drafts compatible. Never automatically upload an old device draft when adding a future service.

Application delivery needs a separately authorized server-side request and provider design, including validation/storage, explicit user submission, truthful outcomes, retries/failures and server-only secrets; see [email-notifications.md](email-notifications.md). Optional marketing consent is not permission for transactional request handling.

Behavioral validation uses actual production-handler tests with synthetic, ephemeral in-memory drafts. LIVE browser review covers presentation and navigation without mailto activation or Save, Copy, Restore or Clear actions. Isolated QA uses synthetic contact values to check validation and Save/Restore/Copy/Clear, then clears only its test draft through the UI.

## Contact enquiry draft

Contact us provides Name, Email, Topic and Message fields with explicit Save draft,
Copy message, Restore saved draft and Clear saved draft controls. A single versioned
record lives in `assaynova.contact.enquiry.v1` only after Save draft and verified
read-back. Restore reads only on request; Clear removes only this key and keeps
current inputs. Copy prepares complete plain text without saving. Failed clipboard
access exposes a full manual-copy field. No action sends a message or grants
optional consent. Existing sample-request and Nova Support recovery drafts remain
separate. Static controls have no name attributes and remain disabled until the
controller installs its handlers, avoiding native GET disclosure if boot fails.
Future delivery requires separate authorization and must never auto-send a draft.
Native Save/Restore/Copy/Clear tests use synthetic values on the isolated QA origin;
the live partner browser is checked without private-value or storage operations.
