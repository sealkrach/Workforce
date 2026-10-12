import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';

delete process.env.LLM_API_KEY;
const fake = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer sk-good') { res.writeHead(401); return res.end('bad key'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [] } : { model: 'fake-1', choices: [{ message: { content: 'ok' } }] }));
});
await new Promise(r => fake.listen(0, r));
const url = `http://localhost:${fake.address().port}/v1`;
const db = openDb(':memory:'); seed(db);
const app = createServer(buildApp(db)); await new Promise(r => app.listen(0, r));
const base = `http://localhost:${app.address().port}`;
const call = async (path, method = 'GET', body) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
test.after(() => { fake.close(); app.close(); });

test('démarre en mode local, puis test / enregistrement / ping / retour au mode local', async () => {
  assert.equal((await call('/api/llm')).enabled, false);
  assert.deepEqual(await call('/api/llm/ping'), { mode: 'mock' });

  const bad = await call('/api/llm/test', 'POST', { enabled: true, baseUrl: url, key: 'sk-bad', model: 'm' });
  assert.equal(bad.ok, false); assert.match(bad.error, /Clé API refusée/);
  const unreachable = await call('/api/llm/test', 'POST', { enabled: true, baseUrl: 'http://localhost:1/v1', key: 'x', model: 'm' });
  assert.equal(unreachable.ok, false); assert.match(unreachable.error, /Connexion impossible/);
  assert.equal((await call('/api/llm')).enabled, false, 'un test n\'enregistre rien');

  const good = await call('/api/llm/test', 'POST', { enabled: true, baseUrl: url, key: 'sk-good', model: 'fake-1' });
  assert.equal(good.ok, true); assert.ok(good.ms >= 0); assert.equal(good.model, 'fake-1');

  const saved = await call('/api/llm', 'POST', { enabled: true, baseUrl: url, key: 'sk-good', model: 'fake-1' });
  assert.equal(saved.enabled, true); assert.equal(saved.keyHint, 'good');
  const boot = JSON.stringify(await call('/api/bootstrap'));
  assert.ok(!boot.includes('sk-good'), 'la clé ne fuit pas vers le navigateur');
  const p = await call('/api/llm/ping'); assert.equal(p.ok, true);

  // clé laissée vide = clé conservée
  await call('/api/llm', 'POST', { enabled: true, baseUrl: url, key: '', model: 'fake-2' });
  assert.equal((await call('/api/llm/ping')).ok, true);

  assert.equal((await call('/api/llm', 'POST', { enabled: false, baseUrl: url })).enabled, false);
  assert.deepEqual(await call('/api/llm/ping'), { mode: 'mock' });
  assert.match((await call('/api/llm', 'POST', { enabled: true, baseUrl: 'ftp://x' })).error, /http/);
});
