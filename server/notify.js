// Notifications dans l'application : qui doit être prévenu de quoi. Jamais l'auteur de l'action lui-même.
import { now } from './util.js';

const q = (db, sql, ...p) => db.prepare(sql).get(...p);

/** Crée une notification par destinataire (sans l'auteur, sans doublon non lu récent). */
export function notify(db, { to, kind, task_id = null, feature_id = null, actor = null, text }) {
  const since = new Date(Date.now() - 120_000).toISOString();
  for (const id of new Set([].concat(to).filter(Boolean))) {
    const m = q(db, 'SELECT name FROM members WHERE id = ?', id);
    if (!m || (actor && m.name.toLowerCase() === String(actor).toLowerCase())) continue;
    if (q(db, 'SELECT 1 FROM notifications WHERE member_id = ? AND kind = ? AND task_id IS ? AND feature_id IS ? AND text = ? AND read_at IS NULL AND created_at > ?', id, kind, task_id, feature_id, text, since)) continue;
    db.prepare('INSERT INTO notifications(member_id, kind, task_id, feature_id, actor, text, created_at) VALUES (?,?,?,?,?,?,?)').run(id, kind, task_id, feature_id, actor, text, now());
  }
}

export const leadOf = (db, squadId) => squadId ? q(db, 'SELECT lead_id FROM squads WHERE id = ?', squadId)?.lead_id ?? null : null;
export const squadOfMember = (db, id) => id ? q(db, 'SELECT squad_id FROM members WHERE id = ?', id)?.squad_id ?? null : null;
export const adminIds = db => db.prepare('SELECT id FROM members WHERE is_admin = 1').all().map(r => r.id);
const label = t => `« ${String(t).length > 60 ? String(t).slice(0, 57) + '…' : t} »`;
const PRIO = { low: 'Basse', medium: 'Moyenne', high: 'Haute', urgent: 'Urgente' };
const STATUS = { todo: 'À faire', doing: 'En cours', review: 'En revue', done: 'Terminé' };

/** Réponses aux événements sur les tâches. `before` = ligne avant modification (ou null à la création), `after` = ligne après. */
export function notifyTaskChange(db, { before, after, actor }) {
  const t = label(after.title);
  const featureSquad = after.feature_id ? q(db, 'SELECT squad_id FROM features WHERE id = ?', after.feature_id)?.squad_id : null;
  const base = { task_id: after.id, actor };
  if (after.assignee_id && after.assignee_id !== before?.assignee_id)
    notify(db, { ...base, to: after.assignee_id, kind: 'assigned', text: `${actor} vous a assigné ${t}` });
  if (before?.assignee_id && before.assignee_id !== after.assignee_id)
    notify(db, { ...base, to: before.assignee_id, kind: 'unassigned', text: `${actor} a retiré ${t} de vos tâches` });
  if (before && after.assignee_id && after.assignee_id === before.assignee_id) {
    if (after.status !== before.status) notify(db, { ...base, to: after.assignee_id, kind: 'changed', text: `${actor} a passé ${t} en « ${STATUS[after.status]} »` });
    else if (after.priority !== before.priority) notify(db, { ...base, to: after.assignee_id, kind: 'changed', text: `${actor} a changé la priorité de ${t} : ${PRIO[after.priority]}` });
    else if (after.due_date !== before.due_date) notify(db, { ...base, to: after.assignee_id, kind: 'changed', text: `${actor} a changé l’échéance de ${t}${after.due_date ? ` : ${after.due_date}` : ' (retirée)'}` });
  }
  // Tâche sans feature : le lead de la squad destinataire doit la trier
  if (!after.feature_id && after.inbox_squad_id && after.inbox_squad_id !== before?.inbox_squad_id && after.status !== 'done')
    notify(db, { ...base, to: leadOf(db, after.inbox_squad_id), kind: 'inbox', text: `Nouvelle tâche à trier dans l’Inbox de votre squad : ${t}` });
  // Aucune squad destinataire (auteur sans squad, personne non assignée) : repli sur les administrateurs, sinon personne ne la verrait
  if (!after.feature_id && !after.inbox_squad_id && after.status !== 'done' && (!before || before.feature_id || before.inbox_squad_id))
    notify(db, { ...base, to: adminIds(db), kind: 'inbox', text: `Tâche sans feature ni squad destinataire, à router : ${t}` });
  // Tâche rattachée à une feature : prévenir le lead de la squad propriétaire
  if (after.feature_id && after.feature_id !== before?.feature_id)
    notify(db, { ...base, to: leadOf(db, featureSquad), feature_id: after.feature_id, kind: 'feature_task', text: `${actor} a rattaché ${t} à votre feature « ${q(db, 'SELECT name FROM features WHERE id = ?', after.feature_id)?.name} »` });
}

/** Une tâche terminée libère celles qu'elle bloquait. */
export function notifyUnblocked(db, doneTask, actor) {
  const blocked = db.prepare("SELECT t.* FROM links l JOIN tasks t ON t.id = l.to_id WHERE l.from_id = ? AND l.type = 'blocks' AND t.status != 'done'").all(doneTask.id);
  for (const b of blocked) {
    const stillBlocked = q(db, "SELECT 1 FROM links l JOIN tasks x ON x.id = l.from_id WHERE l.to_id = ? AND l.type = 'blocks' AND x.status != 'done'", b.id);
    if (stillBlocked) continue;
    const squad = b.feature_id ? q(db, 'SELECT squad_id FROM features WHERE id = ?', b.feature_id)?.squad_id : null;
    notify(db, { to: [b.assignee_id, leadOf(db, squad)], kind: 'unblocked', task_id: b.id, actor, text: `${label(b.title)} n’est plus bloquée : ${label(doneTask.title)} est terminée` });
  }
}

export function notifyBlocked(db, { blocker, blocked, actor }) {
  const squad = blocked.feature_id ? q(db, 'SELECT squad_id FROM features WHERE id = ?', blocked.feature_id)?.squad_id : null;
  notify(db, { to: [blocked.assignee_id, leadOf(db, squad)], kind: 'blocked', task_id: blocked.id, actor, text: `${label(blocker.title)} bloque désormais ${label(blocked.title)}` });
}

export function notifyDeleted(db, task, actor) {
  notify(db, { to: task.assignee_id, kind: 'deleted', actor, text: `${actor} a supprimé ${label(task.title)}, qui vous était assignée` });
}

/* ---------- Lecture ---------- */
export function notificationsFor(db, memberId, limit = 30) {
  if (!memberId) return { unread: 0, items: [] };
  return {
    unread: q(db, 'SELECT COUNT(*) c FROM notifications WHERE member_id = ? AND read_at IS NULL', memberId).c,
    items: db.prepare('SELECT * FROM notifications WHERE member_id = ? ORDER BY id DESC LIMIT ?').all(memberId, limit),
  };
}

export function markRead(db, memberId, { ids, all }) {
  if (all) return db.prepare('UPDATE notifications SET read_at = ? WHERE member_id = ? AND read_at IS NULL').run(now(), memberId).changes;
  let n = 0;
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) n += db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND member_id = ? AND read_at IS NULL').run(now(), Number(id), memberId).changes;
  return n;
}
