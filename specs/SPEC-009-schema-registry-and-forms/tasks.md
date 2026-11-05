# SPEC-009 tasks: Schema registry and schema-driven forms

Requirements: [requirements.md](requirements.md) · Design: [design.md](design.md)

`make test-integration` needs `docker compose up -d`. This spec's migrations are not on other branches, so give it a database of its own while it is in flight: run `CREATE DATABASE lde_spec009 OWNER lde`, then `make test-integration TEST_DB=postgres://lde:lde@localhost:5432/lde_spec009?sslmode=disable`.

Every task ends with `gofmt -l .` printing nothing and `go vet ./...` clean. UI tasks also end with `cd web && npm run build` clean. Migrations start at `0022`. New trigger functions pin `search_path`, as the design's SQL does. The design's SQL and function signatures are final: copy them, don't redesign them.

Fixtures in the tests are the two schemas in requirements §4: `sampleSchema` is `lab/sample` and `qpcrSchema` is `lab/qpcr-params`.

## Phase 1: Database

- [ ] 1.1 Test: published schema versions are immutable (SPEC-009-R01)
  - Requirements: SPEC-009-R01
  - Files: `internal/storage/integration_test.go`
  - Do: add constants `sampleSchema` and `qpcrSchema`, and these helpers:
    - `insertSchema(ctx, tx, tenant, ns, name, appliesTo string) (string, error)`: inserts into `schemas` with `created_by 'it@lab'`, returning the id.
    - `insertSchemaVersion(ctx, tx, tenant, schemaID string, major, minor int, body string) (string, error)`: inserts a draft with `author 'it@lab'`, returning the id.
    - `publishSchemaVersion(ctx, tx, id string) error`: `UPDATE schema_versions SET status = 'published' WHERE id = $1`.
    - `TestPublishedSchemaVersionsAreImmutable`: alice (scientist) creates `lab/sample`, version 1.0 with `sampleSchema`, changes its `body_text` while a draft (no error), and publishes it. Then, each statement in its own transaction, with `wantCode`:
      1. As alice, `UPDATE schema_versions SET body_text = '{}'` on it: `LDE03`.
      2. As alice, `UPDATE schema_versions SET status = 'draft'` on it: `LDE03`.
      3. As a new principal with no roles, the same `body_text` update: `LDE03`.
      4. As alice, `DELETE` of it and `TRUNCATE schema_versions`: `42501`.
      5. As the owner (`db.Pool.Exec`), the `body_text` update, the `status` update and the `DELETE`: `LDE03`.
      6. As the owner, in `db.WithOwner`, `TRUNCATE schema_versions CASCADE`: `LDE03`. Returning the error rolls back the transaction, so a failure of this test can't empty the table.
      7. A draft 1.1 by alice: changing its `body_text` succeeds.
    - Comment `// SPEC-009-R01`.
  - Verify: `make test-integration TEST_DB=…` fails only on the new test (`schemas` doesn't exist).
  - Integrity: yes
- [ ] 1.2 Migration `0022_schema_registry`
  - Requirements: SPEC-009-R01, SPEC-009-R02, SPEC-009-R10, SPEC-009-R11
  - Files: `internal/storage/migrations/0022_schema_registry.sql`, `cmd/server/iq.go`
  - Do: everything in design §2 "Migration `0022_schema_registry`", with a header comment in the style of `0016`. Add `schemas_guard`, `schemas_no_truncate`, `schema_versions_guard` and `schema_versions_no_truncate` to `iqTriggers`.
  - Verify: `make test-integration TEST_DB=…` passes, including 1.1. `go run ./cmd/server iq` passes against that database. `psql`: a version's `sha256` equals `sha256(convert_to(body_text, 'UTF8'))`.
  - Integrity: yes
- [ ] 1.3 Test: references must be published and match (SPEC-009-R03)
  - Requirements: SPEC-009-R03
  - Files: `internal/storage/integration_test.go`
  - Do: `TestSchemaReferencesMustBePublished`. As alice (scientist), `lab/sample` applies to `sample`, with 1.0 published and 1.1 a draft. `lab/qpcr-params` applies to `run_params`, with 1.0 published and 1.1 a draft. A second tenant has its own published `lab/sample` 1.0. One table of cases, each in its own transaction, inserting directly:
    1. A `sample` node referencing `lab/sample` 1.1: `LDE06`.
    2. A `reagent` node referencing `lab/sample` 1.0: `LDE06`.
    3. A `sample` node referencing `lab/qpcr-params` 1.0: `LDE06`.
    4. A `sample` node referencing the other tenant's 1.0: `LDE06`.
    5. A `sample` node referencing `lab/sample` 1.0: succeeds.
    6. A protocol version (a new experiment, its node, then the insert) referencing `lab/sample` 1.0: `LDE06`.
    7. A protocol version referencing `lab/qpcr-params` 1.1: `LDE06`.
    8. A protocol version referencing `lab/qpcr-params` 1.0: succeeds.
    - Comment `// SPEC-009-R03`.
  - Verify: fails only on the new test (`schema_version_id` doesn't exist).
  - Integrity: yes
- [ ] 1.4 Migration `0023_schema_references`
  - Requirements: SPEC-009-R03, SPEC-009-R12
  - Files: `internal/storage/migrations/0023_schema_references.sql`, `cmd/server/iq.go`
  - Do: everything in design §2 "Migration `0023_schema_references`". Add `lineage_nodes_schema_ref`, `lineage_nodes_schema_pinned` and `protocol_versions_schema_ref` to `iqTriggers`.
  - Verify: `make test-integration TEST_DB=…` passes, including 1.3. `go run ./cmd/server iq` passes. `psql`: `UPDATE lineage_nodes SET schema_version_id = NULL` on a schema-backed node is `LDE03` as the owner and `42501` as `lde_app`.
  - Integrity: yes

## Phase 2: Domain

- [ ] 2.1 Schema checks and validation
  - Requirements: SPEC-009-R05, SPEC-009-R07, SPEC-009-R08
  - Files: `internal/domain/schema.go` (new), `go.mod`, `go.sum`
  - Do:
    - `go get github.com/santhosh-tekuri/jsonschema/v6@v6.0.3`, then `go mod tidy`, so `golang.org/x/text` is a direct dependency.
    - The types and functions in design §2 "Validation", following its rules exactly. No I/O and no database. `ParseSchemaName` and `ParseSchemaURL` use the same namespace and name patterns as the `schemas` CHECKs and split on the last `@`, because a namespace may contain one.
    - A package-level `sync.Once` compiles the metaschema for `CheckSchema`.
    - No unit tests: R05 is tested through the API (3.6), and R07 and R08 are `Test: no`.
  - Verify: `go build ./...` and `go test ./internal/domain/`. `go mod why golang.org/x/text` names `internal/domain`.

## Phase 3: API

- [ ] 3.1 Errors
  - Requirements: SPEC-009-R03, SPEC-009-R05
  - Files: `internal/storage/postgres.go`, `internal/api/server.go`, `internal/api/schemas.go` (new)
  - Do:
    - `storage.CodeSchemaRef = "LDE06"` and `storage.IsBadSchemaRef(err)`. Don't add it to `IsConflict`.
    - In `schemas.go`: `type schemaInvalid struct { subject string; problems []domain.SchemaProblem }`, whose `Error()` is the design's `error` text (`<subject>: <pointer> <message>; …`).
    - In `fail`: a `*schemaInvalid` case, before the others, writing `{error, errors}` with status 422, and an `IsBadSchemaRef` case writing 422 with `storage.ErrorMessage(err)`.
  - Verify: `go build ./...`.
- [ ] 3.2 Schema endpoints
  - Requirements: SPEC-009-R11 (API side)
  - Files: `internal/api/schemas.go`, `internal/api/server.go`
  - Do: `POST /v1/schemas`, `GET /v1/schemas` and `GET /v1/schemas/{ns}/{name}`, as design §2 "API". `validNodeKindOrRunParams` checks `applies_to` with `domain.NodeKind.Valid` or the literal `run_params`. Bad namespace or name patterns are 400 here and not left to the CHECK, so the message is clear. Listing uses `readPage`, `page` and `nextCursor`, ordered by `created_at, id`; `latest_published` comes from a lateral join ordered by `major DESC, minor DESC`. Audit `schema.created` in the same transaction. Register routes in `Handler`.
  - Verify: `curl` as a dev user: create `lab/sample`, list it, filter with `?applies_to=reagent` (empty), read it, and create it again (409).
  - Integrity: yes
- [ ] 3.3 Draft endpoints
  - Requirements: SPEC-009-R08, SPEC-009-R10
  - Files: `internal/api/schemas.go`, `internal/api/server.go`
  - Do:
    - `POST /v1/schemas/{ns}/{name}/versions`, `GET /v1/schema-versions/{id}` and `PUT /v1/schema-versions/{id}`, as the design says.
    - Both writes call `domain.CheckSchema` first and answer `*schemaInvalid` on any problem, with the subject "schema is not valid".
    - One `schemaVersion` struct and `loadSchemaVersion(ctx, tx, id)`, joining `schemas`, with `author_id` and hex `sha256`.
    - `refs` comes from `schemaRefs(ctx, tx, bodyText)`: a breadth-first walk with `domain.SchemaRefs`, reading each URL's published text through `registryText` (below), skipping any it can't find and stopping at 100 documents.
    - `registryText(ctx, tx, url) (string, error)` parses with `domain.ParseSchemaURL` and returns the published version's text, or an error naming the URL.
    - `PUT` calls `audit.LockChain`, reads `FOR UPDATE`, updates `body_text` (a published version answers 409, through `LDE03`) and audits `schema.version_updated`. `POST` audits `schema.version_drafted`.
  - Verify: `curl`: save a draft; save `{"type":"nonsense"}`, `true` and `{"$schema":"http://json-schema.org/draft-07/schema#"}` (each 422); as another dev user, `PUT` is 403 (`LDE05`: not the author, though dev users hold every role).
  - Integrity: yes
- [ ] 3.4 Publish
  - Requirements: SPEC-009-R07, SPEC-009-R11
  - Files: `internal/api/schemas.go`, `internal/api/server.go`
  - Do: `POST /v1/schema-versions/{id}/publish`, taking no body:
    - `audit.LockChain`, then read the version `FOR UPDATE`. Already published is 409.
    - `domain.SchemaRefs`: any problem, or a URL `registryText` can't find, is `*schemaInvalid` with the subject "schema cannot be published", with a problem per URL at pointer `""`.
    - `domain.CompileSchema(domain.SchemaURL(…), text, load)`, where `load` wraps `registryText`. A compile error (such as a bad local fragment) is `*schemaInvalid`.
    - `UPDATE … SET status = 'published'`, then audit `schema.version_published`.
  - Verify: `curl`: publish a valid draft. These each fail with 422: `$ref` to `http://example.com/x.json`, to `file:///etc/passwd`, to `lde://schemas/lab/none/1.0`, to a draft version, to `#/$defs/missing`, and a body containing `$id`. A `$ref` to the published version publishes. A second publish is 409.
  - Integrity: yes
- [ ] 3.5 Dry run
  - Requirements: SPEC-009-R05 (support for R09)
  - Files: `internal/api/schemas.go`, `internal/api/server.go`
  - Do: `checkInstance(ctx, tx, schemaVersionID string, instance []byte) (sha string, problems []domain.SchemaProblem, err error)`: read the version's text and name, compile it with `registryText`, validate. A compile error is `*schemaInvalid` with the subject "schema cannot be compiled"; only a draft can reach this, since publishing compiles first. Then `POST /v1/schemas/validate` as the design says. With `body_text`, run `CheckSchema` and `SchemaRefs` first (`*schemaInvalid` on a problem), and compile it under the URL `domain.SchemaURL("draft", "preview", 0, 0)`. It writes nothing and audits nothing. Exactly one of `schema_version_id` and `body_text`, otherwise 400; a missing `instance` is 400.
  - Verify: `curl`, with the fixture: `{"volume_ul":-5,"matrix":"urine"}` gives `valid: false` with `/matrix` and `/volume_ul`; `{"matrix":"plasma"}` gives `/volume_ul`; `{"volume_ul":50,"matrix":"plasma"}` gives `valid: true`.
- [ ] 3.6 Test: writes are validated (SPEC-009-R05)
  - Requirements: SPEC-009-R05
  - Files: `internal/api/integration_test.go`
  - Do: `TestSchemaValidationOnWrite`, in dev mode as `TestCommitIsAtomic` is, using `sendWant`. Helper `publishedSchema(t, srv, headers, ns, name, appliesTo, body) (versionID string)` uses only the API. Helper `schemaErrors(t, body []byte) []string` returns the pointers from a 422's `errors`. Comment `// SPEC-009-R05`, then three subtests, each checking `auditCount` is unchanged after a refusal:
    - `nodes`: the first R05 example (`/matrix` and `/volume_ul`; then `/volume_ul`; then 201). A refused create adds no node. An `add_node` change set with bad attrs and `schema_version_id` commits with 422 and stays `proposed`.
    - `edits`: on the created sample, `PATCH /v1/lineage/nodes/{id}` with the bad attrs is 422 and `max(rev)` stays 1. A proposed `update_node` with them commits with 422, stays `proposed`, and `max(rev)` stays 1. A label-only `PATCH` is 200. A `PATCH` with good attrs is 200.
    - `runs`: an experiment whose `protocol_md` frontmatter says `params_schema: lab/qpcr-params@1.0`. `POST /v1/runs` with no params is 422 at `/cycles`, and the experiment has no runs. `{"cycles":40}` is 201. `PATCH /v1/runs/{id}/params` with `{"cycles":0}` is 422 at `/cycles`. A proposed `update_run_params` with it commits with 422 and stays `proposed`. `{"cycles":35}` is 200.
  - Verify: fails only on the new test. This task stays uncommitted until 3.10, which makes all three subtests pass. 3.7 and 3.8 each make one pass, and `go test -run 'TestSchemaValidationOnWrite/nodes' ./internal/api/` shows it.
- [ ] 3.7 Nodes
  - Requirements: SPEC-009-R05, SPEC-009-R06
  - Files: `internal/api/lineage.go`, `internal/api/changesets.go`, `internal/api/schemas.go`, `internal/domain/lineage.go`
  - Do:
    - `domain.Node` gains `SchemaVersionID *string` (`schema_version_id,omitempty`). `getLineage` selects and scans it.
    - In `schemas.go`, `insertSchemaNode(ctx, tx, p, kind, label, attrs, schemaVersionID string) (string, error)`: with `""` it calls `insertNode`. Otherwise it applies `insertNodeRow`'s same checks and defaults, inserts with the column, calls `checkInstance` on `json.Marshal(attrs)`, with nil attrs as `{}` (a problem is `*schemaInvalid` with the subject "does not match <ns>/<name>@<major>.<minor>"), and appends `lineage.node_created` with the usual payload plus `schema_version_id` and `schema_sha256`.
    - `createNode` gains `schema_version_id` in its request (not a UUID: 400), calls it and returns it.
    - `changeItem` gains `SchemaVersionID string` (`schema_version_id,omitempty`). `omitempty` keeps the items, and so the `items_sha256`, of existing change sets as they are. `validate` checks the UUID on `add_node`. `applyItem`'s `add_node` calls `insertSchemaNode`.
  - Verify: `go test -run 'TestSchemaValidationOnWrite/nodes' ./internal/api/` passes. `make test-integration TEST_DB=…` fails only on the other two subtests.
  - Integrity: yes
- [ ] 3.8 Edits
  - Requirements: SPEC-009-R05, SPEC-009-R06
  - Files: `internal/api/changesets.go`, `internal/api/schemas.go`
  - Do:
    - In `schemas.go`, `recordSchema(ctx, tx, entityType, entityID string) (id, sha string, err error)`: for `lineage_node`, through the node's column; for `run`, through `runs` to `protocol_versions.params_schema_version_id`; for anything else, or with no schema, `"", "", nil`.
    - In `applyItem`, before the update: `update_node` with non-nil `Attrs`, and `update_run_params`, call `recordSchema` and, when it finds one, `checkInstance` on the new value (`json.Marshal(it.Attrs)`, or `it.Params`). A problem is `*schemaInvalid`, as in 3.7.
    - `updateRecord` calls `recordSchema` and, when it finds one, adds `schema_version_id` and `schema_sha256` to the `record.revised` payload.
  - Verify: `go test -run 'TestSchemaValidationOnWrite/edits' ./internal/api/` passes. `make test-integration TEST_DB=…` fails only on the `runs` subtest.
  - Integrity: yes
- [ ] 3.9 `params_schema` on protocol versions
  - Requirements: SPEC-009-R04, SPEC-009-R06
  - Files: `internal/api/protocols.go`, `internal/api/schemas.go`
  - Do:
    - In `schemas.go`, `resolveParamsSchema(ctx, tx, meta map[string]any) (id, sha string, err error)`: `""` when the key is absent. A non-string value, a name `ParseSchemaName` refuses, or a name with no version in the tenant is a 422 `httpError` naming the value. Draft and wrong-kind versions are found here, and the insert's trigger answers `LDE06` for them, which is also 422.
    - `addProtocolVersion` calls it after parsing the frontmatter, inserts the column (null when `""`), and adds `schema_version_id` and `schema_sha256` to the `protocol.version_created` payload when set.
    - `protocolVersion` gains `ParamsSchemaVersionID *string` (`params_schema_version_id,omitempty`). The list and read queries select it.
  - Verify: `curl`: a `POST /v1/experiments` whose frontmatter names a draft version, a `sample` schema, an unknown name, or `params_schema: 5` is 422. One naming a published `run_params` version is 201, and `GET /v1/protocol-versions/{id}` shows the id.
  - Integrity: yes
- [ ] 3.10 Runs
  - Requirements: SPEC-009-R05, SPEC-009-R06
  - Files: `internal/api/runs.go`, `internal/domain/run.go`
  - Do:
    - `domain.Run` gains `ParamsSchemaVersionID *string` (`params_schema_version_id,omitempty`). Append `(SELECT pv.params_schema_version_id FROM protocol_versions pv WHERE pv.id = protocol_version_id)` to `runColumns`, and scan it last in `scanRun`.
    - In `createRun`, the protocol version query also selects `params_schema_version_id`. When set, call `checkInstance` on `req.Params` before `insertNode` (a problem is `*schemaInvalid`, as in 3.7), and add `schema_version_id` and `schema_sha256` to the `run.created` payload.
    - The manifest doesn't change.
  - Verify: `make test-integration TEST_DB=…` passes, including all of 3.6 and `TestManifestIsCanonical`. Commit 3.6 with this task.
  - Integrity: yes

## Phase 4: UI

- [ ] 4.1 API client
  - Requirements: SPEC-009-R09 (support)
  - Files: `web/src/api.ts`
  - Do:
    - Types `SchemaProblem`, `SchemaSummary`, `SchemaDetail`, `SchemaVersion`, and `AppliesTo` (`NodeKind | 'run_params'`).
    - `schema_version_id?` on the lineage node type and on `add_node`'s `ChangeItem`; `params_schema_version_id?` on `Run`, `RunDetail` and `ProtocolVersion`.
    - Functions `listSchemas`, `getSchema`, `createSchema`, `createSchemaVersion`, `getSchemaVersion`, `updateSchemaVersion`, `publishSchemaVersion`, `validateAgainstSchema`, `createNode` and `createRun`. The last two don't exist in the client yet.
    - `ApiError` gains `problems: SchemaProblem[]`, read from the body's `errors` in `request`, empty when absent.
  - Verify: `npm run build`.
- [ ] 4.2 `SchemaForm`
  - Requirements: SPEC-009-R09
  - Files: `web/src/SchemaForm.tsx` (new), `web/src/styles.css`
  - Do: as design §3 "Form", exactly. Props `{schema: unknown; refs: Record<string, string>; value: Record<string, unknown>; errors: SchemaProblem[]; onChange: (v: Record<string, unknown>) => void; disabled?: boolean}`. A second export, `SchemaValues({schema, refs, value})`, shows a `<dl>` of titled values with units, for reading. Keep `resolve(node, refs, depth)` a plain function at the top of the file. Every control has a `<label>`, and errors use `aria-describedby`. Only classes in `styles.css`: the CSP has no `unsafe-inline`.
  - Verify: `npm run build`. Exercised by 4.4.
- [ ] 4.3 Validation hook and the Problems panel
  - Requirements: SPEC-009-R09
  - Files: `web/src/useSchemaValidation.ts` (new), `web/src/BottomPanel.tsx`
  - Do:
    - `useSchemaValidation(source: string, target: {schemaVersionId: string} | {bodyText: string} | null, value: unknown): SchemaProblem[]`, as design §3 "Validation": 300 ms debounce, stale answers dropped, dispatching `labrat:problems` with `{source, problems}`. On unmount it dispatches an empty list for its source.
    - `BottomPanel` keeps problems per source from that event and replaces the fixed "No problems" with a table of source, pointer and message, keeping "No problems" when there are none. The tab shows the count when it isn't zero, as "Problems (2)".
  - Verify: `npm run build`. Exercised by 4.4.
- [ ] 4.4 Forms when editing
  - Requirements: SPEC-009-R09
  - Files: `web/src/EditField.tsx`, `web/src/LineageView.tsx`, `web/src/RunView.tsx`
  - Do: `EditField` gains an optional `schemaVersionId`. When set, it loads the version with `getSchemaVersion`. Reading shows `SchemaValues`. Editing shows `SchemaForm` with `useSchemaValidation` in place of the textarea, with `draft` kept as JSON text, so `onSave` and the reason, propose and read-only flows don't change. A failed load falls back to the JSON box with the message shown. On a save error, `err.problems` goes to the form inline. `LineageView` passes `node.schema_version_id` to Attributes, and `RunView` passes `run.params_schema_version_id` to Params.
  - Verify: against the dev server, with `lab/sample@1.0` published and a node created through `curl`: the lineage panel shows labelled values with `µL`. Edit to `-5`: the error appears under the field and in the Problems panel, and clears when corrected. Save with a reason: the revision appears. On a signed run with a params schema, the form saves as "Propose correction". A node with no schema still shows the JSON box.
- [ ] 4.5 New record
  - Requirements: SPEC-009-R09
  - Files: `web/src/NewNodeView.tsx` (new), `web/src/tabs.ts`, `web/src/Workspace.tsx`, `web/src/Explorer.tsx`
  - Do: the singleton tab `newnode`, "New record", as design §3, with `newnode` added to `Kind`, `KINDS` and `SINGLETONS`, a case in `TabContent` and an explorer item (the palette follows the explorer). Kind `<select>`; schema `<select>` of `listSchemas(kind)` entries with a `latest_published`, plus "No schema"; label; `SchemaForm` or a JSON box. The button is disabled while validation problems exist. On success, open the node's lineage tab.
  - Verify: create a sample through the form: it opens in lineage with its values. A `-5` volume shows an inline error and doesn't submit.
- [ ] 4.6 New run
  - Requirements: SPEC-009-R09
  - Files: `web/src/NewRunForm.tsx` (new), `web/src/ExperimentView.tsx`
  - Do: as design §3, a form in `ExperimentView` above the run list. It reads the latest version with `getProtocolVersion(exp.protocol_version_id)`. Fields: label; inputs (one node id per line); `SchemaForm` when `params_schema_version_id` is set, otherwise a JSON box defaulting to `{}`. On success, open the run tab.
  - Verify: with an experiment whose frontmatter names `lab/qpcr-params@1.0`: the form shows Cycles as required, and a run starts once it is filled in. An experiment with no schema still creates a run from the JSON box.
- [ ] 4.7 Schema browser
  - Requirements: SPEC-009-R09 (support), SPEC-009-R10
  - Files: `web/src/SchemasView.tsx` (new), `web/src/SchemaView.tsx` (new), `web/src/tabs.ts`, `web/src/Workspace.tsx`, `web/src/Explorer.tsx`
  - Do: as design §3 "Schema browser". The singleton tab `schemas`: a list grouped by namespace, Load more, and a new-schema form that opens the new schema. The tab `schema` (id `ns/name`): a versions table (version, status, author, hash, published time). Selecting a version shows a field-docs table (field, type, required, unit, description) and a sample `SchemaForm` that saves nothing, with `useSchemaValidation` showing its errors.
  - Verify: browse to `lab/sample`, see its fields and `µL`, and try the sample form. A new schema appears in the list.
- [ ] 4.8 Draft editor
  - Requirements: SPEC-009-R08, SPEC-009-R09, SPEC-009-R10
  - Files: `web/src/SchemaDraftEditor.tsx` (new), `web/src/SchemaView.tsx`, `web/src/styles.css`
  - Do: as design §3 "Draft editor". In `SchemaView`, a "New draft" form with major and minor (defaulting to the next minor) and text copied from the latest version. For a draft whose `author_id` is `getMe().id`: a monospace `<textarea>` beside the live preview, Save, and Publish in a `<dialog>` saying "Published versions can never change", with focus returned on close. For anyone else's draft, the text is read-only. A failed save or publish lists `err.problems` in `role="alert"`.
  - Verify: as one dev user, write a draft, see the preview update, try `{"type":"nonsense"}` (the message shows and it doesn't save), save, publish. The edit controls go away. As another dev user, the draft is read-only.

## Phase 5: Documentation

- [ ] 5.1 Documentation
  - Requirements: SPEC-009-R01–R12
  - Files: `docs/schemas.md` (new), `docs/schema.sql`, `README.md`, `specs/ROADMAP.md`
  - Do:
    - `docs/schemas.md`: naming and `applies_to`; draft and published; `$ref`, and why `$id` is refused; the `x-lde-*` keywords; `params_schema`; a node keeps its version; what the form renders and what falls back to raw JSON; the error format; a worked `curl` example using the fixtures.
    - `make schema SCHEMA_DB=lde_spec009`.
    - README: status row and the layout entry.
    - ROADMAP §1: split the "Schemas and governance tiers" row, marking schemas Built and governance Not started.
  - Verify: follow the `curl` example from a clean database.

## Phase 6: Verify and close out

- [ ] 6.1 `verifier` passes the whole spec
- [ ] 6.2 `uat-planner` writes [uat.md](uat.md)
- [ ] 6.3 Status set to Implemented, folder moved to `specs/implemented/`, `ROADMAP.md` updated
- [ ] 6.4 Summary commit written as the PR description
