# SPEC-008 design: Electronic signatures v2

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: a `signatures` table plus a `signature_manifests` table storing the canonical manifest text, with a generated `sha256`. Go builds the manifest using the audit package's canonical JSON. Triggers enforce policy order, roles, four-eyes, principal kind and immutability. The service checks re-auth freshness, because only it sees the token and its setting. The seal predicate gains "or has ≥ 1 valid signature". Signing happens through one endpoint.
- Not doing: a workflow engine, configurable signature forms, or per-step deadlines and notifications (open question 3).

## 2. Data and interfaces

Every new trigger function has `SET search_path = pg_catalog, public, pg_temp` and writes relations as `public.<name>` (SPEC-007 decision log). `lde_app`-only stamps and role checks follow the SPEC-006 pattern; the owner passes them.

### GxP mode and signing policies (migration `0015_signing_policy`)

- `tenants.gxp boolean NOT NULL DEFAULT true`. `lde_app` holds only `SELECT` on `tenants`, so the setting can't be changed through the API. `tenants_gxp_audited` is a deferred constraint trigger on update of `gxp`; it raises `LDE02` unless the transaction wrote a `tenant.gxp_changed` event (`entity_type = 'tenant'`, `entity_id` = the tenant id). It needs its own function because `lde_require_audit` reads `NEW.tenant_id`.
- `signing_policy_valid(p jsonb) RETURNS boolean`, `IMMUTABLE`: a non-empty array whose elements are `{step, meaning, role}`, with steps exactly `1..n` in order, `meaning` in the vocabulary, and `role` in `scientist`, `reviewer`, `qa`.
- Meanings vocabulary (v1): `author`, `review`, `approval`, `verification`. Adding one needs a spec.
- `experiments.signing_policy jsonb NOT NULL DEFAULT '[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"review","role":"reviewer"}]'`, `CHECK (signing_policy_valid(signing_policy))`. Creating an experiment always gets the default, so a policy can only be weakened through the gated path.
- `experiments_revisions` is dropped and recreated as `record_revise('experiment', 'title', 'signing_policy')`, so policy changes are revisions. `GRANT UPDATE (signing_policy) ON experiments TO lde_app`.
- `runs.signing_policy jsonb NOT NULL` with the same default and check (the default fills existing rows without firing triggers), and `runs.signed_from text CHECK (signed_from IN ('completed', 'failed'))`.
- `runs_copy_signing_policy` (`BEFORE INSERT`) sets `NEW.signing_policy` from the experiment (R13). `runs_signing_columns` (`BEFORE UPDATE`): changing `signing_policy` raises `LDE03` for every role; changing `signed_from` as `lde_app` raises `LDE03`.

### Printed names (also `0015`)

`CREATE OR REPLACE principals_reject_mutation()` removes `display_name` from the immutable list, and a blank new name raises `check_violation`. `GRANT UPDATE (display_name) ON principals TO lde_app`; `principals_admin_only` already gates updates. `principals_name_audited` is `lde_require_audit('principal', '', 'principal.renamed')`, `WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name)`. Dev sign-in now creates principals with `display_name = handle`.

### Signatures (migration `0016_signatures`)

| Table | Columns |
|---|---|
| `signature_manifests` | `id` uuid PK, `tenant_id`, `run_id` (FK runs), `manifest` text, `sha256` bytea `GENERATED ALWAYS AS (protocol_sha256(manifest)) STORED`, `created_at`. `UNIQUE (tenant_id, id)`. Append-only |
| `signatures` | `id` uuid PK, `tenant_id`, `entity_type` `CHECK (= 'run')`, `entity_id` uuid, `step` int, `meaning` `CHECK` (vocabulary), `signer_id` (FK principals), `printed_name` `CHECK (btrim(printed_name) <> '')`, `signed_at`, `manifest_id` (FK manifests), `manifest_sha256` bytea, `comment` text, `reauth_at` timestamptz NOT NULL, `reauth_method` `CHECK (IN ('oidc', 'dev'))`, `invalidated_at`, `invalidated_by_change_set` (FK change_sets). `UNIQUE (tenant_id, id)`. `CHECK ((invalidated_at IS NULL) = (invalidated_by_change_set IS NULL))`. Partial unique index on `(tenant_id, entity_type, entity_id, step) WHERE invalidated_at IS NULL` |

"Valid" means `invalidated_at IS NULL`. `entity_id` has no FK because SPEC-010 extends `entity_type`; the guard checks the run exists.

