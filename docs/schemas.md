# Schemas and schema-driven forms

A schema says what a record must contain: what a sample's `attrs` hold, or
what a run's `params` hold. Schemas are JSON Schema 2020-12 documents kept in
a registry, versioned, and immutable once published. The server checks every
write against the schema a record names, and the web UI draws a form from the
same schema. This is the design of [SPEC-009](../specs/implemented/SPEC-009-schema-registry-and-forms/requirements.md);
this page describes what it delivers.

Which namespaces may publish, and compatibility rules between versions, are
not part of it. Today any human with the `scientist` role may publish
anywhere. Per-namespace governance is [SPEC-010](../specs/SPEC-010-schema-governance/requirements.md).

## Naming and `applies_to`

A schema version is written `namespace/name@major.minor`, for example
`lab/sample@1.0`.

| Part | Pattern |
|---|---|
| `namespace` | `^~?[a-z0-9][a-z0-9._@+-]{0,127}$` |
| `name` | `^[a-z0-9][a-z0-9-]{0,127}$` |
| `major`, `minor` | whole numbers, 0 or more |

Each schema declares what it applies to, and that never changes. It is one of
the lineage node kinds `sample`, `reagent`, `protocol`, `run`, `instrument`,
`dataset` and `analysis`, or `run_params` for the params of a run. The database
refuses a node whose schema applies to another kind, so a `reagent` cannot name
`lab/sample@1.0`.

## Draft and published

A new version is a **draft**. Its author can edit the text as often as they
like, and nobody else can. Publishing makes it **published**, and from then on:

- The text can't change, and the version can't go back to draft. The database
  rejects any update, delete or truncate with `LDE03` (or `42501` for the app
  role, which has no such privilege), whoever asks.
- The version has a `sha256`, computed by the database from its stored text.
- Records may reference it. A draft can't be referenced.

Only a human with the `scientist` role may publish; agents and services can't.
Creating a schema or a draft needs `scientist` too. Anyone else gets `LDE05`.
To change a published schema, publish a new version.

## `$ref` and `$id`

A schema may use `$ref` and `$dynamicRef` in two ways only:

- a local fragment, such as `#/$defs/unit`;
- a published registry version, written `lde://schemas/<ns>/<name>/<major>.<minor>`,
  for example `lde://schemas/lab/sample/1.0`. A fragment may follow it.

Nothing is fetched from the network or the disk, so a schema means the same
thing on every server, offline too. Publishing a schema with any other `$ref`
is refused with `422`.

`$id` is refused outright. It could claim the URL of another version and shadow
it, or set a base URL that sends relative references somewhere unexpected.

A draft may name a version that isn't published yet. It can't be published, or
used for a record, until that version is.

## UI keywords

Three `x-lde-*` keywords shape the form. They don't affect validation. Unknown
`x-` keywords, and any other widget value, are ignored.

| Keyword | Where | Effect |
|---|---|---|
| `x-lde-unit` | a property | Adds the unit to the field's label, for example `Volume (µL)` |
| `x-lde-widget` | a property | `textarea` draws a multi-line box; `date` a date input |
| `x-lde-order` | an object | Lists property names in display order; the rest follow |

`format: date` also gives a date input. Formats are enforced by the server.

## Run params: `params_schema`

A protocol's frontmatter can name a schema for the params of its runs:

```yaml
---
protocol: qpcr-ddct
version: 3
params_schema: lab/qpcr-params@1.0
---
```

The schema must be published and apply to `run_params`, or the protocol version
is refused with `422`. Every run of that protocol version follows it, because a
run pins its protocol version.

A run that is `planned` isn't checked: params can be incomplete while you plan.
They are checked when the run moves to `running`. If they don't validate, the
transition is refused with `422`, the run stays `planned` and no event is
written. Once the run is `running`, every edit of its params is checked too,
whether made directly or by committing a change set.

## A node keeps its schema version

A node names a published schema version when it is created, in
`schema_version_id`, and keeps it. The database rejects any later change. A
node's version can't be attached, removed or moved after creation. Its attrs are
checked against that version on creation, on direct edits and when a change set
is committed. A failed check writes nothing, adds no revision, and leaves a
proposed change set proposed.

Audit events for schema-backed records carry `schema_version_id` and
`schema_sha256`, so an auditor can see exactly which text a record was held to.

## How forms get their errors

The Go server is the only validator. The browser draws the form with a library
and a small adapter, but the adapter reports no errors. While you type, the form
sends the values to `POST /v1/schemas/validate` (a dry run that writes nothing)
and shows what comes back, next to the field it names. The save is checked by
the same code. So what the form says and what the save does can't disagree.

## Error format

A write that fails validation, and a dry run of a schema that can't be saved,
answer `422`:

```json
{"error": "does not match lab/sample@1.0: /matrix value must be one of 'plasma', 'serum'; /volume_ul minimum: got -5, want 0",
 "errors": [{"pointer": "/matrix", "message": "value must be one of 'plasma', 'serum'"},
            {"pointer": "/volume_ul", "message": "minimum: got -5, want 0"}]}
```

