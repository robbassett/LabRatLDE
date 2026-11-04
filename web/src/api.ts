// The only module that calls fetch. Types mirror the JSON the Go handlers in
// internal/api emit; optional fields are the ones with omitempty.

const TENANT_KEY = 'labrat.tenant';
const ACTOR_KEY = 'labrat.actor';

export const DEV_TENANT = '00000000-0000-4000-8000-000000000001';

export type Page<T> = { items: T[]; next_cursor: string | null };

export type OIDCSettings = { issuer: string; client_id: string; scopes: string };

export type Meta = { env: 'dev' | 'prod'; idle_timeout_seconds: number; oidc?: OIDCSettings };

export type PrincipalKind = 'human' | 'service' | 'agent';

export type Role = 'scientist' | 'reviewer' | 'qa' | 'admin' | 'schema_steward';

export const TENANT_ROLES: Role[] = ['scientist', 'reviewer', 'qa', 'admin'];

export type RoleGrant = {
  id: string;
  principal_id: string;
  role: Role;
  scope: string | null;
  reason: string;
  granted_by: string;
  granted_at: string;
  revoked_by: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
};

export type Principal = {
  id: string;
  tenant_id: string;
  kind: PrincipalKind;
  handle: string;
  display_name: string;
  email: string;
  issuer: string;
  subject: string;
  enabled: boolean;
  created_at: string;
  roles: RoleGrant[];
};

export type Me = Principal & {
  actor: string;
  on_behalf_of: string | null;
  auth: 'dev' | 'oidc';
  tenant_gxp: boolean;
};

export type Delegation = {
  id: string;
  agent_id: string;
  human_id: string;
  agent_handle: string;
  human_handle: string;
  reason: string;
  created_by: string;
  created_at: string;
};

export type NewPrincipal = {
  kind: PrincipalKind;
  handle: string;
  display_name: string;
  email: string;
  issuer: string;
  subject: string;
  reason: string;
};

export type ExperimentSummary = { id: string; slug: string; title: string; created_at: string };

// PolicyStep is one step of a signing policy (SPEC-008-R05).
export type PolicyStep = { step: number; meaning: string; role: Role };

// Signature mirrors domain.Signature. It is valid until a committed correction invalidates it.
export type Signature = {
  id: string;
  step: number;
  meaning: string;
  signer: string;
  printed_name: string;
  signed_at: string;
  manifest_sha256: string;
  comment: string | null;
  reauth_method: string;
  valid: boolean;
  invalidated_at: string | null;
  invalidated_by_change_set: string | null;
  invalidated_reason: string | null;
};

export type Experiment = {
  id: string;
  slug: string;
  title: string;
  protocol_version_id: string;
  protocol_version: number;
  protocol_sha256: string;
  protocol_md: string;
  protocol_meta: unknown;
  signing_policy: PolicyStep[];
  created_by: string;
  created_at: string;
};

export type ProtocolVersion = {
  id: string;
  experiment_id: string;
  version: number;
  sha256: string;
  node_id: string;
  created_by: string;
  created_at: string;
  protocol_md?: string;
  protocol_meta?: unknown;
};

export type RunState = 'planned' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted' | 'signed';

export type RunSummary = {
  id: string;
  label: string;
  state: RunState;
  created_at: string;
  signing_policy: PolicyStep[];
  signatures: Signature[];
};

export type Run = {
  id: string;
  tenant_id: string;
  experiment_id: string;
  protocol_version_id: string;
  node_id: string;
  state: RunState;
  params: unknown;
  signing_policy: PolicyStep[];
  signatures: Signature[];
  started_at?: string;
  finished_at?: string;
  created_by: string;
  created_at: string;
};

export type RunInput = { node_id: string; kind: NodeKind; label: string };

export type RunDataset = { node_id: string; label: string; count: number | null; sha256: string | null };

export type RunDetail = Run & {
  protocol_version: number;
  protocol_sha256: string;
  inputs: RunInput[];
  datasets: RunDataset[];
};

// RunManifest is GET /v1/runs/{id}/manifest. manifest is the canonical JSON text that sha256 covers;
// previous and changes describe the latest valid signature, if any (SPEC-008-R02, R19).
export type RunManifest = {
  manifest: string;
  sha256: string;
  previous: { step: number; sha256: string } | null;
  changes: Change[];
};

