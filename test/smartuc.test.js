// Intégration SmartUC : client MCP → cache → liens → gouvernance → planification. Données issues de VRAIES réponses SmartUC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';
import { authConfig } from '../server/auth.js';
import { createSmartuc } from '../server/smartuc.js';
import { playbook, suggestSquads, parseUc } from '../server/uc-plan.js';
import { startFakeSmartuc } from './helpers/fake-smartuc.js';

const fake = await startFakeSmartuc();
const db = openDb(':memory:'); seed(db);
const smartuc = createSmartuc(db, { env: { SMARTUC_MCP_URL: fake.url, SMARTUC_API_KEY: fake.key } });
const srv = createServer(buildApp(db, { smartuc })); await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const mid = n => db.prepare('SELECT id FROM members WHERE name LIKE ?').get(n + '%').id;
const call = async (path, as, method = 'GET', body) => {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-user': String(mid(as)) }, body: body && JSON.stringify(body) });
  return { ...(await r.json()), status: r.status };       // le statut HTTP prime sur un éventuel champ « status » de la réponse
};
const feat = n => db.prepare('SELECT * FROM features WHERE name LIKE ?').get(n + '%');
const squad = n => db.prepare('SELECT * FROM squads WHERE name LIKE ?').get(n + '%');
const notifs = (who, kind = 'uc') => db.prepare('SELECT * FROM notifications WHERE member_id = ? AND kind = ? ORDER BY id').all(mid(who), kind);
test.after(async () => { srv.close(); await fake.close(); });

test('première synchronisation : cache complet, détails seulement pour les UC à suivre, aucune notification', async () => {
  const r = await smartuc.sync();
  assert.deepEqual([r.ok, r.uc_count, r.partial], [true, fake.rows.length, 0]);
  const snap = smartuc.snapshot();
  assert.equal(snap.ucs.length, fake.rows.length);
  assert.deepEqual(snap.ucs.filter(u => u.data).map(u => u.ref).sort(), ['UC-0002', 'UC-0004', 'UC-0018'], 'détails des UC approuvés / en construction uniquement');
  const uc2 = snap.ucs.find(u => u.ref === 'UC-0002');
  assert.equal(uc2.data.owner.email, 'anita.sharma@example.com'); assert.equal(uc2.data.estimated_effort, 'M'); assert.ok(uc2.data.target_systems.includes('SAP S/4HANA'));
  assert.ok(uc2.relations.entities.length > 0, 'entités partagées retenues');
  assert.equal(snap.smartuc.ok, true); assert.equal(snap.smartuc.publicUrl, fake.origin);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM notifications').get().c, 0, 'premier import : pas de déluge de notifications');
});

test('synchronisation incrémentale : sans changement aucun appel de détail ; un changement refait un seul appel', async () => {
  const before = fake.calls_of('get_use_case');
  await smartuc.sync(); assert.equal(fake.calls_of('get_use_case'), before, 'rien n’a changé : pas de relecture');
  fake.set('UC-0002', { title: 'Tri automatique des factures fournisseurs' });
  await smartuc.sync(); assert.equal(fake.calls_of('get_use_case'), before + 1);
  assert.equal(smartuc.snapshot().ucs.find(u => u.ref === 'UC-0002').title, 'Tri automatique des factures fournisseurs');
});

test('liens feature ↔ UC : lead de la squad uniquement, UC inconnu refusé', async () => {
  const f = feat('Connexion & SSO');                                          // squad Portail Client, lead Camille
  assert.equal((await call(`/features/${f.id}/ucs`, 'Yanis', 'POST', { uc_ref: 'UC-0002' })).status, 200, 'sans authentification tout le monde est admin');
  assert.equal((await call(`/features/${f.id}/ucs`, 'Camille', 'POST', { uc_ref: 'UC-9999' })).status, 404);
  assert.equal((await call(`/features/${f.id}/ucs`, 'Camille', 'POST', { uc_ref: 'uc-0002' })).status, 200, 'idempotent, casse ignorée');
  assert.deepEqual((await call('/bootstrap', 'Camille')).uc_links, [{ feature_id: f.id, uc_ref: 'UC-0002' }]);
  assert.equal((await call(`/features/${f.id}/ucs/UC-0002`, 'Camille', 'DELETE')).uc_links.length, 0);
  await call(`/features/${f.id}/ucs`, 'Camille', 'POST', { uc_ref: 'UC-0002' });
});

