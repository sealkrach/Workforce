// Squads (micro-équipes 3–5 + lead) et features : modèle, santé calculée, garde-fous, couplage.
import { logActivity, workload, HORIZON_DAYS } from './db.js';
import { tx } from './actions.js';
import { notify, leadOf } from './notify.js';
import { now, today, HttpError, isRealDate } from './util.js';

export const FEATURE_STATUSES = ['discovery', 'building', 'shipping', 'live'];
export const SQUAD_MIN = 3, SQUAD_MAX = 5;
const PALETTE = ['#6366f1', '#0ea5e9', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];

export { HttpError };

const row = (db, sql, ...p) => db.prepare(sql).get(...p);
const need = (db, table, id, label) => row(db, `SELECT * FROM ${table} WHERE id = ?`, +id) || (() => { throw new HttpError(`${label} introuvable`, 404); })();
const log = (db, actor, action, after, before) => logActivity(db, { actor, action, after, before });

/* ---------- Lecture : stats, santé, garde-fous ---------- */
export function orgSnapshot(db) {
  const squads = db.prepare('SELECT * FROM squads ORDER BY id').all();
  const members = db.prepare('SELECT * FROM members').all();
  const features = db.prepare('SELECT * FROM features ORDER BY id').all();
  const deps = db.prepare('SELECT * FROM feature_deps').all();
  const tasks = db.prepare('SELECT id, status, feature_id, estimate_h, due_date, assignee_id, inbox_squad_id FROM tasks').all();
  const blocks = db.prepare("SELECT l.from_id, l.to_id FROM links l JOIN tasks b ON b.id = l.from_id WHERE l.type = 'blocks' AND b.status != 'done'").all();
  const wl = Object.fromEntries(workload(db).map(w => [w.id, w]));
  const t0 = today();
  const featOf = Object.fromEntries(tasks.map(t => [t.id, t.feature_id]));
  const fById = Object.fromEntries(features.map(f => [f.id, f]));
  const sById = Object.fromEntries(squads.map(s => [s.id, s]));
  const squadsById = id => (id && sById[id] ? id : 0);

  const weeks = HORIZON_DAYS / 7;
  const squadStats = Object.fromEntries(squads.map(s => {
    const mine = members.filter(m => m.squad_id === s.id);
    const loaned = members.filter(m => m.loan_squad_id === s.id && m.loan_pct > 0);
    // Les prêts comptent : la part prêtée sort de la capacité (et de la charge) de la squad d'origine pour entrer dans l'autre
    const share = m => (m.squad_id === s.id ? 1 - (m.loan_squad_id && m.loan_pct ? m.loan_pct / 100 : 0) : m.loan_pct / 100);
    const cap = [...mine, ...loaned].reduce((a, m) => a + (m.capacity_h || 0) * share(m) * weeks, 0);
    const load = [...mine, ...loaned].reduce((a, m) => a + (wl[m.id]?.load_h || 0) * share(m), 0);
    return [s.id, { member_ids: mine.map(m => m.id), size: mine.length, loaned: loaned.map(m => ({ member_id: m.id, pct: m.loan_pct })),
      capacity_h: Math.round(cap), load_h: Math.round(load), window_days: HORIZON_DAYS, pct: cap ? Math.round(load / cap * 100) : 0,
      active_features: features.filter(f => f.squad_id === s.id && f.status !== 'live').length }];
  }));

  // Gouvernance : une feature qui construit un use case SmartUC doit respecter les portes de ce use case (information lue dans le cache, jamais écrite vers SmartUC).
  const ucRows = db.prepare('SELECT fu.feature_id, c.ref, c.title, c.status, c.risk_tier, c.deleted, c.ignored FROM feature_ucs fu JOIN uc_cache c ON c.ref = fu.uc_ref').all();
  const PRE_APPROVAL = ['draft', 'submitted', 'qualified'];
  const governance = f => {
    const out = [];
    for (const u of ucRows.filter(x => x.feature_id === f.id)) {
      if (f.status === 'live') { if (!u.deleted && !['in_production', 'retired'].includes(u.status)) out.push({ info: true, text: `la feature est en ligne mais l’UC ${u.ref} est « ${u.status} » dans SmartUC : déclarez la mise en production (porte go-live)` }); continue; }
      if (f.status === 'discovery') continue;                      // le cadrage peut précéder l'approbation
      if (u.deleted) out.push({ text: `l’UC ${u.ref} n’existe plus dans SmartUC` });
      else if (['rejected', 'retired'].includes(u.status)) out.push({ red: true, text: `l’UC ${u.ref} est « ${u.status} » dans SmartUC : arrêter ou requalifier cette feature` });
      else if (PRE_APPROVAL.includes(u.status)) out.push({ text: `l’UC ${u.ref} n’est pas encore approuvé (« ${u.status} ») : la porte d’investissement SmartUC n’est pas franchie` });
      else if (f.status === 'shipping' && !u.risk_tier) out.push({ text: `le tier EU AI Act de l’UC ${u.ref} n’est pas validé dans SmartUC` });
    }
    return out;
  };
  const governanceByFeature = Object.fromEntries(features.map(f => [f.id, governance(f)]));

  const featureStats = features.map(f => {
    const mine = tasks.filter(t => t.feature_id === f.id), open = mine.filter(t => t.status !== 'done');
    const h = t => t.estimate_h ?? 4, total = mine.reduce((a, t) => a + h(t), 0), done = mine.filter(t => t.status === 'done').reduce((a, t) => a + h(t), 0);
    const blockedTasks = open.filter(t => blocks.some(b => b.to_id === t.id));
    const crossBlocked = blockedTasks.filter(t => blocks.some(b => b.to_id === t.id && featOf[b.from_id] && fById[featOf[b.from_id]]?.squad_id !== f.squad_id));
    const overdue = open.filter(t => t.due_date && t.due_date < t0);
    const unassigned = open.filter(t => !t.assignee_id);
    const waiting = deps.filter(d => d.from_feature_id === f.id).map(d => fById[d.to_feature_id]).filter(p => p && p.status !== 'live');
    const waitingCross = waiting.filter(p => p.squad_id !== f.squad_id);
    const red = [], orange = [];
    if (f.status !== 'live') {
      if (overdue.length) red.push(`${overdue.length} tâche${overdue.length > 1 ? 's' : ''} en retard`);
      if (f.target_date && f.target_date < t0 && open.length) red.push('échéance de la feature dépassée');
      if (crossBlocked.length) red.push(`${crossBlocked.length} tâche${crossBlocked.length > 1 ? 's' : ''} bloquée${crossBlocked.length > 1 ? 's' : ''} par une autre squad`);
      const innerBlocked = blockedTasks.length - crossBlocked.length;
      if (innerBlocked > 0) orange.push(`${innerBlocked} tâche${innerBlocked > 1 ? 's' : ''} bloquée${innerBlocked > 1 ? 's' : ''}`);
      if (unassigned.length) orange.push(`${unassigned.length} tâche${unassigned.length > 1 ? 's' : ''} sans responsable`);
      for (const p of waitingCross) orange.push(`attend « ${p.name} » (${sById[p.squad_id]?.name})`);
      if (squadStats[f.squad_id]?.pct > 100) orange.push('squad surchargée');
      if (!mine.length && f.status !== 'discovery') orange.push('aucune tâche');
      for (const g of governanceByFeature[f.id]) (g.red ? red : orange).push(g.text);
    }
    return { ...f, uc_refs: ucRows.filter(x => x.feature_id === f.id).map(x => x.ref), task_count: mine.length, open: open.length, done_count: mine.length - open.length, progress: total ? Math.round(done / total * 100) : 0,
      blocked: blockedTasks.length, overdue: overdue.length, health: red.length ? 'red' : orange.length ? 'orange' : 'green', reasons: [...red, ...orange] };
  });

  // Couplage entre squads : nombre de dépendances de features qui traversent une frontière de squad
  const pairs = {};
  for (const d of deps) {
    const a = fById[d.from_feature_id], b = fById[d.to_feature_id];
    if (!a || !b || a.squad_id === b.squad_id) continue;
    const key = [a.squad_id, b.squad_id].sort((x, y) => x - y).join('-');
    (pairs[key] ||= { a: Math.min(a.squad_id, b.squad_id), b: Math.max(a.squad_id, b.squad_id), count: 0, links: [] });
    pairs[key].count++; pairs[key].links.push({ from: a.name, to: b.name, from_squad: a.squad_id, to_squad: b.squad_id, open: b.status !== 'live' });
  }
  const coupling = Object.values(pairs).sort((x, y) => y.count - x.count);

  const guardrails = [];
  for (const f of features) for (const g of governanceByFeature[f.id]) guardrails.push({ level: g.info ? 'info' : 'warn', kind: 'governance', squad_id: f.squad_id, feature_id: f.id, message: `Gouvernance — « ${f.name} » : ${g.text}.` });
  const unplanned = db.prepare("SELECT COUNT(*) c FROM uc_cache WHERE status IN ('approved','in_build') AND deleted = 0 AND ignored = 0 AND ref NOT IN (SELECT uc_ref FROM feature_ucs)").get().c;
  if (unplanned) guardrails.push({ level: 'info', kind: 'uc_unplanned', squad_id: null, message: `${unplanned} use case${unplanned > 1 ? 's' : ''} SmartUC approuvé${unplanned > 1 ? 's' : ''} ${unplanned > 1 ? 'n’ont' : 'n’a'} pas encore de feature : à planifier avec une squad.` });
  for (const s of squads) {
    const st = squadStats[s.id];
    if (st.size < SQUAD_MIN) guardrails.push({ level: 'warn', kind: 'size', squad_id: s.id, message: `« ${s.name} » compte ${st.size} personne${st.size > 1 ? 's' : ''} : il en faut au moins ${SQUAD_MIN} pour livrer en autonomie.` });
    if (st.size > SQUAD_MAX) guardrails.push({ level: 'warn', kind: 'size', squad_id: s.id, message: `« ${s.name} » compte ${st.size} personnes : au-delà de ${SQUAD_MAX}, envisagez de la scinder en deux squads.` });
    if (!s.lead_id) guardrails.push({ level: 'warn', kind: 'lead', squad_id: s.id, message: `« ${s.name} » n’a pas de lead.` });
    if (st.active_features > (s.max_active_features ?? 3)) guardrails.push({ level: 'warn', kind: 'wip', squad_id: s.id, message: `« ${s.name} » mène ${st.active_features} features en parallèle (limite : ${s.max_active_features}). Terminez avant d’en ouvrir.` });
  }
  for (const m of members.filter(m => !m.squad_id)) guardrails.push({ level: 'info', kind: 'nosquad', member_id: m.id, message: `${m.name} n’appartient à aucune squad.` });
  for (const c of coupling.filter(c => c.count >= 2)) guardrails.push({ level: c.count >= 3 ? 'warn' : 'info', kind: 'coupling', squads: [c.a, c.b],
    message: `${sById[c.a].name} ↔ ${sById[c.b].name} : ${c.count} dépendances entre features. ${c.count >= 3 ? 'Couplage fort : fusionner, ou extraire la partie commune dans une squad dédiée.' : 'À surveiller : un couplage qui grandit ralentit les deux squads.'}` });
  // Inbox ciblée : chaque squad voit (et son lead doit trier) les tâches sans feature qui lui sont adressées
  const open = tasks.filter(t => !t.feature_id && t.status !== 'done');
  const inbox = open.length;
  const inboxBySquad = {};
  for (const t of open) { const k = squadsById(t.inbox_squad_id); inboxBySquad[k] = (inboxBySquad[k] || 0) + 1; }
  for (const [k, n] of Object.entries(inboxBySquad)) {
    const sq = sById[k];
    guardrails.push({ level: n > 5 ? 'warn' : 'info', kind: 'inbox', squad_id: sq ? sq.id : null,
      message: sq ? `${n} tâche${n > 1 ? 's' : ''} à trier dans l’Inbox de « ${sq.name} » : le lead doit les rattacher à une feature.` : `${n} tâche${n > 1 ? 's' : ''} sans feature ni squad destinataire : à router vers une squad.` });
  }

  return {
    squads: squads.map(s => ({ ...s, ...squadStats[s.id] })), features: featureStats, feature_deps: deps, coupling, guardrails, inbox_count: inbox, inbox_by_squad: inboxBySquad,
    rules: { min: SQUAD_MIN, max: SQUAD_MAX, feature_statuses: FEATURE_STATUSES },
  };
}

