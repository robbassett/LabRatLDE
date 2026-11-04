# Electronic signatures

A signature in LabRat ties a named person to a meaning and to the exact content of a run, at a moment they just proved who they were. This is the design of [SPEC-008](../specs/implemented/SPEC-008-electronic-signatures/requirements.md) (21 CFR 11.50, 11.70, 11.100 and 11.200). This page describes what it delivers and what it doesn't.

The `curl` examples use the dev headers and variables from the [README walkthrough](../README.md#walkthrough-sample--run--instrument-stream--signature--proof): `H` for the first person, `R` for a second (a reviewer), `API`, `EXP` and `RUN`. In production, send `-H "Authorization: Bearer $TOKEN"` instead; see [identity.md](identity.md).

A signature stores:

- the signer, and their **printed name**: the display name they had at that moment;
- the **meaning** and the policy **step** it fills;
- the time, from the database clock;
- the **SHA-256 of the run's manifest** (below), and the manifest text itself;
- how the signer re-authenticated (`oidc`, or `dev` on a development server).

Signatures are never edited or deleted. The only change allowed is setting the invalidation fields once, which a committed correction does. This holds for every role, including the database owner.

## Policies and meanings

An experiment has a **signing policy**: an ordered list of steps, each with a meaning and the role its signer must hold. The default is:

| Step | Meaning | Role |
|---|---|---|
| 1 | `author` | `scientist` |
| 2 | `review` | `reviewer` |

The meanings are `author`, `review`, `approval` and `verification`. The roles a step may require are `scientist`, `reviewer` and `qa`. Adding a meaning needs a spec. A policy has steps `1..n`, in order, with no gaps.

A run copies its experiment's policy when it is created. Changing the policy later affects only runs created afterwards.

Signing follows the policy:

- A run can be signed only when it is `completed` or `failed`. A `failed` run can be signed, and the manifest records that outcome.
- The next signature must fill the lowest step that has no valid signature, with that step's meaning, by a **human** who holds that step's role.
- **No person signs twice** on one run. Agents and services can't sign, even when they act for a human.
- The signer needs a non-blank display name. An admin can set it (see [identity.md](identity.md)).
- When every step has a valid signature, the run moves to `signed`. Nothing can set `signed` directly: `POST /v1/runs/{id}/transitions` with `to: signed` is `400`.

The first signature **seals** the run: its node, the datasets it generated, its params and its non-annotation notes can no longer be changed directly, even before the run is fully signed. Notes added afterwards are annotations and don't invalidate anything.

## GxP mode and who may change a policy

Each tenant is in GxP mode or not. A tenant is **GxP** unless an operator changes it. The mode decides who may change a signing policy:

| Mode | May change a policy |
|---|---|
| GxP (default) | `qa` or `admin` |
| Non-GxP | `reviewer`, `qa` or `admin` |

Anyone else gets `403`, and the database enforces it. The mode governs nothing else yet. A policy change is a direct edit, so it needs a reason and appears in the experiment's revisions (`GET /v1/records/experiment/{id}/revisions`):

```bash
curl -s "${H[@]}" -X PATCH $API/experiments/$EXP/signing-policy -d '{
  "signing_policy": [
    {"step": 1, "meaning": "author", "role": "scientist"},
    {"step": 2, "meaning": "review", "role": "reviewer"},
    {"step": 3, "meaning": "approval", "role": "qa"}],
  "reason": "QA now approves every run"}'
```

The API can't change the mode. An operator does it as the database owner, like `bootstrap-admin`, with the server's `LDE_DATABASE_URL`:

```bash
labrat set-gxp --tenant <tenant uuid> --gxp=false --actor "J. Doe" --reason "R&D tenant, not for regulated work"
```

All four flags are required, and a blank reason is an error. It prints the new value and audits `tenant.gxp_changed` with the old and new values. `GET /v1/me` shows the current mode as `tenant_gxp`, and the UI's **My account** tab says "GxP mode" or "Non-GxP mode".

## Re-authentication

A signature needs the signer to log in again just before. In production the UI sends the user back to the identity provider with `prompt=login&max_age=0`, and sends the new ID token with the signature as `reauth_token`. The server accepts it only if all of these hold:

- the token is an ID token from the configured issuer, issued to the UI client (`LDE_OIDC_UI_CLIENT_ID`);
- its issuer and subject are the signer's own;
- it has an `auth_time`, and that is at most `LDE_SIGN_REAUTH_MAX_AGE` ago (default `120s`). An `auth_time` up to 60 seconds ahead is tolerated for clock skew between the provider and the server.

Otherwise the request is `401` and nothing is written. If `LDE_OIDC_UI_CLIENT_ID` is not set, signing is `501`. The identity provider must honour `prompt=login` and return `auth_time`: see [identity.md](identity.md).

**An ID token isn't single-use.** The server checks only how recent the login was, so one ID token can sign several runs until it is `LDE_SIGN_REAUTH_MAX_AGE` old. The UI asks for a fresh login for every signature, but a client calling the API directly can reuse a token inside that window. Lower `LDE_SIGN_REAUTH_MAX_AGE` if that is too loose for your procedure.

On a development server (`LDE_ENV=dev`) no token is needed, the signature records `reauth_method = dev`, and the UI says "Dev mode: no re-authentication". Dev signatures are not for regulated use.

## What a signature covers: the manifest

`GET /v1/runs/{id}/manifest` returns `{manifest, sha256, previous, changes}`. `manifest` is canonical JSON, so equal content always gives identical bytes, and `sha256` is its SHA-256 in lowercase hex. It holds:

- the run's id, experiment id, protocol version id and the protocol's SHA-256;
- the run's state (`completed` or `failed`) and its params;
- the current revision numbers of the run and its node, and of each input;
- each generated dataset's id, revision, reading count and ingest SHA-256;
- each non-annotation note's id, revision and body SHA-256.

Proposed change sets and annotations don't change it.

A signing request must carry the `manifest_sha256` the signer saw. If the run has changed since, the request is `409` and nothing is written, so a signer can't sign content they never viewed. The UI's sign dialog shows the manifest summary and the confirmation "By signing I confirm I have reviewed this record, and my signature means: …".

```bash
M=$(curl -s "${H[@]}" $API/runs/$RUN/manifest | jq -r .sha256)
curl -s "${H[@]}" $API/runs/$RUN/signatures \
     -d "{\"step\":1,\"meaning\":\"author\",\"manifest_sha256\":\"$M\",\"comment\":\"as run\"}" | jq
```

An input record such as a sample can be revised between two signing steps. Both signatures stay valid, each bound to what its signer saw. `previous` is the latest valid signature's `{step, sha256}`, and `changes` lists what differs from that signature's manifest, so the next signer sees it.

### Re-verifying a signature offline

A signature's `manifest_sha256` must equal the SHA-256 of the manifest text stored with it. The database enforces this on insert, and anyone with read access to the database can check it again without LabRat. With the compose stack, for a signature id from `GET /v1/runs/{id}/signatures`:

```bash
docker compose exec -T postgres psql -U lde -XAtq -c "SELECT m.manifest FROM signatures s JOIN signature_manifests m ON m.id = s.manifest_id WHERE s.id = '<signature id>'" > manifest.json
printf '%s' "$(cat manifest.json)" | sha256sum
```

The hash printed must equal the signature's `manifest_sha256`. `printf` drops the newline that `psql` adds, because the hash covers the text only. A signature also has a `signature.applied` event in the audit chain, whose payload carries the same hash, so [the chain's own verification](audit-chain.md) shows that neither was altered afterwards.

