// Administration de l'organisation réelle : personnes, projets, fonctions, export, démo, remise à zéro.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logActivity } from './db.js';
import { tx } from './actions.js';
import { seed } from './seed.js';
import { HttpError, localDate, now } from './util.js';

const row = (db, sql, ...p) => db.prepare(sql).get(...p);
const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);
const log = (db, actor, action, after) => logActivity(db, { actor, action, after });
const need = (db, table, id, label) => row(db, `SELECT * FROM ${table} WHERE id = ?`, +id) || (() => { throw new HttpError(`${label} introuvable`, 404); })();
const COLOR = /^#[0-9a-f]{6}$/i;

/* ---------- Personnes ---------- */
export function createMember(db, d, actor) {
  const name = clean(d.name, 80);
  if (!name) throw new HttpError('Le nom est obligatoire');
  if (row(db, 'SELECT 1 FROM members WHERE lower(name) = lower(?)', name)) throw new HttpError('Une personne porte déjà ce nom');
  const team = d.team_id ? need(db, 'teams', d.team_id, 'Fonction').id : null;
  const email = d.email == null || d.email === '' ? null : clean(d.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Adresse e-mail invalide');
  if (email && row(db, 'SELECT 1 FROM members WHERE lower(email) = ?', email)) throw new HttpError('Cette adresse e-mail est déjà utilisée');
  const cap = d.capacity_h == null || d.capacity_h === '' ? 30 : Number(d.capacity_h);
  if (!Number.isFinite(cap) || cap < 0 || cap > 80) throw new HttpError('Capacité invalide (0 à 80 h par semaine)');
  return tx(db, () => {
    const id = Number(db.prepare('INSERT INTO members(name, team_id, role, skills, capacity_h, email) VALUES (?,?,?,?,?,?)')
      .run(name, team, clean(d.role, 60), JSON.stringify((Array.isArray(d.skills) ? d.skills : []).map(s => clean(s, 30)).filter(Boolean).slice(0, 12)), cap, email).lastInsertRowid);
    if (d.squad_id) db.prepare('UPDATE members SET squad_id = ? WHERE id = ?').run(need(db, 'squads', d.squad_id, 'Squad').id, id);
    log(db, actor, 'member_create', { name });
    return id;
  });
}

/** Retire une personne : ses tâches redeviennent « non assignées ». Refusé si elle est lead (désigner un successeur d'abord). */
export function deleteMember(db, id, actor) {
  return tx(db, () => {
    const m = need(db, 'members', id, 'Personne');
    const led = row(db, 'SELECT name FROM squads WHERE lead_id = ?', m.id);
    if (led) throw new HttpError(`${m.name} est lead de « ${led.name} » : désignez d’abord un autre lead.`);
    const n = db.prepare('UPDATE tasks SET assignee_id = NULL WHERE assignee_id = ?').run(m.id).changes;
    db.prepare('DELETE FROM members WHERE id = ?').run(m.id);
    log(db, actor, 'member_delete', { name: m.name, tasks_unassigned: n });
  });
}

/* ---------- Projets ---------- */
const keyOf = (name) => clean(name, 40).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 5) || 'PRJ';

export function createProject(db, d, actor) {
  const name = clean(d.name, 80);
  if (!name) throw new HttpError('Le nom du projet est obligatoire');
  const key = clean(d.key || keyOf(name), 6).toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(key)) throw new HttpError('La clé du projet doit faire 2 à 6 lettres ou chiffres');
  if (row(db, 'SELECT 1 FROM projects WHERE lower(name) = lower(?)', name)) throw new HttpError('Un projet porte déjà ce nom');
  if (row(db, 'SELECT 1 FROM projects WHERE key = ?', key)) throw new HttpError(`La clé « ${key} » est déjà prise`);
  const id = Number(db.prepare('INSERT INTO projects(name, key, description, keywords) VALUES (?,?,?,?)').run(name, key, clean(d.description, 300), clean(d.keywords, 300)).lastInsertRowid);
  log(db, actor, 'project_create', { name });
  return id;
}

