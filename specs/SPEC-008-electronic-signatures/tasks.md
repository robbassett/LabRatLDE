# SPEC-008 tasks: Electronic signatures v2

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

`make test-integration` needs `docker compose up -d`. This spec's migrations stop other branches signing runs, so give it a database of its own while it is in flight: run `CREATE DATABASE lde_spec008 OWNER lde`, then `make test-integration TEST_DB=postgres://lde:lde@localhost:5432/lde_spec008?sslmode=disable`.

Every task ends with `gofmt -l .` printing nothing and `go vet ./...` clean. UI tasks also end with `cd web && npm run build` clean. New trigger functions follow the design's `search_path` rule. Migrations start at `0015`.

Storage tests run SQL directly, as the owner (`db.Pool`) or as `lde_app` (`db.WithTenant`). Task 2.1 adds these helpers to `internal/storage/integration_test.go`:

- `newSigner(t, db, tenant, handle, displayName, kind string, roles ...string) storage.Principal`: `newPrincipal`, then as the owner `UPDATE principals SET display_name` with a `principal.renamed` event.
- `applySignature(ctx, tx, tenant, runID, actor string, step int, meaning string) (string, error)`: inserts a manifest with text `{"run_id":"<runID>"}`, inserts the signature (`entity_type 'run'`, `manifest_sha256` from the manifest's `RETURNING sha256`, `signer_id` the current principal, `printed_name 'x'`, `reauth_at now()`, `reauth_method 'dev'`), appends a `signature.applied` event in `tx`, and returns the signature id. The guard stamps the signer and printed name.
- `signFixture`: `newSealFixture(t, db, "completed")` plus `alice` ("Alice Ng"; scientist), `bob` ("Bob Ortiz"; reviewer), `dana` ("Dana Ito"; scientist, reviewer), and `bot` (agent; scientist, reviewer) with a delegation from dana.

## Phase 1: Signing policies and printed names

- [x] 1.1 Migration `0015_signing_policy`
  - Requirements: SPEC-008-R13, SPEC-008-R15 (setting), SPEC-008-R17
  - Files: `internal/storage/migrations/0015_signing_policy.sql`, `cmd/server/iq.go`
  - Do: everything in design §2 "GxP mode and signing policies" and "Printed names": `tenants.gxp`, `tenants_gxp_audited`, `signing_policy_valid`, the `experiments` and `runs` columns, the replaced `experiments_revisions`, `runs_copy_signing_policy`, `runs_signing_columns`, the replaced `principals_reject_mutation`, `principals_name_audited`, and the grants. Add the four new triggers to `iqTriggers`.
  - Verify: `make test-integration TEST_DB=…` passes. `psql`: a new run's `signing_policy` equals its experiment's; `UPDATE runs SET signing_policy = '[]'` is rejected.
  - Integrity: yes

## Phase 2: Signature records

- [x] 2.1 Test: a signature binds to its manifest (SPEC-008-R03)
  - Requirements: SPEC-008-R03
  - Files: `internal/storage/integration_test.go`
  - Do: add the three helpers above. `TestSignatureManifestBinding`, as alice, with the R03 examples, each checked with `wantCode`:
    1. A correct manifest and hash succeeds (a fresh `signFixture`).
    2. The hash with its last byte flipped fails with `LDE07`.
    3. A manifest row for another run fails with `LDE07`.
    4. A manifest row for this run whose text names another `run_id` fails with `LDE07`.
    - Comment `// SPEC-008-R03`.
  - Verify: `make test-integration TEST_DB=…` fails only on the new test (`signature_manifests` doesn't exist).
  - Integrity: yes
- [x] 2.2 Test: signing follows the policy (SPEC-008-R05)
  - Requirements: SPEC-008-R05
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSignaturePolicyOrder`, with `applySignature` and these cases:
    1. Bob signing step 2 with nothing signed fails with `LDE07`.
    2. Alice signing step 2 fails with `LDE07`.
    3. Alice signing step 1 with meaning `review` fails with `LDE07`.
    4. Bob signing step 1 fails with `LDE07` (no `scientist`).
    5. On a `newSealFixture(t, db, "running")` run, alice signing step 1 fails with `LDE07`.
    6. On a `failed` run, alice signing step 1 succeeds.
    7. On the completed run, alice's step 1 then bob's step 2 succeed.
    - Comment `// SPEC-008-R05`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 2.3 Test: no person signs twice (SPEC-008-R06)
  - Requirements: SPEC-008-R06
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSignatureFourEyes`: dana signs step 1, dana signing step 2 fails with `LDE07`, and bob signing step 2 succeeds. Comment `// SPEC-008-R06`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 2.4 Test: agents and services can't sign (SPEC-008-R07)
  - Requirements: SPEC-008-R07
  - Files: `internal/storage/integration_test.go`
  - Do: `TestAgentsAndServicesCannotSign`: `storage.Principal{ID: bot.ID, OnBehalfOf: dana.ID}` signing step 1 fails with `LDE07`, and a service principal holding `scientist`, with a display name, fails with `LDE07`. Comment `// SPEC-008-R07`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 2.5 Test: a signer needs a printed name (SPEC-008-R16)
  - Requirements: SPEC-008-R16
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSignerNeedsPrintedName`: `newPrincipal` (blank display name; scientist) signing step 1 fails with `LDE07`. After an owner rename with its audit event, the same call succeeds, and `printed_name` is the new name, whatever the statement passed. Comment `// SPEC-008-R16`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 2.6 Test: signatures are immutable (SPEC-008-R11)
  - Requirements: SPEC-008-R11
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSignaturesAreImmutable`, with alice's step-1 signature `sig` and its manifest:
    1. As `lde_app`, `UPDATE signatures SET meaning = 'review'`, `DELETE FROM signatures`, `TRUNCATE signatures`, `UPDATE signature_manifests SET manifest = 'x'` and `DELETE FROM signature_manifests` each fail with `42501`.
    2. As the owner, each of those fails with `LDE03`.
    3. As `lde_app`, setting the invalidation fields with no change set committed in the transaction fails with `LDE07`.
    4. With a change set proposed by alice whose items are `[{"op":"update_run_params","run_id":<run>,"params":{}}]`, committed by `as(tenant)` (all roles) in the same transaction, invalidating `sig` with a `signature.invalidated` event succeeds.
    5. Setting `invalidated_at` again fails with `LDE03`.
    - Comment `// SPEC-008-R11`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 2.7 Migration `0016_signatures`
  - Requirements: SPEC-008-R03, SPEC-008-R05, SPEC-008-R06, SPEC-008-R07, SPEC-008-R11, SPEC-008-R16
  - Files: `internal/storage/migrations/0016_signatures.sql`, `internal/storage/postgres.go`, `cmd/server/iq.go`
  - Do: everything in design §2 "Signatures". `storage.CodeSignature = "LDE07"`, added to `IsConflict`. Add `signatures_guard`, `signatures_no_truncate`, `signature_manifests_append_only`, `signature_manifests_no_truncate`, `signatures_audited` and `signatures_invalidated_audited` to `iqTriggers`.
  - Verify: `make test-integration TEST_DB=…` passes, including 2.1–2.6.
  - Integrity: yes
- [x] 2.8 Test: the first signature seals, the last signs (SPEC-008-R08)
  - Requirements: SPEC-008-R08
  - Files: `internal/storage/integration_test.go`
  - Do:
    - `TestFirstSignatureSeals`, as the R08 example. After alice's step 1: a new edge into `f.r` and an attrs update of `f.d` (inside a committed change set) fail with `LDE04`, an annotation succeeds, and `state` is `completed`. After bob's step 2: `state` is `signed` and `signed_from` is `completed`.
    - On a `failed` fixture, the same two signatures leave `signed_from = 'failed'`.
    - As `lde_app`, `UPDATE runs SET state = 'signed'` on a fresh completed run fails with `LDE07`, for alice and for bob.
    - As `lde_app`, inserting a run in state `signed` fails with `LDE07`.
    - A signed run: `UPDATE runs SET state = 'completed'` fails with `LDE03` as `lde_app` and as the owner.
    - Comment `// SPEC-008-R08`.
    - Extend `TestSealedSet` (SPEC-002-R01): a completed run with one signature is sealed for `R` and `D`, and not for `S`.
  - Verify: fails only on `TestFirstSignatureSeals` and the new `TestSealedSet` case.
  - Integrity: yes
- [x] 2.9 Migration `0017_signature_seal`
  - Requirements: SPEC-008-R08
  - Files: `internal/storage/migrations/0017_signature_seal.sql`, `internal/storage/integration_test.go` (existing tests only), `internal/api/integration_test.go` (existing test only), `cmd/server/iq.go`
  - Do:
    - Everything in design §2 "Sealing and run state". Add `signatures_settle_run` to `iqTriggers`.
    - In `TestRoleGatesOnLabRecords`, setting `signed` is now `LDE07` for alice, bob and bot.
    - Rewrite `TestSigningChangesNothingElse` to assert `LDE07` for each principal. Keep its `// SPEC-006-R06` comment.
    - `TestSealedCommitConflicts` (SPEC-007-R10) can no longer sign through the transitions endpoint. Keep the aborted run. Replace the signed run with `db.Pool.Exec` setting a completed run `signed`, which leaves no signature rows and is still 409 (`LDE04`).
  - Verify: `make test-integration TEST_DB=…` passes, including 2.8.
  - Integrity: yes

## Phase 3: Corrections in the database

- [x] 3.1 Test: who may commit a correction (SPEC-008-R09)
  - Requirements: SPEC-008-R09
  - Files: `internal/storage/integration_test.go`
  - Do: `TestCorrectionCommitRoles`. Signed run from `signFixture` (alice, bob). Alice proposes `update_run_params`. Each case below is its own transaction, and each failure leaves the proposal open:
    1. Alice commits: `LDE07`.
    2. Another scientist commits: `LDE07`.
    3. Bot for dana proposes the same items. Dana commits: `LDE07`.
    4. A direct insert as `committed` by a principal holding scientist and reviewer: `LDE07`.
    5. Bob commits alice's proposal, invalidates both signatures with their events, sets `app.change_set_id` and updates params. It succeeds, though bob isn't a scientist.
    6. In a new transaction, bob updating a node without a committed change set: `LDE05`.
    7. A change set with `add_note` on the sealed node commits under scientist alone, with no invalidation.
    - Comment `// SPEC-008-R09`.
  - Verify: fails only on the new test.
  - Integrity: yes
- [x] 3.2 Test: who may change a signing policy (SPEC-008-R15)
  - Requirements: SPEC-008-R15
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSigningPolicyChangeRoles`. Helper `setPolicy(ctx, tx, tenant, expID, actor, policy)` inserts a committed change set whose item is `set_signing_policy`, sets `app.change_set_id`, and updates `experiments.signing_policy`.
    - A new tenant reads `gxp = true`.
    - GxP: scientist and reviewer fail with `LDE05`; qa and admin succeed.
    - A scientist with an empty-items committed change set updating the column directly fails with `LDE05`.
    - As `lde_app`, `UPDATE tenants SET gxp = false` fails with `42501`. As the owner with no event, it fails with `LDE02` at commit. With a `tenant.gxp_changed` event, it succeeds.
    - Non-GxP: scientist fails with `LDE05`; reviewer succeeds.
    - An experiment inserted as `lde_app` with a one-step policy gets the default policy.
    - A run created before the change keeps its old policy, and one created after has the new one (SPEC-008-R13, checked here, not a separate test).
    - An invalid policy (a gap in steps, an unknown meaning, empty) fails with `23514`.
    - Comment `// SPEC-008-R15`.
  - Verify: fails only on the new tests.
  - Integrity: yes
- [x] 3.3 Migration `0018_correction_review`
  - Requirements: SPEC-008-R09, SPEC-008-R15
  - Files: `internal/storage/migrations/0018_correction_review.sql`, `cmd/server/iq.go`
  - Do: everything in design §2 "Corrections". Copy the current `change_sets_guard` and `runs_role_gate` bodies from `0011` and `0017`, and change only what the design says. Add `experiments_policy_gate` to `iqTriggers`.
  - Verify: `make test-integration TEST_DB=…` passes, including 3.1 and 3.2. `go run ./cmd/server iq` passes.
  - Integrity: yes

## Phase 4: API

- [x] 4.1 Config and the re-auth verifier
  - Requirements: SPEC-008-R04 (plumbing)
  - Files: `internal/config/config.go`, `internal/api/server.go`, `cmd/server/main.go`, `internal/api/integration_test.go` (fixture and every `api.New` call)
  - Do:
    - `SignReauthMaxAge time.Duration` from `LDE_SIGN_REAUTH_MAX_AGE`, default `120s`.
    - `api.New(cfg, db, log, verifier, reauth TokenVerifier)`. `main` builds `provider.Verifier(&oidc.Config{ClientID: cfg.OIDCUIClientID})` when the client ID is set.
    - Tests: `prodServer` sets `OIDCUIClientID: "labrat-ui"`, `SignReauthMaxAge: 120 * time.Second`, and a second `oidc.NewVerifier` for that client. Add `reauthToken(t, key, subject, age time.Duration) string` (`aud` `labrat-ui`, `auth_time` = now − age). `newFixture` gives alice "Alice Ng", bob "Bob Ortiz", carol "Carol Diaz" and bot "Bot".
  - Verify: `make test-integration TEST_DB=…` passes.
- [x] 4.2 Test: the manifest is canonical (SPEC-008-R02)
  - Requirements: SPEC-008-R02
  - Files: `internal/api/integration_test.go`
  - Do: `TestManifestIsCanonical`, dev mode. A completed run with params `{"b": 1.50, "a": 2}`, a sample input, an ingested dataset and a note.
    - Two `GET /v1/runs/{id}/manifest` calls return identical bytes, and `sha256` is the SHA-256 of `manifest`.
    - Decode it and check every key in design §2 "Manifest", and that `a` sorts before `b`.
    - A proposed change set leaves the bytes unchanged (SPEC-007-R05).
    - After a step-1 signature, an annotation leaves them unchanged.
    - A committed sample edit changes `inputs[0].rev`.
    - Comment `// SPEC-008-R02`.
  - Verify: fails only on the new test (404).
- [x] 4.3 `GET /v1/runs/{id}/manifest`
  - Requirements: SPEC-008-R02, SPEC-008-R19
  - Files: `internal/api/signatures.go` (new), `internal/api/server.go`
  - Do: `buildManifest(ctx, tx, runID) (text []byte, sha string, err error)` with one struct per design §2, using the queries of `getRun` and `latestRev`, through `audit.Canonicalize`. The handler adds `previous` and `changes` (`domain.Diff` of the two manifests decoded to maps). Reads only.
  - Verify: `make test-integration TEST_DB=…` passes, including 4.2.
  - Integrity: yes
- [x] 4.4 Test: the signature record (SPEC-008-R01)
  - Requirements: SPEC-008-R01
  - Files: `internal/api/integration_test.go`
  - Do: helper `signAs(t, srv, key, who identity.Principal, runID string, step int, meaning string) (status int, body []byte)`: mint the access token, GET the manifest, POST with `reauthToken(…, 30*time.Second)`. `TestSignatureRecord` follows the R01 example, on `prodServer`, reading the row as the owner: printed name, meaning, step, `manifest_sha256`, `reauth_method = oidc`, and `reauth_at` = the token's `auth_time`. The `signature.applied` event has `reason = "author"` and the hash in its payload. After bob's step 2, a `run.signed` event exists. Comment `// SPEC-008-R01`.
  - Verify: fails only on the new tests.
- [x] 4.5 Test: signing needs fresh re-authentication (SPEC-008-R04)
  - Requirements: SPEC-008-R04
  - Files: `internal/api/integration_test.go`
  - Do: `TestSigningNeedsFreshReauth`, table-driven on alice signing step 1. Each of these is 401 with no signature row and an unchanged `auditCount`: no token, 10 minutes old, no `auth_time`, bob's token, `aud` of `labrat`, signed by another key. A 30-second token is 201. Comment `// SPEC-008-R04`.
  - Verify: fails only on the new tests.
- [x] 4.6 Test: signing binds to the manifest shown (SPEC-008-R18)
  - Requirements: SPEC-008-R18
  - Files: `internal/api/integration_test.go`
  - Do: `TestSigningBindsToShownManifest`, as the R18 example. Revise the input through `PATCH /v1/lineage/nodes/{id}` between GET and POST. 409 and no row. The new hash is 201. Then, for bob, `changes` lists the input's `rev` and `previous` is step 1 (SPEC-008-R19, checked here). Comment `// SPEC-008-R18`.
  - Verify: fails only on the new tests.
- [x] 4.7 Signature endpoints
  - Requirements: SPEC-008-R01, SPEC-008-R04, SPEC-008-R18
  - Files: `internal/api/signatures.go`, `internal/api/server.go`, `internal/identity/identity.go`, `internal/api/identity.go`
  - Do:
    - `POST` and `GET /v1/runs/{id}/signatures` as design §2 "Signing transaction" and "Re-authentication".
    - Extract `audit.LockChain(ctx, tx, tenantID) error` from the first statement of `audit.Append` (the same lock, no change to the digest; `Append` calls it). Signing calls it before locking the run, as the design says.
    - `checkReauth(ctx, r, tx, p, token) (at time.Time, method string, err error)`, checked before anything is written. Unknown claims and all token failures are `unauthorized`.
    - A blank `meaning` or malformed hash is 400.
    - Dev principals get `DisplayName: handle` in `createDevPrincipal`.
    - The signature's JSON is one `signature` struct and `loadSignatures(ctx, tx, runID)` with the join for `invalidated_reason`.
  - Verify: `make test-integration TEST_DB=…` passes, including 4.4–4.6.
  - Integrity: yes
- [x] 4.8 Test: a correction invalidates signatures (SPEC-008-R10)
  - Requirements: SPEC-008-R10
  - Files: `internal/api/integration_test.go`
  - Do: `TestCorrectionInvalidatesSignatures`, as the R09/R10 example, on `prodServer`.
    - Every commit in this test sends the `items_sha256` it read (R20, task 4.8a).
    - Alice proposes `update_run_params`, 60 → 62, reason "transcription error". Her commit is 409. A `PATCH /v1/runs/{id}/params` by alice is 409.
    - Bob's commit is 200. Both signatures have `valid = false`, the change set id and the reason. There are two `signature.invalidated` events and one `run.transitioned` with `from: signed`. `state` is `completed`. The revision history shows 60 then 62. Alice can sign step 1 again, against a new manifest.
    - A failed, signed run returns to `failed`.
    - A partly signed run (step 1 only) is invalidated and stays `completed`.
    - A note edit on a sealed node counts; an annotation edit doesn't, and leaves signatures valid.
    - Comment `// SPEC-008-R10`.
  - Verify: fails only on the new tests.
- [x] 4.8a Test: a commit binds to the items reviewed (SPEC-008-R20)
  - Requirements: SPEC-008-R20
  - Files: `internal/api/integration_test.go`
  - Do: `TestCommitBindsToReviewedItems`, as the R20 example, on `prodServer`. After each 409, the change set is still proposed and the signatures are valid. Comment `// SPEC-008-R20`. Added by the integrity review of Phase 3.
  - Verify: fails only on the new tests.
- [x] 4.9 Corrections in commit
  - Requirements: SPEC-008-R10
  - Files: `internal/api/changesets.go`, `internal/api/signatures.go`
  - Do:
    - The commit request, as design §2 "Commit request": read `items_sha256` from the body, and compare it in the transaction after locking the change set.
    - `invalidateTouched(ctx, tx, p, csID, reason string) error`, as design §2 "Commit transaction". `decideChangeSet` calls it on a commit, between the `change_set.committed` event and `applyItems`.
    - `getChangeSet` gains `invalidates: [{run_id, signatures}]` for a proposed change set.
  - Verify: `make test-integration TEST_DB=…` passes, including 4.8.
  - Integrity: yes
- [x] 4.10 Transitions refuse `signed`
  - Requirements: SPEC-008-R14
  - Files: `internal/api/runs.go`, `internal/domain/run.go`
  - Do: `transitionRun` calls `audit.LockChain` before its `FOR UPDATE`, for the lock order in design §2. In `transitionRun`, `to: signed` is `badRequest` naming `POST /v1/runs/{id}/signatures`. Remove the `TODO(part11)`, and the signing branch of `appendRunEvent`. Move `run.signed` to `signatures.go`. Update the comments on `RunState` and `Terminal`: only a committed correction reopens a signed run.
  - Verify: `curl` with `to: signed` is 400. `make test-integration TEST_DB=…` passes.
- [x] 4.11 Test: runs show their signatures (SPEC-008-R12)
  - Requirements: SPEC-008-R12
  - Files: `internal/api/integration_test.go`
  - Do: `TestRunsShowSignatures`: after alice's signature, `GET /v1/runs/{id}`, `GET /v1/experiments/{id}/runs` and a transition response on another run (empty) each have `signatures`, with printed name, meaning, RFC 3339 `signed_at` and `valid`. `POST /v1/runs` returns `signatures: []` and `signing_policy`. After a correction, `valid` is false with the reason. Comment `// SPEC-008-R12`.
  - Verify: fails only on the new test.
- [x] 4.12 Signatures on every run representation
  - Requirements: SPEC-008-R12
  - Files: `internal/api/runs.go`, `internal/domain/run.go`
  - Do: `domain.Run` gains `SigningPolicy json.RawMessage` (`signing_policy`) and `Signatures []Signature` (`signatures`, never null); move the `signature` struct to `domain`. Add the column to `runColumns`. Create, read and transition load signatures through `loadSignatures`. The list query fetches them for the page in one extra query keyed by run id.
  - Verify: `make test-integration TEST_DB=…` passes, including 4.11.
- [x] 4.13 Sign-off inbox endpoint
  - Requirements: SPEC-008-R05 (support)
  - Files: `internal/api/signatures.go`, `internal/api/server.go`
  - Do: `GET /v1/inbox/signatures`, as design §2, with `readPage` and one SQL query: the next step via `jsonb_array_elements(r.signing_policy)` with no valid signature, `lde_has_role(role)`, and no valid signature by the caller. Ordered by `finished_at, id`.
  - Verify: `curl` as dev users: a completed run lists for one user, and after they sign step 1 it no longer lists for them. Dev users hold every role, so it lists for the next user.
- [x] 4.14 Signing policy and rename endpoints, and `tenant_gxp`
  - Requirements: SPEC-008-R15, SPEC-008-R17
  - Files: `internal/api/changesets.go`, `internal/api/edits.go`, `internal/api/experiments.go`, `internal/api/principals.go`, `internal/api/server.go`, `internal/identity/identity.go`
  - Do:
    - The `set_signing_policy` item: validate, `applyItem`, `target`.
    - `PATCH /v1/experiments/{id}/signing-policy`, through `directEdit`. `signing_policy` on `getExperiment`.
    - `identity.SetDisplayName(ctx, tx, actor, tenantID, id, name, reason)`, appending `principal.renamed` with `{handle, from, to}`.
    - `PATCH /v1/principals/{id}`, requiring a name and reason (400 if blank). `tenant_gxp` on `/v1/me`.
  - Verify: `curl`: as a dev user, a policy change is 200 and shows in revisions. Under `LDE_ENV=prod` the role denial is covered by 3.2. A rename appears in the audit trail.
- [x] 4.15 `labrat set-gxp`
  - Requirements: SPEC-008-R15
  - Files: `cmd/server/setgxp.go` (new), `cmd/server/main.go`
  - Do: as design §2 "GxP setting", in the style of `bootstrap-admin`. All four flags are required, and a blank reason is an error. It updates `tenants` and appends `tenant.gxp_changed` with `{from, to}` through `WithOwner`. It prints the new value.
  - Verify: run it both ways against the dev tenant. `/v1/me` shows the change, and `/v1/audit/verify` is valid.

## Phase 5: UI

- [x] 5.1 API client
  - Requirements: SPEC-008-R12 (support)
  - Files: `web/src/api.ts`
  - Do: types `Signature`, `PolicyStep`, `RunManifest`, `SignoffItem`; `signatures` and `signing_policy` on `Run` and `RunSummary`; `signing_policy` on `Experiment`; `tenant_gxp` on `Me`; `invalidates` on `ChangeSetDetail`. Functions `getManifest`, `signRun`, `listSignoff`, `setSigningPolicy`, `renamePrincipal`.
- [x] 5.2 Re-authentication redirect
  - Requirements: SPEC-008-R04 (UI side)
  - Files: `web/src/auth.ts`, `web/src/App.tsx`
  - Do: `beginReauth(oidc, pending: PendingSign)` stores `PendingSign` (`{runId, step, meaning, comment, sha256}`) under `labrat.sign.pending` and redirects like `beginSignIn`, plus `prompt=login` and `max_age=0`. `takePendingSign(runId)` returns and removes it. `App` keeps the latest ID token, and `reauthToken()` returns it once and clears it.
  - Verify: `npm run build`. Against the local Keycloak from SPEC-006's UAT, the redirect shows the login form, and the tab is restored on return.
- [x] 5.3 Test: the signatures panel (SPEC-008-R12)
  - Requirements: SPEC-008-R12
  - Files: `web/e2e/signatures.spec.ts` (new)
  - Do: one test, citing `// SPEC-008-R12` on the line above `test(`. Through Playwright's `request` with dev headers: an admin creates alice and bob with display names and the roles from the fixture, plus a completed run; alice and bob sign through the API. In the page: sign in as bob, open the run, and expect "Alice Ng", "author", "Bob Ortiz", "review" and a time ending in `UTC`. Alice proposes and bob commits a correction through the API. Reload, and expect both rows marked invalidated with "transcription error".
  - Verify: `make e2e` fails only on the new test.
- [x] 5.4 Signatures panel
  - Requirements: SPEC-008-R12
  - Files: `web/src/SignaturesPanel.tsx` (new), `web/src/RunView.tsx`, `web/src/styles.css`
  - Do: as design §3, in a `<section>` above Notes, as a table with a caption. An invalidated row uses `<s>`, not colour alone, and has the text "Invalidated by change set …: <reason>". Show `signed_at` as `YYYY-MM-DD HH:mm UTC`, with the full timestamp in `dateTime`.
  - Verify: `make e2e` passes, including 5.3.
- [x] 5.5 Sign dialog
  - Requirements: SPEC-008-R01, SPEC-008-R04, SPEC-008-R18, SPEC-008-R19
  - Files: `web/src/SignDialog.tsx` (new), `web/src/SignaturesPanel.tsx`, `web/src/styles.css`
  - Do: as design §3. A `<dialog>` with focus returned on close. It shows the manifest summary and `changes`. A required confirmation checkbox reads "By signing I confirm I have reviewed this record, and my signature means: <meaning>". On a 409 hash mismatch it reloads the manifest and says the record changed. Errors go in `role="alert"`. In prod, confirm calls `beginReauth`; on return, `takePendingSign` resumes and posts with `reauthToken()`. The Sign button shows when the user holds the next step's role and hasn't validly signed.
  - Verify: in dev, sign a run with the keyboard only. A signature appears in the panel and in the audit viewer.
- [ ] 5.6 Sign-off inbox
  - Requirements: SPEC-008-R05 (support)
  - Files: `web/src/SignoffView.tsx` (new), `web/src/tabs.ts`, `web/src/Workspace.tsx`, `web/src/Explorer.tsx`
  - Do: the singleton tab `signoff`, "Sign-off inbox", in the explorer and palette. A table of `SignoffItem`, oldest first, where each row opens the run.
  - Verify: as a dev user, a completed run is listed and opens. After signing, it leaves that user's list.
- [ ] 5.7 Proposing a correction
  - Requirements: SPEC-008-R09, SPEC-008-R10 (UI side)
  - Files: `web/src/EditField.tsx`, `web/src/RunView.tsx`, `web/src/LineageView.tsx`, `web/src/Notes.tsx`
  - Do: `EditField` gains an optional `proposeOnly` prop. The save button reads "Propose correction", the form says it needs a reviewer, and the result links to the review inbox. A run with any signature passes it, and its `onSave` calls `POST /v1/change-sets`. Aborted runs and runs that are `signed` with no signature rows pass `readOnly` instead. The lineage view (a node whose edit returns 409 is proposed instead) and frozen notes get the same treatment, using the run's `signatures` where the view has them.
  - Verify: on a signed run in dev, propose a params change. It appears in the review inbox, and the run is unchanged.
- [ ] 5.8 Review inbox warning
  - Requirements: SPEC-008-R09, SPEC-008-R10 (UI side)
  - Files: `web/src/InboxView.tsx`
  - Do: when `invalidates` isn't empty, show the warning from design §3 in the expanded card. Hide Commit for the author. Commit sends the `items_sha256` of the items shown; on a 409 the card reloads them and says they changed. After a commit, the existing `labrat:revised` event reloads the run view.
  - Verify: as another dev user, commit the 5.7 proposal. The signatures show as invalidated, and the run returns to `completed`.
- [ ] 5.9 Signing policy and rename controls
  - Requirements: SPEC-008-R15, SPEC-008-R17
  - Files: `web/src/ExperimentView.tsx`, `web/src/PrincipalsView.tsx`, `web/src/MeView.tsx`
  - Do: the experiment view shows the steps, with an edit form (add, remove and reorder steps, a meaning and role select per step, and a required reason) when `/v1/me` roles allow it for `tenant_gxp`. A denial still shows the API's message. The principals view gets a rename form with a reason. The Me view shows "GxP mode" or "Non-GxP mode".
  - Verify: change a policy in dev and see it in the Revisions panel. Rename a principal and see it in the audit viewer.

## Phase 6: Traceability and documentation

- [ ] 6.1 Playwright results in `make validate`
  - Requirements: SPEC-008-R12 (support), SPEC-004 harness
  - Files: `tools/validate/cites.go`, `tools/validate/report.go`, `tools/validate/main.go`, `tools/validate/validate_test.go`, `web/e2e/README.md`, `web/playwright.config.ts`
  - Do:
    - `scanE2E(root)` finds `// SPEC-NNN-Rxx` on the line above `test(` in `web/e2e/*.spec.ts`, and gives a `citation` with `Package: "web/e2e"` and `Test` = the test title.
    - `readE2EResults(path, notBefore)` reads `web/test-results/results.json` (`suites[].specs[]`: `title`, `ok`) into the existing results map under `web/e2e.<title>`. It returns none if `stats.startTime` is before the HEAD commit's time, so a stale or missing file leaves those requirements `NOT VERIFIED`.
    - Add one case to the existing verdict table for a Playwright citation with no result.
    - Update the README and remove "SPEC-008 feeds" from the config comment.
  - Verify: `go test ./tools/validate/`. `make e2e && make validate` shows `SPEC-008-R12` verified with both tests.
- [ ] 6.2 Documentation and superseded requirements
  - Requirements: SPEC-008-R01–R19
  - Files: `docs/signatures.md` (new), `docs/identity.md`, `docs/revisions.md`, `README.md`, `.env.example`, `specs/implemented/SPEC-001-core-integrity/requirements.md`, `specs/implemented/SPEC-002-sealing-completeness/requirements.md`, `specs/implemented/SPEC-006-identity-and-roles/requirements.md`, `specs/implemented/SPEC-007-revisions-and-change-sets/requirements.md`
  - Do:
    - `docs/signatures.md`: policies and meanings, GxP mode and `labrat set-gxp`, re-authentication, what a manifest holds and how to re-verify one offline, corrections, what stays frozen.
    - `docs/identity.md`: the UI client must return an ID token with `auth_time` under `prompt=login`, and principals need a display name to sign.
    - README: the walkthrough's `curl` and state diagram, and the status row.
    - `.env.example`: `LDE_SIGN_REAUTH_MAX_AGE`.
    - A one-line note under each superseded requirement naming SPEC-008, as SPEC-007 did for SPEC-002.

## Phase 7: Verify and close out

- [ ] 7.1 `verifier` passes the whole spec
- [ ] 7.2 `uat-planner` writes [uat.md](uat.md)
- [ ] 7.3 Status set to Implemented, folder moved to `specs/implemented/`, `ROADMAP.md` updated
- [ ] 7.4 Summary commit written as the PR description
