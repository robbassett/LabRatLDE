# SPEC-008 user acceptance test plan: Electronic signatures v2

| | |
|---|---|
| **Build** | commit `79fc6a0` on `worktree-spec-008-review-tasks` |
| **Written** | 2026-11-04 |
| **Testers** | Bench scientist (alice), reviewer / QA (bob), lab admin (carol), the person who owns GxP mode (a lab manager or QA lead, with a developer or operator for the terminal, database and IdP steps) |

Of the twenty requirements, sixteen have automated tests. R13, R14, R17 and R19 are `Test: no`: this plan is their only acceptance evidence. Even so, the automated tests never drove a real browser through an identity provider (IdP) re-authentication, and the UI screens (sign dialog, Sign-off inbox, correction proposals, review warning, policy and rename forms) were checked only by one Playwright test for the signatures panel. This plan puts people in front of all of it.

Use synthetic data only (the handles, names and samples below). Use a current Chrome, Edge or Firefox.

Every case says which mode it runs in:

- **Dev mode** (`LDE_ENV=dev`, Part A): no token is needed, every new handle holds every role (scientist, reviewer, qa, admin), and the signature records `reauth_method = dev`. Because everyone holds every role, dev mode cannot show a role refusal. It can show the four-eyes rules, the order of steps, sealing, corrections and the screens.
- **Prod mode with Keycloak** (`LDE_ENV=prod`, Part B): real roles and a real login. alice is a scientist, bob a reviewer, carol an admin, dave has a login but starts with a blank display name.
- **Part C** is a checklist for Entra ID and Okta, to be done before any pilot.

## 1. Setup

From a clean checkout of the commit above, in a bash shell (Git Bash or WSL on Windows). Docker, Go, Node 22 and `jq` are needed.

### 1.1 Start from nothing

```bash
docker compose up -d
sh tools/keycloak/reset-uat.sh      # fresh Keycloak realm and an empty lde_uat006 database (stop any LabRat server first)
. tools/keycloak/uat.env            # in EVERY terminal you use
make ui                             # npm ci && npm run build
```

Always use a **new private browser window** for each person, so an old IdP cookie never signs you in as someone else.

### 1.2 Part A: dev server and helpers

First terminal (the first log line must say `"env":"dev"`; if it says `prod`, run `dev_env` and start again):

```bash
go run ./cmd/server                 # API and UI on http://localhost:8080
```

Second terminal, after `. tools/keycloak/uat.env`. Paste this block. The dev tenant is `$T`; do not use `T1`, which is the prod tenant.

```bash
export LAB=http://localhost:8080
export T=00000000-0000-4000-8000-000000000001

as() {  # as USER METHOD PATH [JSON] -> prints "body [STATUS]". Prefix OBO=alice to act as an agent for alice.
  local u=$1 m=$2 p=$3 b=${4:-}
  curl -s -w ' [%{http_code}]\n' -X "$m" -H "X-LDE-Tenant: $T" -H "X-LDE-Actor: $u" \
    ${OBO:+-H "X-LDE-On-Behalf-Of: $OBO"} -H 'Content-Type: application/json' ${b:+-d "$b"} "$LAB$p"
}
body()   { sed 's/ \[[0-9]*\]$//'; }                                  # strips the status
field()  { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }  # first string value
events() { as alice GET '/v1/audit/events?after=0&limit=1000' | body; }
nevents(){ events | jq length; }
sha()    { as "$1" GET /v1/runs/$2/manifest | body | jq -r .sha256; }                    # sha USER RUN
sign()   { as "$1" POST /v1/runs/$2/signatures "{\"step\":$3,\"meaning\":\"$4\",\"manifest_sha256\":\"$(sha $1 $2)\"}"; }  # sign USER RUN STEP MEANING
ish()    { as "$1" GET /v1/change-sets/$2 | body | jq -r .items_sha256; }
commit() { as "$1" POST /v1/change-sets/$2/commit "{\"reason\":\"$3\",\"items_sha256\":\"$(ish $1 $2)\"}"; }  # commit USER CS REASON
mkrun()  {  # mkrun LABEL [completed|failed] [INPUT_NODE_ID] -> prints a new run id, already finished
  local id; id=$(as alice POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"$1\",\"params\":{\"cycles\":40,\"anneal_temp_c\":60}${3:+,\"inputs\":[\"$3\"]}}" | field id)
  as alice POST /v1/runs/$id/transitions '{"to":"running"}' >/dev/null
  as alice POST /v1/runs/$id/transitions "{\"to\":\"${2:-completed}\"}" >/dev/null
  echo $id
}

# Experiment, samples, and the people (a dev handle is created on first use)
EXP=$(as alice POST /v1/experiments '{"slug":"il6-qpcr","title":"IL-6 qPCR (synthetic)","protocol_md":"---\nprotocol: qpcr\nversion: 1\n---\n\n# Steps\n1. Plate triplicates.\n"}' | field id)
S=$(as alice POST /v1/lineage/nodes '{"kind":"sample","label":"Plasma 042","attrs":{"volume_ul":50}}' | field id)
S2=$(as alice POST /v1/lineage/nodes '{"kind":"sample","label":"Plasma 043","attrs":{"volume_ul":50}}' | field id)
as bob GET /v1/me >/dev/null; as carol GET /v1/me >/dev/null
P=$(as alice GET '/v1/principals?limit=200' | body)
ALICE=$(echo "$P" | jq -r '.items[]|select(.handle=="alice")|.id'); BOB=$(echo "$P" | jq -r '.items[]|select(.handle=="bob")|.id')

# An agent "bot" that may act for alice
BOT=$(as alice POST /v1/principals '{"kind":"agent","handle":"bot","display_name":"Assay bot (synthetic)","issuer":"dev","subject":"bot","reason":"UAT agent"}' | field id)
as alice POST /v1/role-grants "{\"principal_id\":\"$BOT\",\"role\":\"scientist\",\"reason\":\"UAT agent\"}"
as alice POST /v1/agent-delegations "{\"agent_id\":\"$BOT\",\"human_id\":\"$ALICE\",\"reason\":\"UAT automation for alice\"}"
echo "EXP=$EXP S=$S S2=$S2 ALICE=$ALICE BOB=$BOB BOT=$BOT"
```

Every id must be non-empty and every printed status `[200]` or `[201]`. If not, stop and ask a developer. Keep this terminal: the cases reuse the variables.

In the browser: open `http://localhost:8080/` in a private window, Tenant `00000000-0000-4000-8000-000000000001` (prefilled), Handle `alice`. Cases that need a second person use a second private window signed in as `bob` (and a third as `carol`). To open a run: explorer, experiment `il6-qpcr`, then the run's label.

### 1.3 Part B: prod server and Keycloak

Do this when you reach Part B. Stop the dev server first. In the first terminal:

```bash
prod_env && go run ./cmd/server     # first log line must say "env":"prod"
```

In a helper terminal, after `. tools/keycloak/uat.env`, run `tokens` (it lasts 15 minutes; run it again on a `401`) and define:

```bash
api() { # api TOKEN METHOD PATH [JSON] -> "body [STATUS]"
  local tok=$1 m=$2 p=$3 b=${4:-}
  # An empty token shifts the arguments, and curl then prints only [000].
  case "$tok" in GET|POST|PUT|PATCH|DELETE) echo "api: the token is empty: run tokens in this terminal" >&2; return 1 ;; esac
  [ -n "$LAB" ] || { echo "api: LAB is not set: run . tools/keycloak/uat.env in this terminal" >&2; return 1; }
  curl -s -w ' [%{http_code}]\n' -X "$m" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' ${b:+-d "$b"} "$LAB$p"
}
body()  { sed 's/ \[[0-9]*\]$//'; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
```

Create the first admin (a developer helps with this command, which uses the database owner connection; the flags follow `tools/keycloak/README.md`):