`pointer` is an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) JSON pointer
into the value you sent; the whole value is `""`. A missing required property
is reported at the property's own pointer, with the message `is required`.
Errors are sorted by pointer. A reference to a schema version that isn't
published, or applies to another kind, is `422` with `error` only.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/schemas` | Create a schema: `{namespace, name, applies_to}` |
| `GET`  | `/v1/schemas` | Page of schemas, with each one's latest published version; `?applies_to=&cursor=&limit=` |
| `GET`  | `/v1/schemas/{ns}/{name}` | One schema and its versions, highest first |
| `POST` | `/v1/schemas/{ns}/{name}/versions` | Create a draft: `{major, minor, body_text}` |
| `GET`  | `/v1/schema-versions/{id}` | A version with its text and a self-contained `bundled` copy for forms |
| `PUT`  | `/v1/schema-versions/{id}` | Replace a draft's text (its author only) |
| `POST` | `/v1/schema-versions/{id}/publish` | Publish a draft |
| `POST` | `/v1/schemas/validate` | Dry run: `{schema_version_id, instance}` or `{body_text, instance}`; answers `{valid, errors}` |

`POST /v1/lineage/nodes` and the `add_node` change item take an optional
`schema_version_id`. A run's `params_schema_version_id` is returned with the run.

## Audit actions

| Action | When |
|---|---|
| `schema.created` | A schema is created |
| `schema.version_drafted` | A draft is created |
| `schema.version_updated` | A draft's text is replaced |
| `schema.version_published` | A draft is published |

The version events record the schema id, `major`, `minor` and `sha256`. Each is
written in the same transaction as the change.

## Worked example

This starts from a clean database and the dev server (`LDE_ENV=dev go run ./cmd/server`,
see the README). In dev, requests carry a tenant and a handle; a new handle
holds every role.

```bash
T=00000000-0000-4000-8000-000000000001     # seeded dev tenant
H=(-H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" -H "Content-Type: application/json")
API=localhost:8080/v1

# 1. Register a schema for samples, and a draft of version 1.0
curl -s "${H[@]}" $API/schemas -d '{"namespace":"lab","name":"sample","applies_to":"sample"}'
SV=$(jq -n '{major:1, minor:0, body_text: ({type:"object", required:["volume_ul"],
      properties:{volume_ul:{type:"number", minimum:0, "x-lde-unit":"µL"}, matrix:{enum:["plasma","serum"]}}} | tojson)}' \
    | curl -s "${H[@]}" $API/schemas/lab/sample/versions -d @- | jq -r .id)

# 2. Dry run, then publish
curl -s "${H[@]}" $API/schemas/validate -d "{\"schema_version_id\":\"$SV\",\"instance\":{\"volume_ul\":-5}}"
# {"errors":[{"pointer":"/volume_ul","message":"minimum: got -5, want 0"}],"valid":false}
curl -s "${H[@]}" -X POST $API/schema-versions/$SV/publish | jq -c '{status,sha256}'

# 3. A bad node is refused; a good one is created
curl -s -w ' [%{http_code}]\n' "${H[@]}" $API/lineage/nodes \
  -d "{\"kind\":\"sample\",\"label\":\"Plasma 042\",\"schema_version_id\":\"$SV\",\"attrs\":{\"volume_ul\":-5,\"matrix\":\"urine\"}}"
# {"error":"does not match lab/sample@1.0: /matrix value must be one of 'plasma', 'serum'; ...","errors":[...]} [422]
curl -s -w ' [%{http_code}]\n' "${H[@]}" $API/lineage/nodes \
  -d "{\"kind\":\"sample\",\"label\":\"Plasma 042\",\"schema_version_id\":\"$SV\",\"attrs\":{\"volume_ul\":50,\"matrix\":\"plasma\"}}"
# {"id":"...","kind":"sample",...,"attrs":{"matrix":"plasma","volume_ul":50},"schema_version_id":"..."} [201]
```

Run params work the same way. Publish `lab/qpcr-params@1.0`, which applies to
`run_params`, then name it in a protocol:

```bash
curl -s "${H[@]}" $API/schemas -d '{"namespace":"lab","name":"qpcr-params","applies_to":"run_params"}'
PV=$(jq -n '{major:1, minor:0, body_text: ({type:"object", required:["cycles"],
      properties:{cycles:{type:"integer", minimum:1}}} | tojson)}' \
    | curl -s "${H[@]}" $API/schemas/lab/qpcr-params/versions -d @- | jq -r .id)
curl -s "${H[@]}" -X POST $API/schema-versions/$PV/publish >/dev/null

EXP=$(printf -- '---\nprotocol: qpcr-ddct\nversion: 1\nparams_schema: lab/qpcr-params@1.0\n---\n# qPCR\n' \
   | jq -Rs '{slug:"qpcr", title:"qPCR", protocol_md:.}' | curl -s "${H[@]}" $API/experiments -d @- | jq -r .id)
RUN=$(curl -s "${H[@]}" $API/runs -d "{\"experiment_id\":\"$EXP\",\"label\":\"Plate 7\"}" | jq -r .id)

# No params yet: starting is refused and the run stays planned
curl -s -w ' [%{http_code}]\n' "${H[@]}" $API/runs/$RUN/transitions -d '{"to":"running"}'
# {"error":"params do not match lab/qpcr-params@1.0: /cycles is required","errors":[{"pointer":"/cycles","message":"is required"}]} [422]

curl -s "${H[@]}" -X PATCH $API/runs/$RUN/params -d '{"params":{"cycles":40},"reason":"set cycles"}'
curl -s "${H[@]}" $API/runs/$RUN/transitions -d '{"to":"running"}' | jq -c '{state}'
# {"state":"running"}
```
