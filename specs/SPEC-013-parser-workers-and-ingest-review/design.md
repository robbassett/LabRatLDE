# SPEC-013 design: Parser workers and ingest review

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: one `parse_jobs` table with a lease, and four endpoints for workers. Worker output is an ordinary SPEC-007 change set with `source = parser`. Match resolutions are stored in the change set's items and validated at commit. The watcher and parser live in `workers/vicell/` and talk to LabRat only through the public API.
- Not doing: a message queue, a plugin system loaded into the server, or a parser SDK beyond a documented JSON contract.

## 2. Data and interfaces

- `parse_jobs(id, tenant_id, raw_file_id, parser, state ∈ {queued, claimed, submitted, failed}, worker_id, lease_until, change_set_id, error, created_at)`.
- Worker API: `GET /v1/parse-jobs?state=queued&parser=`, `POST /v1/parse-jobs/{id}/claim`, `POST /v1/parse-jobs/{id}/result {items, parser_version, warnings}`, `POST /v1/parse-jobs/{id}/fail {error}`. `POST /v1/raw-files` gains `?parser=`.
- Change set op `ingest_dataset{raw_file_id, label, instrument_id?, run_id?, schema_version_id?, rows?:[{attrs, sample_match:{source_id, candidates:[{node_id, confidence}], resolution?:{node_id|create, by, at}}}], readings?:[…]}`.
- `PUT /v1/change-sets/{id}/matches/{row}` (human only) records a resolution.
- Starter schema `lde/cell-count-result@1.0` (needs SPEC-009 open question 2).
- Worker config (`workers/vicell/config.toml`, read with Python `tomllib`): LabRat URL, client credentials, and a folder → {instrument, parser} map.

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- **Ingest review queue:** a third tab in To do, "Instrument data", with its count. Rows: instrument, file name, received time, the parser that proposed it, and an `--accent` badge such as "3 to check".
- **Review screen:**
  - Layout: the raw file preview on the left and the parsed rows on the right, in a DataTable. A sticky footer shows progress ("12 of 15 rows matched") and **Commit**.
  - Content from the parser is labelled "Proposed by parser <name>".
  - Match chips show confidence as an icon plus a word (High, Check, No match), never colour alone. Rows needing attention sort first and use the `--warn` tint.
  - Row actions: **Confirm**, **Choose another sample** (the SPEC-011 `ComboBox`, with ID entry as fallback) and **Create new sample** (the SPEC-009 form in a Dialog).
  - Each match is confirmed on its own (R05, D10), so there is no "confirm all". To keep that fast: `J` and `K` move between rows, `Enter` confirms the focused match, and focus moves on to the next unresolved row. The shortcuts are listed in a tooltip on the footer.
- **Commit** is never silently disabled. The footer says what's blocking it: "Resolve 3 rows and 1 problem to commit". Schema problems appear in the Problems panel, which opens by itself (SPEC-025-R10).
- Empty state: "No instrument files waiting. Files from the drop folder appear here once a parser has read them."

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | Parsers run out of process and submit change sets (ROADMAP D9) | Parsers churn; the validated core stays small; any language works | In-binary parser plugins |
| 2026-10-20 | No auto-commit at any confidence (ROADMAP D10) | Human accountability for the record | A confidence threshold for auto-accept |