```bash
go run ./cmd/server bootstrap-admin --tenant $T1 --slug lab-a1 --name "UAT lab" \
  --issuer $ISSUER --subject $SUB_CAROL --handle carol --display-name "Carol Diaz" --email carol@lab.test
```

Then, as carol, create the people and roles:

```bash
for spec in "alice:$SUB_ALICE:Alice Ng:scientist" "bob:$SUB_BOB:Bob Ortiz:reviewer"; do
  IFS=: read h sub name role <<<"$spec"
  id=$(api $TOKEN_CAROL POST /v1/principals "{\"kind\":\"human\",\"handle\":\"$h\",\"display_name\":\"$name\",\"issuer\":\"$ISSUER\",\"subject\":\"$sub\",\"reason\":\"UAT\"}" | field id)
  api $TOKEN_CAROL POST /v1/role-grants "{\"principal_id\":\"$id\",\"role\":\"$role\",\"reason\":\"UAT\"}"
done
# dave has a login but NO display name yet (used in UAT-18)
DAVE=$(api $TOKEN_CAROL POST /v1/principals "{\"kind\":\"human\",\"handle\":\"dave\",\"display_name\":\"\",\"issuer\":\"$ISSUER\",\"subject\":\"$SUB_DAVE\",\"reason\":\"UAT visitor\"}" | field id)
api $TOKEN_CAROL POST /v1/role-grants "{\"principal_id\":\"$DAVE\",\"role\":\"scientist\",\"reason\":\"UAT visitor\"}"
```

If creating dave with an empty `display_name` is refused, note the message and ask a developer: UAT-18 depends on it. Then create an experiment and a helper for finished runs as alice:

```bash
EXPP=$(api $TOKEN_ALICE POST /v1/experiments '{"slug":"prod-qpcr","title":"Prod qPCR (synthetic)","protocol_md":"---\nprotocol: qpcr\nversion: 1\n---\n\n# Steps\n1. Plate triplicates.\n"}' | field id)
pmk() { # pmk LABEL -> a completed run in prod-qpcr
  local id; id=$(api $TOKEN_ALICE POST /v1/runs "{\"experiment_id\":\"$EXPP\",\"label\":\"$1\",\"params\":{\"cycles\":40,\"anneal_temp_c\":60}}" | field id)
  api $TOKEN_ALICE POST /v1/runs/$id/transitions '{"to":"running"}' >/dev/null
  api $TOKEN_ALICE POST /v1/runs/$id/transitions '{"to":"completed"}' >/dev/null; echo $id
}
RUN_BEFORE=$(pmk "Before policy change")     # used in UAT-16
```

At the Keycloak login page every user's password is `labrat`.

---

## 2. Test cases

## Part A: dev mode

### UAT-01: Correct a person's printed name

- **Mode:** Dev
- **Requirements:** SPEC-008-R17
- **As:** Lab admin (carol), watched by QA
- **Steps:**
  1. In the UI as carol (new private window, handle `carol`), open Principals from the explorer. Find `alice`.
  2. Click Rename on `alice`. Clear the name and try to submit. Then enter `Alice Ng` with an empty reason.
  3. Enter name `Alice Ng` and the reason `legal name for signatures`, and submit.
  4. Do the same for `bob`: `Bob Ortiz`, reason `legal name for signatures`.
  5. In the terminal try a blank name directly: `as carol PATCH /v1/principals/$ALICE '{"display_name":"   ","reason":"x"}'`, and a missing reason: `as carol PATCH /v1/principals/$ALICE '{"display_name":"Alice Ng"}'`.
  6. `events | jq -r '.[] | select(.action=="principal.renamed") | [.actor,.reason,(.payload|tostring)] | @tsv'`
- **Expected:**
  - Step 2: the form refuses a blank name ("Display name must not be blank.") and the button stays disabled without a reason.
  - Step 3: "Renamed alice to Alice Ng." and the table shows the new display name.
  - Step 5: both calls return `[400]`; the name is unchanged.
  - Step 6: one `principal.renamed` event per rename, actor `carol`, with the reason and the old and new names in the payload. Nothing for the refused attempts.
- **Result:** Pass / Fail · Notes:

### UAT-02: See the runs waiting for my signature (Sign-off inbox)

- **Mode:** Dev
- **Requirements:** SPEC-008-R05 (inbox support)
- **As:** Bench scientist (alice) and reviewer (bob)
- **Steps:**
  1. In the terminal create three runs in this order: `R1=$(mkrun "Plate 1")`, `R2=$(mkrun "Plate 2" failed)`, then a run left running: `R3=$(as alice POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"Plate 3\"}" | field id); as alice POST /v1/runs/$R3/transitions '{"to":"running"}'`.
  2. As alice in the UI, open Sign-off inbox from the explorer (or Ctrl+K and "Sign-off inbox").
  3. Click `Plate 1`.
  4. In the terminal sign step 1 for Plate 1: `sign alice $R1 1 author`. Close and reopen the Sign-off inbox as alice.
  5. As bob (second window) open the Sign-off inbox.
  6. Compare with `as alice GET /v1/inbox/signatures | body | jq '.items[]|[.label,.state,.step,.meaning]'`.
- **Expected:**
  - Step 2: a table with Plate 1 (state `completed`, "Step 1: author") then Plate 2 (state `failed`, "Step 1: author"), oldest finished first. Plate 3 (still running) is not listed. An empty list reads "Nothing is waiting for your signature."
  - Step 3: Plate 1 opens as a run tab.
  - Step 4: `[201]`. Alice's inbox now lists only Plate 2.
  - Step 5: bob sees Plate 1 as "Step 2: review" and Plate 2 as "Step 1: author" (in dev bob holds every role).
  - Step 6: the same rows as the screen.
- **Result:** Pass / Fail · Notes:

### UAT-03: Sign a run in two steps from the sign dialog

- **Mode:** Dev (the dialog says "Dev mode: no re-authentication")
- **Requirements:** SPEC-008-R01, R05, R06, R08, R12
- **As:** Bench scientist (alice), then reviewer (bob)
- **Steps:**
  1. Create the run and keep its id: `RUN_A=$(mkrun "Plate 7" completed $S)`.
  2. As alice open Plate 7. Read the Signatures section above Notes.
  3. Click "Sign as author". Read the dialog. Try to click Sign without ticking the confirmation.
  4. Type the comment `as run`, tick "By signing I confirm I have reviewed this record, and my signature means: author", and click Sign.
  5. Read the Signatures section and the State line.
  6. Try to sign step 2 as alice from the terminal: `sign alice $RUN_A 2 review`.
  7. As bob open Plate 7 (reload the page if it is already open), click "Sign as review", tick the box, and click Sign.
  8. Open Audit trail and look for the newest events of the run. Also: `as alice GET /v1/runs/$RUN_A/signatures | body | jq '.items[]|{step,meaning,printed_name,signed_at,valid,reauth_method,manifest_sha256}'`
