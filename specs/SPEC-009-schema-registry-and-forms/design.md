# SPEC-009 design: Schema registry and schema-driven forms

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: tables `schemas` and `schema_versions`, with a generated SHA-256 and a generated `jsonb` over the stored text. Nodes and protocol versions get a nullable reference, guarded by a trigger requiring published status and a matching kind; a run's schema is its pinned protocol version's. Validation uses one Go library behind a few functions in `internal/domain`, and the Go server is the only validator of record. Forms are stock `@rjsf/core`, driven by the schema plus a few `x-lde-*` keywords. Their errors come from the same Go code through the dry-run endpoint. A small adapter supplies the browser-side validator rjsf needs for drawing, without `unsafe-eval`. A planned run may hold incomplete params; starting it checks them.
- Not doing: a custom schema language, a form designer, an in-house form renderer, browser-side error messages, validation inside PostgreSQL, a schema column on `runs`, or starter schemas (SPEC-024).

## 2. Data and interfaces

### Migration `0022_schema_registry`

The SQL below ran as written against Postgres 16, in a transaction that was rolled back.

```sql
CREATE TABLE schemas (
    id         uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id  uuid NOT NULL REFERENCES tenants (id),
    namespace  text NOT NULL CHECK (namespace ~ '^~?[a-z0-9][a-z0-9._@+-]{0,127}$'),
    name       text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
    applies_to text NOT NULL CHECK (applies_to IN ('sample', 'reagent', 'protocol', 'run', 'instrument', 'dataset', 'analysis', 'run_params')),
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, namespace, name)
);

CREATE TABLE schema_versions (
    id           uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    uuid NOT NULL REFERENCES tenants (id),
    schema_id    uuid NOT NULL,
    major        int NOT NULL CHECK (major >= 0),
    minor        int NOT NULL CHECK (minor >= 0),
    status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    body_text    text NOT NULL,
    body         jsonb GENERATED ALWAYS AS (body_text::jsonb) STORED,
    sha256       bytea GENERATED ALWAYS AS (protocol_sha256(body_text)) STORED,
    author       text NOT NULL,
    author_id    uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_by uuid,
    published_at timestamptz,
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, schema_id, major, minor),
    FOREIGN KEY (tenant_id, schema_id)    REFERENCES schemas (tenant_id, id),
    FOREIGN KEY (tenant_id, author_id)    REFERENCES principals (tenant_id, id),
    FOREIGN KEY (tenant_id, published_by) REFERENCES principals (tenant_id, id),
    CHECK ((status = 'published') = (published_at IS NOT NULL)),
    CHECK (jsonb_typeof(body) = 'object')
);

-- SPEC-009-R11; a schema's name and applies_to never change, because R03 reads them.
CREATE FUNCTION schemas_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM lde_require_role('scientist');
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a schema''s identity never changes (% rejected)', TG_OP USING ERRCODE = 'LDE03';
END;
$$;
CREATE TRIGGER schemas_guard BEFORE INSERT OR UPDATE OR DELETE ON schemas
    FOR EACH ROW EXECUTE FUNCTION schemas_guard();
CREATE TRIGGER schemas_no_truncate BEFORE TRUNCATE ON schemas
    FOR EACH STATEMENT EXECUTE FUNCTION schemas_guard();

-- SPEC-009-R01, R10, R11. The immutability check comes first, so it answers
-- LDE03 whoever is asking. The owner may insert a published row (SPEC-015).
CREATE FUNCTION schema_versions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'schema versions are never truncated' USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.status = 'published' THEN
        RAISE EXCEPTION 'schema version % is published and immutable (% rejected)', OLD.id, TG_OP USING ERRCODE = 'LDE03';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    PERFORM lde_require_role('scientist');
    IF TG_OP = 'INSERT' THEN
        IF current_user = 'lde_app' THEN
            IF NEW.status <> 'draft' THEN
                RAISE EXCEPTION 'a schema version starts as a draft' USING ERRCODE = 'check_violation';
            END IF;
            NEW.author_id := lde_current_principal();
            NEW.created_at := clock_timestamp();
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.tenant_id, NEW.schema_id, NEW.major, NEW.minor, NEW.author, NEW.author_id, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.tenant_id, OLD.schema_id, OLD.major, OLD.minor, OLD.author, OLD.author_id, OLD.created_at) THEN
        RAISE EXCEPTION 'schema version %: identity and authorship never change', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    IF current_user = 'lde_app' THEN
        IF NEW.status = 'draft' THEN
            IF lde_current_principal() IS DISTINCT FROM OLD.author_id THEN
                RAISE EXCEPTION 'only the author of schema version % may change its draft', OLD.id USING ERRCODE = 'LDE05';
            END IF;
        ELSE
            IF NEW.body_text IS DISTINCT FROM OLD.body_text THEN
                RAISE EXCEPTION 'schema version %: publishing cannot change the text', OLD.id USING ERRCODE = 'LDE03';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM principals pr WHERE pr.id = lde_current_principal() AND pr.kind = 'human' AND pr.enabled) THEN
                RAISE EXCEPTION 'only a human may publish a schema version' USING ERRCODE = 'LDE05';
            END IF;
            NEW.published_by := lde_current_principal();
            NEW.published_at := clock_timestamp();
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER schema_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON schema_versions
    FOR EACH ROW EXECUTE FUNCTION schema_versions_guard();
CREATE TRIGGER schema_versions_no_truncate BEFORE TRUNCATE ON schema_versions
    FOR EACH STATEMENT EXECUTE FUNCTION schema_versions_guard();
```

