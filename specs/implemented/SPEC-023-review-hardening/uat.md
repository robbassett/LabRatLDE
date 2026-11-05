# SPEC-023 user acceptance test plan: Review hardening

| | |
|---|---|
| **Build** | commit `d5123c2` (or the branch head, if later) on `spec-009-review-tasks` |
| **Written** | 2026-11-05 |
| **Testers** | Bench scientist (alice), reviewer (bob), lab admin (carol), the operator who deploys LabRat, and a maintainer for UAT-11 |

Of the twelve requirements, R01, R04 and R05 have automated tests. R02, R03, R06 to R12 are `Test: no`: this plan is their acceptance evidence. The automated upload test holds an upload open through an in-memory pipe, and the signature tests call the API directly. Neither drives a real browser through a Keycloak re-authentication, or a real slow client, so this plan does both.

Use synthetic data only (the handles, names and readings below). Use a current Chrome, Edge or Firefox for the UI steps.

Cases are in three parts:

- **Part A, dev mode** (`LDE_ENV=dev`): no token is needed, and every new handle holds every role. It shows the upload, error-handling and start-up behaviour.
- **Part B, prod mode with Keycloak** (`LDE_ENV=prod`): real roles and a real login. It shows the role refusal and signing.
- **Part C** is a maintainer check of the build tooling.

## 1. Setup

From a clean checkout of the commit above, in a bash shell (Git Bash or WSL on Windows). Docker, Go, Node 22, `jq` and `curl` are needed.

**Use a database of its own.** Migration `0021` changes how signatures are stored, and an older branch cannot sign against a database that has it. So this plan never touches the `lde` database. Use `lde_spec023_uat`:

```bash
docker compose up -d --wait
docker compose exec -T postgres psql -U lde -d lde -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS lde_spec023_uat WITH (FORCE)" -c "CREATE DATABASE lde_spec023_uat OWNER lde"
make ui                                   # npm ci && npm run build; the server embeds web/dist
docker compose --profile idp up -d keycloak   # only needed for Part B; ready at http://localhost:8081
```

In **every** terminal you use:

```bash
. tools/keycloak/uat.env
export LDE_DATABASE_URL="postgres://lde:lde@localhost:5432/lde_spec023_uat?sslmode=disable"
```

Order matters: `uat.env` points `LDE_DATABASE_URL` at `lde_uat006`, so the second line must come after it. Sourcing `uat.env` also runs `dev_env`, which sets `LDE_ENV=dev`. The commands `dev_env` and `prod_env` both set `LDE_ENV`; neither leaves it empty.

Check the database before every server start: `echo $LDE_DATABASE_URL` must end in `lde_spec023_uat?sslmode=disable`.

### 1.1 Part A: dev server and helpers

First terminal (the first log line must say `"env":"dev"`):

```bash
dev_env
go run ./cmd/server                       # API and UI on http://localhost:8080; migrates lde_spec023_uat
```

Second terminal (after the two lines above). Paste this block. The dev tenant is `$T`; do not use `T1`, which is the prod tenant.

