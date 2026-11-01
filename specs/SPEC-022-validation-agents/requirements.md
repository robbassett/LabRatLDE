# SPEC-022: Validation agents

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-11-01 / 2026-11-01 |
| **Regulatory refs** | 21 CFR 11.10(a), 11.10(e), 11.10(g); GAMP 5 (leveraging supplier evidence) |
| **Depends on** | `SPEC-004`, `SPEC-006`, `SPEC-007`, `SPEC-012`, `SPEC-014`, `SPEC-020` |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

## 1. Problem

The regulated company owns validation for its intended use. No supplier can do that part for them, however much is scripted. LabRat's traceability report and install checks (SPEC-004) and validation documents (SPEC-020) cover the supplier's evidence. Customer QA teams still have to map their user requirements (URS) to that evidence, draft performance qualification (PQ) protocols for their real workflows, and work out what to retest at every upgrade. That is slow, repetitive reading and drafting, and the upgrade work recurs with every release.

Agents can speed up the drafting. The danger is a draft that looks finished: an invented requirement ID, or a URS item silently left out, reads the same as a clean result, and a reviewer under time pressure may not notice. So LabRat computes the list of what must be covered and checks each draft against it, the agent only writes the judgement text, and a QA person decides every item.

## 2. Scope

**In scope**
- A deterministic **worklist**: from a customer URS and one or two traceability reports, the items a draft must cover, plus any **evidence gaps**. No LLM is involved.
- Three **draft kinds**, each with an MCP prompt: `urs_mapping` (URS items to LabRat requirements), `upgrade_impact` (what changed between releases and what to retest) and `pq_protocol` (draft test steps per URS item).
- Deterministic **draft checks** for completeness and citations, which block commit.
- **Item-by-item QA review** in the review inbox, keeping the agent's text next to any human edit.
- A Markdown **export** for the customer's own quality system, clearly marked as not approved.

**Out of scope**
- Approving anything. Formal approval and e-signature of validation documents stay in the customer's quality system.
- Agents running tests, executing PQ, or filling in actual results.
- GMP decisions by an agent, such as risk ratings, batch or record decisions. See ROADMAP D14 and open question 4.
- LabRat calling an LLM (ROADMAP D6). The customer chooses the agent and model, and decides whether its URS may be sent to that model.
- Any change to audit digest v1.
- Other agents: the CDMO parser builder and the tech transfer agent get their own specs. Protocol drafting and inventory requests for the bench are not validation work and are not covered here.
- Importing URS documents from Word, Excel or PDF (open question 3).

## 3. Requirements (EARS)

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-022-R01 | When `make validate` writes a report, the validation tool shall add a `catalog` listing the ID, spec, text and `Test` flag of every requirement in specs with status Approved or Implemented. | no | needed by R02, R03 |
| SPEC-022-R02 | When a worklist is requested for `urs_mapping` or `pq_protocol`, the validation API shall return exactly one entry for each item in the URS file. | yes | GAMP 5 |
| SPEC-022-R03 | When a worklist is requested for `upgrade_impact`, the validation API shall return exactly one entry for each requirement that was added or removed, or whose text, verdict or citing tests differ, between the two reports. | yes | GAMP 5, change control |
| SPEC-022-R04 | When a worklist is requested, the validation API shall list as evidence gaps each `NOT VERIFIED` requirement, each unknown reference, and a report that has uncommitted changes, reported `go test` failures or a result other than `PASS`. | yes | 11.10(a) |
| SPEC-022-R05 | If a URS file has a blank or duplicate item ID, or a report isn't in format `labrat-validation/2`, then the validation API shall respond `422` naming the fault and return no worklist. | yes | data integrity |
| SPEC-022-R06 | When a validation draft is proposed or replaced, the draft check shall raise a blocking problem for each worklist entry with no draft item, each draft item whose subject isn't on the worklist, and each repeated subject. | yes | 11.10(a) |
| SPEC-022-R07 | When a validation draft is proposed or replaced, the draft check shall raise a blocking problem for each cited requirement or URS ID that isn't in the draft's input files, and each item whose outcome needs a citation and has none. | yes | 11.10(a) |
| SPEC-022-R08 | If a principal that isn't an enabled human holding `qa` records an item decision, then the database shall reject it with SQLSTATE `LDE05`. | yes | 11.10(g), ROADMAP D6 |
| SPEC-022-R09 | If a validation draft is committed while any of its items has no decision recorded against the change set's current `items_sha256`, then the database shall reject the commit with SQLSTATE `LDE08`. | yes | ROADMAP D10, 11.10(e) |
| SPEC-022-R10 | If a validation draft is committed while the draft check reports any blocking problem, then the change set API shall reject the commit with `409`, listing the problems. | yes | 11.10(a) |
| SPEC-022-R11 | If a principal that isn't an enabled human holding `qa` commits a validation draft, then the database shall reject it with SQLSTATE `LDE05`. | yes | 11.10(g) |
| SPEC-022-R12 | When a validation draft is committed, the change set API shall store, for each item, the agent's original text, any human edit, and the decision, decider and time, together with the SHA-256 of each input file. | yes | 11.10(e) |
| SPEC-022-R13 | When a committed validation draft is exported, the validation API shall return Markdown stating that it is not an approved document, showing agent provenance as self-reported, and ending with a blank sign-off table. | no | GAMP 5 |
| SPEC-022-R14 | Where MCP is enabled, the MCP server shall serve the prompts `draft_urs_mapping`, `draft_upgrade_impact` and `draft_pq_protocol`, each telling the agent to work only from the worklist and to mark what it can't support as `needs_qa_decision`. | no | user need |

