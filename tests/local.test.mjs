import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openLocalStore } from '../lib/local-store.mjs';
import { createLocalHandler } from '../local/handler.mjs';
import { makePasswordHash, totpCode } from '../local/auth.mjs';
import { supabase } from '../lib/supabase.mjs';

test('local PC server owns login, MFA, settings and worker storage', async () => {
  const store = await openLocalStore('memory://');
  const password = 'a-long-test-password';
  const { salt, hash } = await makePasswordHash(password);
  const userId = randomUUID();
  await store.run(db => db.query(`insert into app_owner(singleton,user_id,email,password_salt,password_hash)
    values(true,$1,$2,$3,$4)`, [userId, 'owner@example.com', salt, hash]));
  const env = { PORT: 0, LOCAL_WORKER_TOKEN: 'test-worker-token' };
  const server = http.createServer(createLocalHandler(store, env));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  env.PORT = server.address().port;
  const request = async (route, { method = 'GET', body, cookie, workerToken, originHeader = origin } = {}) => {
    const response = await fetch(origin + route, { method, headers: {
      ...(method === 'GET' ? {} : { Origin: originHeader, 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(workerToken ? { 'x-worker-token': workerToken } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  try {
    assert.equal((await request('/api/session')).status, 401);
    assert.equal((await request('/internal/task_settings?select=*')).status, 403);
    assert.equal((await request('/api/login', { method: 'POST', body: { email: 'owner@example.com', password }, originHeader: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/login', { method: 'POST', body: { email: 'owner@example.com', password: 'wrong' } })).status, 401);
    const login = await request('/api/login', { method: 'POST', body: { email: 'owner@example.com', password } });
    assert.equal(login.status, 200);
    assert.match(login.cookie, /^trade_session=/);
    assert.equal((await request('/api/dashboard', { cookie: login.cookie })).status, 403);
    assert.equal((await request('/api/session', { cookie: login.cookie })).data.aal, 'aal1');
    const enrolled = await request('/api/mfa/enroll', { method: 'POST', body: {}, cookie: login.cookie });
    assert.equal(enrolled.status, 200);
    assert.ok(enrolled.data.secret);
    assert.equal((await request('/api/mfa/verify', { method: 'POST', body: { factor_id: 'totp', code: '000000' }, cookie: login.cookie })).status, 400);
    assert.equal((await request('/api/mfa/verify', { method: 'POST', body: { factor_id: 'totp', code: totpCode(enrolled.data.secret) }, cookie: login.cookie })).status, 200);
    assert.equal((await request('/api/session', { cookie: login.cookie })).data.aal, 'aal2');
    const dashboard = await request('/api/dashboard', { cookie: login.cookie });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.settings.length, 4);
    const models = [{ id: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
    assert.equal((await request('/internal/worker_status', { method: 'POST', workerToken: env.LOCAL_WORKER_TOKEN,
      body: { worker_id: 'test', updated_at: new Date().toISOString(), settings_versions: {}, models,
        models_at: new Date().toISOString(), rate_limits: null, rate_limits_at: null,
        state: 'idle', current_job: null, error: null } })).status, 200);
    const changed = await request('/api/settings', { method: 'PUT', cookie: login.cookie,
      body: { task_key: 'kr_trade', model: 'gpt-6-sol', effort: 'medium', enabled: true, version: 1 } });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.version, 2);
    assert.equal((await request('/api/settings', { method: 'PUT', cookie: login.cookie,
      body: { task_key: 'kr_trade', model: 'gpt-6-sol', effort: 'medium', enabled: true, version: 1 } })).status, 409);
    assert.equal((await request('/api/dashboard', { cookie: login.cookie })).data.audit.length, 1);
    const workerApi = supabase({ LOCAL_CONTROL_URL: origin, LOCAL_WORKER_TOKEN: env.LOCAL_WORKER_TOKEN }, fetch, true);
    assert.equal((await workerApi('/rest/v1/task_settings?select=*')).length, 4);
    await workerApi('/rest/v1/task_runs?on_conflict=id', { method: 'POST', body: {
      id: randomUUID(), job_id: 'example-job', task_key: 'kr_trade', cohort: 'A', config_version: 2,
      model: 'gpt-6-sol', effort: 'medium', status: 'completed', input_tokens: 100,
      cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10,
      total_tokens: 130, duration_ms: 2000, error: null,
      created_at: new Date().toISOString(), finished_at: new Date().toISOString()
    } });
    await workerApi('/rest/v1/paper_accounts?on_conflict=market,cohort', { method: 'POST', body: {
      market: 'kr', cohort: 'A', cash: 9000000, equity: 10000000, positions: [], updated_at: new Date().toISOString()
    } });
    await workerApi('/rest/v1/paper_trades?on_conflict=id', { method: 'POST', body: {
      id: randomUUID(), job_id: 'example-job', market: 'kr', cohort: 'A', symbol: '005930', side: 'BUY',
      quantity: 1, price: 1000000, fee: 100, as_of: new Date().toISOString(), source: 'fixture', reason: 'test'
    } });
    const populated = (await request('/api/dashboard', { cookie: login.cookie })).data;
    assert.equal(populated.totals.total_tokens, 130);
    assert.equal(populated.accounts.length, 1);
    assert.equal(populated.trades.length, 1);
    assert.equal((await request('/api/logout', { method: 'POST', body: {}, cookie: login.cookie })).status, 200);
    assert.equal((await request('/api/session', { cookie: login.cookie })).status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await store.close();
  }
});

test('embedded database persists settings after closing and reopening', async () => {
  const parent = path.resolve('.runtime/tests');
  await fs.mkdir(parent, { recursive: true });
  const dir = await fs.mkdtemp(path.join(parent, 'pglite-'));
  assert.equal(path.dirname(dir), parent);
  try {
    const firstStore = await openLocalStore(dir);
    try {
      await firstStore.run(db => db.query("update task_settings set model='persistence-check',version=4 where task_key='kr_trade'"));
    } finally { await firstStore.close(); }
    const secondStore = await openLocalStore(dir);
    try {
      const row = await secondStore.run(db => db.query("select model,version from task_settings where task_key='kr_trade'"));
      assert.equal(row.rows[0].model, 'persistence-check');
      assert.equal(row.rows[0].version, 4);
    } finally { await secondStore.close(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
