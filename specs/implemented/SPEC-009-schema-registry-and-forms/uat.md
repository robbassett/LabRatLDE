# SPEC-009 user acceptance test plan: Schema registry and schema-driven forms

| | |
|---|---|
| **Build** | commit `a9a9fca` on `worktree-spec-009-tasks` |
| **Written** | 2026-11-06 |
| **Testers** | scientist (cases 1-14), QA or lab manager (cases 6, 7, 9 and the sign-off) |

You will check that a lab can define what a sample or a run's parameters must contain, that scientists get a form instead of raw JSON, and that bad values are refused with a message that names the field. Use synthetic data only.

Known limitations, not UAT failures:

- Units (`x-lde-unit`) of fields that come from a `$ref`-bundled definition are not shown on form labels.
- "Start run" in the run view sends a fixed reason ("Start run").
- The database owner can still change a node's kind. This is a follow-up and is not tested here.

## 1. Setup

The database is rebuilt for this UAT. Run from a clean checkout of the build above. Node 22 is needed for the UI, and `curl` and `jq` for the API steps (Git Bash or WSL on Windows).

```bash
docker compose down -v && docker compose up -d     # fresh PostgreSQL 16
make ui                                            # builds the web UI into web/dist
LDE_ENV=dev go run ./cmd/server                    # migrates, seeds the dev tenant, listens on :8080
```

Leave the server running. In a second terminal, set up the shell used by the API steps:

```bash
T=00000000-0000-4000-8000-000000000001            # seeded dev tenant
API=localhost:8080/v1
A=(-H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" -H "Content-Type: application/json")   # scientist 1
B=(-H "X-LDE-Tenant: $T" -H "X-LDE-Actor: bob"   -H "Content-Type: application/json")   # scientist 2
```

In the dev server a handle it has not seen gets every role. Open http://localhost:8080/ in a browser. When asked, use tenant `00000000-0000-4000-8000-000000000001` and handle `alice`. For cases that need a second person (case 3), use a private window with handle `bob`.

Create the run-params schema and an experiment that uses it (the sample schema is built in the UI in case 1):

```bash
curl -s "${A[@]}" $API/schemas -d '{"namespace":"lab","name":"qpcr-params","applies_to":"run_params"}'
PV=$(jq -n '{major:1, minor:0, body_text: ({type:"object", required:["cycles"],
      properties:{cycles:{type:"integer", minimum:1, title:"Cycles"}}} | tojson)}' \
    | curl -s "${A[@]}" $API/schemas/lab/qpcr-params/versions -d @- | jq -r .id)
curl -s "${A[@]}" -X POST $API/schema-versions/$PV/publish | jq -c '{status,sha256}'
EXP=$(printf -- '---\nprotocol: qpcr-ddct\nversion: 1\nparams_schema: lab/qpcr-params@1.0\n---\n# qPCR\n' \
   | jq -Rs '{slug:"qpcr", title:"qPCR", protocol_md:.}' | curl -s "${A[@]}" $API/experiments -d @- | jq -r .id)
echo "PV=$PV EXP=$EXP"
```

Expected: `status` is `published` with a 64-character `sha256`, and `EXP` is a UUID.

The UI sample schema text used in cases 1, 2 and 8 (paste it as one line):

```json
{"type":"object","required":["volume_ul"],"properties":{"volume_ul":{"type":"number","minimum":0,"title":"Volume","description":"Volume of the aliquot","x-lde-unit":"µL"},"matrix":{"enum":["plasma","serum"],"title":"Matrix"}}}
```

## 2. Test cases

### UAT-01: Write, preview and publish a schema in the schema browser