/* ---------- Écriture ---------- */
const clean = (s, max = 200) => String(s ?? '').trim().slice(0, max);

const COLOR = /^#[0-9a-f]{6}$/i;

/** Un lead = une seule squad : on refuse quelqu'un qui dirige déjà une autre squad. Le lead rejoint la squad. */
function setLead(db, squadId, leadId) {
  if (leadId == null || leadId === '') return db.prepare('UPDATE squads SET lead_id = NULL WHERE id = ?').run(squadId);
  const m = need(db, 'members', leadId, 'Personne');
  const other = row(db, 'SELECT name FROM squads WHERE lead_id = ? AND id != ?', m.id, squadId);
  if (other) throw new HttpError(`${m.name} est déjà lead de « ${other.name} » : un lead ne dirige qu’une squad.`);
  db.prepare('UPDATE members SET squad_id = ?, loan_squad_id = NULL, loan_pct = 0 WHERE id = ?').run(squadId, m.id);   // le lead fait partie de la squad
  db.prepare('UPDATE squads SET lead_id = ? WHERE id = ?').run(m.id, squadId);
  notify(db, { to: m.id, kind: 'squad', text: `Vous êtes désormais lead de la squad « ${row(db, 'SELECT name FROM squads WHERE id = ?', squadId).name} »` });
}

