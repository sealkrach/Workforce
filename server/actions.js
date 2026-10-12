// Actions métier : résolution des noms -> ids, aperçu lisible, exécution, annulation.
// Le LLM ne touche jamais la base directement : il propose, l'humain confirme.
import { parseTask, reindex, logActivity, STATUSES, PRIORITIES, LINK_TYPES } from './db.js';
import { strip, tokens, coverage, now, HttpError, isRealDate } from './util.js';
import { notifyTaskChange, notifyUnblocked, notifyBlocked, notifyDeleted, squadOfMember } from './notify.js';

const FIELDS = ['title', 'description', 'status', 'priority', 'assignee_id', 'team_id', 'project_id', 'labels', 'due_date', 'estimate_h', 'position', 'feature_id'];
export const STATUS_FR = { todo: 'À faire', doing: 'En cours', review: 'En revue', done: 'Terminé' };
export const PRIO_FR = { low: 'Basse', medium: 'Moyenne', high: 'Haute', urgent: 'Urgente' };

function fuzzy(list, q, keys) {
  if (q == null || q === '') return null;
  const s = strip(String(q)).trim();
  return list.find(x => keys.some(k => strip(x[k] || '') === s))
    || list.find(x => keys.some(k => strip(x[k] || '').includes(s) || (s.length > 2 && s.includes(strip(x[k] || '')) && strip(x[k] || '').length > 2)))
    || null;
}

export function context(db, user) {
  return {
    db, user,
    members: db.prepare('SELECT * FROM members').all(),
    teams: db.prepare('SELECT * FROM teams').all(),
    projects: db.prepare('SELECT * FROM projects').all(),
    squads: db.prepare('SELECT * FROM squads').all(),
    features: db.prepare('SELECT * FROM features').all(),
  };
}

