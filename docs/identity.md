# Identity, roles and agents

LabRat doesn't store passwords. In production (`LDE_ENV=prod`) every API call carries a bearer token from your OIDC identity provider (Entra ID, Okta, Keycloak, …), and each token maps to a **principal** that an admin provisioned. Roles are checked by the database itself, so no endpoint or script can skip them ([SPEC-006](../specs/implemented/SPEC-006-identity-and-roles/requirements.md)).

## Principals and roles

A principal is a `human`, a `service` (for example an instrument PC) or an `agent` (an AI assistant, SPEC-014). Each one has a handle that's unique in the tenant and is never reused: principals are disabled, never deleted, and a handle is never renamed. An admin can correct the display name (see below).

| Role | May |
|---|---|
| `scientist` | create and change lab records: experiments, protocol versions, lineage, runs, instruments, readings; sign the steps a signing policy gives `scientist` (the default policy's first step) |
| `reviewer`, `qa` | sign the steps a signing policy gives their role; commit a correction to a signed record, if they didn't propose it. `qa` also changes signing policies in a GxP tenant, and `reviewer` in a non-GxP one. See [signatures.md](signatures.md) |
| `admin` | provision and disable principals, correct display names, grant and revoke roles, delegate to agents; change signing policies |
| `schema_steward` | (scoped to a schema namespace; used by SPEC-010) |

Anyone signed in may read. Every grant, revocation, delegation and principal change needs a reason and is written to the audit chain in the same transaction. The database refuses the change otherwise.

## Configure your identity provider

1. Register an **API** (resource) whose access tokens carry:
   - `iss`: your issuer, which becomes `LDE_OIDC_ISSUER`;
   - `aud`: the audience you choose, which becomes `LDE_OIDC_AUDIENCE`;
   - `sub`: a stable user id;
   - a string claim with the LabRat tenant UUID, `lde_tenant` by default (`LDE_OIDC_TENANT_CLAIM`). Most IdPs set it from a static claim or a user attribute.
2. Register the **UI** as a public single-page client with authorization code + PKCE:
   - Redirect URI and post-logout redirect URI: `https://<your LabRat host>/`.
   - Set `LDE_OIDC_UI_CLIENT_ID` to its client id.
   - Set `LDE_OIDC_UI_SCOPES` so the access token is issued for your API's audience. For Entra ID, include `api://<app id>/<scope>`.
   - Signing re-authenticates the user ([signatures.md](signatures.md)). The UI redirects to the provider with `prompt=login&max_age=0`, and the provider must then return an **ID token that contains `auth_time`** and the request's **`nonce`**, issued to this client. Without the `nonce`, every signature is refused as "not recent enough". Some providers make `auth_time` an optional claim that you have to enable. Check yours: if the token has no `auth_time`, every signature is refused with `401`. `LDE_SIGN_REAUTH_MAX_AGE` (default `120s`) sets how recent the login must be.
3. Allow CORS from the LabRat origin to the IdP's discovery and token endpoints. Most IdPs do this for SPA clients automatically.

The server fetches the issuer's discovery document at startup and refuses to start in prod without `LDE_OIDC_ISSUER` and `LDE_OIDC_AUDIENCE`. The UI keeps tokens in memory only. It signs out after `LDE_UI_IDLE_TIMEOUT` (default `15m`) without activity, and when a token expires.

## Create the first admin

Run this once per tenant, as the database owner (the server's `LDE_DATABASE_URL`):

```bash
labrat bootstrap-admin --tenant <tenant uuid> \
  --issuer https://login.example.com/ --subject <admin's sub claim> \
  --handle jdoe --display-name "J. Doe" --email jdoe@lab.example
```

It creates the tenant if it doesn't exist, then the human principal with `admin`, audited as `system:bootstrap-admin`, and prints the principal's id. It refuses once the tenant has an admin; from then on, admins work in the UI (**Principals**) or the API.

## Provision people and services

As an admin, in the UI's **Principals** tab or through the API:

```bash
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' $API/principals \
  -d '{"kind":"human","handle":"asmith","display_name":"A. Smith","issuer":"https://login.example.com/","subject":"00u8…","reason":"new starter"}'
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' $API/role-grants \
  -d '{"principal_id":"<id>","role":"scientist","reason":"joins the assay team"}'
```

`POST /v1/role-grants/{id}/revoke` and `POST /v1/principals/{id}/disable` take `{"reason": …}`. `GET /v1/me` shows who you are, what you hold and whether the tenant is in GxP mode (`tenant_gxp`).

## Display names and signing

A signature records the signer's **printed name**, which is their `display_name` at the moment they sign (21 CFR 11.50). A principal with a blank display name can't sign, so set one when you provision a person. An admin can correct it later, with a required non-blank name and a reason, in the UI (**Principals**, **Rename**) or through the API:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' $API/principals/<id> \
  -d '{"display_name":"Alice Ng","reason":"legal name"}'
```

It is audited as `principal.renamed`. Signatures already applied keep the name they were signed with. Handles and subjects can't be changed.

## Agents

An agent never acts on its own authority. An admin delegates a human to it (**Agent delegations**, or `POST /v1/agent-delegations {agent_id, human_id, reason}`). The agent then sends `X-LDE-On-Behalf-Of: <human handle>` with its own token, and:

- it holds only the roles that both it and that human hold;
- its changes are audited as `<human> via <agent>`;
- without the header, or without an active delegation from an enabled human, it gets `403`.

End a delegation with `POST /v1/agent-delegations/{id}/end {reason}`.

## Development mode

`LDE_ENV` has no default: the server refuses to start without it. With `LDE_ENV=dev`, the server trusts `X-LDE-Tenant` and `X-LDE-Actor` instead of tokens. An actor handle it hasn't seen is created with `scientist`, `reviewer`, `qa` and `admin`, audited as `system:dev-auth`, and every response carries `X-LDE-Auth: dev`. Its display name is its handle, and signing needs no re-authentication (the signature records `reauth_method = dev`). Never expose a dev server to anyone you wouldn't give admin. In prod those headers are ignored.