export function createSquad(db, d, actor) {
  const name = clean(d.name, 60);
  if (!name) throw new HttpError('Le nom de la squad est obligatoire');
  if (row(db, 'SELECT 1 FROM squads WHERE name = ?', name)) throw new HttpError('Une squad porte déjà ce nom');
  return tx(db, () => {
    const n = row(db, 'SELECT COUNT(*) c FROM squads').c;
    const id = Number(db.prepare('INSERT INTO squads(name, mission, color, max_active_features) VALUES (?,?,?,?)')
      .run(name, clean(d.mission, 300), COLOR.test(d.color || '') ? d.color : PALETTE[n % PALETTE.length], Math.min(10, Math.max(1, +d.max_active_features || 3))).lastInsertRowid);
    if (d.lead_id) setLead(db, id, +d.lead_id);   // en cas d'erreur, la squad n'est pas créée (transaction)
    log(db, actor, 'squad_create', { name });
    return id;
  });
}

export function updateSquad(db, id, d, actor) { return tx(db, () => updateSquadTx(db, id, d, actor)); }
function updateSquadTx(db, id, d, actor) {
  const s = need(db, 'squads', id, 'Squad');
  if (d.name != null) {
    const name = clean(d.name, 60); if (!name) throw new HttpError('Le nom de la squad est obligatoire');
    if (row(db, 'SELECT 1 FROM squads WHERE name = ? AND id != ?', name, s.id)) throw new HttpError('Une squad porte déjà ce nom');
    db.prepare('UPDATE squads SET name = ? WHERE id = ?').run(name, s.id);
  }
  if (d.mission != null) db.prepare('UPDATE squads SET mission = ? WHERE id = ?').run(clean(d.mission, 300), s.id);
  if (d.color) { if (!COLOR.test(d.color)) throw new HttpError('Couleur invalide'); db.prepare('UPDATE squads SET color = ? WHERE id = ?').run(d.color, s.id); }
  if (d.max_active_features != null) db.prepare('UPDATE squads SET max_active_features = ? WHERE id = ?').run(Math.min(10, Math.max(1, +d.max_active_features || 3)), s.id);
  if ('lead_id' in d) setLead(db, s.id, d.lead_id);
  log(db, actor, 'squad_update', { name: d.name ?? s.name, fields: Object.keys(d) });
}

