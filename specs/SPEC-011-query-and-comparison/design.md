# SPEC-011 design: Query and comparison

Requirements: [requirements.md](requirements.md)

## 1. Simplicity budget

- Approach: plain SQL in the handlers. `attrs @? $jsonpath` with a parameterised jsonpath, a GIN index on `attrs`, and `date_bin` bucketing in SQL. Everything runs inside `WithTenant`, so RLS scopes every query. Charts use one small library.
- Not doing: a query language of our own, a search engine (OpenSearch), an OLAP store or materialised views.

## 2. Data and interfaces

- Indexes (new migration): `lineage_nodes USING gin (attrs jsonb_path_ops)`, `(tenant_id, schema_version_id)`, `(tenant_id, kind, created_at)`, and `pg_trgm` on `label` if the extension is available (open question 2).
- API:
  - `GET /v1/lineage/nodes?kind=&schema=&label=&created_after=&created_before=&where=<jsonpath>&cursor=&limit=`
  - `GET /v1/datasets/{id}/channels`
  - `GET /v1/datasets/{id}/readings?channel=&from=&to=&bucket=&cursor=&limit=`
  - `POST /v1/compare/series {dataset_ids, channel, bucket}`
  - `POST /v1/compare/attrs {node_ids}`

## 3. UI

Built on the SPEC-025 design system: tokens, shared components (`StatusBadge`, `Field`, `Dialog`, `EmptyState`, `RecordDetails`, `ErrorMessage`, toasts), the plain-language glossary and the error-message table. Every action shows a toast on success and an inline `ErrorMessage` on failure; identifiers and digests go in Record details.

- **Quick search** is the SPEC-025 top-bar search field: typing searches item labels across kinds, with results grouped as Experiments, Runs, Samples and materials, Datasets. **Advanced search** opens a Search tab.
- **Advanced search:** pick a kind, then a schema. The schema's fields become typed `Field`s built from their JSON Schema types: number range, date range, enum select, text contains. Active filters show as removable chips, and the result count updates as filters change (debounced 300 ms). Results go in a DataTable with `StatusBadge` where relevant, plus row checkboxes. A sticky action bar, **Compare (n)**, appears once two or more datasets are selected.
- **Input picker:** this spec's node search replaces SPEC-025's paste-an-ID input on the run view with a `ComboBox` that searches samples and materials by label. ID entry stays as a fallback for barcode scanners.
- **Dataset chart** follows the `dataviz` skill and SPEC-025 tokens:
  - one line per channel from a categorical palette validated in both themes;
  - a legend showing channel and unit, units on both axes, and a min/max band when bucketed;
  - drag to zoom, with a visible **Reset zoom** button and keyboard zoom (`+` and `-`);
  - a hover tooltip with time, value and unit in Fira Code.
  A **Table** toggle shows the same data as a table, for screen readers and exact values.
- **Comparison view:** overlaid series, a legend per dataset (run label, instrument) that toggles a series on click, and the attribute table below. Values that differ get the `--accent` tint plus a "differs" icon.
- Empty states: no results → "No matches. Try removing the last filter." with that chip focused; no readings → "No readings yet. Send data from the run view."
- **Copy table** is a `.btn-ghost`, confirmed by a toast.

## 4. Decision log

| Date | Decision | Why | Alternatives rejected |
|---|---|---|---|
| 2026-10-20 | Filters use PostgreSQL SQL/JSON path, passed as a bound parameter | Expressive, indexed by GIN, no custom language | A home-grown filter DSL |
| 2026-10-20 | Frontend dependency `uplot` for charts | ~50 KB, handles 10⁵–10⁶ points | Chart.js, Plotly (heavier) |
