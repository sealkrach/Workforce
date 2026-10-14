import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { McpClient, McpError, McpAuthError, McpToolError } from '../server/mcp-client.js';
import { startFakeSmartuc } from './helpers/fake-smartuc.js';

test('JSON simple : poignée de main, session, outils, appel d’outil', async () => {
  const s = await startFakeSmartuc(); const c = new McpClient({ url: s.url, key: s.key });
  try {
    assert.equal((await c.connect()).name, 'UseCase Hub'); assert.ok(c.sessionId);
    assert.deepEqual((await c.listTools()).map(t => t.name).slice(0, 2), ['list_use_cases', 'get_use_case']);
    const rows = await c.callTool('list_use_cases', { limit: 3 }); assert.equal(rows.length, 3); assert.match(rows[0].ref, /^UC-\d+$/);
    await c.close(); assert.equal(s.sessions.size, 0, 'session fermée côté serveur');
  } finally { await s.close(); }
});

test('flux SSE : le message portant notre id est retenu', async () => {
  const s = await startFakeSmartuc({ sse: true }); const c = new McpClient({ url: s.url, key: s.key });
  try { await c.connect(); assert.equal((await c.callTool('list_use_cases', { limit: 2 })).length, 2); } finally { await c.close(); await s.close(); }
});

test('session expirée (404) : une reconnexion transparente, une seule', async () => {
  const s = await startFakeSmartuc(); const c = new McpClient({ url: s.url, key: s.key });
  try {
    await c.connect(); const first = c.sessionId; s.expireNext = true;
    assert.equal((await c.callTool('list_use_cases', { limit: 1 })).length, 1);
    assert.notEqual(c.sessionId, first, 'nouvelle session');
  } finally { await c.close(); await s.close(); }
});

test('erreurs lisibles : clé refusée, outil en échec, serveur injoignable, URL invalide', async () => {
  const s = await startFakeSmartuc();
  try {
    await assert.rejects(() => new McpClient({ url: s.url, key: 'uch_mauvaise' }).connect(), e => e instanceof McpAuthError && /refusée/.test(e.message));
    const c = new McpClient({ url: s.url, key: s.key }); await c.connect();
    await assert.rejects(() => c.callTool('get_use_case', { ref: 'UC-9999' }), e => e instanceof McpToolError && /404/.test(e.message));
    await assert.rejects(() => c.callTool('outil_inconnu'), McpToolError); await c.close();
  } finally { await s.close(); }
  await assert.rejects(() => new McpClient({ url: 'http://127.0.0.1:9/mcp', key: 'k' }).connect(), e => e instanceof McpError && e.code === 'network');
  assert.throws(() => new McpClient({ url: 'ftp://x' }), /URL MCP invalide/);
});

test('une redirection est refusée : la clé ne part jamais vers une autre adresse', async () => {
  const seen = [];
  const evil = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(200); res.end('{}'); });
  await new Promise(r => evil.listen(0, '127.0.0.1', r));
  const redirector = createServer((req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${evil.address().port}/steal` }); res.end(); });
  await new Promise(r => redirector.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(() => new McpClient({ url: `http://127.0.0.1:${redirector.address().port}/mcp`, key: 'uch_secret' }).connect(), e => e.code === 'redirect' && /redirige/.test(e.message));
    assert.deepEqual(seen, [], 'rien n’a été envoyé à l’adresse de destination');
  } finally { evil.close(); redirector.close(); }
});

test('délai dépassé : erreur claire, pas de blocage', async () => {
  const slow = createServer(() => { /* ne répond jamais */ });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  try { await assert.rejects(() => new McpClient({ url: `http://127.0.0.1:${slow.address().port}/mcp`, key: 'k', timeoutMs: 300 }).connect(), e => e.code === 'network' && /Délai dépassé/.test(e.message)); }
  finally { slow.closeAllConnections?.(); slow.close(); }
});