export function resolveMember(ctx, q) {
  if (/^(moi|me|je|j'|moi-meme|self)$/i.test(String(q ?? '').trim())) return ctx.user || null;
  return fuzzy(ctx.members, q, ['name']) || ctx.members.find(m => strip(m.name).split(' ').some(p => p === strip(String(q ?? '')))) || null;
}
export const resolveTeam = (ctx, q) => fuzzy(ctx.teams, q, ['name']);
export const resolveProject = (ctx, q) => fuzzy(ctx.projects, q, ['name', 'key']);
export const resolveFeature = (ctx, q) => fuzzy(ctx.features, q, ['name']);

/** Feature la plus proche d'un texte (nom + résultat attendu + intitulés de ses tâches). Préfère les features de la squad de l'assigné. */
export function guessFeature(ctx, text, assigneeId) {
  const titles = ctx.db.prepare('SELECT feature_id, title FROM tasks WHERE feature_id IS NOT NULL').all();
  const mySquad = ctx.members.find(m => m.id === assigneeId)?.squad_id;
  let best = null, bestScore = 0;
  for (const f of ctx.features.filter(f => f.status !== 'live')) {
    const doc = `${f.name} ${f.outcome} ${titles.filter(t => t.feature_id === f.id).map(t => t.title).join(' ')}`;
    const { matched, score } = coverage(text, doc);
    const s = score + (mySquad && f.squad_id === mySquad ? 0.15 : 0);
    if (matched >= 2 && score >= 0.3 && s > bestScore) { best = f; bestScore = s; }
  }
  return best;
}

/** Classification de repli par mots-clés quand le LLM ne propose pas de projet. */
export function guessProject(ctx, text) {
  const tk = new Set(tokens(text));
  let best = null, score = 0;
  for (const p of ctx.projects) {
    const kw = new Set(tokens(`${p.keywords} ${p.name}`));
    const s = [...tk].filter(t => kw.has(t)).length;
    if (s > score) { best = p; score = s; }
  }
  return best;
}

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
const labelOf = (ctx, f, v) => v == null ? '—' :
  f === 'assignee_id' ? ctx.members.find(m => m.id === v)?.name :
  f === 'team_id' ? ctx.teams.find(t => t.id === v)?.name :
  f === 'project_id' ? ctx.projects.find(p => p.id === v)?.name :
  f === 'feature_id' ? ctx.features.find(x => x.id === v)?.name :
  f === 'status' ? STATUS_FR[v] : f === 'priority' ? PRIO_FR[v] :
  f === 'labels' ? v.join(', ') || '—' : f === 'estimate_h' ? `${v} h` : v;
const FIELD_FR = { title: 'Titre', description: 'Description', status: 'Statut', priority: 'Priorité', assignee_id: 'Assigné à',
  team_id: 'Fonction', project_id: 'Projet', feature_id: 'Feature', labels: 'Étiquettes', due_date: 'Échéance', estimate_h: 'Estimation' };

/** Convertit les arguments bruts d'un appel d'outil en patch validé (ids résolus) + avertissements. */
function toPatch(ctx, a, warnings) {
  const p = {};
  if (a.title != null) p.title = String(a.title).trim().slice(0, 200);
  if (a.description != null) p.description = String(a.description).trim();
  if (a.status != null) {
    const s = strip(String(a.status));
    const map = { todo: 'todo', 'a faire': 'todo', backlog: 'todo', doing: 'doing', 'en cours': 'doing', review: 'review', 'en revue': 'review', revue: 'review', done: 'done', termine: 'done', fini: 'done', fait: 'done' };
    if (map[s]) p.status = map[s]; else warnings.push(`Statut inconnu « ${a.status} » ignoré`);
  }
  if (a.priority != null) {
    const s = strip(String(a.priority));
    const map = { low: 'low', basse: 'low', faible: 'low', medium: 'medium', moyenne: 'medium', normale: 'medium', high: 'high', haute: 'high', elevee: 'high', urgent: 'urgent', urgente: 'urgent', critique: 'urgent' };
    if (map[s]) p.priority = map[s]; else warnings.push(`Priorité inconnue « ${a.priority} » ignorée`);
  }
  if (a.assignee !== undefined) {
    if (a.assignee === null || a.assignee === '') p.assignee_id = null;
    else { const m = resolveMember(ctx, a.assignee); if (m) p.assignee_id = m.id; else warnings.push(`Personne introuvable : « ${a.assignee} »`); }
  }
  if (a.team != null) { const t = resolveTeam(ctx, a.team); if (t) p.team_id = t.id; else warnings.push(`Équipe introuvable : « ${a.team} »`); }
  if (a.feature !== undefined) {
    if (a.feature === null || a.feature === '') p.feature_id = null;
    else { const f = resolveFeature(ctx, a.feature); if (f) p.feature_id = f.id; else warnings.push(`Feature introuvable : « ${a.feature} »`); }
  }
  if (a.project != null) { const t = resolveProject(ctx, a.project); if (t) p.project_id = t.id; else warnings.push(`Projet introuvable : « ${a.project} »`); }
  if (a.labels != null) p.labels = [...new Set([].concat(a.labels).map(l => String(l).trim().toLowerCase()).filter(Boolean))].slice(0, 8);
  if (a.due_date !== undefined) {
    if (a.due_date === null || a.due_date === '') p.due_date = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a.due_date)) p.due_date = a.due_date; else warnings.push(`Date invalide « ${a.due_date} »`);
  }
  if (a.estimate_h != null && isFinite(+a.estimate_h)) p.estimate_h = Math.max(0, +a.estimate_h);
  return p;
}

