import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now, tokens } from './util.js';

export const STATUSES = ['todo', 'doing', 'review', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const LINK_TYPES = ['relates', 'blocks', 'duplicates'];

/** Base par défaut : <projet>/data/workforce.db, quel que soit le dossier de lancement. DB_PATH explicite = relatif au dossier courant. */
const DEFAULT_DB = fileURLToPath(new URL('../data/workforce.db', import.meta.url));
export function openDb(path = process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULT_DB) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT DEFAULT '#6366f1');
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, team_id INTEGER REFERENCES teams(id),
      role TEXT DEFAULT '', skills TEXT DEFAULT '[]', capacity_h INTEGER DEFAULT 30);
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, key TEXT UNIQUE NOT NULL,
      description TEXT DEFAULT '', keywords TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
      assignee_id INTEGER REFERENCES members(id), team_id INTEGER REFERENCES teams(id),
      project_id INTEGER REFERENCES projects(id), labels TEXT DEFAULT '[]',
      due_date TEXT, estimate_h REAL, created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL, created_at TEXT, UNIQUE(from_id, to_id, type));
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY, ts TEXT, actor TEXT, batch_id TEXT, task_id INTEGER,
      action TEXT, before TEXT, after TEXT, undone INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS squads (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, mission TEXT DEFAULT '', color TEXT DEFAULT '#6366f1',
      lead_id INTEGER REFERENCES members(id) ON DELETE SET NULL, max_active_features INTEGER DEFAULT 3);
    CREATE TABLE IF NOT EXISTS features (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, outcome TEXT DEFAULT '', squad_id INTEGER NOT NULL REFERENCES squads(id),
      project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'discovery',
      target_date TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS feature_deps (
      id INTEGER PRIMARY KEY, from_feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      to_feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE, note TEXT DEFAULT '',
      UNIQUE(from_feature_id, to_feature_id));
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, created_at TEXT, expires_at TEXT);
    CREATE TABLE IF NOT EXISTS auth_flows (
      state TEXT PRIMARY KEY, provider TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, created_at TEXT);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      task_id INTEGER, feature_id INTEGER, actor TEXT, text TEXT NOT NULL, created_at TEXT, read_at TEXT);
    CREATE INDEX IF NOT EXISTS notifications_member ON notifications(member_id, read_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(title, description, labels,
      tokenize = 'unicode61 remove_diacritics 2');
  `);
  // Migrations additives (bases créées avant l'arrivée des squads / features)
  const addCol = (t, c, ddl) => { if (!db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${ddl}`); };
  addCol('tasks', 'position', 'REAL');
  addCol('tasks', 'feature_id', 'INTEGER REFERENCES features(id) ON DELETE SET NULL');
  addCol('members', 'squad_id', 'INTEGER REFERENCES squads(id) ON DELETE SET NULL');
  addCol('members', 'loan_squad_id', 'INTEGER REFERENCES squads(id) ON DELETE SET NULL');
  addCol('members', 'loan_pct', 'INTEGER DEFAULT 0');
  addCol('members', 'email', 'TEXT');
  addCol('members', 'is_admin', 'INTEGER DEFAULT 0');
  addCol('tasks', 'inbox_squad_id', 'INTEGER REFERENCES squads(id) ON DELETE SET NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS members_email ON members(lower(email)) WHERE email IS NOT NULL');
  // Inbox ciblée : les tâches sans feature déjà présentes sont routées vers la squad de leur assigné
  db.exec(`UPDATE tasks SET inbox_squad_id = (SELECT squad_id FROM members WHERE members.id = tasks.assignee_id)
           WHERE feature_id IS NULL AND inbox_squad_id IS NULL AND assignee_id IS NOT NULL`);
  db.exec('UPDATE tasks SET position = id * 1000 WHERE position IS NULL');
  return db;
}

export const parseTask = t => t && ({ ...t, labels: JSON.parse(t.labels || '[]') });

/** Index plein texte d'une tâche (appelé à chaque écriture). */
export function reindex(db, id) {
  db.prepare('DELETE FROM tasks_fts WHERE rowid = ?').run(id);
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!t) return;
  db.prepare('INSERT INTO tasks_fts(rowid, title, description, labels) VALUES (?,?,?,?)')
    .run(id, t.title, t.description || '', JSON.parse(t.labels || '[]').join(' '));
}

/** Candidats proches d'un texte : pré-filtre FTS5 (jamais tout le backlog vers le LLM). */
export function candidates(db, text, { exclude = [], limit = 6 } = {}) {
  const toks = [...new Set(tokens(text))].slice(0, 12);
  if (!toks.length) return [];
  const q = toks.map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ');
  const rows = db.prepare(
    `SELECT t.*, bm25(tasks_fts) AS rank FROM tasks_fts JOIN tasks t ON t.id = tasks_fts.rowid
     WHERE tasks_fts MATCH ? ORDER BY rank LIMIT ?`).all(q, limit + exclude.length);
  return rows.filter(r => !exclude.includes(r.id)).slice(0, limit).map(parseTask);
}

export function logActivity(db, { actor, batch, task_id, action, before = null, after = null }) {
  return Number(db.prepare('INSERT INTO activity(ts, actor, batch_id, task_id, action, before, after) VALUES (?,?,?,?,?,?,?)')
    .run(now(), actor, batch || null, task_id ?? null, action,
      before && JSON.stringify(before), after && JSON.stringify(after)).lastInsertRowid);
}

/** Fenêtre de planification : la charge compare le travail des N prochains jours à N/7 semaines de capacité. */
export const HORIZON_DAYS = 14;
export function workload(db) {
  const weeks = HORIZON_DAYS / 7;
  const rows = db.prepare(`
    SELECT m.id, m.name, m.role, m.capacity_h, m.team_id, t.name AS team,
      COALESCE(SUM(CASE WHEN k.status != 'done' AND (k.status IN ('doing', 'review') OR (k.due_date IS NOT NULL AND k.due_date <= date('now', 'localtime', '+${HORIZON_DAYS} days')))
        THEN COALESCE(k.estimate_h, 4) END), 0) AS load_h,
      COUNT(CASE WHEN k.status != 'done' THEN 1 END) AS open_tasks,
      COUNT(CASE WHEN k.status != 'done' AND k.due_date < date('now', 'localtime') THEN 1 END) AS overdue
    FROM members m LEFT JOIN teams t ON t.id = m.team_id LEFT JOIN tasks k ON k.assignee_id = m.id
    GROUP BY m.id ORDER BY m.name`).all();
  return rows.map(r => { const win = Math.round(r.capacity_h * weeks); return { ...r, window_h: win, window_days: HORIZON_DAYS, pct: win ? Math.round((r.load_h / win) * 100) : 0 }; });
}

/** Tâches bloquées = au moins un "bloquant" non terminé pointe vers elles. */
export function blockedIds(db) {
  return db.prepare(`SELECT DISTINCT l.to_id AS id FROM links l JOIN tasks b ON b.id = l.from_id
    WHERE l.type = 'blocks' AND b.status != 'done'`).all().map(r => r.id);
}

export const loadSetting = (db, key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
export const saveSetting = (db, key, v) => db.prepare('INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v));