## Corrections

A signed run can't be edited. It can be **corrected**, in the open:

1. A scientist proposes a change set (`POST /v1/change-sets`, or **Edit** on a signed record in the UI, which reads "Propose correction"). A direct edit of a sealed record is refused with `409`.
2. A **reviewer or QA** opens it in the review inbox. Its detail lists `invalidates`: the runs and how many signatures committing would invalidate. The UI warns "Committing invalidates N signatures and returns the run for re-signing".
3. The reviewer commits it with the `items_sha256` of the items they read. A missing or different hash is `409` and nothing changes, so the author can't swap the items after review.
4. In one transaction, every valid signature on the run is marked invalidated, with the time and the change set, and a `signature.invalidated` event is audited for each. A `signed` run returns to the state it had before signing (`completed` or `failed`). Then the items are applied as new revisions. All signatures are invalidated, not only those of steps whose content changed.
5. The run is signed again from step 1. The earlier signers may sign again, because their old signatures are no longer valid. The old signatures stay on the run, struck through in the UI with the change set and its reason.

```bash
curl -s "${H[@]}" $API/change-sets -d '{"title":"Fix anneal temperature","reason":"transcription error",
  "items":[{"op":"update_run_params","run_id":"'$RUN'","params":{"anneal_temp_c":62}}]}'
CS=<id from the response>
curl -s "${R[@]}" $API/change-sets/$CS | jq '{items_sha256, invalidates}'
curl -s "${R[@]}" $API/change-sets/$CS/commit -d '{"reason":"checked against the notebook","items_sha256":"<items_sha256>"}'
```

