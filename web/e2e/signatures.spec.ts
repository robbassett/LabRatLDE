import { expect, test, type APIRequestContext } from '@playwright/test';

const TENANT = '00000000-0000-4000-8000-000000000001';

// call sends a dev-header request as actor and returns the JSON body, failing on an unexpected status.
async function call<T>(
  request: APIRequestContext,
  actor: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  want: number,
  data?: unknown,
): Promise<T> {
  const res = await request.fetch(path, { method, headers: { 'X-LDE-Tenant': TENANT, 'X-LDE-Actor': actor }, data });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(want);
  return (await res.json()) as T;
}

// SPEC-008-R12
test('signatures panel shows who signed what and when, and marks them invalidated after a correction', async ({ page, request }) => {
  const id = Date.now().toString(36);
  const admin = `admin-${id}`;
  const alice = `alice-${id}`;
  const bob = `bob-${id}`;

  // A new dev handle holds every role, so it acts as the admin. Alice and bob get only the fixture's roles.
  for (const [handle, name, role] of [
    [alice, 'Alice Ng', 'scientist'],
    [bob, 'Bob Ortiz', 'reviewer'],
  ]) {
    const p = await call<{ id: string }>(request, admin, 'POST', '/v1/principals', 201, {
      kind: 'human',
      handle,
      display_name: name,
      email: '',
      issuer: 'dev',
      subject: handle,
      reason: 'e2e fixture',
    });
    await call(request, admin, 'POST', '/v1/role-grants', 201, { principal_id: p.id, role, scope: '', reason: 'e2e fixture' });
  }

  const exp = await call<{ id: string }>(request, alice, 'POST', '/v1/experiments', 201, {
    slug: `sig-${id}`,
    title: `Signatures ${id}`,
    protocol_md: '# Protocol\n',
  });
  const run = await call<{ id: string }>(request, alice, 'POST', '/v1/runs', 201, {
    experiment_id: exp.id,
    label: `run-${id}`,
    params: { anneal_temp_c: 60 },
  });
  for (const to of ['running', 'completed']) {
    await call(request, alice, 'POST', `/v1/runs/${run.id}/transitions`, 200, { to });
  }

  const sign = async (actor: string, step: number, meaning: string) => {
    const m = await call<{ sha256: string }>(request, actor, 'GET', `/v1/runs/${run.id}/manifest`, 200);
    await call(request, actor, 'POST', `/v1/runs/${run.id}/signatures`, 201, { step, meaning, manifest_sha256: m.sha256 });
  };
  await sign(alice, 1, 'author');
  await sign(bob, 2, 'review');

  await page.goto('/');
  await page.getByLabel('Handle').fill(bob);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.goto(`/#/run/${run.id}`);

  const panel = page.getByRole('region', { name: 'Signatures' });
  await expect(panel.getByText('Alice Ng')).toBeVisible();
  await expect(panel.getByText('author', { exact: true })).toBeVisible();
  await expect(panel.getByText('Bob Ortiz')).toBeVisible();
  await expect(panel.getByText('review', { exact: true })).toBeVisible();
  await expect(panel.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/).first()).toBeVisible();

  // Alice proposes a correction and bob commits it, which invalidates both signatures.
  const cs = await call<{ id: string; items_sha256: string }>(request, alice, 'POST', '/v1/change-sets', 201, {
    title: 'Fix anneal temperature',
    reason: 'transcription error',
    items: [{ op: 'update_run_params', run_id: run.id, params: { anneal_temp_c: 62 } }],
  });
  await call(request, bob, 'POST', `/v1/change-sets/${cs.id}/commit`, 200, {
    reason: 'transcription error',
    items_sha256: cs.items_sha256,
  });

  await page.reload();
  await expect(panel.locator('s')).toHaveCount(2);
  await expect(panel.getByText(/Invalidated by change set .*: transcription error/)).toHaveCount(2);
});
