import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';
import { authConfig } from '../server/auth.js';

const db = openDb(':memory:'); seed(db);
const srv = createServer(buildApp(db, { auth: authConfig({}) })); await new Promise(r => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const mid = n => db.prepare('SELECT id FROM members WHERE name LIKE ?').get(n + '%').id;
const call = async (path, as, method = 'GET', body) => {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-user': String(mid(as)) }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json()) };
};
const notifs = async who => (await call('/bootstrap', who)).notifications;
const kinds = async who => (await notifs(who)).items.map(n => n.kind);
const task = t => db.prepare('SELECT * FROM tasks WHERE title LIKE ?').get(t + '%');
test.after(() => srv.close());

test('assignation : le destinataire est prévenu, jamais l’auteur', async () => {
  const t = task('Revue de code du module');
  await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { assignee_id: mid('Yanis') });
  const y = await notifs('Yanis');
  assert.equal(y.unread, 1); assert.equal(y.items[0].kind, 'assigned'); assert.match(y.items[0].text, /Camille Durand vous a assigné « Revue de code/); assert.equal(y.items[0].task_id, t.id);
  assert.equal((await notifs('Camille')).items.filter(n => n.kind === 'assigned').length, 0, 'l’auteur n’est pas notifié de ses propres actions');
  await call(`/tasks/${t.id}`, 'Yanis', 'PATCH', { assignee_id: mid('Yanis') });                       // se l'assigner soi-même
  assert.equal((await notifs('Yanis')).items.length, 1);
});

test('changements par un autre : statut, priorité ; retrait ; suppression ; doublons évités', async () => {
  const t = task('Revue de code du module');
  await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { status: 'doing' });
  await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { priority: 'urgent' });
  const items = (await notifs('Yanis')).items;
  assert.ok(items.some(n => n.kind === 'changed' && /« En cours »/.test(n.text)) && items.some(n => /priorité.*Urgente/.test(n.text)));
  await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { priority: 'low' }); await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { priority: 'urgent' }); await call(`/tasks/${t.id}`, 'Camille', 'PATCH', { priority: 'low' });
  assert.equal((await notifs('Yanis')).items.filter(n => /priorité.*Basse/.test(n.text)).length, 1, 'le même message non lu n’est pas dupliqué');
  const own = await call('/tasks', 'Yanis', 'POST', { title: 'Ma tâche perso', assignee_id: mid('Yanis') });
  const before = (await notifs('Yanis')).unread;
  await call(`/tasks/${own.id}`, 'Camille', 'DELETE');
  assert.equal((await notifs('Yanis')).unread, before + 1); assert.match((await notifs('Yanis')).items[0].text, /a supprimé « Ma tâche perso »/);
});

test('blocage et déblocage : l’assigné et le lead de la feature sont prévenus', async () => {
  const a = task('Activer le MFA'), b = task('Rédiger la politique');   // même feature (squad Sécurité, lead Inès), b assignée à Inès
  const x = await call('/tasks', 'Hugo', 'POST', { title: 'Obtenir les accès VPN', assignee_id: mid('Paul') });
  await call('/links', 'Hugo', 'POST', { from_id: x.id, to_id: a.id, type: 'blocks' });
  const ines = await notifs('Inès');
  assert.ok(ines.items.some(n => n.kind === 'blocked' && /bloque désormais « Activer le MFA/.test(n.text)), 'l’assignée de la tâche bloquée est prévenue');
  await call(`/tasks/${x.id}`, 'Paul', 'PATCH', { status: 'done' });
  assert.ok((await notifs('Inès')).items.some(n => n.kind === 'unblocked' && /n’est plus bloquée/.test(n.text)));
  // deux bloqueurs : pas de « débloquée » tant que l'un reste ouvert
  const y1 = await call('/tasks', 'Hugo', 'POST', { title: 'Bloqueur 1' }), y2 = await call('/tasks', 'Hugo', 'POST', { title: 'Bloqueur 2' });
  await call('/links', 'Hugo', 'POST', { from_id: y1.id, to_id: b.id, type: 'blocks' }); await call('/links', 'Hugo', 'POST', { from_id: y2.id, to_id: b.id, type: 'blocks' });
  const n0 = (await notifs('Inès')).items.filter(n => n.kind === 'unblocked').length;
  await call(`/tasks/${y1.id}`, 'Hugo', 'PATCH', { status: 'done' });
  assert.equal((await notifs('Inès')).items.filter(n => n.kind === 'unblocked').length, n0, 'encore un bloqueur ouvert');
  await call(`/tasks/${y2.id}`, 'Hugo', 'PATCH', { status: 'done' });
  assert.equal((await notifs('Inès')).items.filter(n => n.kind === 'unblocked').length, n0 + 1);
});

