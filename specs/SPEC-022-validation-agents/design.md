# SPEC-022 design: Validation agents

Requirements: [requirements.md](requirements.md)

Written against `dev` at `5ab446a`, plus the unmerged SPEC-007 build on `worktree-spec-007-revisions` (`0bd54db`) and the Draft SPEC-012 and SPEC-014. Recheck names and migration numbers once those land.

## 1. Simplicity budget

- **Approach:** compute everything that can be computed, and let the agent write only the judgement text.
  - The worklist and draft checks are pure Go in `internal/domain/validation.go`.
  - A draft is an ordinary SPEC-007 change set with `source = agent` and a new op, so it uses the existing review inbox, audit events and "agents can't commit" rule.
  - An "agent" here is an MCP prompt plus this contract, run by whichever client and model the customer chooses. The binary stays LLM-free (D6).
- **Evidence gap check is not an agent.** Every gap can be read directly from the report, so an LLM would only add a way to miss one.
- **Not doing:** an agent runtime or model configuration in LabRat, a document management system, approval workflows, confidence scores, a new MCP proposal tool (`propose_change_set` carries the new op), or new audit digest fields.

## 2. Data and interfaces

### Report format (`tools/validate`)

`report.json` moves to format `labrat-validation/2`, adding one array. The existing `requirements` array and SPEC-004-R01 don't change, so the report still judges only `Test: yes` requirements.

```json
"catalog": [{"id": "SPEC-007-R02", "spec": "SPEC-007", "text": "If a revisable field changes…", "test_yes": true}]
```

`parseSpecs` also keeps the requirement text: the cells between the ID and the last three, rejoined with `|`. The catalog includes `Test: no` requirements because a URS item often maps to one.

### URS file

UTF-8 CSV with the header `id,requirement`, uploaded as a raw file (SPEC-012). Reports are uploaded the same way, so every input is pinned by SHA-256.

### Worklist

`POST /v1/validation/worklist` (role `scientist` or `qa`; reads only, so no audit event):

```json
{"kind": "upgrade_impact", "urs_raw_file_id": "…", "report_raw_file_id": "…", "previous_report_raw_file_id": "…"}
```

`previous_report_raw_file_id` is required for `upgrade_impact` and rejected for the other kinds. `urs_raw_file_id` is required for all three, because the impact text refers to URS items.

```json
{
  "gaps": [{"kind": "not_verified", "subject": "SPEC-008-R03", "detail": "citing test failed"}],
  "entries": [{"subject": "SPEC-008-R03", "labels": ["verdict_changed"], "text": "…"}],
  "urs": [{"id": "URS-001", "text": "…"}],
  "catalog": [{"id": "SPEC-007-R02", "text": "…"}]
}
```

- Gap kinds: `not_verified`, `unknown_reference`, `git_dirty`, `go_test_failed`, `result_not_pass`.
- Labels: `added`, `removed`, `text_changed`, `verdict_changed`, `tests_changed`.
- The response carries the text the agent needs, so no raw file MCP resource is required.
- For `upgrade_impact`, gaps come from the newer report.

Pure functions in `internal/domain/validation.go`:

```go
func ParseURS(r io.Reader) ([]URSItem, error)
func ParseReport(b []byte) (Report, error)
func BuildWorklist(kind DraftKind, urs []URSItem, report, previous *Report) Worklist
func CheckDraft(w Worklist, d Draft) []Problem
```

### Change set op

`add_validation_draft`, sharing the SPEC-007 items array:

```json
{
  "op": "add_validation_draft",
  "kind": "urs_mapping",
  "basis": {"urs_raw_file_id": "…", "report_raw_file_id": "…", "previous_report_raw_file_id": null},
  "provenance": {"prompt": "draft_urs_mapping", "self_reported": {"client": "…", "model": "…"}},
  "items": [{"subject": "URS-001", "outcome": "supported", "text": "…", "citations": ["SPEC-007-R02"], "steps": []}]
}
```

| Kind | Subject | Outcomes (`*` needs at least one citation) | Extra fields |
|---|---|---|---|
| `urs_mapping` | URS item | `supported*`, `configuration_needed*`, `customer_procedure`, `no_match`, `needs_qa_decision` | |
| `upgrade_impact` | worklist requirement | `retest_proposed*`, `no_retest_proposed*`, `needs_qa_decision` | `affected_urs: ["URS-001"]` |
| `pq_protocol` | URS item | `steps_drafted*`, `not_tested_proposed`, `needs_qa_decision` | `steps: [{"action": "…", "expected_result": "…"}]` |