- **Requirements:** SPEC-009-R02, SPEC-009-R08, SPEC-009-R09, SPEC-009-R10, SPEC-009-R11
- **As:** scientist (alice)
- **Steps:**
  1. In the explorer open **Schemas**. The list shows namespace `lab` with `qpcr-params` and latest published `1.0`.
  2. In **New schema** enter namespace `lab`, name `sample`, applies to `sample`, then **Create schema**. The `lab/sample` tab opens and says "Applies to sample" and "No versions yet".
  3. In **New draft** set major `1`, minor `0`, replace the text with the sample schema above, then **Create draft**.
  4. Click version `1.0` in the Versions table. The draft editor appears with the text on the left and a live preview form on the right.
  5. In the preview, type `-5` in the volume field. Check the field and the Problems panel (bottom) show an error for `/volume_ul`. Correct it to `50` and the error clears.
  6. Change the text to `{"type":"nonsense"}`. The text is not saved until you click **Save**; click **Save**.
  7. Restore the sample schema text, click **Save**, then **Publish**. A dialog says "Published versions can never change". Confirm.
- **Expected:**
  - The preview form shows the labels `Volume (µL)` (required) and `Matrix` (a select with plasma and serum), and the description "Volume of the aliquot".
  - Step 6 shows an alert that the schema is not valid and nothing is saved (reload and the text is still the sample schema).
  - After publishing, the version shows status `published`, an author of `alice`, a 12-character hash and a publish time. The draft editor, Save and Publish controls are gone; instead the sample form and a Fields table (field, type, required, unit, description) appear, with `µL` in the Unit column.
  - The Schemas list shows `sample` with latest published `1.0`.
- **Result:** Pass / Fail · Notes:

### UAT-02: A schema that is not valid JSON Schema is refused (negative)

- **Requirements:** SPEC-009-R08
- **As:** scientist (alice)
- **Steps:**
  1. In the `lab/sample` tab, in **New draft**, set major `1`, minor `1`, text `{"type":"nonsense"}`, **Create draft**.
  2. Repeat with text `true`, then with `{"$schema":"http://json-schema.org/draft-07/schema#"}`.
  3. Through the API: `curl -s -w ' [%{http_code}]\n' "${A[@]}" $API/schemas/lab/sample/versions -d '{"major":1,"minor":1,"body_text":"{\"type\":\"nonsense\"}"}'`
- **Expected:** Each attempt is refused with an alert explaining why (API: `[422]` with `error` and `errors`). No version `1.1` appears in the Versions table.
- **Result:** Pass / Fail · Notes:

### UAT-03: Only a draft's author can change it (negative)

- **Requirements:** SPEC-009-R10
- **As:** two scientists (alice, then bob)
- **Steps:**
  1. As alice, in the `lab/sample` tab, create a valid draft `1.1` (use the pre-filled text from 1.0 and **Create draft**). Leave it unpublished.
  2. In the private window, sign in as `bob`, open **Schemas**, `lab/sample`, and click version `1.1`.
  3. Through the API, as bob: `D=$(curl -s "${A[@]}" $API/schemas/lab/sample | jq -r '.versions[0].id'); curl -s -w ' [%{http_code}]\n' "${B[@]}" -X PUT $API/schema-versions/$D -d '{"body_text":"{\"type\":\"object\"}"}'`
- **Expected:** Bob sees "Draft by alice (read-only)" and the text box cannot be edited, with no Save or Publish. The API call returns `403`. Alice can still edit and save `1.1`.
- **Result:** Pass / Fail · Notes:

### UAT-04: Only a scientist can create or publish schemas (negative)

- **Requirements:** SPEC-009-R11
- **As:** lab manager or QA, with a scientist for the check of the human path
- **Steps:**
  1. As alice (admin), provision a person with no roles: `curl -s "${A[@]}" $API/principals -d '{"kind":"human","handle":"viewer","display_name":"Viewer","issuer":"https://uat.example/","subject":"viewer-1","reason":"uat"}' | jq -c '{handle,roles}'`
  2. As that person: `V=(-H "X-LDE-Tenant: $T" -H "X-LDE-Actor: viewer" -H "Content-Type: application/json")`, then `curl -s -w ' [%{http_code}]\n' "${V[@]}" $API/schemas -d '{"namespace":"lab","name":"nope","applies_to":"sample"}'`.
  3. As the viewer, try to publish alice's draft `1.1`: `curl -s -w ' [%{http_code}]\n' "${V[@]}" -X POST $API/schema-versions/$D/publish`.
  4. Reading is still allowed: `curl -s -o /dev/null -w '%{http_code}\n' "${V[@]}" $API/schemas`.