Then, for both tables: `ENABLE` and `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy for `lde_app` and the `owner_maintenance` policy, exactly as in `0005_protocol_versions.sql`. Grants: `GRANT SELECT, INSERT ON schemas TO lde_app`, and `GRANT SELECT, INSERT, UPDATE (body_text, status) ON schema_versions TO lde_app`.

`body` is generated, so it can never disagree with the text that `sha256` covers. Text that isn't JSON fails with `22P02` and a non-object with `23514`; the API checks both first (R08), so these are the second line.

The same file then adds the references:

```sql
ALTER TABLE lineage_nodes ADD COLUMN schema_version_id uuid;
ALTER TABLE lineage_nodes ADD FOREIGN KEY (tenant_id, schema_version_id) REFERENCES schema_versions (tenant_id, id);
ALTER TABLE protocol_versions ADD COLUMN params_schema_version_id uuid;
ALTER TABLE protocol_versions ADD FOREIGN KEY (tenant_id, params_schema_version_id) REFERENCES schema_versions (tenant_id, id);

-- SPEC-009-R03. Row security hides another tenant's versions, and t covers the owner.
CREATE FUNCTION schema_ref_check(t uuid, v uuid, want text) RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.schema_versions sv
        JOIN public.schemas s ON s.tenant_id = sv.tenant_id AND s.id = sv.schema_id
        WHERE sv.tenant_id = t AND sv.id = v AND sv.status = 'published' AND s.applies_to = want
    ) THEN
        RAISE EXCEPTION 'schema version % is not a published schema for %', v, want USING ERRCODE = 'LDE06';
    END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION schema_ref_check(uuid, uuid, text) TO lde_app;

-- SPEC-009-R03, R12
CREATE FUNCTION lineage_nodes_schema_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'node %: schema_version_id is fixed when the node is created', OLD.id USING ERRCODE = 'LDE03';
    END IF;
    PERFORM public.schema_ref_check(NEW.tenant_id, NEW.schema_version_id, NEW.kind);
    RETURN NEW;
END;
$$;
CREATE TRIGGER lineage_nodes_schema_ref BEFORE INSERT ON lineage_nodes
    FOR EACH ROW WHEN (NEW.schema_version_id IS NOT NULL)
    EXECUTE FUNCTION lineage_nodes_schema_ref();
CREATE TRIGGER lineage_nodes_schema_pinned BEFORE UPDATE OF schema_version_id ON lineage_nodes
    FOR EACH ROW WHEN (OLD.schema_version_id IS DISTINCT FROM NEW.schema_version_id)
    EXECUTE FUNCTION lineage_nodes_schema_ref();

-- SPEC-009-R03. protocol_versions is already append-only, so the reference can't change.
CREATE FUNCTION protocol_versions_schema_ref() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    PERFORM public.schema_ref_check(NEW.tenant_id, NEW.params_schema_version_id, 'run_params');
    RETURN NEW;