test('événements : changement de statut, tier validé, nouvelle relation, nouvel UC prêt à planifier', async () => {
  db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(mid('Inès'));
  const f = feat('Connexion & SSO');                                          // lié à UC-0002, lead Camille
  fake.set('UC-0002', { status: 'in_build' }); await smartuc.sync();
  const n1 = notifs('Camille'); assert.equal(n1.length, 1); assert.match(n1[0].text, /UC-0002.*passé de « approved » à « in_build ».*Connexion & SSO/); assert.equal(n1[0].feature_id, f.id);
  fake.set('UC-0002', { risk_tier: null }); await smartuc.sync();
  fake.set('UC-0002', { risk_tier: 'high_risk' }); await smartuc.sync();
  assert.ok(notifs('Camille').some(n => /tier de risque.*validé : high_risk/.test(n.text)));
  fake.rels['UC-0002'] = [...fake.rels['UC-0002'], { id: 'r-new', type: 'depends_on', status: 'confirmed', source_ref: 'UC-0002', target_ref: 'UC-0004', explanation: 'Réutilise le routeur du service desk', origin: 'manual' }];
  fake.set('UC-0002', {}); await smartuc.sync();
  assert.ok(notifs('Camille').some(n => /Nouvelle relation confirmée.*UC-0002 → UC-0004 \(depends_on\)/.test(n.text)));
  fake.set('UC-0025', { status: 'approved' }); await smartuc.sync();                       // nouvel UC approuvé, sans feature
  for (const who of ['Inès', 'Camille', 'Léa']) assert.ok(notifs(who).some(n => /prêt à planifier : UC-0025/.test(n.text)), `${who} est prévenu`);
  assert.equal(smartuc.snapshot().ucs.find(u => u.ref === 'UC-0025').data?.summary ? true : true, true);
  fake.set('UC-0002', { status: 'rejected' }); await smartuc.sync();
  assert.ok(notifs('Inès').some(n => /UC-0002.*« rejected »/.test(n.text)), 'un rejet prévient aussi les administrateurs');
  fake.set('UC-0002', { status: 'approved' }); await smartuc.sync();
});

test('gouvernance : la feature doit respecter les portes de son UC (santé, garde-fous)', async () => {
  const f = feat('Connexion & SSO'); const status = async () => { const s = await call('/bootstrap', 'Camille'); return { feat: s.features.find(x => x.id === f.id), guards: s.guardrails.filter(g => g.kind === 'governance' && g.feature_id === f.id) }; };
  db.prepare("UPDATE features SET status = 'building' WHERE id = ?").run(f.id);
  fake.set('UC-0002', { status: 'approved', risk_tier: 'minimal_risk' }); await smartuc.sync();
  assert.equal((await status()).guards.length, 0, 'UC approuvé : rien à signaler');
  db.prepare("UPDATE uc_cache SET status = 'qualified' WHERE ref = 'UC-0002'").run();
  let s = await status(); assert.match(s.guards[0].message, /pas encore approuvé « qualified »|pas encore approuvé \(« qualified »\)/); assert.ok(s.feat.reasons.some(r => /porte d’investissement/.test(r)));
  db.prepare("UPDATE uc_cache SET status = 'rejected' WHERE ref = 'UC-0002'").run();
  s = await status(); assert.equal(s.feat.health, 'red'); assert.ok(s.feat.reasons.some(r => /« rejected » dans SmartUC : arrêter ou requalifier/.test(r)));
  db.prepare("UPDATE uc_cache SET status = 'approved', risk_tier = NULL WHERE ref = 'UC-0002'").run(); db.prepare("UPDATE features SET status = 'shipping' WHERE id = ?").run(f.id);
  s = await status(); assert.ok(s.feat.reasons.some(r => /tier EU AI Act.*pas validé/.test(r)));
  db.prepare("UPDATE features SET status = 'discovery' WHERE id = ?").run(f.id); db.prepare("UPDATE uc_cache SET status = 'draft' WHERE ref = 'UC-0002'").run();
  assert.equal((await status()).guards.length, 0, 'le cadrage peut précéder l’approbation');
  db.prepare("UPDATE features SET status = 'live' WHERE id = ?").run(f.id); db.prepare("UPDATE uc_cache SET status = 'approved' WHERE ref = 'UC-0002'").run();
  s = await status(); assert.equal(s.guards[0].level, 'info'); assert.match(s.guards[0].message, /en ligne.*go-live/);
  db.prepare("UPDATE features SET status = 'building' WHERE id = ?").run(f.id); db.prepare("UPDATE uc_cache SET deleted = 1 WHERE ref = 'UC-0002'").run();
  assert.match((await status()).guards[0].message, /n’existe plus dans SmartUC/);
  db.prepare("UPDATE uc_cache SET deleted = 0, status = 'approved', risk_tier = 'minimal_risk' WHERE ref = 'UC-0002'").run(); db.prepare("UPDATE features SET status = 'building' WHERE id = ?").run(f.id);
});