/** Valide une action proposée et construit son aperçu. Retourne null si inexploitable. */
export function normalize(ctx, type, args) {
  const warnings = [];
  const { db } = ctx;
  if (type === 'create_task') {
    const patch = toPatch(ctx, args, warnings);
    if (!patch.title) return null;
    const auto = [];
    if (patch.assignee_id && !patch.team_id) patch.team_id = ctx.members.find(m => m.id === patch.assignee_id)?.team_id;
    if (patch.feature_id === undefined) { const g = guessFeature(ctx, `${patch.title} ${patch.description || ''}`, patch.assignee_id); if (g) { patch.feature_id = g.id; auto.push('feature_id'); } }
    const feat = patch.feature_id && ctx.features.find(f => f.id === patch.feature_id);
    if (feat && !patch.project_id && feat.project_id) { patch.project_id = feat.project_id; auto.push('project_id'); }
    if (!patch.project_id) { const g = guessProject(ctx, `${patch.title} ${patch.description || ''}`); if (g) { patch.project_id = g.id; auto.push('project_id'); } }
    patch.status ||= 'todo'; patch.priority ||= 'medium'; patch.labels ||= [];
    const rows = Object.entries(patch).filter(([k, v]) => k !== 'title' && v != null && !(Array.isArray(v) && !v.length) && !(k === 'status' && v === 'todo') && !(k === 'priority' && v === 'medium'))
      .flatMap(([k, v]) => [{ field: FIELD_FR[k], value: labelOf(ctx, k, v), auto: auto.includes(k) },
        ...(k === 'feature_id' ? [{ field: 'Squad', value: ctx.squads.find(q => q.id === feat?.squad_id)?.name || '—', auto: auto.includes(k) }] : [])]);
    if (patch.feature_id == null) {
      const sqId = routeInbox(ctx.db, patch.assignee_id, ctx.user?.name);
      const sq = ctx.squads.find(x => x.id === sqId);
      if (sqId) patch.inbox_squad_id = sqId;
      warnings.push(sq ? `Aucune feature trouvée : la tâche ira dans l’Inbox de la squad « ${sq.name} », à trier par son lead` : 'Aucune feature trouvée : la tâche ira dans l’Inbox à trier par un lead');
    }
    return { type, patch, title: patch.title, rows, warnings, links: [] };
  }
  if (type === 'update_task') {
    const id = +args.id;
    const cur = parseTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
    if (!cur) return { type, invalid: `Tâche #${args.id} introuvable`, warnings };
    const patch = toPatch(ctx, args, warnings);
    const rows = Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(cur[k]))
      .map(([k, v]) => ({ field: FIELD_FR[k], from: labelOf(ctx, k, cur[k]), value: labelOf(ctx, k, v) }));
    if (!rows.length) return { type, invalid: `Rien à changer sur #${id}`, warnings };
    return { type, id, patch, title: cur.title, rows, warnings };
  }
  if (type === 'link_tasks') {
    const a = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(+args.from_id);
    const b = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(+args.to_id);
    const lt = LINK_TYPES.includes(args.type) ? args.type : 'relates';
    if (!a || !b || a.id === b.id) return { type, invalid: 'Lien impossible : tâches introuvables', warnings };
    return { type, from_id: a.id, to_id: b.id, link_type: lt, from_title: a.title, to_title: b.title, warnings };
  }
  return null;
}

const serialize = p => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === 'labels' ? JSON.stringify(v) : v ?? null]));

/** Exécute `fn` dans une transaction (réentrant) : tout ou rien. */
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const REF_TABLES = { assignee_id: ['members', 'Personne'], team_id: ['teams', 'Fonction'], project_id: ['projects', 'Projet'], feature_id: ['features', 'Feature'], inbox_squad_id: ['squads', 'Squad'] };

/** Squad destinataire d'une tâche sans feature : celle de la personne assignée, à défaut celle de l'auteur. */
export function routeInbox(db, assigneeId, actor) {
  return squadOfMember(db, assigneeId) ?? db.prepare('SELECT squad_id FROM members WHERE lower(name) = lower(?)').get(String(actor || ''))?.squad_id ?? null;
}