```bash
export LAB=http://localhost:8080
export T=00000000-0000-4000-8000-000000000001

as() {  # as USER METHOD PATH [JSON] -> prints "body [STATUS]"
  local u=$1 m=$2 p=$3 b=${4:-}
  curl -s -w ' [%{http_code}]\n' -X "$m" -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: $u" \
    -H 'Content-Type: application/json' ${b:+-d "$b"} "$LAB$p"
}
body()   { sed 's/ \[[0-9]*\]$//'; }
field()  { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
events() { as alice GET '/v1/audit/events?after=0&limit=1000' | body; }
nevents(){ events | jq length; }
sha()    { as "$1" GET /v1/runs/$2/manifest | body | jq -r .sha256; }
sign()   { as "$1" POST /v1/runs/$2/signatures "{\"step\":$3,\"meaning\":\"$4\",\"manifest_sha256\":\"$(sha $1 $2)\"}"; }  # sign USER RUN STEP MEANING
mkrun()  {  # mkrun LABEL -> a new run id, already completed
  local id; id=$(as alice POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"$1\",\"params\":{\"cycles\":40,\"anneal_temp_c\":60}}" | field id)
  as alice POST /v1/runs/$id/transitions '{"to":"running"}' >/dev/null
  as alice POST /v1/runs/$id/transitions '{"to":"completed"}' >/dev/null
  echo $id
}

EXP=$(as alice POST /v1/experiments '{"slug":"il6-qpcr","title":"IL-6 qPCR (synthetic)","protocol_md":"---\nprotocol: qpcr\nversion: 1\n---\n\n# Steps\n1. Plate triplicates.\n"}' | field id)
S=$(as alice POST /v1/lineage/nodes '{"kind":"sample","label":"Plasma 042","attrs":{"volume_ul":50}}' | field id)
INST=$(as alice POST /v1/instruments '{"name":"HPLC-1 (synthetic)","kind":"hplc"}' | field id)
RUN_S=$(mkrun "Plate S")
echo "EXP=$EXP S=$S INST=$INST RUN_S=$RUN_S"
```

Every id must be non-empty. If not, stop and ask a developer. Keep this terminal: the cases reuse the variables. UAT-02 needs a third terminal, also with the two environment lines and the block above pasted.

### 1.2 Part B: prod server, Keycloak and people

Do this when you reach Part B. Stop the dev server first. First terminal:

```bash
prod_env && go run ./cmd/server           # first log line must say "env":"prod"
```

Helper terminal, after the two environment lines, run `tokens` (it lasts 15 minutes; run it again on a `401`) and define:

```bash
export LAB=http://localhost:8080
api() { # api TOKEN METHOD PATH [JSON] -> "body [STATUS]"
  local tok=$1 m=$2 p=$3 b=${4:-}
  case "$tok" in GET|POST|PUT|PATCH|DELETE) echo "api: the token is empty: run tokens" >&2; return 1 ;; esac
  curl -s -w ' [%{http_code}]\n' -X "$m" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' ${b:+-d "$b"} "$LAB$p"
}
body()  { sed 's/ \[[0-9]*\]$//'; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
psqlu() { docker compose exec -T postgres psql -U lde -d lde_spec023_uat -XAtq "$@"; }
```

Create the first admin (the database owner connection; a developer helps if it fails), then the people:

```bash
go run ./cmd/server bootstrap-admin --tenant $T1 --slug lab-a1 --name "UAT lab" \
  --issuer $ISSUER --subject $SUB_CAROL --handle carol --display-name "Carol Diaz" --email carol@lab.test

for spec in "alice:$SUB_ALICE:Alice Ng:scientist" "bob:$SUB_BOB:Bob Ortiz:reviewer"; do
  IFS=: read h sub name role <<<"$spec"
  id=$(api $TOKEN_CAROL POST /v1/principals "{\"kind\":\"human\",\"handle\":\"$h\",\"display_name\":\"$name\",\"issuer\":\"$ISSUER\",\"subject\":\"$sub\",\"reason\":\"UAT\"}" | field id)
  api $TOKEN_CAROL POST /v1/role-grants "{\"principal_id\":\"$id\",\"role\":\"$role\",\"reason\":\"UAT\"}"
done

EXPP=$(api $TOKEN_ALICE POST /v1/experiments '{"slug":"prod-qpcr","title":"Prod qPCR (synthetic)","protocol_md":"---\nprotocol: qpcr\nversion: 1\n---\n\n# Steps\n1. Plate triplicates.\n"}' | field id)
INSTP=$(api $TOKEN_ALICE POST /v1/instruments '{"name":"HPLC-P (synthetic)","kind":"hplc"}' | field id)
pmk() { # pmk LABEL -> a completed run in prod-qpcr
  local id; id=$(api $TOKEN_ALICE POST /v1/runs "{\"experiment_id\":\"$EXPP\",\"label\":\"$1\",\"params\":{\"cycles\":40,\"anneal_temp_c\":60}}" | field id)
  api $TOKEN_ALICE POST /v1/runs/$id/transitions '{"to":"running"}' >/dev/null
  api $TOKEN_ALICE POST /v1/runs/$id/transitions '{"to":"completed"}' >/dev/null; echo $id
}
echo "EXPP=$EXPP INSTP=$INSTP"
```