## 4. Acceptance examples

Fixture (synthetic): URS file `urs.csv` with items `URS-001` "Record who changed a result and why" and `URS-002` "Block use of expired reagent lots". `report-a.json` and `report-b.json` are format `labrat-validation/2`, both `PASS`. `carol` is a human holding `scientist` and `qa`. `alice` is a human holding only `scientist`. `bot` is an agent delegated by carol.

**SPEC-022-R02**: a `urs_mapping` worklist for `urs.csv` returns two entries, `URS-001` and `URS-002`, each with its text.

**SPEC-022-R03**: `report-b.json` adds `SPEC-015-R01`, removes `SPEC-009-R04`, rewords `SPEC-007-R02`, changes `SPEC-008-R03` from `VERIFIED` to `NOT VERIFIED`, and adds a citing test to `SPEC-002-R01`. All other requirements match. The `upgrade_impact` worklist returns exactly those five entries, labelled `added`, `removed`, `text_changed`, `verdict_changed` and `tests_changed`. A requirement with both new text and a new verdict gets one entry carrying both labels.

**SPEC-022-R04**: a report with `git_dirty: true`, `go_test_passed: false`, result `FAIL`, one `NOT VERIFIED` requirement and one unknown reference returns five gaps, and the worklist entries are still returned. A clean `PASS` report returns none.

**SPEC-022-R05**: a URS with `URS-001` twice gets `422` naming `URS-001`. A URS row with a blank ID gets `422` naming the row number. A `labrat-validation/1` report gets `422` naming the format. In each case no worklist is returned.

**SPEC-022-R06**: `bot` proposes a `urs_mapping` draft with items for `URS-001` and the invented `URS-099`, leaving out `URS-002`. The change set is stored with two blocking problems: `URS-002` missing and `URS-099` not on the worklist. Repeating `URS-001` adds a third.

**SPEC-022-R07**: an item for `URS-001` with outcome `supported` citing `SPEC-007-R99`, which isn't in the catalog, gets one problem naming `SPEC-007-R99`. With outcome `supported` and no citations it gets one problem. With outcome `customer_procedure` and no citations it gets none.

**SPEC-022-R08**: alice recording a decision fails with `LDE05`. `bot`, acting for carol, recording a decision fails with `LDE05`. Carol recording a decision succeeds and appends one audit event in the same transaction.

**SPEC-022-R09**: carol accepts `URS-001` only, and her commit fails with `LDE08`. She decides `URS-002` too. Then `bot` replaces the items, which changes `items_sha256`, and her commit fails with `LDE08` because her decisions no longer apply. After she decides both items again, the commit succeeds.

**SPEC-022-R10**: every item has a current decision but `URS-002` is missing from the draft (R06). Carol's commit gets `409` listing the missing item, and nothing is applied.

**SPEC-022-R11**: on a complete draft with every item decided, alice's commit and `bot`'s commit each fail with `LDE05`. Carol's succeeds.

**SPEC-022-R12**: `bot` writes "Covered by the audit trail" for `URS-001`, and carol edits it to "Covered by the audit trail; our SOP-12 sets the review frequency" and commits. The stored draft holds both texts, the decision `edited`, carol and the time, and the SHA-256 of `urs.csv` and of each report.

## 5. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | Should reviewed drafts live in LabRat, or only as exported files? Recommendation: in LabRat, so QA gets the review inbox (ROADMAP D7) and history. The customer's quality system still holds the approved document. | Rob Bassett | |
| 2 | `change_sets_guard()` requires `scientist` to create, commit or reject a change set, so QA users would also need `scientist`. Accept that, or let `qa` alone decide validation drafts? Recommendation: let `qa` alone decide, because QA staff shouldn't need rights to change lab records. That means changing the guard for this op. | Rob Bassett | |
| 3 | Is a two-column CSV (`id,requirement`) enough as the URS input in v1? Recommendation: yes. An agent converting a Word or PDF URS could silently drop items, which is the failure this spec exists to prevent. | Rob Bassett | |
| 4 | EU GMP draft Annex 22 would bar generative AI from critical GMP applications, and that position was under review at last check. Recheck the EMA text before this spec is Approved. Recommendation: keep the intended use as drafting support for QA, and take regulatory advice on the wording. | Rob Bassett | |
| 5 | Does a customer need to validate the agent and model when QA reviews every item? Recommendation: LabRat treats the agent as out of validated scope, as with parsers (ROADMAP D9), validates the deterministic checks and states that position. Each customer's QA decides for itself. Take regulatory advice. | Rob Bassett | |
| 6 | May the person who asked the agent for a draft also review it? Recommendation: yes. The agent is the drafter, and the customer's approval step sits in its quality system. | Rob Bassett | |
| 7 | `upgrade_impact` sees requirement and test changes only, so a code change with no requirement or test change is invisible to it. Is a release-notes pointer in the export enough? Recommendation: yes for v1, with the limit stated on the export (design §2). | Rob Bassett | |
| 8 | SPEC-020 has no PQ template, and PQ is customer-specific. Should `urs_mapping` and `upgrade_impact` ship first if `pq_protocol` has to wait? Recommendation: yes. They only need SPEC-004's report, so the SPEC-020 dependency applies only to `pq_protocol`. | Rob Bassett | |