/** Valide et nettoie des champs de tâche venant du client (REST ou confirmation du chat). Lève une HttpError 400 sinon. */
export function cleanPatch(db, input, { create = false } = {}) {
  const bad = m => { throw new HttpError(m); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Corps de requête invalide');
  const o = {};
  if (create || 'title' in input) {
    const t = String(input.title ?? '').trim();
    if (!t) bad('Le titre est obligatoire');
    if (t.length > 200) bad('Titre trop long (200 caractères maximum)');
    o.title = t;
  }
  if ('description' in input) o.description = String(input.description ?? '').slice(0, 10_000);
  if ('status' in input) { if (!STATUSES.includes(input.status)) bad(`Statut invalide : « ${input.status} »`); o.status = input.status; }
  if ('priority' in input) { if (!PRIORITIES.includes(input.priority)) bad(`Priorité invalide : « ${input.priority} »`); o.priority = input.priority; }
  for (const [k, [table, label]] of Object.entries(REF_TABLES)) {
    if (!(k in input)) continue;
    const v = input[k];
    if (v === null || v === '') { o[k] = null; continue; }
    const n = Number(v);
    if (!Number.isInteger(n) || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(n)) bad(`${label} introuvable`);
    o[k] = n;
  }
  if ('labels' in input) {
    if (!Array.isArray(input.labels)) bad('Les étiquettes doivent être une liste');
    o.labels = [...new Set(input.labels.map(l => String(l).trim().toLowerCase().slice(0, 30)).filter(Boolean))].slice(0, 8);
  }
  if ('due_date' in input) {
    if (input.due_date === null || input.due_date === '') o.due_date = null;
    else if (isRealDate(input.due_date)) o.due_date = input.due_date; else bad(`Date invalide : « ${input.due_date} »`);
  }
  if ('estimate_h' in input) {
    if (input.estimate_h === null || input.estimate_h === '') o.estimate_h = null;
    else { const n = Number(input.estimate_h); if (!Number.isFinite(n) || n < 0 || n > 1000) bad('Estimation invalide (0 à 1000 h)'); o.estimate_h = n; }
  }
  if ('position' in input) { const n = Number(input.position); if (!Number.isFinite(n)) bad('Position invalide'); o.position = n; }
  return o;
}

export function createTask(db, input, actor, batch) {
  const p = serialize({ description: '', labels: [], ...cleanPatch(db, input, { create: true }) });
  return tx(db, () => {
    const inbox = p.feature_id ? null : (p.inbox_squad_id ?? routeInbox(db, p.assignee_id, actor));
    const r = db.prepare(`INSERT INTO tasks(title, description, status, priority, assignee_id, team_id, project_id, labels, due_date, estimate_h, created_by, created_at, updated_at, feature_id, inbox_squad_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.title, p.description, p.status || 'todo', p.priority || 'medium', p.assignee_id ?? null,
      p.team_id ?? null, p.project_id ?? null, p.labels, p.due_date ?? null, p.estimate_h ?? null, actor, now(), now(), p.feature_id ?? null, inbox);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE tasks SET position = (SELECT COALESCE(MAX(position), 0) + 1000 FROM tasks) WHERE id = ?').run(id);
    reindex(db, id);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    logActivity(db, { actor, batch, task_id: id, action: 'create', after: parseTask(row) });
    notifyTaskChange(db, { before: null, after: row, actor });
    return id;
  });
}

export function updateTask(db, id, input, actor, batch) {
  const p = serialize(cleanPatch(db, input));
  return tx(db, () => {
    const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!before) throw new HttpError(`Tâche #${id} introuvable`, 404);
    // Inbox ciblée : rattacher à une feature sort la tâche de l'Inbox ; la retirer (ou changer l'assigné d'une tâche sans feature) la re-route
    if ('feature_id' in p) {
      if (p.feature_id != null) p.inbox_squad_id = null;
      else if (!('inbox_squad_id' in p)) p.inbox_squad_id = routeInbox(db, 'assignee_id' in p ? p.assignee_id : before.assignee_id, actor);
    } else if ('assignee_id' in p && before.feature_id == null && !('inbox_squad_id' in p)) p.inbox_squad_id = routeInbox(db, p.assignee_id, actor) ?? before.inbox_squad_id;
    const keys = Object.keys(p);
    if (!keys.length) return;
    db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => p[k]), now(), id);
    reindex(db, id);
    if (keys.length === 1 && keys[0] === 'position') return;   // réordonner une colonne n'est pas un événement métier
    logActivity(db, { actor, batch, task_id: id, action: 'update', before: Object.fromEntries(keys.map(k => [k, before[k]])), after: p });
    const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    notifyTaskChange(db, { before, after, actor });
    if (before.status !== 'done' && after.status === 'done') notifyUnblocked(db, after, actor);
  });
}