- **Expected:** The person has an empty `roles` list. Steps 2 and 3 are refused (`403`, not a success), and `lab/nope` does not appear in **Schemas**. Step 4 returns `200`. (Agents and services cannot publish either; that part is proved by the automated checks.)
- **Result:** Pass / Fail · Notes:

### UAT-05: Schemas may not fetch from outside the registry (negative), but can reuse a published version

- **Requirements:** SPEC-009-R07
- **As:** scientist (alice)
- **Steps:**
  1. Create a schema `lab/refs` applying to `sample`, then for each body below create a draft and try to publish it (UI **Publish**, or API):
     ```bash
     curl -s "${A[@]}" $API/schemas -d '{"namespace":"lab","name":"refs","applies_to":"sample"}' >/dev/null
     # Versions are permanent: to repeat a try, give it an unused major number (e.g. try 14 ...).
     try() { n=$1; r=$(jq -n --argjson n "$n" --arg b "$2" '{major:$n,minor:0,body_text:$b}' | curl -s -w '\n%{http_code}' "${A[@]}" $API/schemas/lab/refs/versions -d @-)
             code=${r##*$'\n'}; body=${r%$'\n'*}
             if [ "$code" != 201 ]; then echo "try $n: draft not created [$code] $body"; return; fi
             id=$(jq -r .id <<<"$body")
             echo -n "try $n: "; curl -s -w ' [%{http_code}]\n' "${A[@]}" -X POST $API/schema-versions/$id/publish; }
     try 1 '{"$ref":"http://example.com/x.json"}'
     try 2 '{"$ref":"file:///etc/passwd"}'
     try 3 '{"$ref":"lde://schemas/lab/none/1.0"}'
     try 4 '{"$ref":"lde://schemas/lab/sample/1.1"}'
     try 5 '{"$ref":"#/$defs/missing"}'
     try 6 '{"$id":"https://example.com/s","type":"object"}'
     try 7 '{"allOf":[{"$ref":"lde://schemas/lab/sample/1.0"}],"properties":{"note":{"type":"string"}}}'
     ```
- **Expected:** Cases 1 to 6 each answer `422` with "schema cannot be published" and a reason naming the reference or `$id` (case 4 is a draft, 3 does not exist). Case 7 (a `$ref` to the published `lab/sample@1.0`) answers `200` with status `published`. Publishing 7 a second time answers `409`.
- **Result:** Pass / Fail · Notes:

### UAT-06: A published schema cannot be altered or removed

- **Requirements:** SPEC-009-R01
- **As:** QA or lab manager, with someone who can use `psql`
- **Steps:**
  1. API: `P=$(curl -s "${A[@]}" $API/schemas/lab/sample | jq -r '.versions[] | select(.status=="published") | .id'); curl -s -w ' [%{http_code}]\n' "${A[@]}" -X PUT $API/schema-versions/$P -d '{"body_text":"{}"}'`
  2. Database, as the owner (each statement in a rolled-back transaction):
     ```bash
     docker compose exec postgres psql -U lde -c "BEGIN; UPDATE schema_versions SET body_text='{}' WHERE status='published'; ROLLBACK;"
     docker compose exec postgres psql -U lde -c "BEGIN; UPDATE schema_versions SET status='draft' WHERE status='published'; ROLLBACK;"
     docker compose exec postgres psql -U lde -c "BEGIN; DELETE FROM schema_versions WHERE status='published'; ROLLBACK;"
     docker compose exec postgres psql -U lde -c "BEGIN; TRUNCATE schema_versions CASCADE; ROLLBACK;"
     ```
  3. In the UI open `lab/sample` version `1.0` and look for any edit control.
- **Expected:** Step 1 is `409`. Each statement in step 2 fails with an error carrying SQLSTATE `LDE03` (shown as an error message; no rows change). Step 3 shows no Save or Publish controls. (The `42501` refusal of the application role is proved by the automated test.) Afterwards `lab/sample@1.0` still has its original text.
- **Result:** Pass / Fail · Notes:

### UAT-07: A version's fingerprint is computed by the database

- **Requirements:** SPEC-009-R02
- **As:** QA
- **Steps:**
  1. In the UI, note the Hash of `lab/sample` 1.0 (first 12 characters), or via the API `jq -r .sha256`.
  2. Compare with the database: `docker compose exec postgres psql -U lde -c "SELECT encode(sha256, 'hex'), encode(sha256(convert_to(body_text,'UTF8')),'hex') AS recomputed FROM schema_versions WHERE status='published'"`
- **Expected:** For every row the two columns are identical, and the UI/API hash starts with the same characters.
- **Result:** Pass / Fail · Notes:

### UAT-08: Record a sample from a form

- **Requirements:** SPEC-009-R05, SPEC-009-R06, SPEC-009-R09
- **As:** scientist (alice)
- **Steps:**
  1. In the explorer open **New record**. Kind `sample`. The Schema list offers `No schema` and `lab/sample@1.0`; pick the latter.
  2. Enter label `Plasma 042`. The form shows `Volume (µL)` (required) and `Matrix`. Enter `-5` for the volume.
  3. Look at the field, the Problems panel and the **Create** button. Then correct the volume to `50`, choose `plasma`, and click **Create**.
  4. Find the node id (the lineage tab opens) and read its audit events: `curl -s "${A[@]}" "$API/audit/events?entity_type=lineage_node&entity_id=<node id>" | jq`
  5. Also create a `sample` with kind sample and **No schema**, attributes `{"anything":"goes"}`.
- **Expected:**
  - At `-5` an error appears under the field and in the Problems panel (tab shows "Problems (1)"), and **Create** is disabled. After the correction the error clears and Create is enabled.
  - The lineage tab for `Plasma 042` opens with the attributes `volume_ul` 50 and `matrix` plasma, shown as a read-only form.
  - The `lineage.node_created` event carries `schema_version_id` and `schema_sha256` equal to the `lab/sample@1.0` hash.
  - The record with no schema is created from the JSON box as before.
- **Result:** Pass / Fail · Notes:

### UAT-09: Wrong values are refused with the field named, and nothing is written (negative)

- **Requirements:** SPEC-009-R05
- **As:** scientist (alice)
- **Steps:**
  1. Set `S=<id of lab/sample@1.0>` (`curl -s "${A[@]}" $API/schemas/lab/sample | jq -r '.versions[] | select(.status=="published") | .id'`) and `N=<id of Plasma 042>`.
  2. Create with bad attrs: `curl -s -w ' [%{http_code}]\n' "${A[@]}" $API/lineage/nodes -d "{\"kind\":\"sample\",\"label\":\"Bad\",\"schema_version_id\":\"$S\",\"attrs\":{\"volume_ul\":-5,\"matrix\":\"urine\"}}"`
  3. Same with attrs `{"matrix":"plasma"}`.
  4. Edit directly: `curl -s -w ' [%{http_code}]\n' "${A[@]}" -X PATCH $API/lineage/nodes/$N -d '{"attrs":{"volume_ul":-5,"matrix":"urine"},"reason":"uat"}'`
  5. Propose and commit a change set carrying the bad edit, as bob:
     ```bash
     CS=$(curl -s "${A[@]}" $API/change-sets -d "{\"title\":\"Fix volume\",\"reason\":\"uat\",\"items\":[{\"op\":\"update_node\",\"node_id\":\"$N\",\"attrs\":{\"volume_ul\":-5,\"matrix\":\"urine\"}}]}")
     CSID=$(echo "$CS" | jq -r .id); SHA=$(echo "$CS" | jq -r .items_sha256)
     curl -s -w ' [%{http_code}]\n' "${B[@]}" $API/change-sets/$CSID/commit -d "{\"reason\":\"uat\",\"items_sha256\":\"$SHA\"}"
     curl -s "${A[@]}" $API/change-sets/$CSID | jq -r .state
     ```
  6. Do the same with an `add_node` item (`{"op":"add_node","kind":"sample","label":"Bad","schema_version_id":"$S","attrs":{...bad...}}`).
  7. Confirm a good edit works: PATCH `N` with attrs `{"volume_ul":60,"matrix":"serum"}` and a reason.