Both printed role grants must end `[201]`, and both ids must be non-empty. At the Keycloak login page every user's password is `labrat`. Use a **new private browser window** for each person, so no old Keycloak session is reused.

---

## 2. Test cases

## Part A: dev mode

### UAT-01: The server refuses to start without LDE_ENV

- **Requirements:** SPEC-023-R03
- **As:** The operator who deploys LabRat
- **Steps:**
  1. Stop the dev server (Ctrl+C in the first terminal). In that terminal: `unset LDE_ENV; go run ./cmd/server; echo "exit code $?"`.
  2. Set it empty: `LDE_ENV= go run ./cmd/server; echo "exit code $?"`.
  3. Set a wrong value: `LDE_ENV=staging go run ./cmd/server; echo "exit code $?"`.
  4. `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/healthz` (nothing should be listening).
  5. Check the places that start the server set it: `grep -n LDE_ENV Makefile docker-compose.yml .env.example README.md`.
  6. Check the helper commands: `unset LDE_ENV; prod_env; echo $LDE_ENV; dev_env; echo $LDE_ENV`.
  7. Start the server again for the next cases: `dev_env; go run ./cmd/server`.
- **Expected:**
  - Steps 1 and 2: the process exits at once with a non-zero exit code and the line `config: LDE_ENV is required: set it to dev or prod`. It does not connect to the database or listen on a port.
  - Step 3: it exits non-zero, naming `LDE_ENV` and the allowed values `dev` and `prod`.
  - Step 4: `000` (nothing answers).
  - Step 5: `Makefile` (`make run`), `docker-compose.yml` and `.env.example` set `LDE_ENV` to `dev`, and the `README.md` start command is written `LDE_ENV=dev go run ./cmd/server`.
  - Step 6: `prod`, then `dev`.
  - Step 7: the first log line says `"env":"dev"`.
- **Result:** Pass / Fail · Notes:

### UAT-02: An audited write and a signature complete while an upload is still arriving

- **Requirements:** SPEC-023-R01, SPEC-023-R02, SPEC-023-R10 (the manifest is unchanged)
- **As:** Bench scientist (alice) uploading a chromatogram; a second scientist working at the same time
- **Steps:**
  1. Third terminal (setup block pasted, `INST` and `RUN_S` set). Count the readings in the example file: `NLINES=$(wc -l < examples/streams/hplc-uv.ndjson); echo $NLINES`.
  2. Start a slow upload. It sends two lines, then pauses 45 seconds, then sends the rest:
     ```bash
     ( head -n 2 examples/streams/hplc-uv.ndjson; sleep 45; tail -n +3 examples/streams/hplc-uv.ndjson ) |
       curl -s -w ' [%{http_code}]\n' -X POST -T - -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" \
         -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/$INST/stream?label=Slow%20upload"
     ```
  3. At once, in the second terminal (you have 45 seconds), run `N0=$(nevents)`, then time an audited write:
     `time as bob POST /v1/instruments '{"name":"HPLC-2 (synthetic)","kind":"hplc"}'`
  4. In the same terminal, sign the finished run while the upload is still open: `time sign alice $RUN_S 1 author`
  5. Wait for the upload in the third terminal to finish.
  6. List the order of events: `events | jq -r '.[] | select(.seq > '$N0') | [.seq,.actor,.action] | @tsv'`
  7. `as alice GET /v1/audit/verify | body`, and, with Python 3 installed, `make verify-chain`.
  8. The signature must still be valid, which shows the manifest is stable: `as alice GET /v1/runs/$RUN_S/signatures | body | jq '.items[]|{step,meaning,valid,reauth_method}'`
