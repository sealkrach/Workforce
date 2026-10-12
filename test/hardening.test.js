// Défauts relevés par la relecture (technique + produit) : chacun a ici son test de non-régression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';
import { isRealDate, localDate, parseDateFr } from '../server/util.js';

delete process.env.LLM_API_KEY;
const db = openDb(':memory:'); seed(db);
const srv = createServer(buildApp(db)); await new Promise(r => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const id = n => db.prepare('SELECT id FROM members WHERE name LIKE ?').get(n + '%').id;
const camille = id('Camille');
const call = async (path, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': String(camille), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, ...data };
};
test.after(() => srv.close());

test('une URL statique absente renvoie 404 sans arrêter le serveur', async () => {
  for (const p of ['/robots.txt', '/apple-touch-icon.png', '/missing.css', '/%2e%2e/server/db.js', '/app.js/..%2f..%2fREADME.md']) {
    const r = await fetch(base + p); assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
  }
  assert.equal((await call('/api/health')).status, 200, 'le serveur est toujours vivant');
  const page = await fetch(base + '/'); assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('l\'API refuse les valeurs invalides au lieu de les stocker', async () => {
  const bad = async (path, method, body, re) => { const r = await call(path, method, body); assert.equal(r.status, 400, `${method} ${path} ${JSON.stringify(body)} → ${r.status}`); if (re) assert.match(r.error, re); };
  await bad('/api/tasks/1', 'PATCH', { status: 'nimportequoi' }, /Statut invalide/);
  await bad('/api/tasks/1', 'PATCH', { priority: 'zzz' }, /Priorité invalide/);
  await bad('/api/tasks/1', 'PATCH', { due_date: 'demain' }, /Date invalide/);
  await bad('/api/tasks/1', 'PATCH', { due_date: '2026-02-31' }, /Date invalide/);
  await bad('/api/tasks/1', 'PATCH', { estimate_h: 'beaucoup' }, /Estimation/);
  await bad('/api/tasks/1', 'PATCH', { labels: 'abc' }, /liste/);
  await bad('/api/tasks/1', 'PATCH', { assignee_id: 9999 }, /Personne introuvable/);
  await bad('/api/tasks/1', 'PATCH', { feature_id: 9999 }, /Feature introuvable/);
  await bad('/api/tasks', 'POST', { title: '   ' }, /titre/);
  await bad('/api/tasks', 'POST', { title: 'x'.repeat(201) }, /trop long/);
  await bad('/api/links', 'POST', { from_id: 1, to_id: 1, type: 'blocks' }, /elle-même/);
  await bad('/api/links', 'POST', { from_id: 1, to_id: 2, type: 'nimporte' }, /Type de lien/);
  await bad('/api/tasks', 'POST', '{oops', /JSON/);
  const t = db.prepare('SELECT status, priority, due_date FROM tasks WHERE id = 1').get();
  assert.ok(['todo', 'doing', 'review', 'done'].includes(t.status) && t.priority !== 'zzz', 'rien n\'a été écrit');
  const n = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  const bad2 = await call('/api/tasks', 'POST', { title: 'ok', labels: 'abc' }); assert.equal(bad2.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, n, 'aucune ligne à moitié écrite');
});

test('limites de taille, type de contenu et origine', async () => {
  assert.equal((await call('/api/tasks', 'POST', { title: 'gros', description: 'x'.repeat(1_100_000) })).status, 413);
  assert.equal((await call('/api/tasks', 'POST', JSON.stringify({ title: 'csrf' }), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call('/api/tasks', 'POST', { title: 'csrf' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/tasks', 'POST', { title: 'ok même origine' }, { origin: base })).status, 200);
  assert.equal((await call('/api/chat', 'POST', { message: 'a'.repeat(4001) })).status, 400);
  assert.equal((await call('/api/chat', 'POST', { message: 'Il faut tester', history: 'pas un tableau' })).status, 200);
});

test('la clé LLM enregistrée n\'est jamais envoyée vers une autre URL', async () => {
  const seen = [];
  const mk = name => createServer((req, res) => { seen.push([name, req.headers.authorization]); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [], model: 'x', choices: [{ message: { content: 'ok' } }] })); });
  const a = mk('A'), b = mk('B');
  await Promise.all([a, b].map(s => new Promise(r => s.listen(0, r))));
  const urlA = `http://localhost:${a.address().port}/v1`, urlB = `http://localhost:${b.address().port}/v1`;
  try {
    await call('/api/llm', 'POST', { enabled: true, baseUrl: urlA, key: 'sk-SECRET', model: 'm' });
    await call('/api/llm/test', 'POST', { enabled: true, baseUrl: urlB, model: 'm' });          // pas de clé fournie, autre URL
    await call('/api/llm/test', 'POST', { enabled: true, baseUrl: urlA, model: 'm' });          // même URL : la clé enregistrée sert
    assert.deepEqual(seen.find(s => s[0] === 'B'), ['B', undefined], 'aucune clé envoyée à B');
    assert.equal(seen.find(s => s[0] === 'A')[1], 'Bearer sk-SECRET');
    assert.ok(!JSON.stringify(await call('/api/export')).includes('sk-SECRET'), 'l\'export ne contient pas la clé');
  } finally { await call('/api/llm', 'POST', { enabled: false, baseUrl: urlA, clearKey: true }); a.close(); b.close(); }
});

test('la confirmation conserve la feature proposée, re-valide tout et reste atomique', async () => {
  const p = await call('/api/chat', 'POST', { message: 'Il faut ajouter une revue de code du module SSO du portail client' });
  const feat = p.actions[0].patch.feature_id; assert.ok(feat);
  const ok = await call('/api/chat/confirm', 'POST', { actions: p.actions });
  assert.equal(ok.tasks.find(t => t.id === ok.results[0].task_id).feature_id, feat, 'la feature proposée est bien celle créée');
  const n = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  const tampered = await call('/api/chat/confirm', 'POST', { actions: [{ type: 'create_task', patch: { title: 'bonne' }, links: [{ task_id: 1, type: 'pwn' }] }, { type: 'create_task', patch: { title: 'mauvaise', status: 'lol' } }] });
  assert.equal(tampered.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, n, 'tout ou rien : la première action est annulée aussi');
  const links = await call('/api/chat/confirm', 'POST', { actions: [{ type: 'create_task', patch: { title: 'avec lien bidon' }, links: [{ task_id: 1, type: 'pwn' }, { task_id: 99999, type: 'relates' }] }] });
  assert.equal(links.status, 200); assert.equal(db.prepare("SELECT COUNT(*) c FROM links WHERE type = 'pwn'").get().c, 0, 'liens invalides ignorés');
});

test('annulation : refuse d\'écraser le travail d\'un autre, est tracée, restaure une suppression', async () => {
  const lea = id('Léa'), yanis = id('Yanis');
  const t = db.prepare("SELECT id FROM tasks WHERE title LIKE 'Rédiger la politique%'").get().id;
  const r = await call('/api/chat/confirm', 'POST', { actions: [{ type: 'update_task', id: t, patch: { status: 'review' } }] }, { 'x-user': String(yanis) });
  await call(`/api/tasks/${t}`, 'PATCH', { status: 'done' }, { 'x-user': String(lea) });             // quelqu'un d'autre modifie le même champ ensuite
  const u = await call(`/api/undo/${r.batch}`, 'POST', {});
  assert.equal(u.undone, 0); assert.equal(u.conflicts.length, 1); assert.match(u.conflicts[0].reason, /Léa/);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(t).status, 'done', 'le travail de Léa est intact');

  const del = await call(`/api/tasks/${t}`, 'DELETE', undefined);
  assert.ok(del.undo_id); assert.equal(db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(t), undefined);
  const back = await call(`/api/undo-activity/${del.undo_id}`, 'POST', {});
  assert.equal(back.undone, 1); assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(t).status, 'done');
  assert.equal(db.prepare("SELECT actor FROM activity WHERE action = 'undo' ORDER BY id DESC").get().actor, 'Camille Durand', 'l\'annulation est journalisée');
  assert.ok(db.prepare("SELECT 1 FROM tasks_fts WHERE rowid = ?").get(t), 'index de recherche restauré');
});

test('un lead ne dirige qu\'une squad ; échec = rien n\'est créé', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM squads').get().c;
  const r = await call('/api/squads', 'POST', { name: 'Observabilité', lead_id: id('Léa') });
  assert.equal(r.status, 400); assert.match(r.error, /déjà lead/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM squads').get().c, before, 'la squad n\'a pas été créée');
  assert.equal((await call('/api/squads', 'POST', { name: 'Observabilité', lead_id: 9999 })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM squads').get().c, before);
});

test('gérer l\'équipe réelle depuis l\'interface : personnes, projets, fonctions', async () => {
  const fn = (await call('/api/teams', 'POST', { name: 'Data' })).id;
  assert.equal((await call('/api/teams', 'POST', { name: 'data' })).status, 400, 'nom unique sans casse');
  const m = (await call('/api/members', 'POST', { name: 'Awa Diallo', team_id: fn, role: 'Data engineer', capacity_h: 28 })).id;
  assert.equal((await call('/api/members', 'POST', { name: 'awa diallo' })).status, 400);
  await call(`/api/members/${m}`, 'PATCH', { name: 'Awa Diallo-Sy', role: 'Lead data' });
  const t = (await call('/api/tasks', 'POST', { title: 'Pipeline', assignee_id: m })).id;
  const p = await call('/api/projects', 'POST', { name: 'Plateforme Data' });
  assert.match(db.prepare('SELECT key FROM projects WHERE id = ?').get(p.id).key, /^[A-Z0-9]{2,6}$/);
  assert.equal((await call('/api/projects', 'POST', { name: 'Autre', key: db.prepare('SELECT key FROM projects WHERE id = ?').get(p.id).key })).status, 400, 'clé unique');
  assert.equal((await call(`/api/members/${id('Inès')}`, 'DELETE')).status, 400, 'un lead ne peut pas être retiré');
  const gone = await call(`/api/members/${m}`, 'DELETE');
  assert.equal(gone.status, 200); assert.equal(db.prepare('SELECT assignee_id FROM tasks WHERE id = ?').get(t).assignee_id, null, 'ses tâches redeviennent non assignées');
  await call(`/api/teams/${fn}`, 'DELETE'); await call(`/api/projects/${p.id}`, 'DELETE');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams WHERE id = ?').get(fn).c, 0);
});

test('démo et remise à zéro : jamais automatiques, confirmées, avec sauvegarde', async () => {
  const fresh = openDb(':memory:');                                     // base neuve : aucune donnée de démo imposée
  const s2 = createServer(buildApp(fresh)); await new Promise(r => s2.listen(0, r));
  const b2 = `http://localhost:${s2.address().port}`;
  const c2 = async (path, method = 'GET', body) => (await fetch(b2 + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    let s = await c2('/api/bootstrap');
    assert.equal(s.empty, true); assert.equal(s.members.length + s.tasks.length + s.squads.length, 0);
    assert.equal((await c2('/api/chat', 'POST', { message: 'Il faut préparer la démo' })).actions.length, 1, 'le chat fonctionne même sans organisation');
    s = await c2('/api/demo/load', 'POST', {}); assert.equal(s.empty, false); assert.equal(s.squads.length, 4);
    assert.match((await c2('/api/demo/load', 'POST', {})).error, /base vide/, 'la démo ne s\'écrase pas sur des données');
    assert.match((await c2('/api/reset', 'POST', { confirm: 'oui' })).error, /EFFACER/);
    s = await c2('/api/reset', 'POST', { confirm: 'EFFACER' });
    assert.equal(s.empty, true); assert.equal(s.tasks.length, 0);
    assert.ok(fresh.prepare('SELECT 1 FROM settings').all().length >= 0);
  } finally { s2.close(); }
});

test('dates : calendrier réel et fuseau local', () => {
  assert.equal(isRealDate('2026-02-28'), true); assert.equal(isRealDate('2026-02-31'), false); assert.equal(isRealDate('26-02-01'), false);
  assert.equal(parseDateFr('pour fin de mois', new Date(2026, 9, 12)), '2026-10-31');
  assert.equal(parseDateFr('demain', new Date(2026, 9, 12, 0, 30)), '2026-10-13', 'à 00 h 30 locale, demain reste le lendemain');
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('le chat ignore les politesses et la charge est calculée sur 2 semaines', async () => {
  const r = await call('/api/chat', 'POST', { message: 'Merci beaucoup !' });
  assert.equal(r.actions.length, 0); assert.ok(r.reply);
  const s = await call('/api/bootstrap');
  const nora = s.workload.find(w => w.name.startsWith('Nora'));
  assert.equal(nora.window_days, 14); assert.equal(nora.window_h, nora.capacity_h * 2);
  const far = await call('/api/tasks', 'POST', { title: 'Très lointain', assignee_id: nora.id, due_date: '2099-01-01', estimate_h: 40 });
  const after = (await call('/api/bootstrap')).workload.find(w => w.id === nora.id);
  assert.equal(after.load_h, nora.load_h, 'une tâche à échéance lointaine ne pèse pas dans la charge à 2 semaines');
});

test('reverse proxy : Host/Origin refusés par défaut, acceptés via ALLOWED_HOSTS / TRUST_PROXY', async () => {
  const { request } = await import('node:http');
  const raw = (port, { method = 'GET', path = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, method, path, headers }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    r.on('error', reject); r.end(body);
  });
  const post = (port, headers) => raw(port, { method: 'POST', path: '/api/tasks', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ title: 'via proxy' }) });
  const open = async opts => { const s = createServer(buildApp(db, { loopbackOnly: true, ...opts })); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; };
  const plain = await open({});
  try {
    const port = plain.address().port;
    assert.equal((await raw(port, { headers: { host: 'workforce.corp.example' } })).status, 403);
    assert.match((await raw(port, { headers: { host: 'workforce.corp.example' } })).text, /ALLOWED_HOSTS/, 'le message nomme le réglage à poser');
    assert.equal((await post(port, { host: `127.0.0.1:${port}`, origin: 'https://workforce.corp.example' })).status, 403);
    assert.equal((await post(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).status, 200, 'même origine : accepté');
  } finally { plain.close(); }
  const declared = await open({ allowedHosts: ['workforce.corp.example'] });
  try {
    const port = declared.address().port;
    assert.equal((await raw(port, { headers: { host: 'workforce.corp.example' } })).status, 200);
    assert.equal((await post(port, { host: 'workforce.corp.example', origin: 'https://workforce.corp.example' })).status, 200);
    assert.equal((await post(port, { host: 'workforce.corp.example', origin: 'https://evil.example' })).status, 403, 'un autre site reste refusé');
    assert.equal((await post(port, { host: `127.0.0.1:${port}`, origin: 'https://workforce.corp.example' })).status, 200, 'origine déclarée acceptée');
  } finally { declared.close(); }
  const proxied = await open({ allowedHosts: ['workforce.corp.example'], trustProxy: true });
  try {
    const port = proxied.address().port;
    assert.equal((await post(port, { host: `127.0.0.1:${port}`, 'x-forwarded-host': 'workforce.corp.example', origin: 'https://workforce.corp.example' })).status, 200);
  } finally { proxied.close(); }
  const untrusted = await open({});
  try { assert.equal((await post(untrusted.address().port, { host: `127.0.0.1:${untrusted.address().port}`, 'x-forwarded-host': 'workforce.corp.example', origin: 'https://workforce.corp.example' })).status, 403, 'X-Forwarded-Host ignoré sans TRUST_PROXY'); }
  finally { untrusted.close(); }
});

test('start.js : démarre depuis un chemin avec espace/accent et via lien symbolique', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, cpSync, symlinkSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'wf test é '));
  const copy = join(root, 'wf app'); cpSync(resolve('server'), join(copy, 'server'), { recursive: true }); cpSync(resolve('public'), join(copy, 'public'), { recursive: true });
  cpSync(resolve('package.json'), join(copy, 'package.json'));
  symlinkSync(copy, join(root, 'current'));
  try {
    for (const dir of [copy, join(root, 'current')]) {
      const port = 3300 + Math.floor(Math.random() * 500);
      const child = spawn(process.execPath, [join(dir, 'server', 'start.js')], { env: { ...process.env, PORT: String(port), DB_PATH: join(root, 'w.db') }, stdio: 'ignore' });
      try {
        let ok = false;
        for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 150)); ok = await fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok, () => false); }
        assert.ok(ok, `le serveur répond depuis ${dir}`);
      } finally { child.kill(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