**`signatures_reject_mutation()`**, attached as `signatures_guard` (`BEFORE INSERT OR UPDATE OR DELETE … FOR EACH ROW`, and `signatures_no_truncate`). `DELETE` and `TRUNCATE` raise `LDE03`.

- **INSERT.** Checks, in order, each raising `LDE07` unless noted:
  1. As `lde_app`, set `NEW.signer_id := lde_current_principal()`. For every role, set `NEW.signed_at := clock_timestamp()` and clear the invalidation fields.
  2. Lock the run: `SELECT … FROM public.runs WHERE tenant_id AND id = NEW.entity_id FOR UPDATE`. This makes a concurrent edge, note or node edit wait (R08). It must exist and be `completed` or `failed` (R05).
  3. The manifest row: its `run_id` is `entity_id`, `manifest::jsonb->>'run_id'` is `entity_id`, and `sha256 = NEW.manifest_sha256` (R03).
  4. The signer is an enabled `human` (R07). `NEW.printed_name` is set from `display_name` and must be non-blank (R16).
  5. `NEW.step` is the lowest policy step with no valid signature. `NEW.meaning` is that step's meaning, and `lde_principal_holds(signer_id, role, NULL)` holds for that step's role (R05).
  6. The signer holds no valid signature on this run (R06).
  7. `reauth_at <= signed_at`.
- **UPDATE.** If `OLD.invalidated_at` is set, or any column but the two invalidation fields changes, raise `LDE03` (R11). The change set must be committed in this transaction (`xmin = pg_current_xact_id()::xid`), and `entity_id` must be in `change_set_touched_runs(tenant_id, items)`, otherwise `LDE07`. Stamp `invalidated_at := clock_timestamp()`.

**`signature_manifests_reject_mutation()`**: `signature_manifests_append_only` and `signature_manifests_no_truncate` raise `LDE03`.

**`change_set_touched_runs(t uuid, items jsonb) RETURNS SETOF uuid`** (`STABLE`) is the runs with at least one valid signature whose seal covers a node the items touch. Aborted runs and runs signed before this spec have no valid signature, so they aren't returned: applying the items raises `LDE04`, which is the R10 `409`. An item touches:

| `op` | Node |
|---|---|
| `update_node` | `node_id` |
| `update_run_params` | that run's `node_id` |
| `add_edge` | `to`, and `from` when `relation = 'wasGeneratedBy'` |
| `edit_note` | the note's `node_id`, unless the note is an annotation |
| `add_node`, `add_note`, `set_experiment_title`, `set_signing_policy` | none |

A run's seal covers its own node and the nodes it generated, as in `lineage_node_sealed`.

**Audit:** `signatures_audited` is `lde_require_audit('signature', 'signature.applied')`; `signatures_invalidated_audited` is `lde_require_audit('signature', '', 'signature.invalidated')`, `WHEN (OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL)`.

**RLS and grants:** enabled and forced, with `tenant_isolation` and `owner_maintenance` as in `0005`. `GRANT SELECT, INSERT (tenant_id, run_id, manifest) ON signature_manifests`, so the database sets `id` and `created_at`. `GRANT SELECT, INSERT, UPDATE (invalidated_at, invalidated_by_change_set) ON signatures`.

### Sealing and run state (migration `0017_signature_seal`)

- `lineage_node_sealed` (`CREATE OR REPLACE`, pinned): today's check, or a valid signature on a run whose node is `node` or which generated `node`.
- `lineage_nodes_reject_sealed` (`CREATE OR REPLACE`, pinned) first locks `FOR SHARE` the runs whose seal covers `OLD.id`, as `notes_reject_mutation` does, so a node edit can't land after a manifest is built.
- `signatures_settle_run()`, `AFTER INSERT OR UPDATE ON signatures FOR EACH ROW`, `SECURITY DEFINER`:
  - It counts valid signatures on the run. On INSERT, if the count equals the policy length: `UPDATE runs SET signed_from = state, state = 'signed'`.
  - On UPDATE, if the run is `signed` and the count is below the policy length: `UPDATE runs SET state = signed_from, signed_from = NULL`.
  - Running as the owner, it passes the role gates.