END;
$$;
CREATE TRIGGER protocol_versions_schema_ref BEFORE INSERT ON protocol_versions
    FOR EACH ROW WHEN (NEW.params_schema_version_id IS NOT NULL)
    EXECUTE FUNCTION protocol_versions_schema_ref();
```

Add `schemas_guard`, `schemas_no_truncate`, `schema_versions_guard`, `schema_versions_no_truncate`, `lineage_nodes_schema_ref`, `lineage_nodes_schema_pinned` and `protocol_versions_schema_ref` to `iqTriggers`.

A run has no schema column. Its schema is `protocol_versions.params_schema_version_id` of the version it pins, and SPEC-003 makes that pin immutable. The API returns it on a run as `params_schema_version_id`.

### Validation (`internal/domain/schema.go`)

Pure Go, with no I/O; the caller passes a function that reads the registry.

```go
type SchemaProblem struct {
    Pointer string `json:"pointer"`
    Message string `json:"message"`
}

// CheckSchema is R08: an object, no other $schema, valid against the 2020-12 metaschema.
func CheckSchema(bodyText string) []SchemaProblem

// SchemaRefs lists every $ref and $dynamicRef that isn't a local fragment, and
// problems for any $id or for a ref that isn't an lde:// registry URL. R07's first half.
func SchemaRefs(bodyText string) (refs []string, problems []SchemaProblem)

// CompileSchema compiles for validation. load returns a registry version's text.
func CompileSchema(url, bodyText string, load func(url string) (string, error)) (*jsonschema.Schema, error)

// ValidateInstance returns one problem per failed rule, sorted by pointer, then message.
func ValidateInstance(s *jsonschema.Schema, instance []byte) []SchemaProblem

// BundleSchema returns one self-contained document for the form. Each lde://
// version the body reaches, transitively, goes into the root $defs under the
// key "lde:<ns>:<name>:<major>.<minor>". Every $ref to it becomes a local
// pointer ("#/$defs/<key>" plus its fragment, escaped per RFC 6901), and the
// local refs inside an embedded document gain that prefix. A ref load can't
// find (a draft's) is left as it is.
func BundleSchema(bodyText string, load func(url string) (string, error)) (map[string]any, error)

// ParseSchemaName parses "ns/name@major.minor"; ParseSchemaURL parses its lde:// form.
func ParseSchemaName(s string) (ns, name string, major, minor int, ok bool)
func ParseSchemaURL(s string) (ns, name string, major, minor int, ok bool)
func SchemaURL(ns, name string, major, minor int) string
```

These rules come from running the library, `santhosh-tekuri/jsonschema/v6` v6.0.3, on the fixtures. Its defaults would break the requirements in each case:

- **`CompileSchema` always calls `UseLoader`.** The default loader reads `file://` URLs, so a `$ref` could read the server's disk. Our loader's function accepts only `lde://` URLs.
- **`CompileSchema` calls `DefaultDraft(jsonschema.Draft2020)` and `AssertFormat()`.** Formats aren't enforced otherwise, and SPEC-015 needs `format: date` to be.
- **`CheckSchema` tests `$schema` itself.** The library accepts a draft-07 `$schema` and the boolean schema `true`. It validates against a separate compiler's `Compile("https://json-schema.org/draft/2020-12/schema")`, which is embedded in the library. That is deliberately not `CompileSchema`: a draft may name a `$ref` that isn't published yet.
- **`ValidateInstance` walks to the leaf `Causes` and rewrites locations.** The library reports `kind.Required` and `kind.AdditionalProperties` at the parent. So each name in `Missing` becomes its own problem at `<parent>/<name>` with the message "is required", and each name in `Properties` one at `<parent>/<name>` with "is not allowed". Other leaves keep their location and `ErrorKind.LocalizedString(message.NewPrinter(language.English))`. Pointer segments escape `~` as `~0` and `/` as `~1`, per RFC 6901. The root is `""`.
- **`SchemaRefs` refuses `$id`.** A body's `$id` could claim another version's URL and shadow it, or set a base URL for relative refs.

A string value under the key `$ref`, `$dynamicRef` or `$id` counts wherever it appears, including inside `const` or `enum`. That is over-strict but harmless. An object under such a key (a property named `$ref`) doesn't count.

### API

The status is `422` for R04, R05, R07 and R08, with this body:

