import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';

delete process.env.LLM_API_KEY;
const db = openDb(':memory:'); seed(db);
const srv = createServer(buildApp(db)); await new Promise(r => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const camille = db.prepare("SELECT id FROM members WHERE name LIKE 'Camille%'").get().id;
const call = async (path, method = 'GET', body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': String(camille) }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const feat = (snap, name) => snap.features.find(f => f.name === name);
const sq = (snap, name) => snap.squads.find(s => s.name === name);
test.after(() => srv.close());

test('démo : 4 squads transverses, leads membres de leur squad, garde-fous actifs', async () => {
  const s = await call('/api/bootstrap');
  assert.equal(s.squads.length, 4);
  for (const q of s.squads) assert.ok(s.members.find(m => m.id === q.lead_id)?.squad_id === q.id, `${q.name} : lead dans la squad`);
  const secu = sq(s, 'Conformité & Sécurité');
  assert.equal(secu.size, 2);
  assert.ok(s.guardrails.some(g => g.kind === 'size' && g.squad_id === secu.id), 'squad de 2 personnes signalée');
  assert.ok(!s.guardrails.some(g => g.kind === 'size' && g.squad_id === sq(s, 'Portail Client').id), 'squad de 4 : rien à signaler');
  assert.ok(s.guardrails.some(g => g.kind === 'coupling' && /2 dépendances/.test(g.message)), 'couplage Support ↔ Portail');
});

test('santé calculée et expliquée', async () => {
  let s = await call('/api/bootstrap');
  const sso = feat(s, 'Connexion & SSO');
  assert.equal(sso.health, 'orange');
  assert.ok(sso.reasons.some(r => /bloquée/.test(r)) && sso.reasons.some(r => /attend « MFA/.test(r)));
  assert.equal(feat(s, 'Test d\'intrusion externe').reasons.some(r => /sans responsable/.test(r)), true);
  const t = db.prepare("SELECT id FROM tasks WHERE title LIKE 'Intégrer le SSO%'").get().id;
  await call(`/api/tasks/${t}`, 'PATCH', { due_date: '2020-01-01' });
  s = await call('/api/bootstrap');
  assert.equal(feat(s, 'Connexion & SSO').health, 'red');
  assert.match(feat(s, 'Connexion & SSO').reasons[0], /en retard/);
});

test('règles : lead intouchable, suppression protégée, dépendance circulaire refusée', async () => {
  const s = await call('/api/bootstrap');
  const leadId = sq(s, 'Cloud & Plateforme').lead_id;
  const r = await call(`/api/members/${leadId}`, 'PATCH', { squad_id: sq(s, 'Portail Client').id });
  assert.equal(r.status, 400); assert.match(r.error, /lead de/);
  assert.equal((await call(`/api/squads/${sq(s, 'Portail Client').id}`, 'DELETE')).status, 400);
  const a = feat(s, 'Connexion & SSO').id, b = feat(s, 'Traitement des incidents').id;
  const cyc = await call('/api/feature-deps', 'POST', { from_feature_id: a, to_feature_id: b });
  assert.equal(cyc.status, 400); assert.match(cyc.error, /circulaire/);   // incidents dépend déjà du SSO
});

test('créer une squad : le lead en devient membre ; ajouter des membres résorbe l\'alerte ; prêt de temps', async () => {
  let s = await call('/api/bootstrap');
  const emma = s.members.find(m => m.name.startsWith('Emma')).id, tom = s.members.find(m => m.name.startsWith('Tom')).id;
  const created = await call('/api/squads', 'POST', { name: 'Data', mission: 'Piloter par la donnée', lead_id: emma });
  s = created;
  assert.equal(s.members.find(m => m.id === emma).squad_id, created.id);
  assert.equal(sq(s, 'Data').size, 1);
  assert.equal((await call('/api/squads', 'POST', { name: 'Data' })).status, 400, 'nom unique');
  const paul = s.members.find(m => m.name.startsWith('Paul')).id, sarah = s.members.find(m => m.name.startsWith('Sarah')).id;
  await call(`/api/members/${paul}`, 'PATCH', { squad_id: created.id });
  s = await call(`/api/members/${sarah}`, 'PATCH', { squad_id: created.id });
  assert.equal(sq(s, 'Data').size, 3);
  assert.ok(!s.guardrails.some(g => g.kind === 'size' && g.squad_id === created.id));
  s = await call(`/api/members/${tom}`, 'PATCH', { loan_squad_id: created.id, loan_pct: 20 });
  assert.deepEqual(sq(s, 'Data').loaned, [{ member_id: tom, pct: 20 }]);
  assert.equal((await call(`/api/members/${tom}`, 'PATCH', { loan_squad_id: sq(s, 'Support & Incidents').id })).status, 400, 'pas de prêt à sa propre squad');
});

test('supprimer une feature renvoie ses tâches dans l\'Inbox ; le glisser vers une feature la rattache', async () => {
  let s = await call('/api/bootstrap');
  const f = feat(s, 'Tableau de bord client');
  s = await call(`/api/features/${f.id}`, 'DELETE');
  assert.equal(s.inbox_count, 1, 'seule la tâche ouverte compte (l\'autre est terminée)');
  assert.ok(s.guardrails.some(g => g.kind === 'inbox'));
  const task = s.tasks.find(t => !t.feature_id && t.status !== 'done');
  s = await call(`/api/tasks/${task.id}`, 'PATCH', { feature_id: feat(s, 'Connexion & SSO').id });
  assert.equal(s.tasks.find(t => t.id === task.id).feature_id, feat(s, 'Connexion & SSO').id);
});

test('le chat classe une nouvelle tâche dans la bonne feature (et la squad est affichée)', async () => {
  const r = await call('/api/chat', 'POST', { message: 'Il faut ajouter une revue de code du module SSO du portail client' });
  const a = r.actions[0];
  const sso = db.prepare("SELECT * FROM features WHERE name = 'Connexion & SSO'").get();
  assert.equal(a.patch.feature_id, sso.id);
  assert.ok(a.rows.some(x => x.field === 'Feature' && x.auto) && a.rows.some(x => x.field === 'Squad' && x.value === 'Portail Client'));
  const none = await call('/api/chat', 'POST', { message: 'Il faut acheter des chaises ergonomiques pour la salle de pause' });
  assert.equal(none.actions[0].patch.feature_id, undefined);
  assert.ok(none.actions[0].warnings.some(w => /Inbox/.test(w)));
});
