# SPEC-012 design: Raw file custody

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: files are written to `LDE_BLOB_DIR/<tenant>/<sha[0:2]>/<sha>`. The server writes to a temp file while hashing, fsyncs, renames, then makes the file read-only. An existing path means the bytes are already stored. Metadata lives in a `raw_files` table with an append-only trigger. If a transaction fails, an orphaned blob is harmless; garbage collection is out of scope.
- Not doing: a blob service, chunking, encryption at rest (left to the filesystem or volume), or a `storage` interface with one implementation.

## 2. Data and interfaces

- `raw_files(id, tenant_id, node_id, sha256 bytea, size bigint, original_filename, media_type, source ∈ {upload, stream, dropfolder}, uploaded_by, received_at)`. Append-only.
- New lineage kind `raw_file` (a new migration replaces the `kind` CHECK constraint).
- Config: `LDE_BLOB_DIR` (required in prod; `./data/blobs` in dev) and `LDE_MAX_RAW_BYTES`. SPEC-004 `labrat iq` gains a check that the blob directory is writable.
- API: `POST /v1/raw-files?instrument_id=&run_id=` (body is the file; headers `Content-Type`, `Content-Disposition` with filename), `GET /v1/raw-files/{id}`, `GET /v1/raw-files/{id}/content`, `POST /v1/raw-files/{id}/fixity`.
- Linking to a sealed run follows SPEC-002 and SPEC-008: rejected unless it goes through a correction.

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- **Upload:** drop files on the run view's Data card (SPEC-025 `RunData`), or use the **Upload file** button there or in the New menu. The button is the keyboard and touch equivalent of dragging (WCAG 2.5.7). While dragging, the target shows a dashed `--primary` border and "Drop to upload to <run label>". Each file gets a progress row (name, size, progress bar, Cancel). On completion a toast confirms it and the file appears in Data with the status "Stored".
- **Same bytes again:** an info message, not an error: "This file is already stored (uploaded by <name> on <date>)", linking to it.
- **Raw file view:**
  - Header: file name, type icon, size, who uploaded it and when. **Download** is the primary action.
  - Preview: text and CSV show the first 1 MB as a DataTable with "Showing the first N rows". PDF and images display inline. Other types show "No preview for this file type" and Download.
  - Fixity: a status row with icon and words ("Fingerprint verified 2026-11-06 10:02", or a danger icon with "Fingerprint does not match: tell QA") and a **Re-check** button.
  - The SHA-256 sits in Record details as "File fingerprint (SHA-256)".
  - A "Parsed into" card lists the datasets derived from the file (SPEC-013).
- A 413 response names the maximum file size.

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | Keep vendor originals, content-addressed (ROADMAP D9) | Part 11 original records; integrity by construction | Discarding originals after parsing |
| 2026-10-20 | Filesystem first, no storage abstraction | One real backend; S3 gets its own spec and decision when needed | An interface with one implementation |