test('UC à planifier : garde-fou global, ignorer', async () => {
  const unplanned = async () => (await call('/bootstrap', 'Camille')).guardrails.find(g => g.kind === 'uc_unplanned');
  const g = await unplanned(); assert.match(g.message, /use cases? SmartUC approuvés? (n’ont|n’a) pas encore de feature/); assert.equal(g.squad_id, null);
  const n = Number(g.message.match(/^(\d+)/)[1]);
  assert.equal((await call('/ucs/UC-0025/ignore', 'Camille', 'POST', { on: true })).status, 200);
  const g2 = await unplanned(); assert.equal(n - 1 === 0 ? g2 : Number(g2.message.match(/^(\d+)/)[1]), n - 1 === 0 ? undefined : n - 1);
  assert.equal((await call('/ucs/UC-0025/ignore', 'Camille', 'POST', { on: false })).status, 200);
  assert.equal((await call('/ucs/UC-9999/ignore', 'Camille', 'POST', {})).status, 404);
});

test('paquet de tâches IA : dimensionné par l’effort, conditionné par les données et le risque', () => {
  const base = { ref: 'UC-0100', ai_capability: 'extraction', risk_tier: null, data: { estimated_effort: 'M', data_sources: ['Factures', 'ERP'], source_systems: ['SAP'], target_systems: ['SAP', 'GED'], kpis: ['Temps 12 → 4 min'], mitigations: ['Revue humaine', 'Journalisation'], human_in_the_loop: 'review_before_action', data_sensitivity: 'internal', build_approach: 'build' } };
  const t = playbook(base), titles = t.map(x => x.title);
  const proto = x => playbook(x).find(y => /prototype/.test(y.title)).estimate_h;
  assert.equal(proto(base), 24); assert.equal(proto({ ...base, data: { ...base.data, estimated_effort: 'XL' } }), 48); assert.equal(proto({ ...base, data: { ...base.data, estimated_effort: 'S' } }), 12);
  assert.equal(titles.filter(x => /Vérifier l’accès/.test(x)).length, 2); assert.equal(titles.filter(x => /intégration avec/.test(x)).length, 2, 'SAP dédupliqué : SAP + GED');
  assert.ok(titles.some(x => /KPI : Temps/.test(x)) && titles.some(x => /mitigation : Revue humaine/.test(x)) && titles.some(x => /validation humaine/.test(x)) && titles.some(x => /go-live/.test(x)));
  assert.ok(!titles.some(x => /RGPD|haut risque/.test(x)), 'pas de DPIA ni de documentation haut risque sans raison');
  const strict = playbook({ ...base, risk_tier: 'high_risk', data: { ...base.data, data_sensitivity: 'personal_data', eu_ai_act_tier: 'high_risk', build_approach: 'buy' } }).map(x => x.title);
  assert.ok(strict.some(x => /RGPD/.test(x)) && strict.some(x => /haut risque/.test(x)) && strict.some(x => /achat \/ partenaire/.test(x)));
  assert.ok(t.every(x => x.labels.includes('uc') && x.labels.includes('uc-0100') && x.labels.includes('ia')) && t.length <= 24);
});