R07 checks requirement citations against the catalogs of all the draft's reports, because a `removed` requirement exists only in the older one. It checks `affected_urs` IDs against the URS file.

Malformed items get `422` with field errors, as SPEC-014-R08 does. Well-formed drafts with check failures are stored with blocking problems, following SPEC-013-R08, so QA can see what the agent got wrong. Problems are recomputed from the stored items and files whenever the change set is read and at commit.

### Item decisions

New append-only table (next numbered migration):

```text
validation_item_decisions(id, tenant_id, change_set_id, items_sha256 bytea, subject text,
  decision text CHECK IN ('accepted','edited','rejected'), edited_text text, reason text,
  decided_by uuid, decided_at timestamptz)
```

- A separate table, not a field in `items`, because a change set's author can replace its items (SPEC-007-R12). An agent could otherwise write its own approvals.
- `edited` requires `edited_text`, and `rejected` requires `reason`.
- The latest row per `(change_set_id, items_sha256, subject)` wins, and earlier rows stay.
- The `BEFORE INSERT` trigger:
  - calls `lde_require_human()` and requires `lde_has_role('qa')`, raising `LDE05` (R08);
  - requires the change set to be `proposed` and `items_sha256` to equal its current value, raising `LDE03` otherwise;
  - stamps `decided_by` and `decided_at`.
- Update, delete and truncate raise `LDE03`.
- A deferred trigger fails the commit with `LDE02` unless the transaction appended `validation_draft.item_decided`, the pattern used in `0006_principals`.

`PUT /v1/change-sets/{id}/items/{subject}/decision` `{decision, edited_text?, reason?}`.

### Commit

A `BEFORE UPDATE OF state` trigger on `change_sets` runs when the new state is `committed` and `items` contains `add_validation_draft`:

- `lde_require_human()` and `lde_has_role('qa')`, or `LDE05` (R11);
- every subject in `items` has a decision at the row's `items_sha256`, or `LDE08` (R09).

R10 is checked in Go, in the commit handler, in the same transaction. The commit then:

1. adds `validation_draft` to the `lineage_nodes.kind` check (migration);
2. creates one `validation_draft` node whose `attrs` hold the kind, basis with each file's SHA-256, provenance, and each item's agent text, edited text, decision, decider and time (R12);
3. adds `wasDerivedFrom` edges to each input raw file.

The audit event stays `change_set.committed` with `items_sha256`, so the audit chain covers the agent's output and provenance through the hash without any digest change. A rejected draft's items and decisions remain on the change set and its decision rows, and no node is created.

### Provenance

| Field | Source | Trust |
|---|---|---|
| Agent handle, delegating human | Principal and delegation (`<human> via <agent>`) | Verified by LabRat |
| Input file hashes, `items_sha256` | Computed by LabRat | Verified by LabRat |
| Prompt name | Sent by the client | Self-reported |
| Client, model, sampling settings | Sent by the client | Self-reported, shown as such |

LabRat can't verify which model produced a draft, because agents are external clients (D6). This metadata therefore never enters the audit trail as fact.

### Export

`GET /v1/validation-drafts/{node_id}/export.md` (committed drafts only), in this order:

1. Title and the banner: `**Reviewed draft. Not an approved document: approve it in your quality system.**`
2. Inputs and their SHA-256, then the provenance table with the self-reported label.
3. For `upgrade_impact`, the scope line: `*Covers changes to requirements, test results and citing tests only. Code changes with none of these don't appear: read the release notes too.*`
4. Any evidence gaps.
5. One section per item: outcome, final text, citations, decision and decider. Edited items also show the agent's original text.
6. A blank sign-off table in the SPEC-004-R11 format (`Executed by`, `Reviewed by`, `QA approved`).

### MCP

- New read tool `validation_worklist`, with the same request and response as the REST endpoint.
- New prompts per R14. Each one tells the agent to call `validation_worklist`, write one item per entry, cite only IDs from `catalog`, use `needs_qa_decision` where unsure, do no arithmetic, and submit through `propose_change_set`.
- Agents may use the SPEC-014 read tools to see configuration, such as schemas.
- No commit, decide or sign tool: SPEC-014-R03 stands, and it gains `record item decisions` in its list.
- Agent roles come from the delegating human (SPEC-006-R08), so the agent can only read what that person can.