- `runs_reject_signed_mutation` (`CREATE OR REPLACE`, pinned): a signed run still raises `LDE03`, except an `UPDATE` where `NEW.state = OLD.signed_from`, `NEW.signed_from IS NULL`, every other column is unchanged, `current_user <> 'lde_app'`, and a signature on the run was invalidated in this transaction (`xmin`). A run with a NULL `signed_from` therefore can't leave `signed`.
- The same function: as `lde_app`, a run that is aborted or has a valid signature can't change or be deleted at all (`LDE04`), because the seal depends on its `node_id` and `state`.
- `signatures_invalidated_together`, a deferred constraint trigger: invalidating a signature while another on the run stays valid raises `LDE07` at commit (R10).
- `runs_role_gate` (`CREATE OR REPLACE`, pinned): as `lde_app`, `NEW.state = 'signed'` on insert, or moving into it on update, raises `LDE07`. Otherwise it requires `scientist`, unless `lde_reviewed_commit()` (below; `0018` adds that branch).

### Corrections (migration `0018_correction_review`)

- `change_sets.author_for uuid` (FK principals), stamped on insert as `lde_on_behalf_of()`; the guard's identity check covers it. As `lde_app`, replacing or withdrawing a proposal needs `lde_on_behalf_of()` to equal `author_for` (`LDE05`), so an agent with two delegators can't move a proposal to the other human. `change_sets.review text CHECK (review IN ('correction', 'policy'))`, stamped by the guard for `lde_app` and not granted for update.
- `lde_reviewed_commit(kind text) RETURNS boolean` (`STABLE`): `app.change_set_id` names a change set with `state = 'committed'`, `review = kind`, `decided_by = lde_current_principal()`, and `xmin` of this transaction.
- `signatures_invalidation_reviewed` (`BEFORE UPDATE`, for a valid signature): as `lde_app`, the change set must have `review = 'correction'` and `decided_by = lde_current_principal()`, else `LDE07`.
- `change_sets_guard` (`CREATE OR REPLACE`). Let `sealed` be whether `change_set_touched_runs` returns anything for `NEW.items`, and `policy` whether any item has `op = 'set_signing_policy'`. For `NEW.state IN ('committed', 'rejected')`, as `lde_app`:
  - If `sealed`: the principal must hold `reviewer` or `qa`, else `LDE07`. On a commit it must also not be `author_id` or `author_for` (an `INSERT` as `committed` is a direct edit, so its author is the committer), else `LDE07` (R09). `lde_require_human()` still applies.
  - If `policy`: `lde_require_signing_policy_role(NEW.tenant_id)`.
  - If both: `LDE07`; they go in separate change sets.
  - If either: skip `lde_require_role('scientist')` and, on a commit, stamp `NEW.review` as `correction` or `policy`.
  - Otherwise behaviour is unchanged. Proposing, replacing and withdrawing still need `scientist`.
- `lde_require_signing_policy_role(t uuid)`: `lde_require_role('qa', 'admin')` if the tenant is GxP, else `lde_require_role('reviewer', 'qa', 'admin')`. It raises `LDE05` (R15).
- `experiments_policy_gate` (`BEFORE UPDATE … WHEN (OLD.signing_policy IS DISTINCT FROM NEW.signing_policy)`) calls the same function, so an empty change set can't get a scientist past the guard.
- `lab_records_require_scientist` (`CREATE OR REPLACE`) passes without `scientist` only for: inserts and updates of `lineage_nodes`, `lineage_edges` and `notes` under `lde_reviewed_commit('correction')`, and updates of `experiments` under `lde_reviewed_commit('policy')`. Instruments, readings and protocols always need `scientist`.
- `runs_role_gate` (`CREATE OR REPLACE`) passes without `scientist` only for an update that changes nothing but `params`, under `lde_reviewed_commit('correction')`, of a run the change set's items name. It also makes `node_id` and `experiment_id` immutable for `lde_app` (`LDE03`), because the seal and `change_set_touched_runs` resolve through them.

### Manifest

Canonical JSON (`audit.Canonicalize`) with these keys. Arrays are sorted by id.

```json
{"format": "labrat.run-manifest.v1",
 "run_id": "", "experiment_id": "", "protocol_version_id": "", "protocol_sha256": "",
 "params": {}, "run_rev": 1, "node_rev": 1,
 "inputs": [{"node_id": "", "rev": 1}],
 "datasets": [{"node_id": "", "count": 0, "sha256": ""}],
 "notes": [{"note_id": "", "node_id": "", "rev": 1, "body_sha256": ""}]}
```

