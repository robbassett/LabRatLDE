# SPEC-009: Schema registry and schema-driven forms

| | |
|---|---|
| **Status** | Draft |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-10-20 / 2026-11-05 |
| **Regulatory refs** | 21 CFR 11.10(h) (input checks), 11.10(e), 11.10(g) |
| **Depends on** | `SPEC-003`, `SPEC-005`, `SPEC-006`, `SPEC-007` |

Design: [design.md](design.md) · Tasks: [tasks.md](tasks.md)

## 1. Problem

Node `attrs` and run `params` are free JSON. Two scientists record the same measurement as `volume_ul` and `Volume (µL)`, typos go unnoticed, and nothing can be compared across experiments. Labs need structured, versioned definitions of what a sample, reagent lot or run's parameters must contain. Scientists shouldn't have to write JSON, so the same definition should give them a form.

## 2. Scope

**In scope**
- A registry of JSON Schema 2020-12 documents, identified as `namespace/name@major.minor`.
- Versions are `draft` (editable by their author) or `published` (immutable).
- Each schema declares what it applies to: a lineage node kind, or `run_params`.
- A node may name a published schema version when it is created, and keeps it. Protocol frontmatter may name a `params_schema`, which every run of that protocol version follows.
- Writes are validated against the referenced schema, and validation errors are reported per field.
- `$ref` is resolved only inside the registry. Nothing is fetched remotely.
- UI: forms rendered from schemas, for creating and editing records; a schema browser and a draft editor.

**Out of scope**
- Who may publish where, and compatibility rules. In this spec any human `scientist` may publish; SPEC-010 replaces that with per-namespace governance.
- Making a schema mandatory for a node kind (SPEC-010, Controlled namespaces).
- LinkML import, and migrating existing data between schema versions. That includes attaching a schema to an existing node or moving a node to another version.
- The `node-picker` form widget, which needs the node search from SPEC-011.
- Starter schemas. SPEC-015 ships them, in namespace `lde`.

## 3. Requirements (EARS)

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-009-R01 | If any role attempts to update, delete or truncate a published schema version, then the database shall reject the statement: `lde_app` holds no delete or truncate privilege (SQLSTATE `42501`), and every other attempt, including the owner's, raises `LDE03`. | yes | 11.10(e) |
| SPEC-009-R02 | The database shall compute each schema version's `sha256` from the UTF-8 bytes of its stored text. | no | traceability |
| SPEC-009-R03 | If a lineage node or protocol version references a schema version that is not published, or whose `applies_to` differs from the node's kind (or from `run_params`, for a protocol version), then the database shall reject it with SQLSTATE `LDE06`. | yes | data integrity |
| SPEC-009-R04 | If a protocol version's `params_schema` names a schema version that is not published or does not apply to `run_params`, then the API shall reject the protocol version with `422`. | no | data integrity |
| SPEC-009-R05 | If a node's attrs, or a run's params, do not validate against the referenced schema version, whether created, edited directly or changed by committing a change set, then the API shall reject the write with `422`, list each error's JSON pointer and message, and write nothing. | yes | 11.10(h) |
| SPEC-009-R06 | When a schema-backed record is created or revised, the audit event shall include the schema version id and its `sha256`. | no | 11.10(e) |
| SPEC-009-R07 | If a schema contains a `$id`, or a `$ref` or `$dynamicRef` that doesn't resolve to a published registry version (`lde://schemas/<ns>/<name>/<major>.<minor>`) or a local fragment, then the registry shall refuse to publish it. | no | air-gap, reproducibility |
| SPEC-009-R08 | If a schema is not a JSON object valid against the JSON Schema 2020-12 metaschema, or its `$schema` names any other dialect, then the registry shall refuse to save it as a draft. | no | usability |
| SPEC-009-R09 | When a schema-backed record is created or opened for editing, the UI shall render a form from its schema version, showing titles, descriptions, units (`x-lde-unit`) and inline validation errors. | no | user need |
| SPEC-009-R10 | While a schema version is a draft, the database shall let only its author change its text, rejecting anyone else with SQLSTATE `LDE05`. | no | workflow |
| SPEC-009-R11 | If a principal without `scientist` creates a schema or draft, or a principal that isn't an enabled human with `scientist` publishes a version, then the database shall reject it with SQLSTATE `LDE05`. | no | 11.10(g), ROADMAP D6 |
| SPEC-009-R12 | If any role attempts to change a node's schema version after the node is created, then the database shall reject the statement: `lde_app` holds no such privilege (SQLSTATE `42501`), and any other role raises `LDE03`. | no | 11.10(e) |