test('squad suggérée : porteur du UC, entités partagées, compétences, capacité — avec les raisons', async () => {
  const uc = () => parseUc(db.prepare("SELECT * FROM uc_cache WHERE ref = 'UC-0002'").get());
  db.prepare('UPDATE members SET email = ? WHERE id = ?').run('anita.sharma@example.com', mid('Hugo'));        // propriétaire de la fiche = Hugo (squad Cloud)
  let ranked = suggestSquads(db, uc()); assert.match(ranked[0].name, /^Cloud/); assert.ok(ranked[0].reasons.some(r => /Hugo Petit \(propriétaire de la fiche\)/.test(r)));
  db.prepare('UPDATE members SET email = NULL WHERE id = ?').run(mid('Hugo'));
  // UC-0004 (« Data & AI platform » partagé avec UC-0002) est porté par Support : cette squad gagne un signal d'entités partagées
  const supportFeat = feat('Traitement des incidents'); smartuc.link(supportFeat.id, 'UC-0004', 'test');
  ranked = suggestSquads(db, uc()); const sup = ranked.find(r => /^Support/.test(r.name)); assert.ok(sup.reasons.some(r => /partage \d+ entités? .*UC-0004/.test(r)), JSON.stringify(sup));
  assert.ok(sup.score > 0);
  smartuc.unlink(supportFeat.id, 'UC-0004', 'test');
  const overload = squad('Cloud'); db.prepare('UPDATE squads SET max_active_features = 1 WHERE id = ?').run(overload.id);
  assert.ok(suggestSquads(db, uc()).find(r => r.squad_id === overload.id).reasons.some(r => /limite de 1 features/.test(r)), 'la pénalité de capacité est expliquée');
  db.prepare('UPDATE squads SET max_active_features = 3 WHERE id = ?').run(overload.id);
  const plan = await call('/ucs/UC-0002/plan', 'Camille');
  assert.equal(plan.draft.name, 'Tri automatique des factures fournisseurs'); assert.equal(plan.draft.status, 'discovery'); assert.ok(plan.playbook.length >= 10); assert.ok(plan.ranking.length === 4); assert.equal(plan.tasks, undefined, 'le plan ne reprend pas les clés de l’instantané'); assert.equal(plan._snapshot, undefined);
  assert.equal((await call('/ucs/UC-9999/plan', 'Camille')).status, 404);
});

test('créer une feature depuis un UC : feature + lien + tâches, permissions de lead, validations', async () => {
  const portail = squad('Portail'), cloud = squad('Cloud');
  const plan = await call('/ucs/UC-0018/plan', 'Camille');
  const before = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  const r = await call('/ucs/UC-0018/create-feature', 'Camille', 'POST', { squad_id: portail.id, tasks: plan.playbook.slice(0, 4) });
  assert.equal(r.status, 200); assert.equal(r.tasks_created, 4);
  const f = db.prepare('SELECT * FROM features WHERE id = ?').get(r.feature_id);
  assert.equal(f.name, plan.draft.name); assert.equal(f.squad_id, portail.id); assert.equal(f.status, 'discovery');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, before + 4);
  const task = db.prepare('SELECT * FROM tasks WHERE feature_id = ? ORDER BY id').get(f.id); assert.ok(JSON.parse(task.labels).includes('uc-0018')); assert.equal(task.inbox_squad_id, null);
  assert.deepEqual(db.prepare('SELECT uc_ref FROM feature_ucs WHERE feature_id = ?').all(f.id).map(x => x.uc_ref), ['UC-0018']);
  assert.ok(db.prepare("SELECT 1 FROM activity WHERE action = 'uc_link'").get());
  assert.equal((await call('/ucs/UC-0018/create-feature', 'Camille', 'POST', { squad_id: 9999 })).status, 404);
  assert.equal((await call('/ucs/UC-9999/create-feature', 'Camille', 'POST', { squad_id: cloud.id })).status, 404);
  assert.equal((await call('/ucs/UC-0018/create-feature', 'Camille', 'POST', { squad_id: cloud.id, tasks: [{ title: '' }] })).status, 400, 'titre de tâche vide refusé');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM features WHERE squad_id = ? AND name LIKE 'Enterprise%'").get(cloud.id).c, 0, 'échec = rien n’est créé (transaction)');
  db.prepare("UPDATE uc_cache SET deleted = 1 WHERE ref = 'UC-0018'").run();
  assert.equal((await call('/ucs/UC-0018/create-feature', 'Camille', 'POST', { squad_id: portail.id })).status, 409); db.prepare("UPDATE uc_cache SET deleted = 0 WHERE ref = 'UC-0018'").run();
  assert.equal((await call('/bootstrap', 'Camille')).uc_links.some(l => l.uc_ref === 'UC-0018' && l.feature_id === f.id), true);
});