- `run_rev` and `node_rev` are the latest revisions of the `run` and its `lineage_node`.
- `inputs` are `used` nodes other than the protocol (as `getRun`).
- `datasets` are `wasGeneratedBy` nodes, with `count` and `sha256` from the `instrument.ingested` event (as `getRun`; null if none).
- `notes` are the non-annotation notes on the run's node and its datasets.
- Hashes are lowercase hex.

### API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /v1/runs/{id}/manifest` | | `{manifest, sha256, previous, changes}`. `manifest` is the canonical text. `previous` is the latest valid signature's `{step, sha256}` or null. `changes` is `domain.Diff` from that signature's manifest, or `[]` (R19) |
| `POST /v1/runs/{id}/signatures` | `{step, meaning, manifest_sha256, comment?, reauth_token?}` | 201, the signature |
| `GET /v1/runs/{id}/signatures` | | `{items: [signature]}` by `signed_at` |
| `GET /v1/inbox/signatures?cursor=&limit=` | | page of `{run_id, label, experiment_id, experiment_title, state, step, meaning, finished_at}`, oldest first: finished runs whose next step's role the caller holds and which the caller hasn't validly signed |
| `PATCH /v1/experiments/{id}/signing-policy` | `{signing_policy, reason}` | `{change_set_id, rev}` (a direct edit with the new item `set_signing_policy {experiment_id, signing_policy}`) |
| `PATCH /v1/principals/{id}` | `{display_name, reason}` | the principal |