export function updateProject(db, id, d, actor) {
  const p = need(db, 'projects', id, 'Projet');
  if (d.name != null) {
    const name = clean(d.name, 80); if (!name) throw new HttpError('Le nom du projet est obligatoire');
    if (row(db, 'SELECT 1 FROM projects WHERE lower(name) = lower(?) AND id != ?', name, p.id)) throw new HttpError('Un projet porte déjà ce nom');
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, p.id);
  }
  if (d.key != null) {
    const key = clean(d.key, 6).toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(key)) throw new HttpError('La clé du projet doit faire 2 à 6 lettres ou chiffres');
    if (row(db, 'SELECT 1 FROM projects WHERE key = ? AND id != ?', key, p.id)) throw new HttpError(`La clé « ${key} » est déjà prise`);
    db.prepare('UPDATE projects SET key = ? WHERE id = ?').run(key, p.id);
  }
  for (const k of ['description', 'keywords']) if (d[k] != null) db.prepare(`UPDATE projects SET ${k} = ? WHERE id = ?`).run(clean(d[k], 300), p.id);
  log(db, actor, 'project_update', { name: d.name ?? p.name });
}

export function deleteProject(db, id, actor) {
  tx(db, () => {
    const p = need(db, 'projects', id, 'Projet');
    db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(p.id);
    db.prepare('UPDATE features SET project_id = NULL WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    log(db, actor, 'project_delete', { name: p.name });
  });
}

/* ---------- Fonctions (Dev, Infra, Sécurité…) ---------- */
export function createTeam(db, d, actor) {
  const name = clean(d.name, 40);
  if (!name) throw new HttpError('Le nom de la fonction est obligatoire');
  if (row(db, 'SELECT 1 FROM teams WHERE lower(name) = lower(?)', name)) throw new HttpError('Une fonction porte déjà ce nom');
  const id = Number(db.prepare('INSERT INTO teams(name, color) VALUES (?,?)').run(name, COLOR.test(d.color || '') ? d.color : '#64748b').lastInsertRowid);
  log(db, actor, 'team_create', { name });
  return id;
}

export function updateTeam(db, id, d, actor) {
  const t = need(db, 'teams', id, 'Fonction');
  if (d.name != null) {
    const name = clean(d.name, 40); if (!name) throw new HttpError('Le nom de la fonction est obligatoire');
    if (row(db, 'SELECT 1 FROM teams WHERE lower(name) = lower(?) AND id != ?', name, t.id)) throw new HttpError('Une fonction porte déjà ce nom');
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, t.id);
  }
  if (d.color != null) { if (!COLOR.test(d.color)) throw new HttpError('Couleur invalide'); db.prepare('UPDATE teams SET color = ? WHERE id = ?').run(d.color, t.id); }
  log(db, actor, 'team_update', { name: d.name ?? t.name });
}

export function deleteTeam(db, id, actor) {
  tx(db, () => {
    const t = need(db, 'teams', id, 'Fonction');
    db.prepare('UPDATE members SET team_id = NULL WHERE team_id = ?').run(t.id);
    db.prepare('UPDATE tasks SET team_id = NULL WHERE team_id = ?').run(t.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);
    log(db, actor, 'team_delete', { name: t.name });
  });
}

/* ---------- Données : export, démo, remise à zéro ---------- */
const TABLES = ['teams', 'members', 'projects', 'squads', 'features', 'feature_deps', 'tasks', 'links', 'activity'];

/** Export JSON complet (la table des réglages, qui contient la clé API, n'en fait jamais partie). */
export function exportAll(db) {
  return { app: 'WorkForce', exported_at: now(), ...Object.fromEntries(TABLES.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()])) };
}

export const isEmpty = db => ['members', 'tasks', 'squads', 'projects', 'teams'].every(t => row(db, `SELECT COUNT(*) c FROM ${t}`).c === 0);

export function loadDemo(db) {
  if (!isEmpty(db)) throw new HttpError('Les données de démonstration ne se chargent que sur une base vide.', 409);
  tx(db, () => { seed(db); db.prepare('UPDATE tasks SET position = id * 1000 WHERE position IS NULL').run(); });
}

/** Efface toute l'organisation et les tâches (les réglages LLM restent). Une sauvegarde est écrite avant, si la base est un fichier. */
export function resetAll(db, confirm, actor) {
  if (confirm !== 'EFFACER') throw new HttpError('Confirmation manquante : tapez EFFACER');
  let backup = null;
  const file = db.location();
  if (file) {
    backup = join(dirname(file), 'backups', `workforce-${localDate()}-${Date.now()}.db`);
    mkdirSync(dirname(backup), { recursive: true });
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  tx(db, () => {
    for (const t of ['links', 'feature_deps', 'activity', 'tasks_fts', 'tasks', 'features']) db.exec(`DELETE FROM ${t}`);
    db.exec('UPDATE members SET squad_id = NULL, loan_squad_id = NULL; UPDATE squads SET lead_id = NULL');
    for (const t of ['squads', 'members', 'projects', 'teams']) db.exec(`DELETE FROM ${t}`);
    log(db, actor, 'reset', { backup });
  });
  return { backup };
}
