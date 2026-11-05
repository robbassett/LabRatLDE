# SPEC-023 tasks: Review hardening

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

Use a database of your own: `make test-integration TEST_DB='postgres://lde:lde@localhost:5432/lde_spec023?sslmode=disable'`. Every task ends with `gofmt -l .` printing nothing and `go vet ./...` clean.

## Phase 1: Database

- [x] 1.1 Migration `0021_signature_challenge_link`, and `signRun` passes `challenge_id`
  - Requirements: SPEC-023-R04, SPEC-023-R05
  - Integrity: yes

## Phase 2: Uploads

- [x] 2.1 Failing test, then spool the body and defer the chain lock
  - Requirements: SPEC-023-R01, SPEC-023-R02
  - Integrity: yes

## Phase 3: Configuration and small bugs

- [x] 3.1 Require `LDE_ENV`; update `Makefile`, compose, README, `.env.example`, docs
  - Requirements: SPEC-023-R03
  - Verify: `go run ./cmd/server` with no `LDE_ENV` exits with the message.
- [x] 3.2 Item position, 413, `/healthz`, token verified before the transaction
  - Requirements: SPEC-023-R06, SPEC-023-R07, SPEC-023-R08, SPEC-023-R09

## Phase 4: Readability

- [x] 4.1 Split `signRun` and `decideChangeSet`; `CollectRows` in `buildManifest`; one dataset join; remove needless reads
  - Requirements: SPEC-023-R10
  - Verify: `TestManifestIsCanonical` passes; `golangci-lint` reports both under 30.
- [x] 4.2 `.golangci.yml`, CI step, `make schema`, `docs/schema.sql`
  - Requirements: SPEC-023-R11

## Phase 5: Verify and close out

- [x] 5.1 `make test-integration`, integrity review, verifier, UAT plan, move to `specs/implemented/`