- **Expected:**
  - Step 2: a table with "Awaiting" rows for step 1 (author) and step 2 (review), and a "Sign as author" button.
  - Step 3: the dialog shows the protocol version and hash, Params, counts of inputs and notes, the manifest SHA-256, "Changes since the previous signature: No earlier valid signature.", "Dev mode: no re-authentication". The browser blocks Sign until the box is ticked. Cancel closes it and focus returns to the Sign button.
  - Step 5: row "Alice Ng, author, `YYYY-MM-DD HH:mm UTC`, Valid · as run"; step 2 still awaiting. State is still `completed`. Alice's Sign button is gone.
  - Step 6: `[409]`; no second signature (the same person can't sign two steps).
  - Step 7: "Bob Ortiz, review, ... UTC, Valid". State changes to `signed`.
  - Step 8: the API shows two signatures with printed names, the correct meanings, RFC 3339 `signed_at`, `valid: true`, `reauth_method: "dev"` and 64-hex `manifest_sha256`. The audit trail has `signature.applied` (reason `author`), `signature.applied` (reason `review`) and `run.signed` (reason `review`), actors `alice` and `bob`.
- **Result:** Pass / Fail · Notes:

### UAT-04: Signing that must be refused

- **Mode:** Dev
- **Requirements:** SPEC-008-R05, R06, R07, R14
- **As:** Bench scientist (alice), QA
- **Steps:**
  1. `RUN_N=$(mkrun "Plate 8")`. Plate 3 (`$R3`, from UAT-02) is still running. `N0=$(nevents)`.
  2. Sign a run that is still running: `sign alice $R3 1 author`.
  3. Wrong step or meaning: `as alice POST /v1/runs/$RUN_N/signatures "{\"step\":2,\"meaning\":\"review\",\"manifest_sha256\":\"$(sha alice $RUN_N)\"}"` and the same with `"step":1,"meaning":"review"`.
  4. Old way of signing: `as bob POST /v1/runs/$RUN_N/transitions '{"to":"signed","reason":"quick approval"}'`.
  5. An agent signs for alice: `OBO=alice sign bot $RUN_N 1 author`.
  6. `nevents` again, and `as alice GET /v1/runs/$RUN_N | body | jq '{state,signatures}'`.
  7. Open Plate 3 (running) in the UI.
- **Expected:**
  - Steps 2, 3, 5: each `[409]` with an `error` message. Step 4: `[400]`, the message naming the signatures endpoint.
  - Step 6: the event count equals `N0` (the refusals wrote nothing; no `signature.applied` or `run.signed`), state `completed`, `signatures: []`.
  - Step 7: no Sign button for a running run.
- **Result:** Pass / Fail · Notes:

### UAT-05: The first signature seals the run; the manifest stays stable

- **Mode:** Dev
- **Requirements:** SPEC-008-R08, R02
- **As:** Bench scientist (alice), QA
- **Steps:**
  1. Use `RUN_N` from UAT-04. Record the manifest twice: `A1=$(as alice GET /v1/runs/$RUN_N/manifest | body | jq -r .manifest)`, `A2=...` again. Compare `[ "$A1" = "$A2" ] && echo same`. Check the hash: `printf '%s' "$A1" | sha256sum` against `sha alice $RUN_N`.
  2. Alice proposes a change (it must not change the manifest): `CS_T=$(as alice POST /v1/change-sets "{\"title\":\"Try cycles\",\"reason\":\"idea\",\"items\":[{\"op\":\"update_run_params\",\"run_id\":\"$RUN_N\",\"params\":{\"cycles\":41}}]}" | field id)`. Check `sha alice $RUN_N` is unchanged. Then withdraw it: `as alice POST /v1/change-sets/$CS_T/withdraw '{"reason":"test"}'`.
  3. `sign alice $RUN_N 1 author`.
  4. Direct edit: `as alice PATCH /v1/runs/$RUN_N/params '{"params":{"cycles":50},"reason":"late fix"}'`.
  5. Add a note: `as alice POST /v1/lineage/nodes/$(as alice GET /v1/runs/$RUN_N | body | jq -r .node_id)/notes '{"body":"Freezer alarm at 02:10, samples unaffected"}'`. Check `sha alice $RUN_N` again and the state.
- **Expected:**
  - Step 1: `same`; `sha256sum` equals the API's `sha256` (lowercase hex).
  - Step 2: the hash is unchanged by the proposal.
  - Step 3: `[201]`; the run is `completed` (only one of two steps) but now sealed.
  - Step 4: `[409]`; params unchanged.
  - Step 5: `[201]` with `"annotation":true`; the hash is the same as before the note, the signature is still valid and the state still `completed`.
- **Result:** Pass / Fail · Notes:

### UAT-06: Sign only what you saw, and see what changed since the last signer

- **Mode:** Dev (terminal for the API check, UI for the dialog)
- **Requirements:** SPEC-008-R18, R19
- **As:** Bench scientist (alice), reviewer (bob)
- **Steps:**
  1. `RUN_C=$(mkrun "Plate 9" completed $S2)`. Remember the hash: `OLD=$(sha alice $RUN_C)`.
  2. Revise the input: `as bob PATCH /v1/lineage/nodes/$S2 '{"attrs":{"volume_ul":45},"reason":"pipetting error"}'`.
  3. Count signatures `as alice GET /v1/runs/$RUN_C/signatures | body | jq '.items|length'`, then sign with the old hash: `as alice POST /v1/runs/$RUN_C/signatures "{\"step\":1,\"meaning\":\"author\",\"manifest_sha256\":\"$OLD\"}"`. Count again, and run `nevents`.
  4. In the UI as alice open Plate 9 and click "Sign as author". Without ticking anything, revise the input again in the terminal: `as bob PATCH /v1/lineage/nodes/$S2 '{"attrs":{"volume_ul":44},"reason":"re-measured"}'`. Now tick the box and click Sign.
  5. Read the dialog. Tick the box again and click Sign.
  6. Revise the input once more (`volume_ul` 43, reason `re-measured again`). As bob open Plate 9 and click "Sign as review". Read "Changes since the previous signature". Tick and sign.
- **Expected:**
  - Step 3: `[409]` ("the record changed since you viewed it"), signature count stays 0, no new audit event.
  - Step 4: no signature is applied. A notice reads "The record changed since you reviewed it. Review the updated manifest and confirm again." and the box is unticked.
  - Step 5: the signature is applied (step 1 shows Valid).
  - Step 6: the dialog lists the change since step 1, a line whose path starts `$.inputs` ("changed from ... to ...", the input's revision number). Bob signs; both signatures stay Valid and the run becomes `signed`. Each signature keeps the hash its signer saw (the two `manifest_sha256` values differ).
- **Result:** Pass / Fail · Notes:

### UAT-07: Propose a correction to a signed run, and the reviewer's warning (including a stale review)

- **Mode:** Dev
- **Requirements:** SPEC-008-R09, R20 (R10 is shown in UAT-08)
- **As:** Bench scientist (alice), reviewer (bob)
- **Steps:**
  1. `RUN_A` (Plate 7) is signed by alice and bob (UAT-03). As alice open it, click Edit beside Params, read the text, enter `{"cycles": 40, "anneal_temp_c": 62}` with the reason `transcription error`, and click "Propose correction".
  2. Open the Review inbox as alice and expand "Correct params of run ...".
  3. Terminal: alice tries to commit her own proposal: `CS=$(as alice GET '/v1/change-sets?state=proposed' | body | jq -r '.items[-1].id'); commit alice $CS "self approval"`.
  4. An agent proposes a correction for alice, and alice tries to commit it: `CS_BOT=$(OBO=alice as bot POST /v1/change-sets "{\"title\":\"Bot fix\",\"reason\":\"bot idea\",\"items\":[{\"op\":\"update_run_params\",\"run_id\":\"$RUN_A\",\"params\":{\"cycles\":42,\"anneal_temp_c\":60}}]}" | field id)`; then `commit alice $CS_BOT "approve my bot"`. Finally reject it as bob: `as bob POST /v1/change-sets/$CS_BOT/reject '{"reason":"not needed"}'`.
  5. As bob (second window) open the Review inbox, expand alice's card, and read it. Do not commit yet.
  6. Alice changes the items after bob opened them: `as alice PUT /v1/change-sets/$CS "{\"title\":\"Correct params of run\",\"reason\":\"transcription error\",\"items\":[{\"op\":\"update_run_params\",\"run_id\":\"$RUN_A\",\"params\":{\"cycles\":40,\"anneal_temp_c\":63}}]}"`
  7. Bob clicks Commit in his still-open card, types `checked against the notebook`, and clicks Confirm commit.
  8. Terminal: bob commits with no hash: `as bob POST /v1/change-sets/$CS/commit '{"reason":"no hash"}'`.
  9. Bob reads the reloaded card (it shows `anneal_temp_c` 63), and commits again with the reason `checked against the notebook`.
- **Expected:**
  - Step 1: the form says "This record is signed. Your change is proposed as a correction, and a reviewer must commit it." After saving: "Correction proposed. A reviewer can commit it from the Review inbox." Params still show 60; the run is `signed` with both signatures Valid.
  - Step 2: the card shows the warning "Committing invalidates 2 signatures and returns the run for re-signing." Alice sees Reject and Withdraw but no Commit button.
  - Step 3: `[409]`; nothing changes. Step 4: alice's commit of the agent's proposal is `[409]` (she is the human the agent acts for); bob's rejection succeeds.
  - Step 5: bob sees the same warning and a Commit button.
  - Step 7: nothing is committed. The card shows "The items changed since you opened this change set. Read the reloaded items, then commit again." and the run is still `signed` with two valid signatures.
  - Step 8: `[409]` (a commit of a signed-record correction needs the hash of the items read); the change set is still proposed.
  - Step 9: the commit succeeds and the card leaves the inbox.
- **Result:** Pass / Fail · Notes:

### UAT-08: Run and audit views after a correction, and re-signing

- **Mode:** Dev
- **Requirements:** SPEC-008-R10, R12, R13 (policy copied onto the run)
- **As:** Bench scientist (alice), reviewer (bob), QA
- **Steps:**
  1. After UAT-07 step 9, look at alice's open Plate 7 tab (reload the page if it still shows the old state). Read State, Params and the Signatures section. Click the "changed" button beside Params.
  2. Click the change set link in a struck-through row.
  3. Audit trail: `events | jq -r '.[] | select(.action|test("^(signature|run|change_set)\\.")) | [.seq,.actor,.action,.reason] | @tsv' | tail -12`
  4. API: `as alice GET /v1/runs/$RUN_A | body | jq '{state,params,signatures:[.signatures[]|{step,printed_name,valid,invalidated_reason}]}'`, then the same fields from `as alice GET /v1/experiments/$EXP/runs | body`, and the response of a transition on a fresh run: `X=$(as alice POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"Plate X\"}" | field id); as alice POST /v1/runs/$X/transitions '{"to":"running"}'`.
  5. Re-sign: as alice click "Sign as author" on Plate 7 and sign; as bob, "Sign as review".
- **Expected:**
  - Step 1: State `completed`. Params show `anneal_temp_c` 63 and a "changed" button. Two rows are struck through: "Alice Ng" and "Bob Ortiz" with "Invalidated by change set `xxxxxxxx`: transcription error"; their Signed at times are kept. Steps 1 and 2 show "Awaiting" again, and alice has a Sign button. The "changed" button opens the Revisions tab: revision 1 with 60, revision 2 with 63 and the reason.
  - Step 2: the link goes to the Review inbox.
  - Step 3: two `signature.invalidated` events with the change set's reason, a `run.transitioned` event (signed back to completed) and `change_set.committed` by bob.
  - Step 4: invalid signatures show `valid: false` and the reason in the read and the list; the transition response on another run carries `signatures: []` and `signing_policy`.
  - Step 5: four signature rows in all: two struck through, two Valid, state `signed` again.
- **Result:** Pass / Fail · Notes:

### UAT-09: A failed run returns to failed after a correction

- **Mode:** Dev
- **Requirements:** SPEC-008-R10, R02 (outcome in the manifest)
- **As:** Reviewer (bob), bench scientist (alice)
- **Steps:**
  1. `RUN_F=$(mkrun "Plate F" failed)`. `sign alice $RUN_F 1 author`, then `sign bob $RUN_F 2 review`. Check `as alice GET /v1/runs/$RUN_F | body | jq .state`.
  2. `as alice GET /v1/runs/$RUN_F/manifest | body | jq -r .manifest | jq .state`.
  3. Alice proposes: `CSF=$(as alice POST /v1/change-sets "{\"title\":\"Fix F\",\"reason\":\"wrong cycle count\",\"items\":[{\"op\":\"update_run_params\",\"run_id\":\"$RUN_F\",\"params\":{\"cycles\":38}}]}" | field id)`; `commit bob $CSF "checked"`.
  4. Open Plate F in the UI.
- **Expected:**
  - Step 1: `[201]` twice; state `signed`. Step 2: `"failed"` (the signed outcome).
  - Step 3: `[200]`.
  - Step 4: State `failed` (not `completed`), both signatures struck through with "wrong cycle count", and Sign buttons are offered again.
- **Result:** Pass / Fail · Notes:

### UAT-10: An aborted run stays frozen

- **Mode:** Dev
- **Requirements:** SPEC-008-R10 (the 409 case), R08
- **As:** Bench scientist (alice), reviewer (bob)
- **Steps:**
  1. `RUN_X=$(as alice POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"Plate dropped\",\"params\":{\"cycles\":40}}" | field id)`; `as alice POST /v1/runs/$RUN_X/transitions '{"to":"aborted","reason":"plate dropped"}'`.
  2. Open it in the UI as alice. Look at Params and the Signatures section.
  3. Terminal: direct edit `as alice PATCH /v1/runs/$RUN_X/params '{"params":{"cycles":1},"reason":"x"}'`; sign `sign alice $RUN_X 1 author`.
  4. Propose and commit a correction: `CSX=$(as alice POST /v1/change-sets "{\"title\":\"Fix X\",\"reason\":\"try\",\"items\":[{\"op\":\"update_run_params\",\"run_id\":\"$RUN_X\",\"params\":{\"cycles\":1}}]}" | field id)`; `commit bob $CSX "try"`.
  5. `as alice GET /v1/change-sets/$CSX | body | jq .state`; then reject it as bob: `as bob POST /v1/change-sets/$CSX/reject '{"reason":"frozen"}'`.
- **Expected:**
  - Step 2: State `aborted`; Params shows "Read-only: this record is frozen." with no Edit button; no Sign button.
  - Step 3: both `[409]`. Step 4: the commit is `[409]` and nothing changes. Step 5: the state is still `proposed` before the rejection; the rejection succeeds. Params remain `{"cycles":40}`.
- **Result:** Pass / Fail · Notes:

### UAT-11: Change a signing policy, and switch GxP mode with the operator command

- **Mode:** Dev (the operator command runs against the same database)
- **Requirements:** SPEC-008-R13, R15 (allowed path and audit of the mode change), R08 (all steps needed)
- **As:** The person who owns GxP mode (with a developer), QA / lab manager
- **Steps:**
  1. As alice open My account (click `alice` in the top bar). Read the mode line.
  2. `RUN_P1=$(mkrun "Plate P1")`. Open experiment `il6-qpcr`. Read the Signing policy table. Click "Edit signing policy", click "Add step", set Meaning `approval`, Role `qa`, enter the reason `QA now approves every run`, and click "Save signing policy".
  3. `RUN_P2=$(mkrun "Plate P2")`. Compare `as alice GET /v1/runs/$RUN_P1 | body | jq -c '.signing_policy|map(.meaning)'` with the same for `$RUN_P2`. Open Plate P2 in the UI.
  4. Sign Plate P2 with three different people: `sign alice $RUN_P2 1 author`; `sign bob $RUN_P2 2 review`; check the state; `sign carol $RUN_P2 3 approval`; check the state.
  5. In the terminal, as the operator: `go run ./cmd/server set-gxp --tenant $T --gxp=false --actor "UAT Operator" --reason "R&D tenant, not for regulated work"` (prints `false`). Run it again without `--reason`, and with `--gxp=maybe`.
  6. Reload the UI, open My account, and `as alice GET /v1/me | body | jq .tenant_gxp`.
  7. Audit: `events | jq -r '.[] | select(.action=="tenant.gxp_changed") | [.actor,.reason,(.payload|tostring)] | @tsv'`; then Verify chain in the Audit trail. Finally switch back: the same command with `--gxp=true --reason "back to GxP"`.
- **Expected:**
  - Step 1: "GxP mode" (every tenant is GxP until changed).
  - Step 2: the table shows steps 1 to 3; the Revisions panel for the experiment lists a new revision with the reason.
  - Step 3: Plate P1 keeps two steps, Plate P2 has `["author","review","approval"]` and three Awaiting rows.
  - Step 4: after step 2 the run is still `completed`; after carol's approval it is `signed`.
  - Step 5: the first run prints `false`; the other two fail with "--reason is required" and "--gxp must be true or false" and change nothing.
  - Step 6: "Non-GxP mode"; `false`. Step 7: one `tenant.gxp_changed` event, actor `UAT Operator`, with the reason and `from true to false`; the chain is valid. The API has no way to change the mode.
- **Result:** Pass / Fail · Notes:

### UAT-12: Database protections for signatures (offline re-verification included)

- **Mode:** Dev database (the same checks hold in prod)
- **Requirements:** SPEC-008-R03, R11, R15 (setting), R01 / R02 (hash re-derived offline)
- **As:** QA / validation staff, with a developer (direct database access)
- **Steps:**
  1. Pick a valid signature id and an invalidated one: `as alice GET /v1/runs/$RUN_A/signatures | body | jq -r '.items[]|[.id,.valid]|@tsv'`.
  2. Re-verify offline, with the valid id (`SIG`): `docker compose exec -T postgres psql -U lde -d lde_uat006 -XAtq -c "SELECT m.manifest FROM signatures s JOIN signature_manifests m ON m.id = s.manifest_id WHERE s.id = '$SIG'" > manifest.json; printf '%s' "$(cat manifest.json)" | sha256sum`. Compare with that signature's `manifest_sha256`.
  3. Open `docker compose exec postgres psql -U lde -d lde_uat006` and type `\set VERBOSITY verbose`. As the owner try each, one at a time: `UPDATE signatures SET meaning = 'review' WHERE id = '<SIG>';` `DELETE FROM signatures WHERE id = '<SIG>';` `TRUNCATE signatures;` `UPDATE signature_manifests SET manifest = 'x';` `DELETE FROM signature_manifests;` and on the invalidated one `UPDATE signatures SET invalidated_at = now() WHERE id = '<INVALIDATED SIG>';`.
  4. As the application role (if `SET ROLE` is refused, note it and skip): `BEGIN; SET LOCAL ROLE lde_app; UPDATE signatures SET meaning = 'review'; ROLLBACK;` and the same with `DELETE FROM signatures;`.
  5. Forge a signature with a wrong hash on a fresh finished run (`mkrun "Plate Z"` gives `<RUN>`; `<TENANT>` is the dev tenant; `<SIGNER>` is `$ALICE`):
     ```sql
     BEGIN;
     INSERT INTO signature_manifests (tenant_id, run_id, manifest) VALUES ('<TENANT>', '<RUN>', '{"run_id":"<RUN>"}') RETURNING id \gset m_
     INSERT INTO signatures (tenant_id, entity_type, entity_id, step, meaning, signer_id, printed_name, signed_at, manifest_id, manifest_sha256, reauth_at, reauth_method)
       VALUES ('<TENANT>', 'run', '<RUN>', 1, 'author', '<SIGNER>', 'x', now(), :'m_id', '\x00', now(), 'dev');
     ROLLBACK;
     ```
  6. Change the GxP setting with no audit event: `BEGIN; UPDATE tenants SET gxp = false WHERE id = '<TENANT>'; COMMIT;`
- **Expected:**
  - Step 2: the printed hash equals the signature's `manifest_sha256`. (The printf drops the newline psql adds.)
  - Step 3: every statement fails with code `LDE03`, including the second invalidation.
  - Step 4: both fail with `42501` (permission denied).
  - Step 5: the second INSERT fails with `LDE07`. If a different error appears first, ask the developer to adjust the statement; a forged hash must still be refused.
  - Step 6: the COMMIT fails with `LDE02`; the setting is unchanged (`/v1/me` `tenant_gxp` is still `true`).
- **Result:** Pass / Fail · Notes:

### UAT-13: `make validate` shows the signatures panel requirement verified

- **Mode:** Dev server running (Playwright drives it)
- **Requirements:** SPEC-008-R12 (and the validation harness)
- **As:** QA / validation staff
- **Steps:**
  1. With the dev server up (Part A), once: `cd web && npx playwright install chromium && cd ..`.
  2. `make e2e` (after the last commit, or the result is ignored).
  3. `make validate OPERATOR="UAT Operator"`.
  4. Open the report folder it prints (`validation/<timestamp>/`) and find SPEC-008-R12.
- **Expected:**
  - Step 2: the signatures test passes.
  - Step 3: ends with `Result: PASS` and prints the report folder and `report.json SHA-256`.
  - Step 4: SPEC-008-R12 is `VERIFIED`, citing both the Go test (`TestRunsShowSignatures`) and the browser test (under `web/e2e`). If it says `NOT VERIFIED`, run `make e2e` again and then `make validate`; record it as a failure if it stays so.
- **Result:** Pass / Fail · Notes:

## Part B: prod mode with Keycloak

Stop the dev server and follow section 1.3 (prod server, `tokens`, bootstrap, people). Use new private windows for alice, bob and carol, and sign in with "Sign in with your organisation".

### UAT-14: Sign through a real login (re-authentication) and return to the same tab

- **Mode:** Prod, Keycloak
- **Requirements:** SPEC-008-R04, R01, R05, R12
- **As:** Bench scientist (alice), reviewer (bob)
- **Steps:**
  1. `RUN_P=$(pmk "Plate P")`. As alice in the UI, open the Sign-off inbox, then open Plate P from it. Also open two other tabs (My account and the experiment `prod-qpcr`) so there are several tabs; end with Plate P selected.
  2. Click "Sign as author". Tick the box, type a comment, and click Sign. Read the line above the buttons first.
  3. At the Keycloak page, look at the address bar for `prompt=login`, and note whether the login form appears even though alice is already signed in. Log in as `alice` / `labrat`.
  4. Watch what the UI does on return.
  5. As bob, first check his inbox: `api $TOKEN_BOB GET /v1/inbox/signatures | body | jq '.items[].label'` (run `tokens` first if needed). Then in the UI open the Sign-off inbox, open Plate P, and sign as review in the same way (log in as `bob`).
  6. In the helper terminal: `api $TOKEN_ALICE GET /v1/runs/$RUN_P/signatures | body | jq '.items[]|{step,meaning,printed_name,signed_at,reauth_method,valid}'`.
- **Expected:**
  - Step 2: the dialog says "You will be asked to log in again before the signature is applied."
  - Step 3: the browser goes to Keycloak with `prompt=login` and `max_age=0`, and the login form really appears (not a silent sign-in).
  - Step 4: you return to LabRat with the same tab (Plate P) active and the other tabs still open. The dialog resumes by itself ("Signing...") without another click, closes, and the Signatures section shows "Alice Ng, author, ... UTC, Valid · comment".
  - Step 5: bob's inbox lists Plate P as step 2 (review) only after alice signed, and does not list runs that still await a scientist (bob is only a reviewer, so `RUN_BEFORE` must not appear). After bob's login the state becomes `signed`.
  - Step 6: `reauth_method` is `oidc` for both signatures; printed names "Alice Ng" and "Bob Ortiz".
- **Result:** Pass / Fail · Notes:

### UAT-15: Signing is refused without a fresh login by the same person

- **Mode:** Prod, Keycloak
- **Requirements:** SPEC-008-R04
- **As:** Bench scientist (alice), QA
- **Steps:**
  1. `RUN_Q=$(pmk "Plate Q")`. `Q0=$(api $TOKEN_CAROL GET '/v1/audit/events?after=0&limit=1000' | body | jq length)`.
  2. No token: `api $TOKEN_ALICE POST /v1/runs/$RUN_Q/signatures "{\"step\":1,\"meaning\":\"author\",\"manifest_sha256\":\"$(api $TOKEN_ALICE GET /v1/runs/$RUN_Q/manifest | body | jq -r .sha256)\"}"`.
  3. Access token in place of an ID token: send the same body with `,"reauth_token":"'$TOKEN_ALICE'"` added.
  4. In the UI as alice, open Plate Q, click Sign, tick the box, click Sign. At the Keycloak login page, log in as `bob` instead of alice.
  5. Repeat in a new private window as alice, but this time wait about 2.5 minutes at the Keycloak login form before entering the password.
  6. `api $TOKEN_ALICE GET /v1/runs/$RUN_Q/signatures`, and count the events again (`Q1`).
  7. Abandon an attempt: as alice, open Plate Q, click Sign, tick the box, click Sign. At the Keycloak login page, press the browser's Back button without entering a password. If the app shows its sign-in page, sign in, then look at Plate Q.
- **Expected:**
  - Steps 2 and 3: `[401]`; no signature (an access token is not a valid proof; the proof must be an ID token for the UI client, from a login made for this attempt).
  - Step 4: nothing is signed in alice's name. The dialog stays open and shows `log in again to sign` or that the token is for someone else; the tab is now signed in as bob, so sign out before the next step.
  - Step 5: after the login the UI shows "log in again to sign: your login is not recent enough" (HTTP 401) and nothing is signed.
  - Step 6: `items: []`, and no `signature.applied` since `Q0`. Each attempt that reached the login page adds a `signature.challenge_issued` event.
  - Step 7: nothing is signed: no signature appears, even if signing in needed no password. The Sign button is available again, and signing needs a new password entry.
- **Result:** Pass / Fail · Notes:

### UAT-16: Who may change a signing policy, in GxP and non-GxP

- **Mode:** Prod, Keycloak
- **Requirements:** SPEC-008-R15, R13
- **As:** Bench scientist (alice), reviewer (bob), lab admin (carol), the owner of GxP mode
- **Steps:**
  1. `RUN_BEFORE` was created in setup with the old policy. `POL='{"signing_policy":[{"step":1,"meaning":"author","role":"scientist"},{"step":2,"meaning":"verification","role":"reviewer"}],"reason":"verification instead of review"}'`.
  2. In GxP (default): `api $TOKEN_ALICE PATCH /v1/experiments/$EXPP/signing-policy "$POL"`; the same with `$TOKEN_BOB`; then with `$TOKEN_CAROL`.
  3. As bob in the UI open experiment `prod-qpcr` and read the Signing policy section. As carol, open the same.
  4. `RUN_AFTER=$(pmk "After policy change")`. Compare the policies: `api $TOKEN_ALICE GET /v1/runs/$RUN_BEFORE | body | jq -c '.signing_policy|map(.meaning)'` and the same for `$RUN_AFTER`.
  5. Switch the tenant to non-GxP (operator): `go run ./cmd/server set-gxp --tenant $T1 --gxp=false --actor "UAT Operator" --reason "R&D tenant"`.
  6. Repeat step 2 with a new body (reason `back to review`, step 2 meaning `review`): alice, then bob. As bob reload the experiment view and My account.
  7. Switch back: `--gxp=true --reason "GxP again"`.
- **Expected:**
  - Step 2: alice `[403]`, bob `[403]`, carol `[200]` with `change_set_id` and `rev`.
  - Step 3: bob sees the table but no "Edit signing policy" button; carol sees the button.
  - Step 4: `RUN_BEFORE` keeps `["author","review"]`; `RUN_AFTER` has `["author","verification"]`.
  - Step 6: alice `[403]`, bob `[200]`; bob now sees the Edit button and "Non-GxP mode" in My account.
  - Step 7: the command prints `true`. The audit trail has two `tenant.gxp_changed` events and the experiment's Revisions list shows each policy change with its reason.
- **Result:** Pass / Fail · Notes:

### UAT-17: Correct a signed run with real roles (reviewer who is not a scientist)

- **Mode:** Prod, Keycloak
- **Requirements:** SPEC-008-R09, R10, R20
- **As:** Bench scientist (alice), reviewer (bob), lab admin (carol)
- **Steps:**
  1. `RUN_P` is signed by alice and bob (UAT-14). As alice in the UI, open Plate P and propose a params correction (`anneal_temp_c` 62, reason `transcription error`).
  2. Terminal: `CSP=$(api $TOKEN_ALICE GET '/v1/change-sets?state=proposed' | body | jq -r '.items[-1].id')`. Alice tries to commit: `api $TOKEN_ALICE POST /v1/change-sets/$CSP/commit "{\"reason\":\"self\",\"items_sha256\":\"$(api $TOKEN_ALICE GET /v1/change-sets/$CSP | body | jq -r .items_sha256)\"}"`.
  3. Carol (admin, no reviewer or QA role) tries the same with `$TOKEN_CAROL`.
  4. As bob in the UI, open the Review inbox, expand the card, read the warning, and commit with the reason `checked against the notebook`.
  5. Open Plate P as alice and as bob.
- **Expected:**
  - Steps 2 and 3: `[409]` each. The change set is still proposed.
  - Step 4: the card warns "Committing invalidates 2 signatures and returns the run for re-signing." and the commit succeeds even though bob is not a scientist.
  - Step 5: State `completed`, both signatures struck through with "transcription error", Params 62, and a Sign button offered to alice (as author). Alice can sign again with a new login.
- **Result:** Pass / Fail · Notes:

### UAT-18: A blank display name blocks signing; renaming fixes it and keeps old signatures

- **Mode:** Prod, Keycloak
- **Requirements:** SPEC-008-R16, R17
- **As:** Lab admin (carol), visiting scientist (dave)
- **Steps:**
  1. `RUN_D=$(pmk "Plate D")`, `RUN_D2=$(pmk "Plate D2")`.
  2. In a new private window sign in as `dave`, open Plate D, and try to sign (log in as dave when asked).
  3. As carol in Principals, rename `dave` to a blank name, then to `Dave Okafor` with the reason `name was missing`.
  4. As dave sign Plate D as author again (log in as dave).
  5. As carol rename dave again: `Dave Okafor-Lind`, reason `name change`. As dave sign Plate D2 as author.
  6. Open both runs and read the signatures. Audit: `api $TOKEN_CAROL GET '/v1/audit/events?after=0&limit=1000' | body | jq -r '.[]|select(.action=="principal.renamed")|[.reason,(.payload|tostring)]|@tsv'`.
- **Expected:**
  - Step 2: no signature is applied; the dialog shows an error (HTTP 409, the printed name is missing). The run has no signatures.
  - Step 3: the blank rename is refused ("Display name must not be blank."); the second succeeds.
  - Step 4: signed as "Dave Okafor".
  - Step 5: Plate D2 is signed as "Dave Okafor-Lind", and Plate D still shows "Dave Okafor".
  - Step 6: `principal.renamed` events with the reasons.
- **Result:** Pass / Fail · Notes:

## Part C: Entra ID and Okta (before any pilot)

### UAT-19: Prove the ID token carries `auth_time` after `prompt=login`, and the login form appears

- **Mode:** Prod, against a real Entra ID tenant and a real Okta org (not run locally; the local Keycloak case is the control)
- **Requirements:** SPEC-008-R04
- **As:** IdP administrator and QA, with a developer
- **Why:** the re-authentication check accepts an ID token only when it has a recent `auth_time`. Entra ID and Okta are the target IdPs and this has not been proven on either. If either fails, every signature on that IdP is refused with `401`, or the form never shows, so users are not asked to prove themselves.
- **Steps (repeat once per IdP, and once on the local Keycloak as a control):**
  1. For Entra ID, follow **UAT-19 on Entra ID: step by step** below in place of this step. Otherwise, register the LabRat UI client and API as in `docs/identity.md` (public client, PKCE, redirect URI = the LabRat host). Enable `auth_time` as a claim of the UI client's ID token if the IdP needs it switched on (optional claims). Start LabRat in prod against it with `LDE_OIDC_UI_CLIENT_ID` set.
  2. Sign in to LabRat as a test user and stay signed in (so the IdP has a live session).
  3. Open a completed run, click Sign, tick the box, click Sign.
  4. Watch the browser: does the IdP show its login form (username or password, or MFA), even though the session is live? Capture the authorization request URL: it must have `prompt=login` and `max_age=0`.
  5. Complete the login. In the browser's Network tab, find the request to `/v1/runs/<id>/signatures` and copy `reauth_token` from its body. Decode it locally with the `claims` helper in the Entra ID walkthrough below (tokens are base64url, so plain `base64 -d` can fail); do not paste it into a public website.
  6. Check the claims: `iss` is the configured issuer, `aud` is the UI client id, `sub` is the signer's, `auth_time` is present and is the time of this login, within about a minute of now, and `nonce` is present and equals the `nonce` in the authorization request URL from step 4.
  7. Check the signature was recorded: `GET /v1/runs/<id>/signatures` has `reauth_method: "oidc"`.
  8. Negative: wait longer than `LDE_SIGN_REAUTH_MAX_AGE` (2 minutes) at the login form, then log in; the signature must be refused with `401`.
  9. Record, per IdP: tenant or org name, date, whether `prompt=login` forced the form, whether `auth_time` was present, and the difference between `auth_time` and the server clock.
- **Expected:** the form appears each time; `auth_time` is present and fresh; the signature is recorded with `reauth_method: "oidc"`; the stale login is refused. An `auth_time` up to 60 seconds ahead of the server is tolerated and recorded as the current time.
- **Result (Entra ID):** Pass / Fail · Notes:
- **Result (Okta):** Pass / Fail · Notes:
- **Result (Keycloak control):** Pass / Fail · Notes:

#### UAT-19 on Entra ID: step by step

This uses a free Entra tenant and a LabRat server on your own machine. It needs no client secret. It has not been run yet, so if a portal label has moved or a step fails, record what you saw.

Two choices differ from a general reading of `docs/identity.md`, and both are deliberate:

- **One app registration for both the UI and the API.** Entra gives the same user a different `sub` for each application. LabRat finds the signer from the access token's `sub` and requires the ID token's `sub` to match, so with two registrations every signature would be refused as "for someone else".
- **`tid` as the tenant claim.** Entra already puts its tenant ID, a UUID, in the token when the `profile` scope is requested. The LabRat tenant simply uses the same UUID, so no custom claim is needed.

**A. Set up Entra.** In the [Microsoft Entra admin center](https://entra.microsoft.com):

1. On **Entra ID** > **Overview**, copy the **Tenant ID**.
2. Create a test user: **Entra ID** > **Users** > **New user** > **Create new user**. Use a synthetic name such as `labrat-alice`, and copy the user principal name and password. Don't test with your own Azure sign-in, which is usually a guest in this tenant. The first login asks for a new password, and security defaults may ask you to set up MFA.
3. Register the app: **Entra ID** > **App registrations** > **New registration**.
   - Name: `LabRat UAT`.
   - Supported account types: this organizational directory only (single tenant).
   - Redirect URI: platform **Single-page application (SPA)**, value exactly `http://localhost:8090/`, with the trailing slash. Use `localhost`, not `127.0.0.1`. If port 8090 is taken, choose another and use it everywhere below.
   - Click **Register**, then copy the **Application (client) ID**.
4. Don't tick the implicit grant boxes, and don't create a client secret.
5. Expose the API: open **Expose an API**.
   - Next to **Application ID URI**, click **Add** and accept `api://<client id>`.
   - Click **Add a scope**. Scope name `access`, who can consent **Admins and users**, any display names and descriptions, state **Enabled**.
6. Ask for v2 access tokens: open **Manifest**, find `requestedAccessTokenVersion` under `api`, set it to `2`, and click **Save**. It starts as `null`, which gives v1 tokens that LabRat rejects. (The older manifest format calls it `accessTokenAcceptedVersion`.)
7. Turn on `auth_time`: open **Token configuration** > **Add optional claim**, choose token type **ID**, tick `auth_time`, and click **Add**.

**B. Start LabRat against it.** Use a new Git Bash terminal, without `uat.env` sourced. Run `make ui` first if you haven't built the UI on this checkout. Using a database of its own keeps this away from your other UAT data.

```bash
export ENTRA_TENANT=<tenant id, lowercase>
export ENTRA_CLIENT=<application (client) id>
export LAB=http://localhost:8090
export LDE_ENV=prod
export LDE_HTTP_ADDR=:8090
export LDE_DATABASE_URL='postgres://lde:lde@localhost:5432/lde_entra?sslmode=disable'
export LDE_OIDC_ISSUER="https://login.microsoftonline.com/$ENTRA_TENANT/v2.0"
export LDE_OIDC_AUDIENCE=$ENTRA_CLIENT
export LDE_OIDC_UI_CLIENT_ID=$ENTRA_CLIENT
export LDE_OIDC_TENANT_CLAIM=tid
export LDE_OIDC_UI_SCOPES="openid profile email api://$ENTRA_CLIENT/access"

docker compose exec -T postgres psql -U lde -d postgres -c 'CREATE DATABASE lde_entra'
go run ./cmd/server      # first log line says "env":"prod"; a later line says "oidc ready"
```

In a second terminal, run the same `export` lines (skip the database and server commands) and define these helpers:

```bash
claims() { # paste a token at the prompt; prints its claims. Nothing leaves your machine.
  local t; read -rsp 'Token: ' t; echo
  # "command" skips Git Bash's alias of node to winpty, which refuses piped input ("stdin is not a tty").
  printf %s "$t" | command node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(Buffer.from(s.trim().split(".")[1],"base64url")),null,1)))'
}
api() { # api METHOD PATH [JSON] -> "body [STATUS]"; uses $TOKEN
  curl -s -w ' [%{http_code}]\n' -X "$1" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' ${3:+-d "$3"} "$LAB$2"
}
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
```

**C. Find the test user's `sub`, and create them in LabRat.**

1. Open a new private browser window, press F12, open the **Network** tab and tick **Preserve log**. Go to `http://localhost:8090/` and sign in as the test user. Accept the permissions prompt if one appears.
2. LabRat should now say there is no principal for this identity (`403`). That is expected: they don't exist in LabRat yet.
3. In the Network tab, click the `POST` request named `token` and open **Response**. Copy the value of `access_token`, run `claims` and paste it. Check: `ver` is `2.0`, `iss` equals `$LDE_OIDC_ISSUER`, `aud` equals `$ENTRA_CLIENT`, `tid` equals `$ENTRA_TENANT`. Note `sub`.
4. Do the same with `id_token` from that response. Check: `aud` equals `$ENTRA_CLIENT`, **`sub` is identical to the access token's**, and `auth_time` is present. If any of this differs, stop and see the table below.
5. Create the user. This runs as the database owner, so first check this terminal has the settings from part B. Replace the placeholder, then run:

```bash
export ENTRA_SUB='<sub from step 3>'
echo "tenant=[$ENTRA_TENANT] env=[$LDE_ENV] db=[$LDE_DATABASE_URL] issuer=[$LDE_OIDC_ISSUER] sub=[$ENTRA_SUB]"
```

Every bracket must be filled in, with `env=[prod]` and a `db` ending in `lde_entra?sslmode=disable`. If any is empty, run the `export` lines from part B in this terminal. On a checkout without SPEC-023, a missing `LDE_ENV` or `LDE_DATABASE_URL` quietly means dev mode and the shared `lde` database, so don't skip this. Then:

```bash
export ALICE=$(go run ./cmd/server bootstrap-admin --tenant "$ENTRA_TENANT" --slug entra-uat --name "Entra UAT" \
  --issuer "$LDE_OIDC_ISSUER" --subject "$ENTRA_SUB" --handle alice --display-name "Alice Test" --email alice@lab.test | tail -1)
echo "ALICE=[$ALICE]"
```

`ALICE` must be a UUID. If it's empty, read the error above it.

6. Reload the browser page: you should now be signed in as `alice`.
7. Give them the role that signs step 1, and make two finished runs. Copy `TOKEN` from the same `access_token`, or from the `Authorization` header of any `/v1/` request, without the word `Bearer`:

```bash
read -rsp 'Token: ' TOKEN; echo
api POST /v1/role-grants "{\"principal_id\":\"$ALICE\",\"role\":\"scientist\",\"reason\":\"UAT-19\"}"   # [201]
EXP=$(api POST /v1/experiments '{"slug":"entra-qpcr","title":"Entra qPCR (synthetic)","protocol_md":"---\nprotocol: qpcr\nversion: 1\n---\n\n# Steps\n1. Plate triplicates.\n"}' | field id)
mk() { local id; id=$(api POST /v1/runs "{\"experiment_id\":\"$EXP\",\"label\":\"$1\",\"params\":{\"cycles\":40}}" | field id)
  api POST /v1/runs/$id/transitions '{"to":"running"}' >/dev/null
  api POST /v1/runs/$id/transitions '{"to":"completed"}' >/dev/null; echo $id; }
RUN_A=$(mk "Entra A"); RUN_B=$(mk "Entra B"); echo "EXP=$EXP RUN_A=$RUN_A RUN_B=$RUN_B"
```

Every id must be non-empty. Two runs are needed because one person can't sign the same run twice.

**D. Run the test (steps 2 to 9 above).** Keep the browser window from step C, still signed in, with **Preserve log** ticked.

1. In the explorer, open experiment `entra-qpcr`, then run `Entra A`. Click **Sign**, tick the box, and click **Sign**.
2. *Step 4:* Entra must ask for the password, even though you are signed in. Record whether it also asks for MFA. In the Network tab, filter on `authorize` and copy the newest request's URL: it must contain `prompt=login`, `max_age=0` and `nonce=`. Note the `nonce`. Microsoft documents `prompt=login` as what forces the login, so don't count this as a pass on `max_age` alone.
3. Enter the password. LabRat returns and applies the signature.
4. *Steps 5 and 6:* filter on `signatures`, click the `POST`, open **Payload** and copy `reauth_token`. Run `claims` and paste it. Check `iss` equals `$LDE_OIDC_ISSUER`, `aud` equals `$ENTRA_CLIENT`, `sub` equals `$ENTRA_SUB`, `nonce` equals the one you noted, and `auth_time` is within about a minute of `date +%s`. Record the difference.
5. *Step 7:* `api GET /v1/runs/$RUN_A/signatures` must show `"reauth_method":"oidc"`, with `[200]`.
6. *Step 8:* open run `Entra B`, click **Sign**, tick the box and click **Sign**. **Wait 2 minutes 30 seconds on the Entra password page**, then log in. LabRat must refuse with `log in again to sign: your login is not recent enough` (`401` on the `signatures` request). The login itself is fresh, so this is the expired challenge being refused. `api GET /v1/runs/$RUN_B/signatures` must show no signatures.
7. *Step 9:* record the tenant ID, the date, and the results above under **Result (Entra ID)**. Don't paste tokens into the plan.

**If something goes wrong:**

| What you see | Likely cause | Fix |
|---|---|---|
| `AADSTS50011` (redirect URI mismatch) | The URL isn't exactly the registered one | Use `http://localhost:8090/` for both, including the trailing slash |
| `AADSTS9002326` (cross-origin token redemption), or `Sign-in failed: the identity provider returned 400` | The redirect URI is under **Web**, not **SPA** | A.3: move it to the SPA platform |
| "Need admin approval", or `AADSTS65001` | The user can't consent to the scope | A.5: check **Admins and users**, then have an admin grant consent under **API permissions** |
| Server log says `bearer token rejected`, or the UI shows `401` right after sign-in | The access token has `ver` `1.0` or `iss` of `sts.windows.net`, or the wrong `aud` | A.6, and check `LDE_OIDC_AUDIENCE` is the client ID. Sign out and in again for a new token |
| `token has no valid tid claim` | No `tid` in the access token | Check `profile` is in `LDE_OIDC_UI_SCOPES` and `LDE_OIDC_TENANT_CLAIM=tid` |
| `no enabled principal for this identity` after step C.5 | `sub` or issuer doesn't match the access token, or `--tenant` isn't the `tid` | Compare them with the `claims` output. They must match exactly |
| `reauth_token is for someone else` | Signed in as another user at the forced login, or two app registrations | Use the same user; use one registration |
| `reauth_token has no auth_time` | The optional claim isn't on the ID token | A.7. **Record this as a finding**: if it's still missing, re-authentication doesn't work on Entra |
| `not recent enough` on a quick login | Clock difference, or the `nonce` is missing from the ID token | Record the token's `auth_time` and `nonce` against `date +%s` |

Afterwards: stop the server, and delete the app registration and test user if you no longer need them. To remove the database: `docker compose exec -T postgres psql -U lde -d postgres -c 'DROP DATABASE lde_entra'`.

## 3. Traceability

| Requirement | Cases | Automated test |
|---|---|---|
| SPEC-008-R01 | UAT-03, UAT-14, UAT-12 | yes |
| SPEC-008-R02 | UAT-05, UAT-09, UAT-12 | yes |
| SPEC-008-R03 | UAT-12 | yes |
| SPEC-008-R04 | UAT-14, UAT-15, UAT-19 | yes |
| SPEC-008-R05 | UAT-02, UAT-03, UAT-04, UAT-14 | yes |
| SPEC-008-R06 | UAT-03 | yes |
| SPEC-008-R07 | UAT-04 | yes |
| SPEC-008-R08 | UAT-03, UAT-04, UAT-05, UAT-10, UAT-11 (that no statement sets `signed` directly is shown through the API in UAT-04 and by the automated test only at database level) | yes |
| SPEC-008-R09 | UAT-07, UAT-17 | yes |
| SPEC-008-R10 | UAT-08, UAT-09, UAT-10, UAT-17 | yes |
| SPEC-008-R11 | UAT-12 | yes |
| SPEC-008-R12 | UAT-03, UAT-08, UAT-13, UAT-14 | yes |
| SPEC-008-R13 | UAT-08, UAT-11, UAT-16 | — |
| SPEC-008-R14 | UAT-04 | — |
| SPEC-008-R15 | UAT-11, UAT-12, UAT-16 | yes |
| SPEC-008-R16 | UAT-18 | yes |
| SPEC-008-R17 | UAT-01, UAT-18 | — |
| SPEC-008-R18 | UAT-06 | yes |
| SPEC-008-R19 | UAT-06 | — |
| SPEC-008-R20 | UAT-07 | yes |

Out of scope and not tested here, per the spec: signing schema change requests (SPEC-010), handwritten or biometric signatures, signatures with personal keys (PKI), notifying signers, and correcting runs signed before SPEC-008 (they have no signature records, so none can be built through the API; the aborted run in UAT-10 is the frozen case that can be shown).

## 4. Sign-off

| Tester | Role | Date | Outcome | Notes |
|---|---|---|---|---|
| | | | Accepted · Accepted with issues · Rejected | |