- **Expected:**
  - Step 3: `[201]`, `real` well under 2 seconds. It does not wait for the upload.
  - Step 4: `[201]`, also well under 2 seconds.
  - Step 5: `[201]` with a `dataset_id` and a count equal to `$NLINES`, 45 seconds or more after it started.
  - Step 6: the events from steps 3 and 4 (`instrument.registered`, the node event for HPLC-2, `signature.applied`) come first. The upload's events (its dataset node creation and `instrument.ingested`) come after them, because the upload only writes its audit events once it has finished. No event is missing.
  - Step 7: the chain is valid; the independent verifier reports success.
  - Step 8: one signature, `valid: true`, `reauth_method: "dev"`.
- **Result:** Pass / Fail · Notes:

### UAT-03: A rejected upload leaves nothing behind

- **Requirements:** SPEC-023-R02 (atomic with its audit events)
- **As:** Bench scientist (alice)
- **Steps:**
  1. `N1=$(nevents)`.
  2. A file with a damaged last line:
     ```bash
     ( head -n 4 examples/streams/hplc-uv.ndjson; echo '{"ts":"not a time"' ) |
       curl -s -w ' [%{http_code}]\n' -X POST --data-binary @- -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" \
         -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/$INST/stream?label=Broken"
     ```
  3. An empty file: `curl -s -w ' [%{http_code}]\n' -X POST --data-binary '' -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/$INST/stream?label=Empty"`
  4. An unknown instrument: `curl -s -w ' [%{http_code}]\n' -X POST --data-binary @examples/streams/hplc-uv.ndjson -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/00000000-0000-4000-8000-0000000000ff/stream"`
  5. `nevents`, and compare with `$N1`.
- **Expected:**
  - Step 2: `[400]` with a message naming the bad line.
  - Step 3: `[400]`, "stream contained no readings".
  - Step 4: `[404]`, "instrument not found".
  - Step 5: the event count equals `N1`: no dataset, `instrument.ingested` or lineage event was written for any of the three.
- **Result:** Pass / Fail · Notes:

### UAT-04: A change set error says which item is wrong

- **Requirements:** SPEC-023-R06
- **As:** Bench scientist (alice)
- **Steps:**
  1. Propose a change set whose third item has a blank label:
     ```bash
     as alice POST /v1/change-sets "{\"title\":\"Tidy up\",\"reason\":\"UAT\",\"items\":[
       {\"op\":\"add_node\",\"kind\":\"sample\",\"label\":\"Plasma 050\"},
       {\"op\":\"add_node\",\"kind\":\"sample\",\"label\":\"Plasma 051\"},
       {\"op\":\"update_node\",\"node_id\":\"$S\",\"label\":\"   \"}]}"
     ```
  2. Make the first item the bad one: `as alice POST /v1/change-sets '{"title":"Tidy up","reason":"UAT","items":[{"op":"bogus"}]}'`
  3. Create a valid change set, then replace its items with a bad second item:
     ```bash
     CS=$(as alice POST /v1/change-sets '{"title":"Tidy up","reason":"UAT","items":[{"op":"add_node","kind":"sample","label":"Plasma 050"}]}' | field id)
     as alice PUT /v1/change-sets/$CS "{\"title\":\"Tidy up\",\"reason\":\"UAT\",\"items\":[{\"op\":\"add_node\",\"kind\":\"sample\",\"label\":\"Plasma 050\"},{\"op\":\"add_edge\",\"from\":\"$S\",\"to\":\"not-a-uuid\",\"relation\":\"derived_from\"}]}"
     as alice POST /v1/change-sets/$CS/withdraw '{"reason":"UAT done"}'
     ```