export function addLink(db, from_id, to_id, type, actor, batch) {
  from_id = Number(from_id); to_id = Number(to_id);
  if (!LINK_TYPES.includes(type)) throw new HttpError(`Type de lien invalide : « ${type} »`);
  if (from_id === to_id) throw new HttpError('Une tâche ne peut pas être liée à elle-même');
  for (const id of [from_id, to_id]) if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id)) throw new HttpError(`Tâche #${id} introuvable`, 404);
  return tx(db, () => {
    const r = db.prepare('INSERT OR IGNORE INTO links(from_id, to_id, type, created_at) VALUES (?,?,?,?)').run(from_id, to_id, type, now());
    if (!r.changes) return null;
    const id = Number(r.lastInsertRowid);
    logActivity(db, { actor, batch, task_id: from_id, action: 'link', after: { id, from_id, to_id, type } });
    if (type === 'blocks') notifyBlocked(db, { blocker: db.prepare('SELECT * FROM tasks WHERE id = ?').get(from_id), blocked: db.prepare('SELECT * FROM tasks WHERE id = ?').get(to_id), actor });
    return id;
  });
}

export function removeLink(db, id, actor, batch) {
  const l = db.prepare('SELECT * FROM links WHERE id = ?').get(id);
  if (!l) return;
  tx(db, () => { db.prepare('DELETE FROM links WHERE id = ?').run(id); logActivity(db, { actor, batch, task_id: l.from_id, action: 'unlink', before: l }); });
}

/** Supprime une tâche ; retourne l'id du journal pour permettre de l'annuler. */
export function deleteTask(db, id, actor, batch) {
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!t) throw new HttpError(`Tâche #${id} introuvable`, 404);
    const links = db.prepare('SELECT * FROM links WHERE from_id = ? OR to_id = ?').all(id, id);
    db.prepare('DELETE FROM tasks_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    const logged = logActivity(db, { actor, batch, task_id: id, action: 'delete', before: { task: t, links } });
    notifyDeleted(db, t, actor);
    return logged;
  });
}

/** Exécute une action normalisée (déjà confirmée). Tout est re-validé ici : on ne fait jamais confiance au client. */
export function execute(db, a, actor, batch) {
  if (a.type === 'create_task') {
    const id = createTask(db, a.patch, actor, batch);
    for (const l of (Array.isArray(a.links) ? a.links : []).slice(0, 6)) {
      const other = Number(l?.task_id);
      if (!LINK_TYPES.includes(l?.type) || !db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(other)) continue;   // suggestion périmée : ignorée
      const [from, to] = l.type === 'blocks' && l.direction === 'blocked_by' ? [other, id] : [id, other];
      addLink(db, from, to, l.type, actor, batch);
    }
    return { type: a.type, task_id: id };
  }
  if (a.type === 'update_task') { updateTask(db, Number(a.id), a.patch, actor, batch); return { type: a.type, task_id: Number(a.id) }; }
  if (a.type === 'link_tasks') { addLink(db, a.from_id, a.to_id, a.link_type, actor, batch); return { type: a.type, task_id: Number(a.from_id) }; }
  throw new HttpError(`Action inconnue : ${a.type}`);
}

