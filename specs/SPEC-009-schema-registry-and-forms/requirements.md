# SPEC-009: Schema registry and schema-driven forms

| | |
|---|---|
| **Status** | Approved |
| **Owner** | Rob Bassett |
| **Created / Updated** | 2026-10-20 / 2026-11-06 |
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
- Writes are validated against the referenced schema, and validation errors are reported per field. A planned run may hold incomplete params; they must validate before it starts.
- `$ref` is resolved only inside the registry. Nothing is fetched remotely.
- UI: forms rendered from schemas, for creating and editing records; a schema browser and a draft editor.

**Out of scope**
- Who may publish where, and compatibility rules. In this spec any human `scientist` may publish; SPEC-010 replaces that with per-namespace governance.
- Making a schema mandatory for a node kind (SPEC-010, Controlled namespaces).
- Starter schemas, and alignment with open standards (Allotrope ontology terms, ISA-95, ISA-88): SPEC-024.
- Importing Allotrope Simple Model (ASM) schemas a customer is licensed for: a later spec.
- LinkML import, and migrating existing data between schema versions. That includes attaching a schema to an existing node or moving a node to another version.
- The `node-picker` form widget, which needs the node search from SPEC-011.

## 3. Requirements (EARS)

| ID | Requirement | Test | Source |
|---|---|---|---|
| SPEC-009-R01 | If any role attempts to update, delete or truncate a published schema version, then the database shall reject the statement: `lde_app` holds no delete or truncate privilege (SQLSTATE `42501`), and every other attempt, including the owner's, raises `LDE03`. | yes | 11.10(e) |
| SPEC-009-R02 | The database shall compute each schema version's `sha256` from the UTF-8 bytes of its stored text. | no | traceability |
| SPEC-009-R03 | If a lineage node or protocol version references a schema version that is not published, or whose `applies_to` differs from the node's kind (or from `run_params`, for a protocol version), then the database shall reject it with SQLSTATE `LDE06`. | yes | data integrity |
| SPEC-009-R04 | If a protocol version's `params_schema` names a schema version that is not published or does not apply to `run_params`, then the API shall reject the protocol version with `422`. | no | data integrity |
| SPEC-009-R05 | If a node's attrs, or the params of a run that is not `planned`, do not validate against the referenced schema version, whether created, edited directly or changed by committing a change set, then the API shall reject the write with `422`, list each error's JSON pointer and message, and write nothing. | yes | 11.10(h) |
| SPEC-009-R06 | When a schema-backed record is created or revised, the audit event shall include the schema version id and its `sha256`. | no | 11.10(e) |
| SPEC-009-R07 | If a schema contains a `$id`, or a `$ref` or `$dynamicRef` that doesn't resolve to a published registry version (`lde://schemas/<ns>/<name>/<major>.<minor>`) or a local fragment, then the registry shall refuse to publish it. | no | air-gap, reproducibility |
| SPEC-009-R08 | If a schema is not a JSON object valid against the JSON Schema 2020-12 metaschema, or its `$schema` names any other dialect, then the registry shall refuse to save it as a draft. | no | usability |
| SPEC-009-R09 | When a schema-backed record is created or opened for editing, the UI shall render a form from its schema version, showing titles, descriptions, units (`x-lde-unit`) and the server's validation errors inline. | no | user need |
| SPEC-009-R10 | While a schema version is a draft, the database shall let only its author change its text, rejecting anyone else with SQLSTATE `LDE05`. | no | workflow |
| SPEC-009-R11 | If a principal without `scientist` creates a schema or draft, or a principal that isn't an enabled human with `scientist` publishes a version, then the database shall reject it with SQLSTATE `LDE05`. | no | 11.10(g), ROADMAP D6 |
| SPEC-009-R12 | If any role attempts to change a node's schema version after the node is created, then the database shall reject the statement: `lde_app` holds no such privilege (SQLSTATE `42501`), and any other role raises `LDE03`. | no | 11.10(e) |
| SPEC-009-R13 | If a run is moved from `planned` to `running` while its params do not validate against its protocol version's `params_schema`, then the run service shall reject the transition with `422`, list each error's JSON pointer and message, and leave the run `planned`. | yes | 11.10(h), run lifecycle |

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

**SPEC-009-R13**: an experiment's protocol names `params_schema: lab/qpcr-params@1.0`.
- `POST /v1/runs` with no params returns `201`; the run is `planned`. `PATCH /v1/runs/{id}/params` with `{"cycles": 0}` returns `200` while it is planned.
- Moving it to `running` returns `422` with an error at `/cycles`. The run stays `planned`, and no `run.transitioned` event is written.
- After `PATCH` with `{"cycles": 40}`, moving it to `running` returns `200`.
- Now running, `PATCH` with `{"cycles": 0}` returns `422` at `/cycles` (R05). So does committing an `update_run_params` change set with it, and the change set stays proposed.

## 5. Open questions

| # | Question | Owner | Answer (date) |
|---|---|---|---|
| 1 | Form library: `@rjsf/core` (react-jsonschema-form) or a small in-house renderer for a schema subset? | Rob Bassett | Stock `@rjsf/core` (2026-11-06). Its usual validator, Ajv, needs `unsafe-eval`, which our CSP forbids, so a small adapter plugs in `@cfworker/json-schema`, which doesn't need it, and the CSP stays. Errors shown in the form come only from the Go server's dry run, so the form and the write can't disagree. |
| 2 | Should LabRat ship starter schemas (sample, reagent lot, instrument status) in a system namespace `lde`? SPEC-015 assumes yes for inventory and equipment. | Rob Bassett | Yes, in a separate spec, SPEC-024, built straight after this one (2026-11-06). They follow open standards: Allotrope ontology terms (not ASM schemas, which are licensed non-commercial only), ISA-95 (B2MML) and ISA-88. This spec stays generic, and only makes sure the owner can insert a published version directly. |
| 3 | May a planned run hold incomplete params? | Rob Bassett | Yes (2026-11-06): agility while planning. Params aren't checked while a run is planned, and must validate before it starts (R13). SPEC-016's preflight then reports the problems before the start. |