- **Expected:**
  - Step 1: `[400]` with `item 2: label must not be blank` (positions count from 0, so the third item is 2).
  - Step 2: `[400]` with `item 0: unknown op "bogus"`.
  - Step 3: the PUT returns `[400]` with a message starting `item 1:` that says add_edge needs node uuids. The withdraw returns `[200]`. Steps 1 and 2 create no change set.
- **Result:** Pass / Fail · Notes:

### UAT-05: An oversized request body is answered 413

- **Requirements:** SPEC-023-R07
- **As:** Operator or integrator
- **Steps:**
  1. A body just over 1 MiB, with the excess inside a string:
     ```bash
     { printf '{"kind":"sample","label":"'; head -c 1200000 /dev/zero | tr '\0' a; printf '"}'; } |
       curl -s -w ' [%{http_code}]\n' -X POST --data-binary @- -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" \
         -H 'Content-Type: application/json' "$LAB/v1/lineage/nodes"
     ```
  2. A small valid object followed by a lot of padding after it:
     ```bash
     N2=$(nevents)
     { printf '{"kind":"sample","label":"Padded"}'; head -c 1200000 /dev/zero | tr '\0' ' '; } |
       curl -s -w ' [%{http_code}]\n' -X POST --data-binary @- -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: alice" \
         -H 'Content-Type: application/json' "$LAB/v1/lineage/nodes"
     ```
  3. A small request with a syntax error: `as alice POST /v1/lineage/nodes '{"kind":'`
  4. A normal small request: `as alice POST /v1/lineage/nodes '{"kind":"sample","label":"Small enough"}'`
  5. `nevents` and compare with `$N2` plus the one event from step 4.
- **Expected:**
  - Steps 1 and 2: `[413]` (not 400 and not 500), with an error message. Nothing is created by either.
  - Step 3: `[400]`, "invalid JSON body".
  - Step 4: `[201]`.
  - Step 5: exactly one new event (from step 4).
- **Result:** Pass / Fail · Notes:

### UAT-06: The health check does not leak the database error

- **Requirements:** SPEC-023-R08
- **As:** The operator who deploys LabRat
- **Steps:**
  1. With the dev server running: `curl -s -w ' [%{http_code}]\n' $LAB/healthz`.
  2. Stop the database: `docker compose stop postgres` (this stops it for every local LabRat database; restart it in step 5).
  3. `curl -s -w ' [%{http_code}]\n' $LAB/healthz`, then look at the server's log in the first terminal.
  4. Look at the body from step 3 for a host name, user name or the word `postgres`/`lde`.
  5. `docker compose start postgres`, wait about 10 seconds, and run step 1 again.
- **Expected:**
  - Step 1: `{"status":"ok"} [200]`.
  - Step 3: `{"status":"degraded","database":"unavailable"} [503]`. The server log has an error line `health check failed` that carries the database error.
  - Step 4: the response has no host, port, user or driver text.
  - Step 5: `[200]` again, with no restart of the server.
- **Result:** Pass / Fail · Notes:

## Part B: prod mode with Keycloak

Stop the dev server and follow section 1.2.

### UAT-07: Someone without the scientist role is refused before the upload is read

- **Requirements:** SPEC-023-R12, SPEC-023-R01
- **As:** Reviewer (bob, who holds the reviewer role only), bench scientist (alice) as the control
- **Steps:**
  1. Helper terminal. Run `tokens` (if not done in the last 15 minutes), then count the audit events as carol, who can read the audit trail: `N3=$(api $TOKEN_CAROL GET '/v1/audit/events?after=0&limit=1000' | body | jq length)`.
  2. Bob uploads with a slow body, a pipe that would take 30 seconds:
     ```bash
     time ( ( head -n 2 examples/streams/hplc-uv.ndjson; sleep 30 ) |
       curl -s -w ' [%{http_code}]\n' --max-time 40 -X POST -T - -H "Authorization: Bearer $TOKEN_BOB" \
         -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/$INSTP/stream" )
     ```
     Read the status line, and watch the server log line for the request (it has the status and `dur_ms`).
  3. The same as alice (control), with a short file: `curl -s -w ' [%{http_code}]\n' -X POST --data-binary @examples/streams/hplc-uv.ndjson -H "Authorization: Bearer $TOKEN_ALICE" -H 'Content-Type: application/x-ndjson' "$LAB/v1/instruments/$INSTP/stream?label=Prod%20upload"`
  4. Count the events again and compare with `N3`.