// SignoffItem is a run waiting for the caller's signature (SPEC-008-R05).
export type SignoffItem = {
  run_id: string;
  label: string;
  experiment_id: string;
  experiment_title: string;
  state: RunState;
  step: number;
  meaning: string;
  finished_at: string;
};

export type Instrument = {
  id: string;
  node_id: string;
  name: string;
  kind: string;
  attrs: Record<string, unknown>;
  created_at: string;
};

export type NodeKind = 'sample' | 'reagent' | 'protocol' | 'run' | 'instrument' | 'dataset' | 'analysis';

export type Relation = 'used' | 'wasGeneratedBy' | 'wasDerivedFrom' | 'wasInformedBy' | 'wasAssociatedWith' | 'wasAttributedTo';

export type LineageNode = {
  id: string;
  kind: NodeKind;
  label: string;
  attrs?: Record<string, unknown>;
  created_at: string;
};

export type LineageEdge = { from: string; to: string; relation: Relation };

// edges is null when the subgraph has no edges (Go nil slice).
export type Lineage = { root: string; nodes: LineageNode[]; edges: LineageEdge[] | null };

export type LineageDirection = 'upstream' | 'downstream' | 'both';

export type AuditEvent = {
  tenant_id: string;
  seq: number;
  occurred_at: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
  reason?: string;
  payload: unknown;
  prev_hash: string;
  hash: string;
};

export type AuditReport = {
  valid: boolean;
  events: number;
  head: { seq: number; hash: string };
  break?: { seq: number; reason: string };
};

export type AuditVerify = {
  valid: boolean;
  engine: AuditReport;
  database: { events: number; head_seq: number; head_hash: string; broken_at?: number };
  agree: boolean;
};

export type RecordType = 'lineage_node' | 'run' | 'experiment' | 'note';

// Revision is one saved value of a record. Value holds the record's revisable fields.
export type Revision = {
  rev: number;
  value: Record<string, unknown>;
  author: string;
  reason: string;
  change_set_id: string | null;
  created_at: string;
};

// Change is one difference between two revisions. Path is a JSON path from "$".
export type Change = {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: unknown;
  to?: unknown;
};

export type BlameEntry = { path: string; rev: number; author: string; at: string };

export type EditResult = { change_set_id: string; rev: number };

export type Note = {
  id: string;
  node_id: string;
  body: string;
  annotation: boolean;
  created_by: string;
  created_at: string;
  rev: number;
};

// ChangeItem is one edit in a change set, keyed on op (SPEC-007 design §2).
export type ChangeItem =
  | { op: 'update_node'; node_id: string; label?: string; attrs?: Record<string, unknown> }
  | { op: 'update_run_params'; run_id: string; params: Record<string, unknown> }
  | { op: 'set_experiment_title'; experiment_id: string; title: string }
  | { op: 'add_node'; kind: NodeKind; label: string; attrs?: Record<string, unknown> }
  | { op: 'add_edge'; from: string; to: string; relation: Relation }
  | { op: 'add_note'; node_id: string; body: string }
  | { op: 'edit_note'; note_id: string; body: string };

export type ChangeSetState = 'proposed' | 'committed' | 'rejected' | 'withdrawn';

export type ChangeSetSource = 'human' | 'parser' | 'agent';

export type ChangeSet = {
  id: string;
  title: string;
  reason: string;
  source: ChangeSetSource;
  author: string;
  state: ChangeSetState;
  items: ChangeItem[];
  items_sha256: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
};

// ChangeSetDetail's current holds, per item, the target's latest revision value (or null).
// invalidates lists the runs whose valid signatures a commit would invalidate (SPEC-008-R10).
export type ChangeSetDetail = ChangeSet & {
  current: unknown[];
  invalidates: { run_id: string; signatures: number }[];
};

// ChangeSetSummary is a change set in a list, with the item count.
export type ChangeSetSummary = {
  id: string;
  title: string;
  reason: string;
  source: ChangeSetSource;
  author: string;
  state: ChangeSetState;
  items: number;
  created_at: string;
};

// stored reads a session key, tolerating storage that is disabled or throws.
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storedActor(): string | null {
  return stored(ACTOR_KEY);
}