**What a reviewer can and can't do under a correction.** The rule is four-eyes:

- The committer must hold `reviewer` or `qa`, and be a human. They need not hold `scientist`.
- They can't be the author, or the human an agent author acts for. An agent can propose, but it can't commit, and neither can the human it acted for.
- Their extra rights last only for the change set they commit in that transaction, and cover only lineage nodes, edges, notes and a run's params. They can't write readings, instruments or protocols, or change a run's state, and they can't propose changes of their own unless they also hold `scientist`.
- A change set can't mix a signed-record correction with a signing-policy change. They go in separate change sets.

Not every edit to a run invalidates signatures. An edit that touches the run's sealed set does: the run's params, its node or a dataset it generated, an edge added to the run or to a dataset it generated, or a note that existed when the run was sealed. Adding a note to a sealed run is an annotation and stays a direct edit.

## What stays frozen

Corrections need signatures to invalidate. Two kinds of run have none, so they can't be corrected:

- **Aborted runs.** Aborting is final and seals the run.
- **Runs signed before SPEC-008.** They are in state `signed` but have no signature records. They stay sealed as they were signed.

A correction to either is refused with `409` when committed. The run view shows their fields as read-only; the lineage view says the record is frozen when you try to save. For a run that needs fixing after it is frozen, record a new, linked run and refer to the old one.

## In the UI

- The run view has a **Signatures** section above Notes. It lists each policy step with its signature (printed name, meaning, date and time in UTC, valid or invalidated with the reason) or "Awaiting". The **Sign** button appears when you hold the next step's role and haven't validly signed.
- The **Sign-off inbox** tab lists finished runs waiting for your signature, oldest first, and `GET /v1/inbox/signatures` returns the same.
- The experiment view shows the signing policy, with an edit form for the roles your tenant's mode allows.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/runs/{id}/manifest` | The manifest, its SHA-256, the previous valid signature and what changed since |
| `POST` | `/v1/runs/{id}/signatures` | Apply the next step: `{step, meaning, manifest_sha256, comment?, reauth_token?}`; returns `201` and the signature |
| `GET` | `/v1/runs/{id}/signatures` | `{items}`, oldest first |
| `GET` | `/v1/inbox/signatures?cursor=&limit=` | Runs awaiting the caller's signature |
| `PATCH` | `/v1/experiments/{id}/signing-policy` | `{signing_policy, reason}`; returns `{change_set_id, rev}` |
| `PATCH` | `/v1/principals/{id}` | `{display_name, reason}` (admin) |

Every run representation (create, read, list, transition) carries `signatures` and `signing_policy`. A signature has `id, step, meaning, signer` (the handle), `printed_name, signed_at, manifest_sha256, comment, reauth_method, valid, invalidated_at, invalidated_by_change_set` and `invalidated_reason`.

Errors: `400` for a malformed request or `to: signed`; `401` when re-authentication fails; `403` when a role check fails, for example a policy change without the role the tenant's mode needs; `409` when the manifest has changed, the run is not signable, the step or the signer's role doesn't match the policy, the signer has already signed, or a correction breaks the four-eyes rule; `501` when signing is not configured in production.

## Out of scope

Signing schema change requests (SPEC-010 reuses this mechanism), handwritten or biometric signatures, signatures with personal keys (PKI), and notifying signers when a run reaches their step. LabRat's §11.70 link between signature and record is the manifest digest plus the hash-chained audit trail.
