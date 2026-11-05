# SPEC-023: Review hardening

| | |
|---|---|
| **Status** | Approved |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-11-05 / 2026-11-05 |
| **Regulatory refs** | 21 CFR 11.10(d), 11.70, 11.200(a) |
| **Depends on** | `SPEC-002`, `SPEC-006`, `SPEC-008` |
| **Supersedes** | The `LDE_ENV` default in `docs/identity.md`: the variable no longer has one |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

Approval: the owner reviewed the findings and asked for all of them to be fixed on branch `spec-009-review-tasks`. The branch name is the owner's; SPEC-009 remains the schema registry. These files were written after that instruction and have not had a separate review.

## 1. Problem

A code review of the SPEC-008 branch found that one instrument upload can stop every audited write in its tenant, including signatures. A server started without `LDE_ENV` silently trusts request headers for identity. The database does not tie a re-authenticated signature to the login that proved it. It also found small error-handling bugs and two handlers that had grown too complex.

## 2. Scope

**In scope**
- Instrument upload locking and connection use.
- Requiring `LDE_ENV`.
- A database link from an `oidc` signature to its challenge.
- The small bugs in R06 to R09.
- Readability work with no behaviour change: R10 and R11.

**Out of scope**
- Rewriting the existing integration tests.
- Refusing `dev` signatures on GxP tenants: tenants default to GxP, so this would break dev mode.
- A read timeout or concurrency limit on uploads: a stalled upload no longer holds a lock or database connection. It does still hold temp disk (up to `LDE_MAX_INGEST_BYTES` each) and a file handle, so limits on those are left to the proxy.

## 3. Requirements (EARS)

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-023-R01 | While an instrument upload is being received, the API shall hold neither the tenant's audit chain lock nor a database connection, so other audited writes in the tenant complete. | yes | chain of custody, availability |
| SPEC-023-R02 | When an instrument upload is parsed and its readings are stored, the API shall not take the tenant's audit chain lock until the readings are stored, and the upload shall stay atomic with its audit events. | no | availability |
| SPEC-023-R03 | If `LDE_ENV` is unset or empty, then the server shall refuse to start and name the variable and its allowed values. | no | 11.10(d) |
| SPEC-023-R04 | If a signature with `reauth_method = 'oidc'` does not name a challenge used in the same transaction, for the same signer, run and manifest, with a recorded login, or a `dev` signature names a challenge, or a challenge is named by a second signature, then the database shall reject it with SQLSTATE `LDE07`, and the database shall reject any change to a signature's challenge after insert. | yes | 11.70, 11.200(a) |
| SPEC-023-R05 | If `lde_app` marks a signature challenge used without a login time, then the database shall reject it with SQLSTATE `LDE07`. | yes | 11.200(a) |
| SPEC-023-R06 | When a change set item fails validation, the API's error message shall name the item's position. | no | usability |
| SPEC-023-R07 | If a JSON request body exceeds the size limit, then the API shall respond with status 413. | no | HTTP correctness |
| SPEC-023-R08 | If the database is unreachable, then `/healthz` shall respond 503 without including the database error, and shall log it. | no | information exposure |
| SPEC-023-R09 | The API shall verify a re-authentication token before opening the signing transaction. | no | connection use |
| SPEC-023-R10 | `signRun` and `decideChangeSet` shall each have a cognitive complexity under 30, the manifest's bytes shall not change, and the dataset ingest join shall be defined once. | no | maintainability |
| SPEC-023-R11 | CI shall fail when a non-test Go function exceeds cognitive complexity 50, and `make schema` shall write the migrated schema to `docs/schema.sql`. | no | maintainability |
| SPEC-023-R12 | If a caller without the `scientist` role starts an instrument upload, then the API shall respond 403 before reading the body. | no | availability |

## 4. Acceptance examples

- With an upload still sending, `POST /v1/instruments` returns 201 straight away, and the upload then finishes with 201.
- `go run ./cmd/server` with no `LDE_ENV` exits with `config: LDE_ENV is required: set it to dev or prod`.
- Inserting a signature with `reauth_method = 'oidc'` and no `challenge_id` fails with `LDE07`.
- A change set whose third item has a blank label returns 400 with `item 2: label must not be blank`.