- **Expected:**
  - Step 2: `[403]` with a message that uploading readings needs the scientist role. The server log shows the request ended with 403 in a few milliseconds (`dur_ms` small), not after 30 seconds. (curl itself may wait for its pipe to end; the log line is the evidence.) The body was not read.
  - Step 3: `[201]` with a `dataset_id`.
  - Step 4: bob's attempt added no events; the control added the upload's events (dataset node, edge and `instrument.ingested`).
- **Result:** Pass / Fail · Notes:

### UAT-08: Sign in prod through Keycloak, correct the run, and sign again

- **Requirements:** SPEC-023-R04, SPEC-023-R05, SPEC-023-R09, SPEC-023-R10
- **As:** Bench scientist (alice), reviewer (bob), QA
- **Steps:**
  1. `RUN_P=$(pmk "Plate P")`.
  2. In a new private window open `http://localhost:8080/`, choose "Sign in with your organisation", log in as `alice` / `labrat`. Open the Sign-off inbox, open Plate P, click "Sign as author", tick the confirmation, type the comment `as run`, click Sign.
  3. At the Keycloak page note that `prompt=login` is in the address bar and the login form appears even though alice is already signed in. Log in as `alice` / `labrat`.
  4. Watch the UI on return. Then in a second private window, as bob, do the same: Sign-off inbox, Plate P, "Sign as review", log in as `bob`. The state becomes `signed`.
  5. Correct the signed run. As alice open Plate P, click Edit beside Params, enter `{"cycles": 40, "anneal_temp_c": 62}` with the reason `transcription error`, and click "Propose correction".
  6. As bob open the Review inbox, expand the card, read the warning, and commit it with the reason `checked against the notebook`.
  7. As alice reload Plate P. Both earlier signatures must be struck through and the run is `completed` again. Click "Sign as author" and sign with a new login (log in as `alice`). Then bob signs "review" again.
  8. List the signatures: `api $TOKEN_ALICE GET /v1/runs/$RUN_P/signatures | body | jq '.items[]|{step,printed_name,reauth_method,valid}'` (run `tokens` first if it returns 401).
  9. Look at the stored link: `psqlu -c "SELECT s.step, s.reauth_method, s.challenge_id IS NOT NULL AS linked, c.login_at IS NOT NULL AS login_recorded, s.invalidated_at IS NOT NULL AS invalidated FROM signatures s LEFT JOIN signature_challenges c ON c.id = s.challenge_id WHERE s.entity_id = '$RUN_P' ORDER BY s.signed_at"`
  10. Challenges are one-use: `psqlu -c "SELECT count(*) FROM (SELECT challenge_id FROM signatures WHERE challenge_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x"` and `psqlu -c "SELECT count(*) FROM signature_challenges WHERE used_at IS NOT NULL AND login_at IS NULL"`