- **Expected:** Steps 2 and 4 and the commits in 5 and 6 answer `422` with `errors` listing pointer `/matrix` ("value must be one of 'plasma', 'serum'") and `/volume_ul` ("minimum: got -5, want 0"). Step 3 lists only `/volume_ul` with "is required". The change set state stays `proposed`. No `Bad` node exists in the explorer, `Plasma 042` still shows 50 and `plasma` until step 7, and its audit events show no `record.revised` until step 7. Step 7 answers `200` and the new event carries `schema_version_id` and `schema_sha256`.
- **Result:** Pass / Fail · Notes:

### UAT-10: Edit a schema-backed record in its form

- **Requirements:** SPEC-009-R05, SPEC-009-R09
- **As:** scientist (alice)
- **Steps:**
  1. Open the lineage tab of `Plasma 042` (explorer or **Open lineage**). Find Attributes.
  2. Click **Edit** next to Attributes. Set the volume to `-5`.
  3. Correct it to `75`, enter reason `recount`, and **Save**.
  4. Open the lineage tab of the node created without a schema (case 8).
- **Expected:** Attributes first shows as a read-only form with `Volume (µL)`. In edit mode the `-5` error appears under the field and in the Problems panel and clears when corrected. Save needs a reason; after saving the form shows 75 and the revision appears in the record's history. The node without a schema still shows the JSON box.
- **Result:** Pass / Fail · Notes:

### UAT-11: A record can only name a published schema of the right kind, and keeps it

- **Requirements:** SPEC-009-R03, SPEC-009-R12
- **As:** scientist (alice), QA or lab manager for the database step
- **Steps:**
  1. Draft check: `curl -s -w ' [%{http_code}]\n' "${A[@]}" $API/lineage/nodes -d "{\"kind\":\"sample\",\"label\":\"X\",\"schema_version_id\":\"$D\",\"attrs\":{\"volume_ul\":1}}"` (`$D` is the draft `lab/sample` 1.1).
  2. Kind check: same with `"kind":"reagent"` and `schema_version_id` `$S`.
  3. Params schema on a sample: same with `"kind":"sample"` and `schema_version_id` `$PV`.
  4. Database, as the owner: `docker compose exec postgres psql -U lde -c "BEGIN; UPDATE lineage_nodes SET schema_version_id = NULL WHERE schema_version_id IS NOT NULL; ROLLBACK;"` and another statement setting `schema_version_id` to `$PV`'s id (any other value).
- **Expected:** Steps 1 to 3 are refused with `422` and an `error` message (not a server error), and no node is created. Step 4 fails with SQLSTATE `LDE03`; the node keeps its schema version. (The `42501` refusal for the application role and the other-tenant case are proved by automated tests.)
- **Result:** Pass / Fail · Notes:

### UAT-12: A protocol can name a params schema only if it is a published run-params schema (negative and positive)

- **Requirements:** SPEC-009-R04
- **As:** scientist (alice)
- **Steps:**
  1. Create experiments whose protocol frontmatter has `params_schema:` set to each of: `lab/sample@1.1` (a draft), `lab/sample@1.0` (a sample schema), `lab/missing@1.0`, and `5`. For example:
     ```bash
     mk() { printf -- "---\nprotocol: p\nversion: 1\nparams_schema: $1\n---\n# p\n" | jq -Rs --arg s "$2" '{slug:$s, title:$s, protocol_md:.}' | curl -s -w ' [%{http_code}]\n' "${A[@]}" $API/experiments -d @-; }
     mk 'lab/sample@1.1' bad1; mk 'lab/sample@1.0' bad2; mk 'lab/missing@1.0' bad3; mk '5' bad4
     ```
  2. The experiment created in Setup names `lab/qpcr-params@1.0`. Read its latest protocol version: `curl -s "${A[@]}" $API/experiments/$EXP/protocol-versions | jq`.