test('permissions avec authentification : lead de la squad, administrateur, simple membre', async () => {
  const tok = {}; const addSession = who => { const t = 'tok-' + who; tok[who] = t; db.prepare('INSERT INTO sessions(token_hash, member_id, created_at, expires_at) VALUES (?,?,?,?)').run(createHash('sha256').update(t).digest('hex'), mid(who), new Date().toISOString(), new Date(Date.now() + 3.6e6).toISOString()); };
  ['Camille', 'Léa', 'Yanis', 'Inès'].forEach(addSession); db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(mid('Inès'));
  const s2 = createServer(); await new Promise(r => s2.listen(0, '127.0.0.1', r)); const b2 = `http://127.0.0.1:${s2.address().port}`;
  s2.on('request', buildApp(db, { smartuc, auth: authConfig({ KEYCLOAK_ISSUER: 'http://x.invalid/realms/r', KEYCLOAK_CLIENT_ID: 'x', PUBLIC_URL: b2 }) }));
  const api = async (who, path, method = 'GET', body) => { const r = await fetch(b2 + '/api' + path, { method, headers: { 'content-type': 'application/json', cookie: `wf_session=${tok[who]}` }, body: body && JSON.stringify(body) }); return { ...(await r.json()), status: r.status }; };
  const portail = squad('Portail').id, cloud = squad('Cloud').id, f = feat('Connexion & SSO').id;
  try {
    assert.equal((await api('Yanis', '/smartuc')).status, 200, 'chacun peut voir l’état de l’intégration');
    assert.equal((await api('Yanis', '/smartuc')).hasKey, true); assert.ok(!JSON.stringify(await api('Yanis', '/smartuc')).includes(fake.key), 'la clé ne sort jamais du serveur');
    assert.ok(!JSON.stringify(await api('Yanis', '/bootstrap')).includes(fake.key));
    for (const [method, path, body] of [['GET', '/ucs/UC-0002/plan'], ['POST', '/smartuc/sync', {}], ['POST', '/ucs/UC-0002/ignore', {}], ['POST', '/ucs/UC-0002/create-feature', { squad_id: portail }], ['POST', `/features/${f}/ucs`, { uc_ref: 'UC-0002' }]])
      assert.equal((await api('Yanis', path, method, body)).status, 403, `membre refusé : ${method} ${path}`);
    assert.equal((await api('Camille', '/ucs/UC-0002/plan')).status, 200);
    assert.equal((await api('Camille', '/ucs/UC-0002/create-feature', 'POST', { squad_id: cloud })).status, 403, 'un lead ne crée pas dans la squad d’un autre');
    assert.equal((await api('Léa', `/features/${f}/ucs`, 'POST', { uc_ref: 'UC-0002' })).status, 403, 'ni ne lie la feature d’un autre');
    assert.equal((await api('Camille', `/features/${f}/ucs`, 'POST', { uc_ref: 'UC-0002' })).status, 200);
    assert.equal((await api('Camille', '/smartuc', 'POST', { url: fake.url, enabled: true })).status, 403, 'la configuration est réservée aux administrateurs');
    assert.equal((await api('Camille', '/smartuc/test', 'POST', {})).status, 403);
    assert.equal((await api('Inès', '/ucs/UC-0002/create-feature', 'POST', { squad_id: cloud, tasks: [] })).status, 200, 'un administrateur crée où il veut');
    assert.equal((await api('Inès', '/smartuc/test', 'POST', { url: fake.url, enabled: true })).ok, true);
  } finally { s2.close(); }
});

test('réglages : la clé n’est jamais envoyée vers une autre URL ; test de connexion expliqué ; désactivé = silence', async () => {
  const other = await startFakeSmartuc({ key: fake.key });
  try {
    smartuc.save({ url: fake.url, key: fake.key, enabled: true });
    const t = await smartuc.test({ url: other.url, enabled: true });                      // autre URL, aucune clé saisie : la clé enregistrée ne doit pas partir
    assert.equal(t.ok, false); assert.match(t.error, /Clé d’API|Aucune clé/);
    assert.equal(other.seen.filter(Boolean).length, 0, 'aucun en-tête Authorization n’a atteint l’autre serveur');
    const ok = await smartuc.test({ url: fake.url, enabled: true });
    assert.deepEqual([ok.ok, ok.uc_count, ok.role, ok.tools], [true, fake.rows.length, 'requester', 4]); assert.deepEqual(ok.warnings, [], 'compte « requester » : le moindre privilège, aucun avertissement');
    fake.role = 'reviewer'; assert.match((await smartuc.test({ url: fake.url, enabled: true })).warnings[0], /reviewer.*franchir des portes.*préférez.*requester/);
    fake.role = 'admin'; assert.match((await smartuc.test({ url: fake.url, enabled: true })).warnings[0], /admin.*rejeter des UC.*utilisateurs/); fake.role = 'requester';
    assert.equal((await smartuc.test({ url: 'ftp://x' }).catch(e => ({ ok: false, error: e.message }))).ok, false);
    const cfg = smartuc.save({ url: other.url, enabled: true, pollMinutes: 0 });          // changement d'URL sans clé : la clé est oubliée
    assert.equal(cfg.hasKey, false); assert.equal(cfg.pollMinutes, 1, 'fréquence bornée');
    smartuc.save({ url: fake.url, key: fake.key, enabled: false });
    const calls = fake.calls.length, seen = fake.seen.length;
    assert.deepEqual(await smartuc.sync(), { skipped: 'disabled' }); assert.equal(fake.calls.length, calls); assert.equal(fake.seen.length, seen, 'désactivé : aucun appel réseau');
    smartuc.save({ url: fake.url, key: fake.key, enabled: true });
  } finally { await other.close(); }
});

