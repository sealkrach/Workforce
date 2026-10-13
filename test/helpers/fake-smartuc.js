// Faux serveur MCP « SmartUC » alimenté par de VRAIES réponses capturées (test/fixtures/smartuc), modifiables pendant un test.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const fx = n => JSON.parse(readFileSync(new URL(`../fixtures/smartuc/${n}.json`, import.meta.url), 'utf8'));
export const DETAILED = ['UC-0002', 'UC-0004', 'UC-0018', 'UC-0025'];

export async function startFakeSmartuc({ key = 'uch_testkey', sse = false, role = 'reviewer' } = {}) {
  const s = {
    key, sse, role, rows: fx('list'), details: Object.fromEntries(DETAILED.map(r => [r, fx(r)])), rels: Object.fromEntries(DETAILED.map(r => [r, fx(r + '.relations')])),
    calls: [], seen: [], sessions: new Set(), expireNext: false, down: false, rest: 0,
  };
  s.calls_of = name => s.calls.filter(c => c === name).length;
  s.set = (ref, patch) => {                       // change un UC comme le ferait SmartUC (statut, tier…) et avance updated_at
    const stamp = new Date(Date.now() + s.calls.length + 1000).toISOString();
    for (const r of s.rows) if (r.ref === ref) Object.assign(r, patch, { updated_at: stamp });
    if (s.details[ref]) Object.assign(s.details[ref], patch, { updated_at: stamp });
  };
  const server = createServer(async (req, res) => {
    if (s.down) { res.destroy(); return; }
    const url = new URL(req.url, 'http://x');
    s.seen.push(req.headers.authorization);
    const auth = req.headers.authorization === `Bearer ${s.key}`;
    if (url.pathname === '/api/auth/me') { s.rest++; if (!auth) { res.writeHead(401); return res.end(); } res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ role: s.role, full_name: 'Service WorkForce', email: 'wf@example.com' })); }
    if (url.pathname === '/moved') { res.writeHead(307, { Location: '/mcp' }); return res.end(); }
    if (url.pathname !== '/mcp') { res.writeHead(404); return res.end(); }
    if (!auth) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    if (req.method === 'DELETE') { s.sessions.delete(req.headers['mcp-session-id']); res.writeHead(200); return res.end(); }
    let raw = ''; for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    const reply = (result, headers = {}) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (s.sse) { res.writeHead(200, { 'content-type': 'text/event-stream', ...headers }); res.end(`event: message\ndata: ${body}\n\n`); }
      else { res.writeHead(200, { 'content-type': 'application/json', ...headers }); res.end(body); }
    };
    if (msg.method === 'initialize') { const id = 'sess-' + Math.random().toString(36).slice(2); s.sessions.add(id); return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'UseCase Hub', version: 'fake' } }, { 'mcp-session-id': id }); }
    if (!s.sessions.has(req.headers['mcp-session-id']) || s.expireNext) { s.expireNext = false; s.sessions.clear(); res.writeHead(404); return res.end(); }
    if (msg.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
    if (msg.method === 'tools/list') return reply({ tools: ['list_use_cases', 'get_use_case', 'list_relations', 'search_similar'].map(name => ({ name })) });
    if (msg.method === 'tools/call') {
      const { name, arguments: a = {} } = msg.params; s.calls.push(name);
      const ok = v => reply({ content: [{ type: 'text', text: JSON.stringify(v) }] });
      const err = t => reply({ isError: true, content: [{ type: 'text', text: t }] });
      if (name === 'list_use_cases') return ok(s.rows.slice(0, a.limit ?? 50));
      if (name === 'get_use_case') return s.details[a.ref] ? ok(s.details[a.ref]) : err('Error executing tool get_use_case: 404: Use case not found');
      if (name === 'list_relations') return ok(s.rels[a.ref] || []);
      return err(`Unknown tool: ${name}`);
    }
    return reply({});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  s.origin = `http://127.0.0.1:${server.address().port}`; s.url = `${s.origin}/mcp`;
  s.close = () => new Promise(r => { server.closeAllConnections?.(); server.close(r); });
  return s;
}