- **Expected:**
  - Step 2: the dialog says "You will be asked to log in again before the signature is applied."
  - Step 3: Keycloak shows its login form (not a silent sign-in).
  - Step 4: you return to the same tab, the dialog resumes ("Signing...") and the Signatures section shows "Alice Ng, author, ... UTC, Valid · as run". After bob signs, "Bob Ortiz, review", and the state is `signed`.
  - Step 5: "Correction proposed. A reviewer can commit it from the Review inbox." Params still show 60.
  - Step 6: the warning reads "Committing invalidates 2 signatures and returns the run for re-signing." The commit succeeds.
  - Step 7: params 62; two struck-through rows with "transcription error"; signing again succeeds after a fresh login for each person; the state is `signed` again.
  - Step 8: four signatures: the first two `valid: false`, the last two `valid: true`; all `reauth_method: "oidc"`.
  - Step 9: four rows, all `oidc`, `linked` = `t`, `login_recorded` = `t`; the first two `invalidated` = `t`, the last two `f`.
  - Step 10: both counts are `0`.
- **Result:** Pass / Fail · Notes:

### UAT-09: A bad re-authentication token is refused and writes nothing

- **Requirements:** SPEC-023-R09, SPEC-023-R04
- **As:** Bench scientist (alice), QA
- **Steps:**
  1. `RUN_G=$(pmk "Plate G")`; `SHA=$(api $TOKEN_ALICE GET /v1/runs/$RUN_G/manifest | body | jq -r .sha256)`; `G0=$(api $TOKEN_CAROL GET '/v1/audit/events?after=0&limit=1000' | body | jq length)`; `psqlu -c "SELECT count(*) FROM signatures WHERE entity_id = '$RUN_G'"`.
  2. Sign with no token: `api $TOKEN_ALICE POST /v1/runs/$RUN_G/signatures "{\"step\":1,\"meaning\":\"author\",\"manifest_sha256\":\"$SHA\"}"`
  3. Sign with a made-up token: the same body with `,\"reauth_token\":\"not-a-token\"` added before the closing brace.
  4. Sign with the access token in place of an ID token: the same, with `,\"reauth_token\":\"$TOKEN_ALICE\"`.
  5. Count events and signatures again.
- **Expected:**
  - Steps 2, 3 and 4: `[401]` each, with an error message about logging in again.
  - Step 5: the event count equals `G0` and the signature count for the run is still `0`.
- **Result:** Pass / Fail · Notes:

### UAT-10: The database itself refuses a re-authenticated signature with no login behind it

- **Requirements:** SPEC-023-R04, SPEC-023-R05
- **As:** QA / validation staff, with a developer (direct database access)
- **Steps:**
  1. Get alice's principal id: `ALICE=$(api $TOKEN_CAROL GET '/v1/principals?limit=200' | body | jq -r '.items[]|select(.handle=="alice")|.id')`. Use `RUN_G` from UAT-09 as `<RUN>`; `<TENANT>` is `$T1`; `<SIGNER>` is `$ALICE`.
  2. Open `docker compose exec postgres psql -U lde -d lde_spec023_uat` and type `\set VERBOSITY verbose`.
  3. Try to insert an `oidc` signature that names no challenge:
     ```sql
     BEGIN;
     INSERT INTO signature_manifests (tenant_id, run_id, manifest) VALUES ('<TENANT>', '<RUN>', '{"run_id":"<RUN>"}') RETURNING id \gset m_
     INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id, printed_name, signed_at, manifest_id, manifest_sha256, reauth_at, reauth_method)
       VALUES ('<TENANT>', 'run', '<RUN>', 1, 'author', '<SIGNER>', 'x', now(), :'m_id', sha256(convert_to('{"run_id":"<RUN>"}', 'UTF8')), now(), 'oidc');
     ROLLBACK;
     ```
  4. Try to alter the link of a real signature: take a real signature id `<SIG>` from UAT-08 step 8 (`psqlu -c "SELECT id FROM signatures WHERE entity_id = '$RUN_P' LIMIT 1"`) and run `UPDATE signatures SET challenge_id = NULL WHERE id = '<SIG>';` and `UPDATE signatures SET challenge_id = gen_random_uuid() WHERE id = '<SIG>';`.
  5. The count in UAT-08 step 10 (a challenge used without a login time) was `0`; confirm it is still `0`.
