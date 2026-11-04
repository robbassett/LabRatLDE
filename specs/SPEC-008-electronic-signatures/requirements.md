# SPEC-008: Electronic signatures v2

| | |
|---|---|
| **Status** | Approved |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-10-18 / 2026-11-01 |
| **Regulatory refs** | 21 CFR 11.10(e), 11.10(g), 11.50, 11.70, 11.100(a), 11.200(a); EU Annex 11 §14 |
| **Depends on** | `SPEC-002`, `SPEC-003`, `SPEC-006`, `SPEC-007` |
| **Supersedes** | `SPEC-001-R12` (meaning becomes a controlled value); the "terminal" part of `SPEC-001-R11` for `signed`; `SPEC-002-R01` (sealed predicate); `SPEC-006-R06` (who may sign: the signing policy decides, not `reviewer`/`qa`); `SPEC-007-R10` (sealed commits, except aborted runs and runs signed before this spec) |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

## 1. Problem

Today, "signing" moves a run to `signed` and stores a free-text reason. Part 11 requires more from an electronic signature:
- the signer's printed name, the date and time, and a meaning (review, approval, …) shown wherever the signed record is shown (§11.50);
- a link to the exact record content that can't be copied or excised (§11.70);
- re-authentication at signing time (§11.200).

Real labs also sign in sequence (author → reviewer → QA) and must correct signed records without obscuring what was signed. Without this, LabRat can't be used for regulated work.

## 2. Scope