test('Inbox ciblée : routée vers la squad de l’assigné, à défaut celle de l’auteur ; le lead est prévenu', async () => {
  const portail = db.prepare("SELECT id FROM squads WHERE name = 'Portail Client'").get().id, cloud = db.prepare("SELECT id FROM squads WHERE name LIKE 'Cloud%'").get().id;
  const t1 = await call('/tasks', 'Yanis', 'POST', { title: 'Idée sans feature' });                                   // auteur Portail
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(t1.id).inbox_squad_id, portail);
  assert.ok((await kinds('Camille')).includes('inbox'), 'le lead Portail est prévenu');
  const t2 = await call('/tasks', 'Yanis', 'POST', { title: 'Pour Hugo sans feature', assignee_id: mid('Hugo') });     // assigné Cloud : prime sur l'auteur
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(t2.id).inbox_squad_id, cloud);
  assert.ok((await notifs('Léa')).items.some(n => n.kind === 'inbox' && /Pour Hugo/.test(n.text)), 'le lead Cloud est prévenu');
  const feat = db.prepare("SELECT id FROM features WHERE name = 'Connexion & SSO'").get().id;
  await call(`/tasks/${t1.id}`, 'Camille', 'PATCH', { feature_id: feat });
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(t1.id).inbox_squad_id, null, 'rattachée : plus dans l’Inbox');
  await call(`/tasks/${t1.id}`, 'Camille', 'PATCH', { feature_id: null });
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(t1.id).inbox_squad_id, portail, 'retirée de sa feature : re-routée');
  await call(`/tasks/${t1.id}`, 'Camille', 'PATCH', { inbox_squad_id: cloud });                                          // le lead réachemine
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(t1.id).inbox_squad_id, cloud);
  assert.equal((await call(`/tasks/${t1.id}`, 'Camille', 'PATCH', { inbox_squad_id: 9999 })).status, 400);
  const s = await call('/bootstrap', 'Camille');
  const g = s.guardrails.filter(x => x.kind === 'inbox'); assert.ok(g.some(x => x.squad_id === cloud && /Inbox de « Cloud/.test(x.message)));
  assert.equal(s.inbox_by_squad[cloud] >= 2, true);
});

test('chat : l’aperçu annonce l’Inbox de la bonne squad', async () => {
  const r = await call('/chat', 'Yanis', 'POST', { message: 'Il faut commander des chaises ergonomiques pour la salle de pause' });
  assert.match(r.actions[0].warnings.join(' '), /Inbox de la squad « Portail Client »/);
  const ok = await call('/chat/confirm', 'Yanis', 'POST', { actions: r.actions });
  const id = ok.results[0].task_id;
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(id).inbox_squad_id, db.prepare("SELECT id FROM squads WHERE name = 'Portail Client'").get().id);
});

test('dépendance entre squads et arrivée dans une squad préviennent les bons leads', async () => {
  const a = db.prepare("SELECT id FROM features WHERE name = 'Adoption du nouveau portail'").get().id, b = db.prepare("SELECT id FROM features WHERE name LIKE 'Socle%'").get().id;
  await call('/feature-deps', 'Tom', 'POST', { from_feature_id: a, to_feature_id: b, note: 'x' });
  assert.ok((await notifs('Léa')).items.some(n => n.kind === 'dependency' && /Adoption du nouveau portail.*dépend de « Socle/.test(n.text)));
  const emma = mid('Emma');
  await call(`/members/${emma}`, 'Tom', 'PATCH', { squad_id: db.prepare("SELECT id FROM squads WHERE name LIKE 'Cloud%'").get().id });
  assert.ok((await kinds('Emma')).includes('squad') && (await notifs('Léa')).items.some(n => /Emma Faure rejoint votre squad/.test(n.text)));
});

test('lecture : marquer lu (une, toutes), confidentialité entre personnes', async () => {
  const before = await notifs('Yanis'); assert.ok(before.unread >= 2);
  await call('/notifications/read', 'Yanis', 'POST', { ids: [before.items[0].id] });
  assert.equal((await notifs('Yanis')).unread, before.unread - 1);
  await call('/notifications/read', 'Camille', 'POST', { ids: before.items.map(n => n.id) });          // ne peut pas lire/valider celles des autres
  assert.equal((await notifs('Yanis')).unread, before.unread - 1);
  await call('/notifications/read', 'Yanis', 'POST', { all: true });
  assert.equal((await notifs('Yanis')).unread, 0);
  assert.ok((await notifs('Yanis')).items.length > 0, 'l’historique reste consultable');
  assert.ok((await notifs('Yanis')).items.every(n => n.read_at));
});

test('Inbox orpheline : un auteur sans squad ne perd pas sa tâche — administrateurs prévenus, garde-fou visible', async () => {
  db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(mid('Inès'));
  const newbie = Number(db.prepare("INSERT INTO members(name, email, role, skills, capacity_h) VALUES ('Nouvel Arrivant', 'n@corp.example', '', '[]', 30)").run().lastInsertRowid);
  const r = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': String(newbie) }, body: JSON.stringify({ title: 'Une demande sans destinataire' }) });
  const id = (await r.json()).id;
  assert.equal(db.prepare('SELECT inbox_squad_id FROM tasks WHERE id = ?').get(id).inbox_squad_id, null);
  assert.ok((await notifs('Inès')).items.some(n => n.kind === 'inbox' && /sans feature ni squad destinataire.*Une demande/.test(n.text)), 'un administrateur est prévenu');
  const g = (await call('/bootstrap', 'Camille')).guardrails.filter(x => x.kind === 'inbox' && x.squad_id === null);
  assert.equal(g.length, 1); assert.match(g[0].message, /sans feature ni squad destinataire/);
  await call(`/tasks/${id}`, 'Camille', 'PATCH', { inbox_squad_id: db.prepare("SELECT id FROM squads WHERE name = 'Portail Client'").get().id });   // un lead la route
  assert.equal((await call('/bootstrap', 'Camille')).guardrails.filter(x => x.kind === 'inbox' && x.squad_id === null).length, 0);
});
