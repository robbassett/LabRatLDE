# SPEC-016 design: Pre-flight checks v1

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: each check is a pure Go function in `internal/domain/preflight.go` over a snapshot struct loaded in one query. The gate runs the same functions inside the transition transaction, and results go into the `run.transitioned` audit payload. "Today" comes from the database clock in the tenant time zone.
- Not doing: a rules engine, a results table, or a database-level gate. Overrides are legitimate, so this is a guarded operational rule, not a "never" invariant (decision log).

## 2. Data and interfaces

- API: `POST /v1/runs/{id}/preflight` → `{problems:[{check, severity, subject_id, message, pointer?}]}`. `POST /v1/runs/{id}/transitions` gains optional `overrides:[{check, subject_id, reason}]`. `POST /v1/runs` gains optional `instruments`.
- No new tables.

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- **Run view** (SPEC-025 `RunLifecycle`): while the run is planned, a **Pre-flight** card above the action bar runs preflight when the view opens and after any change to params or inputs. It shows either "Ready to start" (ok icon) or a summary such as "2 errors, 1 warning". Each problem row has an icon with its severity word, a plain message, a link to its subject (lot or instrument) and, for an overridable error, **Override**.
- The **Problems panel** shows the same results (source `preflight:<run id>`) and opens by itself when there are errors (SPEC-025-R10).
- **Start run** with errors not yet overridden reads "Start run (2 blocking)" and opens the override Dialog. It lists each error with a required reason `Field`; Confirm sends the transition with `overrides` (R10). `params_schema` errors are listed without an override, since they can't be overridden (open question 3), and link to the parameters.
- After the start, the overrides show in the run's History and in Record details.

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | Deterministic checks only (ROADMAP D11) | Validatable and explainable | An LLM-driven or open-ended rule base |
| 2026-10-20 | Gate enforced in Go, not by DB trigger | Overrides make it a guarded operational rule, not a "must never happen" invariant | A trigger evaluating JSON expiry dates and override records |