**In scope**
- A `signatures` record bound to a **manifest digest** of the run as signed.
- A controlled list of meanings.
- An ordered **signing policy** per experiment, copied onto each run at creation.
- A per-tenant **GxP mode** that decides who may change a signing policy.
- Step-up re-authentication.
- Four-eyes: no person signs two steps of the same run.
- The first signature seals the run (extending SPEC-002's predicate).
- **Corrections:** a reviewed change set that, when committed, invalidates the run's signatures and returns it to the state it held before signing, for re-signing.
- Post-signature annotations that don't invalidate.
- Correcting a principal's printed name, which signing makes necessary.
- Signature manifestation in the API and UI.
- The first Playwright `Test: yes` flow, fed into `make validate`.

**Out of scope**
- Signing schema change requests. SPEC-010 reuses this mechanism with `entity_type = change_set`.
- Handwritten or biometric signatures.
- Signing documents outside LabRat.
- Cryptographic signatures with personal keys (PKI). LabRat's §11.70 linking comes from the manifest digest plus the hash-chained audit trail.
- Correcting aborted runs, or runs signed before this spec (they have no signature records to invalidate). They stay frozen; a correction is a new, linked run.
- Other GxP-mode behaviour. The setting governs only signing-policy changes for now.

## 3. Requirements (EARS)

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-008-R01 | When a signature is applied, the signature service shall store signer principal, printed name (the signer's display name at that moment), meaning, time (database clock), policy step, and the SHA-256 of the run's canonical manifest, and append an audit event `signature.applied` whose `reason` is the meaning and whose payload carries the manifest hash. | yes | 11.50(a), 11.70 |
| SPEC-008-R02 | The run manifest shall be canonical JSON of: run id, experiment id, protocol version id and SHA-256, the run's state (its outcome), params, current revision numbers of the run node and its inputs, each generated dataset's id, revision, reading count and ingest SHA-256, and each non-annotation note's id, revision and body SHA-256; equal content shall produce identical bytes, and uncommitted change sets and annotations shall not affect it. | yes | 11.70, SPEC-007-R05 |
| SPEC-008-R03 | If a signature's stored manifest hash differs from the SHA-256 of its stored manifest text, or the manifest names a different run, then the database shall reject the insert with SQLSTATE `LDE07`. | yes | 11.70 |
| SPEC-008-R04 | If a signature is applied without an ID token from the configured issuer, for the UI client and the caller's own subject, whose `auth_time` is within `LDE_SIGN_REAUTH_MAX_AGE` (default 120 s) before the request, then the signature service shall reject it with `401`. In dev, no token is needed and the signature records `reauth_method = dev`. | yes | 11.200(a) |
| SPEC-008-R05 | If a signature targets a run that isn't `completed` or `failed`, or does not fill the next unsigned step of the run's signing policy with that step's meaning, by a principal holding that step's role, then the database shall reject it with SQLSTATE `LDE07`. | yes | 11.10(g), 11.50 |
| SPEC-008-R06 | If a principal who already holds a valid signature on a run signs another step of it, then the database shall reject it with SQLSTATE `LDE07`. | yes | four-eyes |
| SPEC-008-R07 | If a principal of kind `agent` or `service` applies a signature, then the database shall reject it with SQLSTATE `LDE07`. | yes | 11.100(a), ROADMAP D6 |
| SPEC-008-R08 | The database shall treat a run's sealed set (SPEC-002) as sealed while the run is `signed` or `aborted` or has at least one valid signature, the run shall move to `signed` when every policy step has a valid signature, and no statement by `lde_app` shall set `signed` directly (SQLSTATE `LDE07`). | yes | 11.10(c) |
| SPEC-008-R09 | If a change set that touches a sealed record is committed by its author, by the human an agent author acts for, or by a principal without `reviewer` or `qa`, then the database shall reject the commit with SQLSTATE `LDE07`. | yes | 11.10(c), four-eyes |
| SPEC-008-R10 | When a change set that touches a run with valid signatures is committed, the signature service shall, in the same transaction, mark every valid signature on the run invalidated (with time and change set id), append a `signature.invalidated` event for each, and return a `signed` run to the state it held before signing (`completed` or `failed`). If the run is aborted or was signed before this spec, the commit shall be rejected with `409`. | yes | 11.10(e), 11.70 |
| SPEC-008-R11 | If any role attempts to delete a signature or manifest, change any manifest field, or change any signature field other than setting the invalidation fields once, then the database shall reject the statement: `lde_app` holds no such privilege (SQLSTATE `42501`), and for any role that does, including the owner, and for a second invalidation, a trigger raises `LDE03`. | yes | 11.70 |
| SPEC-008-R12 | The run view in the UI and every API representation of a run (create, read, list, transition) shall show each signature's printed name, date and time with time zone, meaning, and whether it is valid or invalidated, with the reason. | yes | 11.50(a), (b) |
| SPEC-008-R13 | When a run is created, the database shall copy the experiment's signing policy onto the run, and later policy changes shall not affect existing runs. | no | predictability |
| SPEC-008-R14 | The run lifecycle shall no longer accept `to: signed` through the transitions endpoint (`400`); signing shall happen only through the signatures endpoint. | no | single path |
| SPEC-008-R15 | If an experiment's signing policy is changed by a principal without `qa` or `admin` in a GxP tenant, or without `reviewer`, `qa` or `admin` in a non-GxP tenant, then the database shall reject it with SQLSTATE `LDE05`. A tenant is GxP unless changed; `lde_app` shall not be able to change the setting, and every change shall be audited with a reason. | yes | 11.10(g), (k) |
| SPEC-008-R16 | If the signer's display name is blank, then the database shall reject the signature with SQLSTATE `LDE07`. | yes | 11.50(a)(1) |
| SPEC-008-R17 | When an admin corrects a principal's display name, the principals API shall require a non-blank name and a reason and audit `principal.renamed`; signatures already applied shall keep their printed name. | no | 11.50(a)(1) |
| SPEC-008-R18 | If a signature request's `manifest_sha256` differs from the run's manifest at signing time, then the signature service shall reject it with `409` and write nothing. | yes | 11.50, 11.70 |
| SPEC-008-R19 | While a run has a valid signature whose manifest differs from the current one (an input record was revised), the manifest API and sign dialog shall list what changed since that signature. | no | 11.50 |
| SPEC-008-R20 | If a commit of a change set that touches a run with valid signatures doesn't carry the `items_sha256` of the stored items, then the change set API shall reject it with `409` and write nothing. | yes | 11.10(c), four-eyes |

## 4. Acceptance examples

Fixture: experiment `E` with the default policy `[{step:1, meaning:"author", role:"scientist"}, {step:2, meaning:"review", role:"reviewer"}]`. Principals alice (scientist, display name "Alice Ng"), bob (reviewer, "Bob Ortiz"), dana (scientist + reviewer, "Dana Ito"), bot (agent for dana). Run `R` is completed with dataset `D`.

**SPEC-008-R01 / R02**: alice signs step 1, "author", re-authenticated 30 s earlier. The signature row has printed name "Alice Ng", meaning "author", step 1, and `manifest_sha256` equal to SHA-256 of the manifest. Building the manifest twice yields identical bytes. A proposed change set and an annotation leave those bytes unchanged. The audit event `signature.applied` has `reason = "author"` and payload `manifest_sha256`.

**SPEC-008-R03**: inserting a signature whose `manifest_sha256` is altered by one bit fails with `LDE07`. A manifest whose `run_id` is another run fails with `LDE07`.

**SPEC-008-R04**: alice re-authenticated 10 minutes earlier → `401`, and no signature row is written. The same for: no token, a token with no `auth_time`, bob's token, and a token for another audience.

**SPEC-008-R05**: bob signing step 2 before step 1 exists fails with `LDE07`. Alice (scientist only) signing step 2 fails with `LDE07`. Alice signing step 1 of a `running` run fails with `LDE07`.

**SPEC-008-R06**: dana signs step 1, then dana signs step 2 → `LDE07`. Bob then signs step 2 → OK.

**SPEC-008-R07**: bot (acting for dana) signing step 1 → `LDE07`.

**SPEC-008-R08**: after alice's step-1 signature, adding an edge `X` →used→ `R` fails with `LDE04`, and `R.state` is still `completed`. After bob signs step 2, `R.state = signed`. As `lde_app`, `UPDATE runs SET state = 'signed'` on another completed run fails with `LDE07`.

**SPEC-008-R09 / R10**: with `R` signed, alice proposes correcting param `anneal_temp_c` 60 → 62 (reason "transcription error"). Alice's own commit → `LDE07`. A second scientist's commit → `LDE07`. Bob commits it. Both signatures are marked invalidated by that change set, two `signature.invalidated` events are appended, `R.state = completed`, the params revision history shows 60 then 62, and the step-1 signature can be applied again. With a delegation dana → bot, a correction bot proposes can't be committed by dana (`LDE07`). A signed run that had been `failed` returns to `failed`. A correction to an aborted run is `409`.

**SPEC-008-R11**: as `lde_app`, `UPDATE signatures SET meaning = 'review'` and `DELETE` fail with `42501`. As the owner, the same statements fail with `LDE03`. Setting `invalidated_at` a second time fails with `LDE03`.

**SPEC-008-R12** (Playwright): open signed run `R`. The signatures panel shows "Alice Ng, author, 2026-10-18 14:03 UTC" and "Bob Ortiz, review, …". After the correction above, both show as "Invalidated by change set …: transcription error". The API's run read, list and transition responses carry the same fields.

**SPEC-008-R15**: in a GxP tenant, a scientist or reviewer changing `E`'s policy fails with `LDE05`, and a QA or admin succeeds. In a non-GxP tenant, a scientist fails and a reviewer succeeds. Runs created before the change keep the old policy. As `lde_app`, `UPDATE tenants SET gxp = false` fails with `42501`. As the owner, changing it with no audit event fails with `LDE02`.

**SPEC-008-R16**: a principal with `display_name = ''` and the right role signing step 1 fails with `LDE07`.

**SPEC-008-R18**: alice fetches the manifest. A sample input is then revised. Alice's request with the earlier hash is `409`, with no signature row. Fetching the new manifest and signing succeeds.

**SPEC-008-R20**: with `R` signed, bob opens alice's proposed correction. Alice then replaces its items. Bob's commit with the hash he read is `409`, and nothing changes. A commit with no hash is `409`. After bob reads the new items, committing with their hash succeeds.

## 5. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | Confirm the v1 meanings vocabulary (`author`, `review`, `approval`, `verification`). Is a QA "release" meaning needed for manufacturing? | Rob Bassett | Confirmed; no `release` yet. QA uses `approval`. Adding a meaning needs a spec (2026-11-01) |
| 2 | Should a correction invalidate *all* signatures or only those from steps whose content changed? | Rob Bassett | All (2026-11-01) |
| 3 | Notify signers (email or webhook) when a run reaches their step? | Rob Bassett | Out of scope for v1; the inbox is enough (2026-11-01) |
| 4 | Does appending data to a signed run (new ingest) always need a correction, or can policy allow "append without re-sign"? | Rob Bassett | Always a correction for data, never for annotations (2026-11-01) |
| 5 | Who may change a signing policy? | Rob Bassett | `qa` or `admin` in GxP; `reviewer`, `qa` or `admin` in non-GxP (2026-11-01) |
| 6 | An input record revised between steps means signers sign different manifests. What happens? | Rob Bassett | Allowed. Each signature binds what its signer saw, and the sign dialog shows what changed (2026-11-01) |