```json
{"error": "does not match lab/sample@1.0: /matrix value must be one of 'plasma', 'serum'; /volume_ul minimum: got -5, want 0",
 "errors": [{"pointer": "/matrix", "message": "value must be one of 'plasma', 'serum'"},
            {"pointer": "/volume_ul", "message": "minimum: got -5, want 0"}]}
```

`LDE06` also maps to `422`, with `error` only, through `storage.IsBadSchemaRef`.

| Endpoint | Body | Answer |
|---|---|---|
| `POST /v1/schemas` | `{namespace, name, applies_to}` | `201`, the schema. A bad name or kind is `400`, a duplicate `409`. |
| `GET /v1/schemas?applies_to=&cursor=&limit=` | | A page of schemas, oldest first, each with `latest_published: {id, major, minor, sha256}` or null (the highest published version). |
| `GET /v1/schemas/{ns}/{name}` | | The schema with `versions`, highest first, without their text. |
| `POST /v1/schemas/{ns}/{name}/versions` | `{major, minor, body_text}` | `201`, a draft (R08). A duplicate is `409`. |
| `GET /v1/schema-versions/{id}` | | The version with `namespace`, `name`, `applies_to`, `body_text`, and `bundled`: the `BundleSchema` result. rjsf resolves only local `#/…` refs, so the form renders `bundled`. |
| `PUT /v1/schema-versions/{id}` | `{body_text}` | `200`, the version (R08, R10). |
| `POST /v1/schema-versions/{id}/publish` | none | `200`, the version (R07, R11). |
| `POST /v1/schemas/validate` | `{schema_version_id, instance}` or `{body_text, instance}` | `200`, `{valid, errors}`. Reads only. A `body_text` that breaks R08 or R07 is `422`. This is the form's only source of errors. |
| `POST /v1/lineage/nodes` | gains optional `schema_version_id` | As before, plus `schema_version_id` on the node. |
| `op: add_node` | gains optional `schema_version_id` | As before. |

The design first had `/v1/schemas/{ns}/{name}/versions/{ver}` for read, edit and publish. A node carries only an id, so the UI would have had to look that path up. One id-based path needs no version parsing.

**Who validates what.** Each is in the same transaction as the write:

- `createNode` and `add_node` call `insertSchemaNode`: insert the row (the trigger answers R03 first), validate, then audit. With no schema it calls the existing `insertNode`, so the other call sites don't change.
- `applyItem` validates `update_node` attrs when they are present, against the node's version, and `update_run_params` against the run's, unless the run is `planned`. Every direct edit and commit passes through it.
- `createRun` doesn't validate: a new run is `planned`.
- `transitionRun`, from `planned` to `running` with a schema, validates the params it read `FOR UPDATE` after `run.Apply` and before the `UPDATE`. A problem is `422` and the transaction rolls back, so the run stays planned and no event is written (R13). The run's row lock means a params edit can't slip in between.
- `addProtocolVersion` resolves `params_schema` (R04). A value that isn't a string, doesn't parse, or names no version in the tenant is `422`.
- A proposal isn't validated, only its commit. A failed commit is `422` and the change set stays proposed (SPEC-007-R04). The form has already checked the values through the dry run.

**Locks.** `publish` and `PUT` call `audit.LockChain`, then read the version `FOR UPDATE`, so the text they check is the text they save.

**Audit.** Actions are `schema.created` (entity `schema`; payload `namespace`, `name`, `applies_to`), `schema.version_drafted`, `schema.version_updated` and `schema.version_published` (entity `schema_version`; payload `schema_id`, `major`, `minor`, `sha256`). Schema-backed `lineage.node_created`, `record.revised`, `run.created` and `protocol.version_created` events add `schema_version_id` and `schema_sha256` to their payload (R06). Events for records with no schema don't change. The digest format isn't touched.

**Manifest.** Unchanged, so existing signatures stay valid. A manifest already pins the protocol's hash, and the protocol text names its `params_schema`.

**Frontmatter.** `params_schema: <ns>/<name>@<major>.<minor>`.

**New SQLSTATE.** `LDE06` = invalid schema reference (`storage.CodeSchemaRef`), already reserved in `ROADMAP.md`.

**UI keywords.** `x-lde-unit`, `x-lde-widget` (`textarea`, `date`), `x-lde-order`. Unknown `x-` keywords, and any other widget value, are ignored by validation and by the form.

## 3. UI