export function deleteSquad(db, id, actor) {
  const s = need(db, 'squads', id, 'Squad');
  if (row(db, 'SELECT 1 FROM members WHERE squad_id = ?', s.id)) throw new HttpError('Déplacez d’abord les membres de cette squad');
  if (row(db, 'SELECT 1 FROM features WHERE squad_id = ?', s.id)) throw new HttpError('Transférez d’abord les features de cette squad');
  db.prepare('DELETE FROM squads WHERE id = ?').run(s.id);
  log(db, actor, 'squad_delete', { name: s.name });
}

/** Rattache une personne à une squad (appartenance principale) et/ou prête une part de son temps. */
export function updateMember(db, id, d, actor) { return tx(db, () => updateMemberTx(db, id, d, actor)); }
function updateMemberTx(db, id, d, actor) {
  const m = need(db, 'members', id, 'Personne');
  if (d.name != null) {
    const name = clean(d.name, 80); if (!name) throw new HttpError('Le nom est obligatoire');
    if (row(db, 'SELECT 1 FROM members WHERE lower(name) = lower(?) AND id != ?', name, m.id)) throw new HttpError('Une personne porte déjà ce nom');
    db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, m.id);
  }
  if ('email' in d) {
    const email = d.email == null || d.email === '' ? null : clean(d.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError('Adresse e-mail invalide');
    if (email && row(db, 'SELECT 1 FROM members WHERE lower(email) = ? AND id != ?', email, m.id)) throw new HttpError('Cette adresse e-mail est déjà utilisée par quelqu’un d’autre');
    db.prepare('UPDATE members SET email = ? WHERE id = ?').run(email, m.id);
  }
  if ('is_admin' in d) {
    const on = d.is_admin ? 1 : 0;
    if (!on && m.is_admin && !row(db, 'SELECT 1 FROM members WHERE is_admin = 1 AND id != ?', m.id)) throw new HttpError('Il doit rester au moins un administrateur.');
    db.prepare('UPDATE members SET is_admin = ? WHERE id = ?').run(on, m.id);
    log(db, actor, 'member_admin', { name: m.name, admin: !!on });
  }
  if ('team_id' in d) db.prepare('UPDATE members SET team_id = ? WHERE id = ?').run(d.team_id ? need(db, 'teams', d.team_id, 'Fonction').id : null, m.id);
  if (d.skills != null) { if (!Array.isArray(d.skills)) throw new HttpError('Compétences : liste attendue'); db.prepare('UPDATE members SET skills = ? WHERE id = ?').run(JSON.stringify(d.skills.map(x => clean(x, 30)).filter(Boolean).slice(0, 12)), m.id); }
  if ('squad_id' in d) {
    const to = d.squad_id == null || d.squad_id === '' ? null : need(db, 'squads', d.squad_id, 'Squad').id;
    const ledSquad = row(db, 'SELECT * FROM squads WHERE lead_id = ?', m.id);
    if (ledSquad && ledSquad.id !== to) throw new HttpError(`${m.name} est lead de « ${ledSquad.name} » : désignez d’abord un autre lead.`);
    db.prepare('UPDATE members SET squad_id = ? WHERE id = ?').run(to, m.id);
    if (to && m.loan_squad_id === to) db.prepare('UPDATE members SET loan_squad_id = NULL, loan_pct = 0 WHERE id = ?').run(m.id);
    const toName = to && row(db, 'SELECT name FROM squads WHERE id = ?', to).name;
    log(db, actor, 'member_move', { name: m.name, squad: toName });
    if (to) { notify(db, { to: m.id, kind: 'squad', actor, text: `${actor} vous a placé·e dans la squad « ${toName} »` }); notify(db, { to: leadOf(db, to), kind: 'squad', actor, text: `${m.name} rejoint votre squad « ${toName} »` }); }
  }
  if ('loan_squad_id' in d) {
    const cur = row(db, 'SELECT squad_id FROM members WHERE id = ?', m.id).squad_id;
    const to = d.loan_squad_id == null || d.loan_squad_id === '' ? null : need(db, 'squads', d.loan_squad_id, 'Squad').id;
    if (to && to === cur) throw new HttpError('Une personne ne se prête pas à sa propre squad');
    const pct = to ? Math.min(50, Math.max(5, +d.loan_pct || 20)) : 0;
    db.prepare('UPDATE members SET loan_squad_id = ?, loan_pct = ? WHERE id = ?').run(to, pct, m.id);
  }
  if (d.role != null) db.prepare('UPDATE members SET role = ? WHERE id = ?').run(clean(d.role, 60), m.id);
  if (d.capacity_h != null) { const c = Number(d.capacity_h); if (!Number.isFinite(c) || c < 0 || c > 80) throw new HttpError('Capacité invalide (0 à 80 h par semaine)'); db.prepare('UPDATE members SET capacity_h = ? WHERE id = ?').run(c, m.id); }
}

