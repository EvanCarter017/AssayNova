# Partial catalogs and manual correction

The private admin importer retains every mapped source row, including missing short codes, unsupported product identities, duplicate SKUs and missing pictures. A nonempty parsed table can be confirmed even when all rows are blocked. Fatal table/image validation errors still reject the import. A new customer needs a table; images are optional. Nothing is automatically corrected or inferred from SKU characters.

## Identity and retained data

Each source row has an opaque 20-character ID. Ready report products use this same ID, rather than a hash of the product name. Different unique SKUs may therefore share a full product name while keeping separate pictures. The ledger keeps the parser-selected, already-trimmed SKU/product/dose strings, sheet and row as immutable `raw`; prices are not imported. `values` contains the current corrections. Slash-containing SKUs remain display/index text and are never used for storage paths. Images use opaque IDs and retain their original relative names as metadata only.

An explicit SKU must be unique among non-held entries. Every duplicate is blocked until an administrator edits a code or holds a duplicate. Held rows remain visible but release their active SKU claim. A blocked literal code also reserves its search identity: `ADA10mg` cannot silently select another ready `ADA10` product through a unit suffix. Unknown identity, unsupported composition, ambiguous dose, missing image and parser formula/merge errors remain blocked. Formula/merge provenance is resolved only by an explicit save containing all three identity fields; image-only or partial field edits do not clear it.

Automatic picture assignment uses exact normalized short-code filenames, with no nearest dose/name fallback. Multiple different pictures for the same SKU require explicit selection. All valid images, including unused ones, survive confirmation and remain available in the correction dialog. Reimporting the same filename and normalized byte hash reuses its immutable asset. An existing-customer table replaces old READY rows whose normalized SKU it claims, carries all other ready rows and ALL old blocked/held rows, then adds every incoming source row. Previous immutable revisions preserve replaced source history. A duplicate against an old blocked row requires explicit correction or Hold. Image-only imports preserve source rows and IDs.

## Storage and atomic changes

Optional customer `catalogRevision` points at a v2 immutable folder under `<store>/customer-imports/revisions/<revision>`, containing `records.json` and `images/<opaque-id>.png`. Existing v1 directory/imageRevision/aliasRevision readers are unchanged; no migration happens on read. An explicit later import can convert a legacy catalog after validating/normalizing its image bytes. Report snapshots, their Lookup Codes and original files are never modified by catalog correction.

Writes validate the complete candidate, write exclusive files, fsync them, and serialize the guarded registry pointer change. Every correction requires the current revision. Stale saves return 409 without changing the pointer. Invalid but bounded manual values are saved as blocked. Ready-only products and the current revision are checked again before entering the report renderer.

Pending jobs persist their selected mapping, prepared preview and activity lease for seven days. Resume is explicit and never confirms automatically. Confirmation binds the exact preview ID and the customer fingerprint captured at upload creation. A durable prepared intent includes a preallocated new-customer ID before activation. Completion receipts and ledger origin metadata reconcile a lost response or restart after pointer activation, without duplicating a customer or restoring an older revision. Correction operations similarly use private deterministic intent/receipt hashes; replay returns the current catalog. Ambiguous stale operations fail with 409.

Loaders validate schema, ownership, containment, reparse status, asset size and SHA-256. A process-local LRU caches at most eight manifests and 64 MiB of serialized manifest bytes in total. Each revision owns its image metadata cache; unchanged dev/inode/size/mtime/ctime signatures avoid rereading every image on every private thumbnail request. Changed metadata triggers SHA verification. Cached records are cloned before callers receive them; cache eviction always falls back to full validation.

## Private API

- `GET /admin/api/imports` lists resumable jobs; `GET /admin/api/imports/:job` restores safe file offsets, mapping and preview.
- `POST /admin/api/imports/:job/confirm` accepts `{previewId}`. Legacy empty input remains bound to that job's current prepared preview.
- `GET /admin/api/catalog/:customer/entries/:entry` returns the entry, current revision and retained picture choices.
- `PATCH` at the same URL accepts `{expectedRevision,changes:{sku?,product?,dose?,hold?},image?:null|{assetId}|{jobId,fileId}}`. Omitted image retains it; null removes it. Unknown fields and client readiness flags are rejected.
- A correction image job is created by `POST /admin/api/imports` with `{purpose:'correction',customerId,entryId,expectedRevision,uploadIntent?}`. The optional opaque 32-hex intent is frozen before the first browser request. Exact retries recover the same persisted pending job before quota/current-revision checks, including after a truly lost response or restart. Reusing it for another target is rejected; completed/cancelled intents never allocate another job. It accepts one image through the existing registration/256 KiB chunk routes and is bound to that exact target/revision.
- `GET /admin/catalog-assets/:customer/:asset` serves only that customer's retained image behind admin authentication. Queries and caller paths are rejected.
- Generation of v2 products additionally supplies `catalogRevision`. Blocked products and stale revisions fail before rendering; legacy generation remains compatible.

All existing authentication, Host/Origin/run-token guards, JSON/chunk limits and image decode limits remain in place. Limits are 10,000 rows, 500 retained images, 8 MiB per input file, 512 MiB per image pool, four pending jobs and one parser. Moving a store requires keeping the registry, immutable revisions/assets and receipts together. No actual customer catalog, pending upload, credential, report or original product photograph was migrated as part of implementation.