**Forms are stock rjsf.** Dependencies `@rjsf/core` and `@rjsf/utils` 6.11.1 (Apache-2.0) and `@cfworker/json-schema` 4.1.6 (MIT), pinned exactly. rjsf's default theme is used, styled through classes in `styles.css`, since the CSP has no `unsafe-inline` styles.

**One source of truth: the Go server.** The server validates every write. The errors a scientist sees in a form come only from the server: from the dry run while editing, and from a `422` on save. So the form's hint and the save's verdict can't disagree.

- **`web/src/schemaValidator.ts`.** rjsf requires a validator object, which it also uses to decide what to draw: which `oneOf` or `anyOf` branch applies, and `if`/`then`. Its usual one, `@rjsf/validator-ajv8`, generates code with `new Function`, which the CSP blocks (`default-src 'self'`, no `unsafe-eval`). This file implements rjsf's documented `ValidatorType` (`validateFormData`, `isValid`, `rawValidation`, `toErrorList`) over `@cfworker/json-schema`'s `new Validator(schema, '2020-12')`, which doesn't generate code. `isValid` and `rawValidation` answer rjsf's drawing questions. `validateFormData` returns no errors, because errors come from the server.
- **`uiSchemaFor(schema)`.** It maps the `x-lde-*` keywords onto rjsf's uiSchema. `x-lde-unit` adds ` (µL)` to the field's `ui:title`, `x-lde-widget: textarea` sets `ui:widget: 'textarea'`, and `x-lde-order` sets the parent's `ui:order`, with `'*'` last. rjsf already draws `format: date` as a date input.
- **`toErrorSchema(problems)`.** It turns server problems (`pointer`, `message`) into rjsf's `extraErrors` shape, unescaping `~1` and `~0`. A problem at `""` goes on the form itself.
- **`useSchemaValidation(source, target, value)`.** It calls `POST /v1/schemas/validate` 300 ms after the last change, ignores out-of-date answers, and dispatches `labrat:problems` with `{source, problems}`.
- **`RecordForm.tsx`.** rjsf's `Form` with the adapter as `validator`, `uiSchemaFor`, `extraErrors` from the hook (or from the last save's `422`), `liveValidate` off, `noHtml5Validate` on, and no submit button of its own. A `warnOnly` prop shows the problems without blocking, for planned runs.

The Problems panel shows the latest problems per source, and a source's empty list clears it.

**Where forms appear.**
- `EditField` gains an optional `schemaVersionId`. When set, it renders `RecordForm` for editing, and the same form, read-only, for reading. The reason and "Propose correction" flow stay as they are.
  - The lineage panel passes the node's version.
  - The run view passes the run's, with `warnOnly` while the run is planned.
  - Records with no schema keep the JSON box.
- New tab `newnode`, "New record": kind, optional schema (from `GET /v1/schemas?applies_to=<kind>`, showing `latest_published`), label, and the form or a JSON box. It creates the node and opens its lineage. The UI has no way to create a node today.
- `ExperimentView` gains a "New run" form: label, optional input node ids, and the params form (`warnOnly`) when the latest protocol version names a schema, otherwise a JSON box. It creates the run and opens it. The UI has no way to create a run today.
- A transition to `running` refused with `422` shows the errors in the run view and the Problems panel.

**Schema browser.** New tabs `schemas` ("Schemas": a list grouped by namespace, with a new-schema form) and `schema` (id `ns/name`: versions, field docs from the schema, and a sample form that saves nothing). Tab kinds are lowercase letters only, because `fromHash` matches `[a-z]+`.

**Draft editor.** Part of the `schema` tab, shown for a draft whose `author_id` is the user. JSON text, with a live form preview and messages from the dry run in `body_text` mode; Save; Publish, with a confirmation that says the version can't change afterwards. The preview renders the last saved `bundled` document until the text parses, and then the text itself; a `$ref` it can't resolve shows rjsf's own unsupported-field notice.

Both use only the public API (D7).

## 4. Testing approach

Only the `Test: yes` requirements get tests.

| Requirement | Test | Where |
|---|---|---|
| R01 | `TestPublishedSchemaVersionsAreImmutable` | `internal/storage/integration_test.go` |
| R03 | `TestSchemaReferencesMustBePublished` | `internal/storage/integration_test.go` |
| R05 | `TestSchemaValidationOnWrite` | `internal/api/integration_test.go` |
| R13 | `TestRunStartNeedsValidParams` | `internal/api/integration_test.go` |