- **Expected:** Each of the four attempts answers `422` naming the value, and none of `bad1`-`bad4` appears in the explorer. The setup experiment's protocol version shows `params_schema_version_id` equal to `$PV`.
- **Result:** Pass / Fail · Notes:

### UAT-13: A planned run can be incomplete, but cannot start with bad params

- **Requirements:** SPEC-009-R05, SPEC-009-R06, SPEC-009-R09, SPEC-009-R13
- **As:** scientist (alice)
- **Steps:**
  1. In the explorer open experiment `qPCR`. In **New run** (above the run list) the form shows `Cycles` as required with a note "Not checked until the run starts".
  2. Enter label `Plate 7`, leave Cycles empty, click **Create run**. The run tab opens.
  3. In the run tab, Params shows a form. Click **Edit**, set Cycles to `0`, reason `trial`, **Save**. A warning (not blocking) appears for `/cycles`.
  4. Click **Start run**.
  5. Check run events: `curl -s "${A[@]}" "$API/audit/events?entity_type=run&entity_id=<run id>" | jq -r '.. | .action? // empty'`
  6. Edit Params again: Cycles `40`, reason `set cycles`, **Save**. Click **Start run**.
- **Expected:**
  - Step 2 creates the run (state `planned`) even though Cycles is missing. Step 3 saves `{"cycles":0}` while planned.
  - Step 4 shows an alert with `/cycles` and a message (for example "minimum: got 0, want 1") and the Problems panel lists it. State stays `planned`, and there is no `run.transitioned` event.
  - The `run.created` event carries `schema_version_id` and `schema_sha256` of `lab/qpcr-params@1.0`.
  - Step 6 moves the run to `running` and the State history shows the transition.
  - An experiment with no params schema still creates a run from a JSON box defaulting to `{}`.
- **Result:** Pass / Fail · Notes:

### UAT-14: A running run's params cannot be set to a bad value

- **Requirements:** SPEC-009-R05
- **As:** scientist (alice), and bob to commit
- **Steps:**
  1. With the run from case 13 now `running`, in its Params click **Edit**, set Cycles to `0`, reason `typo`. Note the error; **Save**.
  2. Through the API: `RUN=<run id>`; `curl -s -w ' [%{http_code}]\n' "${A[@]}" -X PATCH $API/runs/$RUN/params -d '{"params":{"cycles":0},"reason":"typo"}'`
  3. Propose an `update_run_params` change set with `{"cycles":0}` and commit it as bob, as in case 9 step 5 (items: `[{"op":"update_run_params","run_id":"'$RUN'","params":{"cycles":0}}]`).
- **Expected:** The UI save is blocked with an error at `/cycles`; the API steps answer `422` with `/cycles`. The change set stays `proposed`. Params still show `40` and no `record.revised` event is added for the failed attempts.
- **Result:** Pass / Fail · Notes:

## 3. Traceability

| Requirement | Cases | Automated test |
|---|---|---|
| SPEC-009-R01 | UAT-06 | yes |
| SPEC-009-R02 | UAT-01, UAT-07 | - |
| SPEC-009-R03 | UAT-11 | yes |
| SPEC-009-R04 | UAT-12 | - |
| SPEC-009-R05 | UAT-08, UAT-09, UAT-10, UAT-13, UAT-14 | yes |
| SPEC-009-R06 | UAT-08, UAT-09, UAT-13 | - |
| SPEC-009-R07 | UAT-05 | - |
| SPEC-009-R08 | UAT-01, UAT-02 | - |
| SPEC-009-R09 | UAT-01, UAT-08, UAT-10, UAT-13 | - |
| SPEC-009-R10 | UAT-01, UAT-03 | - |
| SPEC-009-R11 | UAT-01, UAT-04 | - |
| SPEC-009-R12 | UAT-11 | - |
| SPEC-009-R13 | UAT-13 | yes |

## 4. Sign-off

| Tester | Role | Date | Outcome | Notes |
|---|---|---|---|---|
| | | | Accepted · Accepted with issues · Rejected | |