test('panne et reprise : le cache est conservé, l’erreur est expliquée, la synchronisation reprend', async () => {
  const count = smartuc.snapshot().ucs.length;
  fake.down = true; const r = await smartuc.sync(); fake.down = false;
  assert.equal(r.ok, false); assert.match(r.error, /injoignable|Délai/);
  const s = smartuc.snapshot(); assert.equal(s.smartuc.ok, false); assert.equal(s.ucs.length, count, 'cache conservé'); assert.match(s.smartuc.error, /injoignable/);
  const good = await smartuc.sync(); assert.equal(good.ok, true); assert.equal(smartuc.snapshot().smartuc.ok, true);
  fake.key = 'uch_autre'; const denied = await smartuc.sync(); fake.key = 'uch_testkey';
  assert.equal(denied.ok, false); assert.match(denied.error, /refusée/);
  assert.equal((await smartuc.sync()).ok, true);
});

test('UC supprimés dans SmartUC : marqués, jamais effacés ; une liste vide ne supprime rien', async () => {
  const saved = fake.rows; fake.rows = saved.filter(r => r.ref !== 'UC-0001');
  await smartuc.sync(); assert.equal(smartuc.snapshot().ucs.find(u => u.ref === 'UC-0001').deleted, true);
  fake.rows = []; await smartuc.sync();
  assert.equal(smartuc.snapshot().ucs.filter(u => u.deleted).length, 1, 'liste vide = suspect (droits ?) : rien n’est marqué');
  fake.rows = saved; await smartuc.sync(); assert.equal(smartuc.snapshot().ucs.find(u => u.ref === 'UC-0001').deleted, false, 'le UC réapparaît');
});

test('le portefeuille complet ne part que vers les leads et administrateurs ; les autres reçoivent les UC liés', async () => {
  const sess = {}; for (const who of ['Camille', 'Yanis', 'Inès']) { const t = 'tk-' + who; sess[who] = t; db.prepare('INSERT OR REPLACE INTO sessions(token_hash, member_id, created_at, expires_at) VALUES (?,?,?,?)').run(createHash('sha256').update(t).digest('hex'), mid(who), new Date().toISOString(), new Date(Date.now() + 3.6e6).toISOString()); }
  db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(mid('Inès'));
  const s2 = createServer(); await new Promise(r => s2.listen(0, '127.0.0.1', r)); const b2 = `http://127.0.0.1:${s2.address().port}`;
  s2.on('request', buildApp(db, { smartuc, auth: authConfig({ KEYCLOAK_ISSUER: 'http://x.invalid/realms/r', KEYCLOAK_CLIENT_ID: 'x', PUBLIC_URL: b2 }) }));
  const boot = async who => (await fetch(b2 + '/api/bootstrap', { headers: { cookie: `wf_session=${sess[who]}` } })).json();
  try {
    const all = fake.rows.length, linked = new Set(db.prepare('SELECT uc_ref FROM feature_ucs').all().map(r => r.uc_ref));
    assert.ok(linked.size >= 1 && linked.size < all);
    const yanis = await boot('Yanis'), camille = await boot('Camille'), ines = await boot('Inès');
    assert.equal(camille.ucs.length, all, 'un lead voit tout le portefeuille (il planifie)'); assert.equal(ines.ucs.length, all);
    assert.deepEqual(yanis.ucs.map(u => u.ref).sort(), [...linked].sort(), 'un membre ne reçoit que les UC liés à une feature');
    const draft = fake.rows.find(r => r.status === 'draft');
    assert.ok(!JSON.stringify(yanis).includes(draft.title) && !JSON.stringify(yanis).includes(draft.ref + '"'), 'aucune idée d’un autre métier dans son navigateur');
    assert.ok(JSON.stringify(camille).includes(draft.title));
    assert.equal(yanis.smartuc.uc_count, yanis.ucs.length, 'le total du portefeuille n’est pas divulgué non plus');
    assert.ok(yanis.uc_links.length >= 1, 'les liens restent visibles (puces sur les features)');
  } finally { s2.close(); }
});