### SQLSTATE

Registers `LDE08`: validation draft item without a current decision (SPEC-022).

## 3. UI

- **Validation tab** (singleton, reached from the explorer and command palette, shown to `qa`): upload a URS and reports, then see the worklist and evidence gaps. It also lists validation drafts, and offers export on committed ones. Gaps show here whether or not any agent is used, so the check has value with no LLM at all.
- **Draft review** opens from the review inbox for `add_validation_draft`:
  - left, the input for the current item (URS or requirement text, cited requirements);
  - right, the agent's text labelled as agent-written, with Accept, Edit and Reject.
  - Blocking problems appear in the Problems panel. A counter shows items decided out of the total.
  - There is no "accept all". Commit is enabled only when no problems remain and every item is decided.
  - Items marked `needs_qa_decision` and `no_match` sort first.
- The whole flow works without an agent's client on the QA user's machine: a colleague or service can run the agent, and QA reviews in the browser.
- Playwright critical flow: open a draft with a missing item, see the problem and disabled commit; decide all items of a complete draft, then commit.

## 4. Testing approach

| Requirement | Test location |
|---|---|
| SPEC-022-R02 | `internal/domain/validation_test.go`, `TestWorklistURS` |
| SPEC-022-R03 | `internal/domain/validation_test.go`, `TestWorklistUpgrade` |
| SPEC-022-R04 | `internal/domain/validation_test.go`, `TestEvidenceGaps` |
| SPEC-022-R05 | `internal/domain/validation_test.go`, `TestRejectsBadInputs` |
| SPEC-022-R06 | `internal/domain/validation_test.go`, `TestDraftCompleteness` |
| SPEC-022-R07 | `internal/domain/validation_test.go`, `TestDraftCitations` |
| SPEC-022-R08 | `internal/storage/integration_test.go`, `TestValidationDecisionRole` |
| SPEC-022-R09 | `internal/storage/integration_test.go`, `TestValidationCommitNeedsCurrentDecisions` |
| SPEC-022-R10 | `internal/api` handler test against the database, `TestValidationCommitBlockedByProblems` |
| SPEC-022-R11 | `internal/storage/integration_test.go`, `TestValidationCommitRole` |
| SPEC-022-R12 | `internal/api` handler test against the database, `TestValidationDraftKeepsAgentText` |

## 5. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-11-01 | Agents draft and QA decides each item; nothing here approves | The regulated company owns validation for its intended use (ROADMAP D14) | "Fully scripted validation"; agent-approved items |
| 2026-11-01 | LabRat computes the worklist and checks the draft against it | A missed item must not look like a clean result; invented IDs must be caught mechanically | Asking the agent to confirm its own coverage |
| 2026-11-01 | The evidence gap check is deterministic | Every gap is readable from the report | A third LLM agent |
| 2026-11-01 | Decisions live in their own append-only table, bound to `items_sha256` | The author can replace items, so decisions in `items` could be forged, and old decisions must not carry over to changed text | Storing them in `items`, as SPEC-013 does for match resolutions |
| 2026-11-01 | Item decisions are required, with no "accept all" | Reduces rubber-stamping of plausible text | One decision per draft |
| 2026-11-01 | Model, prompt and sampling details are stored as self-reported provenance, not audit fields | LabRat can't verify them, a new audit field needs a new digest version, and sampling settings don't make an output reproducible; `items_sha256` already ties the content to the chain | Immutable audit metadata for each AI call, signed alongside the e-signature |
| 2026-11-01 | The draft check runs in Go; role and decision gates run in the database | The check needs CSV and report parsing, which doesn't belong in triggers. This is a deliberate exception to "invariants live in the database": a direct write with `lde_app` could bypass R10, while R09 and R11 still hold | Parsing files in PL/pgSQL; storing a client-supplied "checks passed" flag |
| 2026-11-01 | The catalog is a new report array, and the format moves to `/2` | URS items often map to `Test: no` requirements; `requirements` must keep meaning what SPEC-004-R01 says | Listing every requirement in `requirements` |
| 2026-11-01 | One spec at 14 requirements, slightly over the usual 12 | The worklist, checks and review gate are only useful together | Splitting the deterministic core from the prompts |
| 2026-11-01 | Protocol drafting and inventory agents excluded | They aren't validation work, and stoichiometry and hazard data from an LLM carry the most risk | One broad "GxP agents" spec |