- **Signature JSON:** `id, step, meaning, signer, printed_name, signed_at, manifest_sha256` (hex), `comment, reauth_method, valid, invalidated_at, invalidated_by_change_set, invalidated_reason` (the change set's reason). `signer` is the handle.
- **Runs:** create, read, list and transition responses gain `signatures` (R12) and `signing_policy`. `GET /v1/experiments/{id}` gains `signing_policy`, and `GET /v1/me` gains `tenant_gxp`.
- **Errors:** `LDE07` is `409` (`IsConflict`). `to: signed` on transitions is `400`, naming the signatures endpoint.
- **Signing transaction:** take the audit chain lock (`audit.LockChain`) first, because edits take it before their lock on the run and the opposite order deadlocks. Then `SELECT … FOR UPDATE` the run, build the manifest, compare hashes (R18), insert the manifest and signature, append `signature.applied`, and if the run is now `signed`, append `run.signed` with `reason` = the meaning and payload `{from, to}`.
- **Commit request (R20):** `POST /v1/change-sets/{id}/commit` gains `items_sha256`. For a change set that touches a run with valid signatures it is required, and a missing or different hash is `409` with nothing written. For any other change set it is optional and checked if sent.
- **Commit transaction (R10):** in `decideChangeSet`, after the `change_set.committed` event and before `applyItems`: for each run from `change_set_touched_runs`, in id order, lock it, set the invalidation fields on its valid signatures, and append `signature.invalidated` for each (entity `signature`, reason the change set's reason, payload `{run_id, change_set_id}`). If the state changed, append `run.transitioned` with the same reason and payload `{from, to}`.

### Re-authentication

OIDC defines `auth_time` for ID tokens, and what access tokens carry varies by IdP, so the service reads the ID token. The UI redirects with `prompt=login&max_age=0` (SPEC-021-R04 forwards this upstream). The redirect replaces its tokens as a sign-in does, and it sends the new ID token as `reauth_token`.

In prod the service verifies it with a second verifier (`ClientID = LDE_OIDC_UI_CLIENT_ID`), and requires `iss` and `sub` to match the caller's principal and `now - auth_time <= LDE_SIGN_REAUTH_MAX_AGE`. `reauth_at` is `auth_time`, and `reauth_method` is `oidc`. A missing UI client ID in prod makes signing `501`.

In dev no token is needed: `reauth_at` is the current time and `reauth_method` is `dev`.

### GxP setting

`labrat set-gxp --tenant <uuid> --gxp=true|false --actor <name> --reason <text>` runs as the owner, like `bootstrap-admin`, and appends `tenant.gxp_changed`.

## 3. UI

- **Signatures panel:** always on the run view, above Notes. It shows each policy step with its signature or "Awaiting". Printed name, meaning, and `signed_at` with time zone (rendered in UTC). Invalidated signatures are struck through with "Invalidated by change set …: <reason>", linked to the review inbox. A Sign button appears when the current user can sign the next step.
- **Sign dialog:** a manifest summary (protocol version, params, datasets with hashes, notes), any changes since the previous signature (R19), the meaning (preset by the step), an optional comment, the statement "By signing I confirm …", then IdP re-authentication, then a result. The pending signature (run, step, meaning, comment, hash) crosses the redirect in `sessionStorage`, and the dialog resumes on return, because the tab comes back through `location.hash`. In dev, the dialog says "Dev mode: no re-authentication".
- **Sign-off inbox:** a singleton tab, `signoff`, listing runs awaiting my step, oldest first.
- **Proposing a correction:** on a run with any signature, the params `EditField` proposes a change set (`POST /v1/change-sets`) instead of a direct edit, says it needs a reviewer, and tells the user where to find it. The same applies to a sealed node in the lineage view and to a frozen note. The fields stay read-only on aborted runs.
- **Review inbox:** a change set's detail gains `invalidates: [{run_id, signatures}]`. The card warns "Committing invalidates N signatures and returns the run for re-signing". Commit is hidden from the author of such a change set.
- **Signing policy:** the experiment view shows the policy. An edit control, needing a reason, appears for roles the setting allows, with the step list validated client-side.
- **Principals view:** a rename action with a reason.

## 4. Testing

| Requirement | Test | Where |
|---|---|---|
| R03 | `TestSignatureManifestBinding` | `internal/storage/integration_test.go` |
| R05 | `TestSignaturePolicyOrder` | `internal/storage/integration_test.go` |
| R06 | `TestSignatureFourEyes` | `internal/storage/integration_test.go` |
| R07 | `TestAgentsAndServicesCannotSign` | `internal/storage/integration_test.go` |
| R08 | `TestFirstSignatureSeals` | `internal/storage/integration_test.go` |
| R09 | `TestCorrectionCommitRoles` | `internal/storage/integration_test.go` |
| R11 | `TestSignaturesAreImmutable` | `internal/storage/integration_test.go` |
| R15 | `TestSigningPolicyChangeRoles` | `internal/storage/integration_test.go` |
| R16 | `TestSignerNeedsPrintedName` | `internal/storage/integration_test.go` |
| R01 | `TestSignatureRecord` | `internal/api/integration_test.go` |
| R02 | `TestManifestIsCanonical` | `internal/api/integration_test.go` |
| R04 | `TestSigningNeedsFreshReauth` | `internal/api/integration_test.go` |
| R10 | `TestCorrectionInvalidatesSignatures` | `internal/api/integration_test.go` |
| R12 | `TestRunsShowSignatures`; `signatures.spec.ts` | `internal/api/integration_test.go`; `web/e2e/` |
| R18 | `TestSigningBindsToShownManifest` | `internal/api/integration_test.go` |
| R20 | `TestCommitBindsToReviewedItems` | `internal/api/integration_test.go` |

Existing tests that change with this spec:

- `TestRoleGatesOnLabRecords` and `TestSigningChangesNothingElse` (SPEC-006-R06): setting `signed` directly is now `LDE07` for every `lde_app` principal.
- `TestSealedCommitConflicts` (SPEC-007-R10): aborted still `409`. The signed case moves to `TestCorrectionInvalidatesSignatures`.
- `newSealFixture` keeps working: it sets the state as the owner, and that signed run has no signature rows, so it behaves as a run signed before this spec.
- `domain_test.go` is unchanged: the domain still says `completed → signed` and that `signed` is terminal for transitions. The endpoint refuses, and only the database reopens a run.

## 5. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-18 | Signature binds to a manifest digest, stored as text alongside | §11.70 linking can be re-verified later, offline | Binding to the run id only |
| 2026-10-18 | First signature seals | Data can't drift between signing steps | Sealing only at full sign-off |
| 2026-10-18 | Corrections return the run to its pre-signing state, superseding "signed is terminal" | Corrections must be possible without obscuring history | Corrective new run only (heavy for a typo) |
| 2026-11-01 | GxP mode is `tenants.gxp`, default true, changed only by the owner CLI. It decides who may change a signing policy: `qa`/`admin` in GxP, `reviewer`/`qa`/`admin` otherwise | Decided by the owner. A trigger can read a tenant column but not a server environment variable, and invariants live in the database. Failing closed means a forgotten setting is the strict one. An API toggle would let an admin weaken GxP controls in the app | A server env var (invisible to triggers, one setting per deployment); per-experiment or per-namespace (no second use yet) |
| 2026-11-01 | Input records can be revised between signing steps. Each signature binds the revisions its signer saw, and the dialog lists what changed | Decided by the owner. Samples and lots are shared across runs, so one edit mustn't stall unrelated runs. The prior revisions remain readable | Blocking the next step; sealing inputs |
| 2026-11-01 | Correcting a run returns it to `signed_from`, not always `completed` | A failed run can be signed. Returning it as `completed` would falsify the outcome | The original R10 wording |
| 2026-11-01 | Aborted runs and runs signed before this spec stay frozen | They have no signature to invalidate. Reopening them would leave a run unsigned with no record of why | Allowing corrections with no invalidation |
| 2026-11-01 | A reviewer or QA who isn't a scientist can commit and apply a correction, through `lde_reviewed_commit()` | The R09/R10 example needs it. Review needn't imply lab-bench rights, and the gate is limited to a change set they committed in this transaction | Requiring reviewers to hold `scientist` too |
| 2026-11-01 | `change_sets.author_for` extends four-eyes to agent proposals | The author id is the agent's, so the human it acts for could otherwise review their own correction | Parsing the `author` text |
| 2026-11-01 | Re-auth comes from a fresh ID token, checked in the service; the design's trigger on freshness is dropped | `auth_time` is defined for ID tokens, and Entra and Okta are the target IdPs. The database can't see the setting or verify the token | Reading the access token |
| 2026-11-01 | The sign request carries `manifest_sha256` | The redirect sits between viewing and signing, so a signer could otherwise sign content they never saw | Building the manifest only at POST |
| 2026-11-01 | `display_name` becomes correctable by an admin, audited, and a blank one blocks signing. This amends the `principals` immutability of SPEC-006; handles and subjects stay immutable | §11.50 needs a printed name, it defaults to blank, and `(issuer, subject)` is unique, so a principal with a blank or outdated name could never be fixed. Signatures keep the name they were signed with | Falling back to the handle, which isn't a printed name |
| 2026-11-01 | `signatures` keeps `entity_type`/`entity_id`, though only `run` is allowed now | SPEC-010 is a specified second use | A `run_id` column that SPEC-010 would have to migrate |
| 2026-11-02 | Experiment inserts by lde_app are forced to the default policy; the gxp audit event must carry a reason; run inserts clear signed_from | Found by integrity review of 0015: the column DEFAULT alone let lde_app insert a weaker policy (bypassing R15), R15 requires a reason, and signed_from must start empty | Relying on Go |
| 2026-11-03 | The signature guard function is `signatures_reject_mutation()`, with the trigger named `signatures_guard`, as for notes. `lde_app` inserts manifests through a column grant. From the integrity review of tasks 2.1-2.7 | Matches the `*_reject_*` naming. A client could otherwise choose a manifest's `created_at` | A trigger stamping `created_at`, which is more code for the same result |
| 2026-11-03 | While a run is aborted or holds a valid signature, `lde_app` can't change its row at all (`LDE04`). Invalidating one of several signatures fails at commit. Settling a run locks it. Signing takes the audit chain lock before the run lock. From the integrity review of tasks 2.8-2.9 | A probe repointed `node_id`, edited the sealed node and pointed it back, with no invalidation; aborted runs could be reopened the same way. R10's "every signature" was only enforced in Go, and a stale signature could sit beside a re-signed step. Concurrent settling could leave a run `signed` with a step unsigned. The two lock orders deadlocked | Freezing only named columns, where a later column would be missed; retrying on `40P01` |
| 2026-11-03 | From the integrity review of tasks 3.1-3.3: `reviewed` became `review` (`correction` or `policy`), and each passes only the gates its own work needs. Invalidating needs a correction reviewed by this principal. A run's `node_id` and `experiment_id` are immutable. A replace or withdraw must act for the same human as the proposal. A commit of a correction carries `items_sha256` (R20) | A probe let a scientist strip a signed run's signatures by repointing a run of their own at its dataset. A no-op policy item let one admin write readings and change runs with no second person. A real correction let a reviewer abort unrelated runs. An agent with two delegators defeated `author_for`. An author could swap items after review, so a reviewer could commit what they never read | A gate per `op` matched to each statement, which is more code than the table scope. A reviewer with arbitrary SQL can still edit an unrelated unsealed node under their correction; the revision records it under that change set |