/* ---------- Annulation ---------- */
const keysOf = r => Object.keys(r.after ? JSON.parse(r.after) : {});

/** Annule des lignes du journal (dans l'ordre inverse). Refuse d'écraser ce que quelqu'un d'autre a fait depuis. */
export function undoRows(db, rows, actor) {
  const conflicts = []; let undone = 0;
  tx(db, () => {
    for (const r of [...rows].sort((a, b) => b.id - a.id)) {
      if (r.undone) continue;
      const before = r.before && JSON.parse(r.before), after = r.after && JSON.parse(r.after);
      const later = r.task_id == null ? [] : db.prepare("SELECT * FROM activity WHERE task_id = ? AND id > ? AND undone = 0 AND action IN ('create','update','delete','link','unlink') AND (batch_id IS NULL OR batch_id != ?)").all(r.task_id, r.id, r.batch_id || '');
      const clash = r.action === 'update' ? later.filter(l => l.action === 'update' && keysOf(l).some(k => keysOf(r).includes(k)) || l.action === 'delete')
        : r.action === 'create' ? later : r.action === 'delete' ? later.filter(l => l.action === 'create') : [];
      if (clash.length) { conflicts.push({ id: r.id, task_id: r.task_id, reason: `modifié depuis par ${[...new Set(clash.map(c => c.actor))].join(', ')}` }); continue; }
      if (r.action === 'create') { db.prepare('DELETE FROM tasks_fts WHERE rowid = ?').run(r.task_id); db.prepare('DELETE FROM tasks WHERE id = ?').run(r.task_id); }
      else if (r.action === 'update') {
        if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(r.task_id)) { conflicts.push({ id: r.id, task_id: r.task_id, reason: 'la tâche n’existe plus' }); continue; }
        const keys = Object.keys(before);
        db.prepare(`UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => before[k]), now(), r.task_id);
        reindex(db, r.task_id);
      }
      else if (r.action === 'link') db.prepare('DELETE FROM links WHERE id = ?').run(after.id);
      else if (r.action === 'unlink') { if (db.prepare('SELECT 1 FROM tasks WHERE id IN (?, ?)').all(before.from_id, before.to_id).length === 2) db.prepare('INSERT OR IGNORE INTO links(id, from_id, to_id, type, created_at) VALUES (?,?,?,?,?)').run(before.id, before.from_id, before.to_id, before.type, before.created_at); }
      else if (r.action === 'delete') {
        const t = before.task;
        db.prepare(`INSERT INTO tasks(id, title, description, status, priority, assignee_id, team_id, project_id, labels, due_date, estimate_h, created_by, created_at, updated_at, position, feature_id, inbox_squad_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(t.id, t.title, t.description, t.status, t.priority, t.assignee_id, t.team_id, t.project_id, t.labels, t.due_date, t.estimate_h, t.created_by, t.created_at, t.updated_at, t.position, t.feature_id, t.inbox_squad_id ?? null);
        reindex(db, t.id);
        for (const l of before.links) if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(l.from_id) && db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(l.to_id))
          db.prepare('INSERT OR IGNORE INTO links(id, from_id, to_id, type, created_at) VALUES (?,?,?,?,?)').run(l.id, l.from_id, l.to_id, l.type, l.created_at);
      } else continue;
      db.prepare('UPDATE activity SET undone = 1 WHERE id = ?').run(r.id);
      undone++;
    }
    if (undone) logActivity(db, { actor, action: 'undo', task_id: rows[0]?.task_id ?? null, after: { count: undone } });
  });
  return { undone, conflicts };
}

export const undoBatch = (db, batch, actor) => undoRows(db, db.prepare('SELECT * FROM activity WHERE batch_id = ?').all(batch), actor);
export const undoActivity = (db, id, actor) => undoRows(db, db.prepare('SELECT * FROM activity WHERE id = ?').all(+id), actor);
