import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';

process.env.LLM_API_KEY = ''; // force le mode mock
const db = openDb(':memory:'); seed(db);
const srv = createServer(buildApp(db)); await new Promise(r => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}`;
const camille = db.prepare("SELECT id FROM members WHERE name LIKE 'Camille%'").get().id;
const api = async (path, method = 'GET', body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-user': String(camille) }, body: body && JSON.stringify(body) });
  return r.json();
};
test.after(() => srv.close());

test('création en langage naturel : classement auto + proposition', async () => {
  const r = await api('/api/chat', 'POST', { message: "Il faut configurer le MFA pour les comptes de la compta, c'est urgent pour vendredi, assigne à Inès" });
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.type, 'create_task');
  assert.equal(a.patch.priority, 'urgent');
  assert.equal(a.patch.assignee_id, db.prepare("SELECT id FROM members WHERE name LIKE 'Inès%'").get().id);
  assert.equal(a.patch.project_id, db.prepare("SELECT id FROM projects WHERE key = 'SEC'").get().id, 'classé dans Conformité ISO 27001');
  assert.ok(a.patch.due_date);
  assert.ok(a.links.some(l => l.title.includes('MFA')), 'lien suggéré vers la tâche MFA existante');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 14, 'rien n\'est écrit avant confirmation');
});

test('confirmation puis annulation', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  const prop = await api('/api/chat', 'POST', { message: 'Ajoute une tâche : préparer la démo client de jeudi, 3h' });
  const done = await api('/api/chat/confirm', 'POST', { actions: prop.actions });
  assert.equal(done.tasks.length, before + 1);
  const t = done.tasks.at(-1);
  assert.equal(t.estimate_h, 3);
  const undo = await api(`/api/undo/${done.batch}`, 'POST', {});
  assert.equal(undo.tasks.length, before);
});

test('mise à jour par description : "j\'ai terminé les maquettes de connexion"', async () => {
  const r = await api('/api/chat', 'POST', { message: "J'ai terminé les maquettes de la page de connexion" });
  assert.equal(r.actions[0].type, 'update_task');
  assert.equal(r.actions[0].patch.status, 'done');
  const done = await api('/api/chat/confirm', 'POST', { actions: r.actions });
  assert.equal(done.tasks.find(t => t.id === r.actions[0].id).status, 'done');
});

test('plusieurs tâches dans un message + question de charge', async () => {
  const r = await api('/api/chat', 'POST', { message: 'Il faut renouveler le certificat SSL ; puis documenter la procédure de sauvegarde' });
  assert.equal(r.actions.length, 2);
  const w = await api('/api/chat', 'POST', { message: 'Qui est surchargé en ce moment ?' });
  assert.match(w.reply, /%/);
});

test('mise à jour par description approximative (configuration ≈ configurer)', async () => {
  const r = await api('/api/chat', 'POST', { message: "J'ai terminé la configuration des sauvegardes" });
  assert.equal(r.actions[0].type, 'update_task');
  assert.match(r.actions[0].title, /sauvegardes/);
});

test('le titre ne contient pas la consigne d\'assignation', async () => {
  const r = await api('/api/chat', 'POST', { message: "Renouveler le certificat SSL, assigne à Léa" });
  assert.equal(r.actions[0].title, 'Renouveler le certificat SSL');
});

test('réordonner une colonne : position persistée, non journalisée ; changement de statut journalisé', async () => {
  const before = db.prepare('SELECT COUNT(*) c FROM activity').get().c;
  await api('/api/tasks/2', 'PATCH', { position: 500 });
  assert.equal(db.prepare('SELECT position FROM tasks WHERE id = 2').get().position, 500);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity').get().c, before, 'réordonner ne pollue pas le journal');
  await api('/api/tasks/2', 'PATCH', { status: 'doing', position: 250 });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM activity').get().c, before + 1);
  const created = await api('/api/tasks', 'POST', { title: 'Nouvelle carte' });
  const tasks = (await api('/api/bootstrap')).tasks;
  assert.equal(tasks.find(t => t.id === created.id).position, Math.max(...tasks.map(t => t.position)), 'une nouvelle carte arrive en fin de colonne');
});