function featureFields(db, d) {
  const o = {};
  if (d.name != null) { o.name = clean(d.name, 120); if (!o.name) throw new HttpError('Le nom de la feature est obligatoire'); }
  if (d.outcome != null) o.outcome = clean(d.outcome, 300);
  if (d.squad_id != null) o.squad_id = need(db, 'squads', d.squad_id, 'Squad').id;
  if ('project_id' in d) o.project_id = d.project_id ? need(db, 'projects', d.project_id, 'Projet').id : null;
  if (d.status != null) { if (!FEATURE_STATUSES.includes(d.status)) throw new HttpError('Statut de feature invalide'); o.status = d.status; }
  if ('target_date' in d) { if (d.target_date && !isRealDate(d.target_date)) throw new HttpError('Date invalide'); o.target_date = d.target_date || null; }
  return o;
}

export function createFeature(db, d, actor) {
  const o = featureFields(db, d);
  if (!o.name) throw new HttpError('Le nom de la feature est obligatoire');
  if (!o.squad_id) throw new HttpError('Une feature appartient à une squad : choisissez-en une');
  const id = Number(db.prepare('INSERT INTO features(name, outcome, squad_id, project_id, status, target_date, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(o.name, o.outcome || '', o.squad_id, o.project_id ?? null, o.status || 'discovery', o.target_date ?? null, now()).lastInsertRowid);
  log(db, actor, 'feature_create', { name: o.name });
  return id;
}

export function updateFeature(db, id, d, actor) {
  const f = need(db, 'features', id, 'Feature'), o = featureFields(db, d), keys = Object.keys(o);
  if (!keys.length) return;
  db.prepare(`UPDATE features SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => o[k]), f.id);
  log(db, actor, 'feature_update', { name: o.name ?? f.name, fields: keys });
}

export function deleteFeature(db, id, actor) {
  return tx(db, () => {
    const f = need(db, 'features', id, 'Feature');
    const ids = db.prepare('SELECT id FROM tasks WHERE feature_id = ?').all(f.id).map(r => r.id);
    db.prepare('UPDATE tasks SET feature_id = NULL WHERE feature_id = ?').run(f.id);   // les tâches retournent dans l'Inbox
    db.prepare('DELETE FROM features WHERE id = ?').run(f.id);
    log(db, actor, 'feature_delete', { name: f.name, tasks_to_inbox: ids.length });
  });
}

export function addFeatureDep(db, from, to, note, actor) {
  const a = need(db, 'features', from, 'Feature'), b = need(db, 'features', to, 'Feature');
  if (a.id === b.id) throw new HttpError('Une feature ne peut pas dépendre d’elle-même');
  if (row(db, 'SELECT 1 FROM feature_deps WHERE from_feature_id = ? AND to_feature_id = ?', b.id, a.id)) throw new HttpError('Dépendance circulaire : l’autre feature dépend déjà de celle-ci');
  db.prepare('INSERT OR IGNORE INTO feature_deps(from_feature_id, to_feature_id, note) VALUES (?,?,?)').run(a.id, b.id, clean(note, 200));
  log(db, actor, 'feature_dep', { name: `${a.name} → ${b.name}` });
  if (a.squad_id !== b.squad_id) notify(db, { to: leadOf(db, b.squad_id), kind: 'dependency', feature_id: b.id, actor,
    text: `${actor} a déclaré que la feature « ${a.name} » (squad ${row(db, 'SELECT name FROM squads WHERE id = ?', a.squad_id).name}) dépend de « ${b.name} », qui est à vous` });
}

export function removeFeatureDep(db, id, actor) {
  const d = row(db, 'SELECT d.*, a.name AS an, b.name AS bn FROM feature_deps d JOIN features a ON a.id = d.from_feature_id JOIN features b ON b.id = d.to_feature_id WHERE d.id = ?', +id);
  if (!d) return;
  db.prepare('DELETE FROM feature_deps WHERE id = ?').run(d.id);
  log(db, actor, 'feature_dep_remove', { name: `${d.an} → ${d.bn}` });
}