export function setSession(tenant: string, actor: string): void {
  try {
    localStorage.setItem(TENANT_KEY, tenant);
    localStorage.setItem(ACTOR_KEY, actor);
  } catch {
    // Storage unavailable: the header-less request will fail with a clear error.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TENANT_KEY);
    localStorage.removeItem(ACTOR_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

// The OIDC access token lives in memory only (SPEC-006 design §3): a reload
// signs in again.
let accessToken: string | null = null;
let onUnauthorized: () => void = () => {};

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

// setUnauthorizedHandler registers what to do when the server rejects the
// credentials (an expired token): App returns to sign-in.
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

// ApiError is a failed request: the server's message, and its HTTP status.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  } else {
    const tenant = stored(TENANT_KEY);
    const actor = stored(ACTOR_KEY);
    if (tenant) headers['X-LDE-Tenant'] = tenant;
    if (actor) headers['X-LDE-Actor'] = actor;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && path !== '/v1/meta') onUnauthorized();
  if (!res.ok) {
    let msg: string | undefined;
    try {
      const body = await res.json();
      msg = body?.error;
    } catch {
      // Not JSON: fall back to the status code.
    }
    throw new ApiError(msg ?? String(res.status), res.status);
  }
  return res.json() as Promise<T>;
}

function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

// qs builds a query string from the defined, non-empty params.
function qs(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function meta(): Promise<Meta> {
  return get('/v1/meta');
}

export function listExperiments(cursor?: string): Promise<Page<ExperimentSummary>> {
  return get(`/v1/experiments${qs({ cursor })}`);
}

export function getExperiment(id: string): Promise<Experiment> {
  return get(`/v1/experiments/${encodeURIComponent(id)}`);
}

export function listProtocolVersions(experimentId: string): Promise<ProtocolVersion[]> {
  return get(`/v1/experiments/${encodeURIComponent(experimentId)}/protocol-versions`);
}

export function getProtocolVersion(id: string): Promise<ProtocolVersion> {
  return get(`/v1/protocol-versions/${encodeURIComponent(id)}`);
}

export function listRuns(experimentId: string, cursor?: string): Promise<Page<RunSummary>> {
  return get(`/v1/experiments/${encodeURIComponent(experimentId)}/runs${qs({ cursor })}`);
}

export function getRun(id: string): Promise<RunDetail> {
  return get(`/v1/runs/${encodeURIComponent(id)}`);
}

export function listInstruments(cursor?: string): Promise<Page<Instrument>> {
  return get(`/v1/instruments${qs({ cursor })}`);
}

export function getLineage(id: string, direction: LineageDirection): Promise<Lineage> {
  return get(`/v1/lineage/${encodeURIComponent(id)}${qs({ direction })}`);
}

export function listAuditEvents(after: number, entityType?: string, entityId?: string): Promise<AuditEvent[]> {
  const filter = entityType && entityId ? { entity_type: entityType, entity_id: entityId } : {};
  return get(`/v1/audit/events${qs({ after: String(after), limit: '100', ...filter })}`);
}

export function verifyAudit(): Promise<AuditVerify> {
  return get('/v1/audit/verify');
}

export function getMe(): Promise<Me> {
  return get('/v1/me');
}

export function listPrincipals(cursor?: string): Promise<Page<Principal>> {
  return get(`/v1/principals${qs({ cursor, limit: '200' })}`);
}

export function createPrincipal(p: NewPrincipal): Promise<Principal> {
  return post('/v1/principals', p);
}

export function disablePrincipal(id: string, reason: string): Promise<Principal> {
  return post(`/v1/principals/${encodeURIComponent(id)}/disable`, { reason });
}

export function grantRole(principalId: string, role: Role, reason: string, scope = ''): Promise<RoleGrant> {
  return post('/v1/role-grants', { principal_id: principalId, role, scope, reason });
}

export function revokeRole(grantId: string, reason: string): Promise<RoleGrant> {
  return post(`/v1/role-grants/${encodeURIComponent(grantId)}/revoke`, { reason });
}

export function listDelegations(): Promise<{ items: Delegation[] }> {
  return get('/v1/agent-delegations');
}

export function createDelegation(agentId: string, humanId: string, reason: string): Promise<Delegation> {
  return post('/v1/agent-delegations', { agent_id: agentId, human_id: humanId, reason });
}

export function endDelegation(id: string, reason: string): Promise<Delegation> {
  return post(`/v1/agent-delegations/${encodeURIComponent(id)}/end`, { reason });
}

export function editNode(
  id: string,
  edit: { label?: string; attrs?: Record<string, unknown> },
  reason: string,
): Promise<EditResult> {
  return patch(`/v1/lineage/nodes/${encodeURIComponent(id)}`, { ...edit, reason });
}

export function editRunParams(id: string, params: Record<string, unknown>, reason: string): Promise<EditResult> {
  return patch(`/v1/runs/${encodeURIComponent(id)}/params`, { params, reason });
}

export function editExperimentTitle(id: string, title: string, reason: string): Promise<EditResult> {
  return patch(`/v1/experiments/${encodeURIComponent(id)}`, { title, reason });
}

export function editNote(id: string, body: string, reason: string): Promise<EditResult> {
  return patch(`/v1/notes/${encodeURIComponent(id)}`, { body, reason });
}

export function listNotes(nodeId: string): Promise<{ items: Note[] }> {
  return get(`/v1/lineage/nodes/${encodeURIComponent(nodeId)}/notes`);
}

export function addNote(nodeId: string, body: string): Promise<Note> {
  return post(`/v1/lineage/nodes/${encodeURIComponent(nodeId)}/notes`, { body });
}

export function listRevisions(type: RecordType, id: string): Promise<{ items: Revision[] }> {
  return get(`/v1/records/${type}/${encodeURIComponent(id)}/revisions`);
}

export function diffRevisions(
  type: RecordType,
  id: string,
  from: number,
  to: number,
): Promise<{ from: number; to: number; changes: Change[] }> {
  return get(`/v1/records/${type}/${encodeURIComponent(id)}/diff${qs({ from: String(from), to: String(to) })}`);
}

export function blame(type: RecordType, id: string): Promise<{ rev: number; fields: BlameEntry[] }> {
  return get(`/v1/records/${type}/${encodeURIComponent(id)}/blame`);
}

export function listChangeSets(
  filter: { state?: ChangeSetState; source?: ChangeSetSource; cursor?: string } = {},
): Promise<Page<ChangeSetSummary>> {
  return get(`/v1/change-sets${qs(filter)}`);
}

export function getChangeSet(id: string): Promise<ChangeSetDetail> {
  return get(`/v1/change-sets/${encodeURIComponent(id)}`);
}

export function proposeChangeSet(title: string, reason: string, items: ChangeItem[]): Promise<ChangeSet> {
  return post('/v1/change-sets', { title, reason, items });
}

// A commit carries itemsSha256, the hash of the items the reviewer read (SPEC-008-R20).
export function decideChangeSet(
  id: string,
  decision: 'commit' | 'reject' | 'withdraw',
  reason: string,
  itemsSha256?: string,
): Promise<ChangeSet> {
  return post(`/v1/change-sets/${encodeURIComponent(id)}/${decision}`, { reason, items_sha256: itemsSha256 });
}

export function getManifest(runId: string): Promise<RunManifest> {
  return get(`/v1/runs/${encodeURIComponent(runId)}/manifest`);
}

// signRun applies the next policy step. manifestSha256 is the hash the signer saw; reauthToken is the
// fresh ID token in prod and omitted in dev.
export function signRun(
  runId: string,
  req: { step: number; meaning: string; manifest_sha256: string; comment?: string; reauth_token?: string },
): Promise<Signature> {
  return post(`/v1/runs/${encodeURIComponent(runId)}/signatures`, req);
}

export function listSignoff(cursor?: string): Promise<Page<SignoffItem>> {
  return get(`/v1/inbox/signatures${qs({ cursor })}`);
}

export function setSigningPolicy(experimentId: string, policy: PolicyStep[], reason: string): Promise<EditResult> {
  return patch(`/v1/experiments/${encodeURIComponent(experimentId)}/signing-policy`, { signing_policy: policy, reason });
}

export function renamePrincipal(id: string, displayName: string, reason: string): Promise<Principal> {
  return patch(`/v1/principals/${encodeURIComponent(id)}`, { display_name: displayName, reason });
}