- **Expected:**
  - Step 3: the second statement fails with code `LDE07`, naming an `oidc` signature that needs a challenge used in this transaction, by this signer, for this run and manifest. Nothing is stored. If another `LDE07` message appears first, tell a developer: the insert must be refused either way.
  - Step 4: both fail (the first with `LDE03` "its challenge never changes"; if another database rule answers first, such as `LDE03` for a signed record, that is accepted too). The signature row is unchanged.
  - Step 5: `0`.
  - The cases "a `dev` signature naming a challenge" and "a challenge named by a second signature" are not run here; the automated tests are their evidence.
- **Result:** Pass / Fail · Notes:

## Part C: maintainer checks

### UAT-11: Complexity limit in CI, and the readable schema

- **Requirements:** SPEC-023-R10, SPEC-023-R11
- **As:** Maintainer
- **Steps:**
  1. Open `.github/workflows/ci.yml` and `.golangci.yml`. Find the `golangci-lint` step and the `gocognit` setting.
  2. If `golangci-lint` is installed: `golangci-lint run ./...`.
  3. Check the two handlers by name: `grep -n "func (s \*Server) signRun\|decideChangeSet" internal/api/*.go`. Read both. Each should be short, with the real work in named helpers (`applySignature`, `spendChallenge` and `insertSignature` for signing).
  4. Check the manifest bytes did not change: run `go test ./internal/api -run TestManifestIsCanonical -count=1` (needs `LDE_TEST_DATABASE_URL`; use `make test-integration TEST_DB=...lde_spec023_uat...` if it skips). Signatures from before this work still show `valid: true` (UAT-02 step 8).
  5. Check the dataset ingest join is defined once: `grep -rn "instrument_readings" internal/api/*.go | grep -i join`.
  6. Write the schema from this plan's database: `make schema SCHEMA_DB=lde_spec023_uat`, then `grep -c "challenge_id" docs/schema.sql` and `git status --short docs/schema.sql`.
  7. Put the file back: `git checkout docs/schema.sql`.
- **Expected:**
  - Step 1: the CI step runs `golangci-lint` and the configuration enables only `gocognit` at a threshold of 50 for non-test files.
  - Step 2: no findings.
  - Step 3: both functions are short enough to read on one screen.
  - Step 4: the test passes.
  - Step 5: a single definition of the dataset ingest join.
  - Step 6: the command succeeds; `docs/schema.sql` contains `challenge_id` (more than one match).
- **Result:** Pass / Fail · Notes:

## 3. Traceability

| Requirement | Cases | Automated test |
|---|---|---|
| SPEC-023-R01 | UAT-02, UAT-07 | yes |
| SPEC-023-R02 | UAT-02, UAT-03 | — |
| SPEC-023-R03 | UAT-01 | — |
| SPEC-023-R04 | UAT-08, UAT-09, UAT-10 | yes |
| SPEC-023-R05 | UAT-08, UAT-10 | yes |
| SPEC-023-R06 | UAT-04 | — |
| SPEC-023-R07 | UAT-05 | — |
| SPEC-023-R08 | UAT-06 | — |
| SPEC-023-R09 | UAT-08, UAT-09 | — |
| SPEC-023-R10 | UAT-02, UAT-08, UAT-11 | — |
| SPEC-023-R11 | UAT-11 | — |
| SPEC-023-R12 | UAT-07 | — |

Not shown by a person here, per the spec's own limits: a `dev` signature that names a challenge, a challenge named by a second signature, and `lde_app` marking a challenge used with no login time. These are database second lines that the API cannot reach, and the automated tests cover them. Also out of scope: refusing `dev` signatures on GxP tenants, and read timeouts or concurrency limits on uploads.

## 4. Sign-off

| Tester | Role | Date | Outcome | Notes |
|---|---|---|---|---|
| | | | Accepted · Accepted with issues · Rejected | |