## 4. Acceptance examples

Fixture: schema `lab/sample@1.0`, applying to `sample`:

```json
{"type":"object","required":["volume_ul"],"properties":{"volume_ul":{"type":"number","minimum":0,"x-lde-unit":"µL"},"matrix":{"enum":["plasma","serum"]}}}
```

Schema `lab/qpcr-params@1.0`, applying to `run_params`:

```json
{"type":"object","required":["cycles"],"properties":{"cycles":{"type":"integer","minimum":1}}}
```

**SPEC-009-R01**: after publish, `UPDATE schema_versions SET body_text = '{}'` and setting `status` back to `draft` each fail with `LDE03`, as `lde_app` and as the owner. `DELETE` and `TRUNCATE` fail with `42501` as `lde_app` and `LDE03` as the owner. A draft `lab/sample@1.1` can still be edited by its author.

**SPEC-009-R03**: creating a `sample` node that references draft `lab/sample@1.1` fails with `LDE06`. Creating a `reagent` node that references `lab/sample@1.0` fails with `LDE06`. So does a `sample` node referencing `lab/qpcr-params@1.0`, or another tenant's published version. A protocol version referencing `lab/sample@1.0` fails with `LDE06`, and one referencing `lab/qpcr-params@1.0` succeeds.

**SPEC-009-R05**:
- Creating a sample with attrs `{"volume_ul": -5, "matrix": "urine"}` returns `422` with errors at `/volume_ul` (minimum) and `/matrix` (enum). `{"matrix": "plasma"}` returns `422` with an error at `/volume_ul` (required). `{"volume_ul": 50, "matrix": "plasma"}` succeeds.
- `PATCH /v1/lineage/nodes/{id}` with those bad attrs returns `422` and adds no revision. So does committing a change set with an `update_node` or `add_node` item carrying them, and the change set stays proposed.
- A run whose protocol version names `params_schema: lab/qpcr-params@1.0` and whose params lack required `cycles` returns `422` with an error at `/cycles`, and no run is created. `PATCH /v1/runs/{id}/params` with `{"cycles": 0}` returns `422` with an error at `/cycles`.

## 5. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | Form library: `@rjsf/core` (react-jsonschema-form) or a small in-house renderer for a schema subset? | Rob Bassett | Proposed, awaiting confirmation (2026-11-05): in-house. rjsf's standard validator (Ajv) compiles schemas with `new Function`, which our CSP (`default-src 'self'`, no `unsafe-eval`) blocks. Its precompiled mode can't take schemas written at run time, and weakening the CSP needs its own spec. In-house also leaves Go as the only validator. See the design's decision log. |
| 2 | Should LabRat ship starter schemas (sample, reagent lot, instrument status) in a system namespace `lde`? SPEC-015 assumes yes for inventory and equipment. | Rob Bassett | Proposed, awaiting confirmation (2026-11-05): not in this spec. SPEC-015-R01 already ships them; this spec only makes sure the owner can insert a published version directly. |
| 3 | R05 refuses to create a run whose params are incomplete, so a planned run needs its required params up front. SPEC-016's fixture (a planned run with `cycles: 50` over a maximum of 45) can then never exist. Keep R05 strict, or allow incomplete params until `planned → running`? | Rob Bassett | Proposed, awaiting confirmation (2026-11-05): keep it strict, as R05's example already says, and revise SPEC-016's fixture and R04 when that spec is agreed (noted there as an open question). |