Everything else is accepted by the verifier's review and the UAT plan. R09 isn't marked `Test: yes`, so no Playwright test is added.

## 5. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | JSON Schema 2020-12 is the stored format (ROADMAP D3) | Mature Go and JS validators; LinkML can compile to it | LinkML as stored format (Python-only tooling) |
| 2026-10-20 | Dependency `github.com/santhosh-tekuri/jsonschema/v6` | Full 2020-12 support, custom loaders (registry-only `$ref`), pure Go | `xeipuuv/gojsonschema` (draft-07 only) |
| 2026-10-20 | Conformance checked in Go; the DB enforces reference validity (published + kind) | No stock PG extension validates JSON Schema; the DB still guards the "never" rules | `pg_jsonschema` (extension not available in typical managed PG) |
| 2026-11-05 | Pin the library at v6.0.3. `golang.org/x/text`, already an indirect dependency, becomes direct | The library's error messages are localized through an `x/text` printer | Writing a message for every error kind |
| 2026-11-06 | Stock `@rjsf/core` and `@rjsf/utils` 6.11.1 (Apache-2.0) for forms, with `@cfworker/json-schema` 4.1.6 (MIT) behind a small `ValidatorType` adapter (Rob, open question 1) | Out-of-the-box components where the licence allows. The adapter exists for one business reason: rjsf's Ajv validator needs `unsafe-eval`, and the CSP is the UI's main defence against injected script in a Part 11 system. cfworker supports 2020-12 and doesn't generate code | An in-house form renderer (unnecessary risk); Ajv with `unsafe-eval` (weakens the CSP, and a likely audit finding); rjsf with a no-op validator (breaks `oneOf` and `if`) |
| 2026-11-06 | Form errors come only from the Go server's dry run; the browser validator never shows one | One validator of record, so no drift between hint and verdict. Rob: a browser verdict would invite schema drift | Showing cfworker's errors (two validators can disagree) |
| 2026-11-06 | The form renders `bundled`, from `domain.BundleSchema` | rjsf resolves only local `#/…` refs | Teaching rjsf to fetch `lde://` refs |
| 2026-11-06 | A planned run's params aren't checked; starting the run checks them (R13) | Agility while planning is a selling point (Rob). The start is where a wrong value would first matter, and SPEC-016's preflight can report problems before it | Checking on every write; checking only the values filled in |
| 2026-11-06 | One migration, `0022` | No clients, and the database is rebuilt for every UAT, so splitting migrations by task buys nothing | `0022` and `0023` |
| 2026-11-06 | Starter schemas and open standards go to SPEC-024. Allotrope ontology terms (AFO, CC BY 4.0) are used, not ASM schemas (CC BY-NC 4.0, non-commercial) | Keeps this spec generic, as Rob asked. ASM's licence forbids commercial use | Shipping ASM; doing the standards here |
| 2026-11-05 | `body` is generated from `body_text` | The design had two written columns, which could disagree under one hash | Two written columns |
| 2026-11-05 | A run's schema is read through its protocol version; `runs` gets no column | SPEC-003's pin already fixes it, so no copy can drift | `runs.params_schema_version_id`, with a copy trigger and a pin trigger |
| 2026-11-05 | A node's schema is set at creation and never changes (R12) | Migrating between versions is out of scope, and an unrevisioned change to it would be silent | Adding the column to `record_revise` and an edit path |
| 2026-11-05 | Publishing needs a human (R11) | ROADMAP D6: agents propose but don't commit or sign. SPEC-014-R03 relies on it, and a publish can't be undone | Leaving it to the MCP layer |
| 2026-11-05 | `node-picker` moves to SPEC-011 | It needs a node search endpoint, which the registry doesn't otherwise need, and SPEC-011 builds that search | A one-off `GET /v1/lineage/nodes` here |
| 2026-11-05 | The UI gains New record and New run | R09's forms need somewhere to create records, and the UI can't yet | API-only creation, which leaves scientists writing JSON, the problem this spec exists to fix |
| 2026-11-05 | Validate on commit, not on proposal | `applyItem` is the one place every path passes through. A proposal changes no record, and SPEC-013's parsers may propose values for a human to correct | Validating twice |
