# SPEC-015 design: Inventory and equipment status

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: no new tables. Lots are `reagent` nodes and instruments are `instrument` nodes carrying these schemas. The `lde` schemas ship in a migration. The QA gate is a trigger checking `lde_has_role('qa')` when a lot's `status` changes to `released` or `rejected`. Tenant time zone is one column on `tenants`.
- Not doing: separate inventory tables, a stock ledger, or a calibration module.

## 2. Data and interfaces

- `tenants.time_zone text NOT NULL DEFAULT 'UTC'`, which an admin can change (audited).
- Schemas: `lde/reagent-lot@1.0` (`required: catalog_no, lot_no, supplier, expiry_date, status`), `lde/instrument-status@1.0` (`required: status, calibration_due`). Dates use `format: date`.
- API: uses existing node, revision and raw-file endpoints. Convenience endpoints `GET /v1/inventory/lots?status=&expires_within_days=` and `GET /v1/equipment`.

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- The SPEC-025 sidebar section **Instruments** becomes **Equipment**, and a new **Inventory** section (`Package` icon) joins it. The New menu gains "Material lot".
- **Inventory:** a DataTable of lots with columns material, lot number, quantity with unit (mono, right-aligned), expiry and a status badge. Filters: status chips and "Expires within [30] days". Expired lots get a `--danger` badge with an icon and "Expired". Lots within the window get `--warn` and "Expires in 5 days" (R07).
- **Equipment status board:** a card per instrument showing name, kind, a status badge (In service, Out of service, Calibration overdue) and the calibration due date. Overdue shows a `--danger` icon and words; due within 14 days shows `--warn` and "Due in 9 days" (R08). Filter by status, and by ISA-88 level where the SPEC-024 schema provides it.
- Rows and cards open the item with its SPEC-009 form. A status change opens a Dialog with a required reason and is confirmed by a toast.
- **Home** (SPEC-025) gains "Expiring soon" and "Calibration due" cards, shown only when something falls within 14 days.
- Empty states offer **Add material lot** and **Register instrument** to users whose roles allow it.

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | Inventory and equipment are schema-backed nodes, not new tables | Reuses lineage, revisions, forms and governance | Dedicated inventory tables |
