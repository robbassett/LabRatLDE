# SPEC-010 design: Schema governance namespaces

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: a `schema_namespaces` table, keyed by the namespace text already used in SPEC-009. The linter is pure Go, comparing two schema versions. Publishing reuses change sets and signatures. The impact analysis is one SQL query over references.
- Not doing: separate tier systems, a workflow designer, or semantic diffing beyond the rules in R04.

## 2. Data and interfaces

- `schema_namespaces(tenant_id, namespace, level, description, required_for_kind, created_by, created_at)`. Level changes are revisioned (SPEC-007) and may only increase.
- `schema_versions.promoted_from uuid`. The change set op `publish_schema_version{schema, major, minor, body_text, impact_sha256?}`.
- `ontology_prefixes(tenant_id, prefix, iri_base)`.
- Signing policy for `controlled` change requests is fixed in v1: `[approval/schema_steward(ns), approval/qa]`.
- Extends SPEC-008: `signatures.entity_type` also allows `change_set`. A change request's manifest is the canonical JSON of its items, `items_sha256` and the impact analysis SHA-256. Rules R04–R07 and R11 of SPEC-008 apply unchanged. A change set stays editable until its first signature; after that, editing invalidates its signatures.
- API: `GET/POST /v1/schema-namespaces`, `POST /v1/schemas/lint` (dry run), `POST /v1/schemas/{ns}/{name}/promote`, `GET /v1/change-sets/{id}/impact`, `GET/POST /v1/ontology-prefixes`.

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- **Change-request review** opens from To do → Review changes. Header: schema name, a namespace level badge (Sandbox `FlaskConical` / Contract `FileCheck` / Controlled `ShieldCheck`, icon plus word, never colour alone), and the one next action for this user as the primary button: Approve, Sign as Steward, Sign as QA, or the text "Waiting for QA signature". Tabs:
  - *Changes*: a plain-language summary first ("Adds optional field `ph_target`", "Removes field `lot_ref`: breaking"), then the side-by-side schema diff.
  - *Form preview*: before and after rendered read-only with the SPEC-009 form, so a scientist sees what will change on screen.
  - *Checks*: one row per lint rule with a pass or fail icon and words. A failing rule links to the field in the diff and carries the hint "Start a new major version instead" (Contract) or "Breaking changes aren't allowed in a Controlled namespace" (Controlled).
  - *Impact*: dependent protocols, runs and consumers in a DataTable, with counts first.
  - Signatures panel as SPEC-008. Commit and Reject open a Dialog with a required reason; Reject is `.btn-danger`.
- **Schemas sidebar section** groups schemas by namespace. "My sandbox" (`~<handle>`) is pinned first. A namespace page shows its level badge with a one-sentence explanation of the level, its Stewards, pending change requests and, for Stewards, **Promote**.
- **Extend this schema** on a published schema opens a draft in the user's sandbox. The editor states that the original stays unchanged (the Sandbox Rule).
- Empty state: "Nothing to review. Changes proposed to schemas you steward appear here."

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | The three tiers are levels on one registry, with a Steward per namespace (ROADMAP D4) | R&D and GMP need different strictness; one mechanism keeps one UI and one audit story | Three separate systems |
| 2026-10-20 | Change requests reuse SPEC-007 change sets and SPEC-008 signatures | One review flow for data and schemas | A schema-specific approval workflow |
