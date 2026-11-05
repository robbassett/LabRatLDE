# SPEC-023 design: Review hardening

Requirements: [requirements.md](requirements.md) · Tasks: [tasks.md](tasks.md)

## 1. Simplicity budget

No new Go dependencies, packages or interfaces. One migration. `golangci-lint` runs in CI and locally; it is not a module dependency.

## 2. Data and interfaces

**Uploads (R01, R02).** `streamReadings` now runs in three steps:
1. A short read-only transaction checks the caller's role (R12; the database gate still enforces it) and finds the instrument and run, so a bad request fails before the body is read.
2. The body goes to a temp file (mode 0600, removed on return) through `MaxBytesReader`. No transaction is open.
3. One write transaction inserts the dataset node row and readings with no chain lock, then takes it to write the node's audit event, the edges and `instrument.ingested`.

`insertNode` splits into `insertNodeRow` and `auditNodeCreated`; `insertNode` calls both, so other callers are unchanged. This is safe because:
- `instrument_readings_sealed` needs only that the node was created in this transaction.
- The readings' foreign keys take `KEY SHARE`, which doesn't conflict with `set-gxp` or the rename (`FOR NO KEY UPDATE`).
- The edge trigger still rejects a sealed run, now with the chain lock held. An upload to a sealed run is refused after it is received rather than before.

**Signature link (R04, R05).** Migration `0021`:
- `signatures.challenge_id uuid`, nullable because existing rows have none, with a foreign key to `signature_challenges (tenant_id, id)` and a partial unique index.
- A new trigger `signatures_reauth_bound`. It is separate so `signatures_reject_mutation` needn't be copied, and its name sorts after `signatures_guard`, so it sees the stamped signer.
- `signature_challenges_guard` is replaced: `lde_app` must set `login_at`, and the "only used_at may change" message now names `login_at` too.

The service remains the only place that can verify a token, so this proves the service recorded a matching login. It does not stop a compromised service.

**Env (R03).** `config.Load` errors when `LDE_ENV` is unset or empty. `make run`, the compose `labrat` service, the README and `.env.example` set it to `dev`.

**Errors (R06 to R08).** `validateItems` rebuilds the error as a `badRequest` that includes the position, because `fail` prints only the inner `httpError`. `decodeJSON` returns a `MaxBytesError` unwrapped.

**Re-auth (R09).** `verifyReauth` checks the token and its claims before the transaction. `checkReauth` does the database checks inside it. Dev mode skips the first and needs no token.

**Manifest bytes (R10).** Only how rows are read changes. The queries' columns and order and the `manifest` struct stay the same, because a change in bytes would make every existing signature look stale. `TestManifestIsCanonical` guards this.

## 3. UI

None. The sign dialog already sends what the API needs. The item number appears in existing error text.

## 4. Testing approach

- R01: `internal/api/upload_integration_test.go` holds an upload open through `io.Pipe`, waits for its spool file, then requires no acquired connections and an audited write that completes. An earlier version, without the spool wait, failed on the unfixed code: the write hung until its 5-second timeout.
- R04, R05: `internal/storage/signature_link_integration_test.go` and `TestSignatureChallengeRules`, plus the existing prod signing tests through the API. The unique index and the `LDE03` branch for a changed challenge are second lines: `signatures_guard` and the `xmin` check reject those cases first in any path reachable today, so no test reaches them.
- Everything else is `Test: no`, checked by review and the manual steps in `tasks.md`.
- This spec's migration stops older branches signing, so it uses its own database, `lde_spec023`, not `lde`.

## 5. Decision log

| Date | Decision | Why | Rejected |
|---|---|---|---|
| 2026-11-05 | Spool uploads to a temp file and also defer the chain lock | Spooling frees the connection and lock during a slow client; deferring frees the lock during parsing and inserts. Each covers a case the other doesn't | Either alone; a dedicated connection pool for ingest |
| 2026-11-05 | Require `LDE_ENV` rather than warn | A warning in a log doesn't stop a production server trusting headers. Costs the zero-setup quickstart | Keeping the default with a loud log line |
| 2026-11-05 | Tooling: `golangci-lint` v2.13.2 via `golangci/golangci-lint-action@v8` in CI, `gocognit` only at 50 | Stops complexity growing without a clean-up of existing code. 50 passes today; lower it as code improves | Enabling all linters, which needs unrelated fixes |
| 2026-11-05 | `make schema` output is committed, with no CI drift check | It is a reading aid, not a source of truth; migrations remain authoritative | Checking drift in CI, which needs `pg_dump` matched to the server |
| 2026-11-05 | Track as SPEC-023 on a branch named `spec-009-review-tasks` | SPEC-009 is reserved for the schema registry; the owner named the branch | Renumbering the roadmap |