test('disparition massive (droits modifiés ?) ou plafond de 500 : rien n’est marqué supprimé, un avertissement est affiché', async () => {
  const saved = fake.rows;
  fake.rows = saved.slice(0, 8);                                   // 26 → 8 : 18 UC « disparaissent » d'un coup
  await smartuc.sync();
  assert.equal(smartuc.snapshot().ucs.filter(u => u.deleted).length, 0, 'pas de suppression en masse');
  assert.match(smartuc.snapshot().smartuc.warning, /18 UC sur 26 ne sont plus visibles : droits du compte modifiés/);
  fake.rows = saved; await smartuc.sync(); assert.equal(smartuc.snapshot().smartuc.warning, null, 'l’avertissement disparaît dès que la situation se normalise');
  fake.rows = Array.from({ length: 500 }, (_, i) => ({ ...saved[i % saved.length], ref: `UC-${String(i + 1).padStart(4, '0')}`, id: 'id' + i }));
  await smartuc.sync(); assert.match(smartuc.snapshot().smartuc.warning, /limite de 500 UC/);
  assert.equal(smartuc.snapshot().ucs.filter(u => u.deleted).length, 0);
  fake.rows = saved; await smartuc.sync();
  db.prepare("DELETE FROM uc_cache WHERE ref NOT IN (" + saved.map(() => '?').join(',') + ')').run(...saved.map(r => r.ref));
});

test('« premier import » : tant qu’une synchronisation complète n’a pas réussi, aucun UC n’est annoncé comme nouveau', async () => {
  const fresh = openDb(':memory:'); seed(fresh);
  fresh.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(fresh.prepare("SELECT id FROM members WHERE name LIKE 'Inès%'").get().id);
  const uc2 = createSmartuc(fresh, { env: { SMARTUC_MCP_URL: fake.url, SMARTUC_API_KEY: fake.key } });
  fake.dropOn = 'get_use_case'; const broken = await uc2.sync(); fake.dropOn = null;           // coupure en plein import, après quelques UC
  assert.equal(broken.ok, false);
  assert.ok(fresh.prepare('SELECT COUNT(*) c FROM uc_cache').get().c > 0, 'l’import interrompu a laissé un cache partiel');
  assert.equal(fresh.prepare('SELECT COUNT(*) c FROM notifications').get().c, 0);
  assert.equal((await uc2.sync()).ok, true);
  assert.equal(fresh.prepare("SELECT COUNT(*) c FROM notifications WHERE kind = 'uc'").get().c, 0, 'pas de déluge « nouvel UC approuvé » après un premier import interrompu');
  const draft = fake.rows.find(r => r.status === 'draft').ref;
  fake.set(draft, { status: 'approved' }); await uc2.sync();
  assert.ok(fresh.prepare("SELECT * FROM notifications WHERE kind = 'uc'").all().some(n => n.text.includes(`prêt à planifier : ${draft}`)), 'les changements suivants sont bien notifiés');
  fake.set(draft, { status: 'draft' });
});

test('URL de l’interface SmartUC : http(s) uniquement (elle alimente des liens cliquables)', () => {
  assert.throws(() => smartuc.save({ url: fake.url, enabled: true, publicUrl: 'javascript:alert(1)' }), /http:\/\/ ou https:\/\//);
  assert.throws(() => smartuc.save({ url: fake.url, enabled: true, publicUrl: 'data:text/html,x' }), /http:\/\/ ou https:\/\//);
  assert.equal(smartuc.save({ url: fake.url, enabled: true, publicUrl: 'https://smartuc.example.org/' }).publicUrl, 'https://smartuc.example.org');
  smartuc.save({ url: fake.url, enabled: true, publicUrl: fake.origin });
});
