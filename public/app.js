// WorkForce — interface (aucune dépendance, aucun build).
import { createOrg } from '/org.js';
import { createAdmin } from '/admin.js';
import { enableTouchDnd, markDraggables } from '/touchdnd.js';
const $ = s => document.querySelector(s);
const STATUS = { todo: 'À faire', doing: 'En cours', review: 'En revue', done: 'Terminé' };
const PRIO = { low: 'Basse', medium: 'Moyenne', high: 'Haute', urgent: 'Urgente' };
const LINKFR = { relates: 'lié à', blocks: 'bloque', duplicates: 'doublon de' };

const S = { data: null, view: localStorage.view || 'features', me: +localStorage.me || null, history: [], open: null,
  f: { project: '', squad: null, feature: '', mine: false, q: '', lanes: true }, speak: localStorage.speak === '1' };

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}

async function api(path, method = 'GET', body) {
  let res, data;
  try { res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', 'X-User': S.me || '' }, body: body && JSON.stringify(body) }); data = await res.json(); }
  catch { throw new Error('Le serveur WorkForce ne répond pas. Vérifiez qu’il est démarré puis réessayez.'); }
  if (res.status === 401 && S.auth?.enabled) { showLogin(S.auth.providers); throw new Error('Votre session a expiré : reconnectez-vous.'); }
  if (!res.ok) throw new Error(data.error || res.statusText);
  if (data.tasks) { S.data = { ...S.data, ...data }; render(); }
  return data;
}

function toast(msg, ms = 2600, action) {
  const t = $('#toast'); t.replaceChildren(msg);
  if (action) t.append(h('button', { class: 'toast-act', onclick: async () => { t.hidden = true; try { await action.run(); } catch (e) { toast(e.message, 5000); } } }, action.label));
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, action ? Math.max(ms, 8000) : ms);
}
const idHeaders = () => (S.auth?.enabled ? {} : { 'X-User': S.me || '' });
const by = (list, id) => list.find(x => x.id === id);
const member = id => by(S.data.members, id), team = id => by(S.data.teams, id), project = id => by(S.data.projects, id);
const initials = n => n.split(' ').map(p => p[0]).join('').slice(0, 2);
const squadById = id => S.data.squads.find(q => q.id === id);
const teamColor = m => squadById(m.squad_id)?.color || team(m.team_id)?.color || '#64748b';
const avatar = m => m ? h('span', { class: 'avatar', style: `background:${teamColor(m)}`, title: `${m.name} · ${squadById(m.squad_id)?.name || 'sans squad'} · ${team(m.team_id)?.name || ''}` }, initials(m.name)) : h('span', { class: 'muted' }, '—');
const late = t => t.due_date && t.status !== 'done' && t.due_date < new Date().toLocaleDateString('sv-SE');
const fmtDate = d => d ? new Date(d + 'T00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';

const featureById = id => S.data.features.find(f => f.id === id);
/** Droits côté interface (le serveur reste l'autorité) : sans authentification, tout le monde peut tout faire. */
const can = {
  get admin() { return !S.data.auth.enabled || !!S.data.auth.user?.is_admin; },
  leadOf(squadId) { return this.admin || (squadId && S.data.squads.find(q => q.id === +squadId)?.lead_id === S.me); },
  get anyLead() { return this.admin || S.data.squads.some(q => q.lead_id === S.me); },
};
function visibleTasks() {
  const { project: p, feature: fe, mine, q } = S.f, sq = org.curSquad();
  const needle = q.trim().toLowerCase();
  return S.data.tasks.filter(x => {
    const f = x.feature_id && featureById(x.feature_id);
    return (!p || x.project_id === +p) && (!mine || x.assignee_id === S.me)
      && (!sq || (f ? f.squad_id === +sq : (!x.inbox_squad_id || x.inbox_squad_id === +sq)))   // une squad voit ses tâches + SON Inbox (et les tâches sans destinataire)
      && (!fe || x.feature_id === +fe)
      && (!needle || `${x.title} ${x.description} ${x.labels.join(' ')} #${x.id}`.toLowerCase().includes(needle));
  });
}

/* ---------- Glisser-déposer ---------- */
const DRAG = { id: null, member: null };
function makeDraggable(el, id) {
  el.draggable = true;
  el.addEventListener('dragstart', e => {
    DRAG.id = id; e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => el.classList.add('dragging'));
  });
  el.addEventListener('dragend', () => { DRAG.id = null; el.classList.remove('dragging'); clearDrop(); document.querySelectorAll('.over').forEach(n => n.classList.remove('over')); });
}
function clearDrop() { document.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after')); }
/** Carte la plus proche du curseur dans une colonne, et côté (avant/après). */
function dropSpot(col, y) {
  const cards = [...col.querySelectorAll('.card:not(.dragging)')];
  for (const c of cards) { const r = c.getBoundingClientRect(); if (y < r.top + r.height / 2) return { ref: c, before: true }; }
  return { ref: cards.at(-1) || null, before: false };
}

function openModal(node) { const m = $('#modal'); m.replaceChildren(node); m.hidden = false; m.onclick = closeModal; node.querySelector?.('input[type=text], input:not([type]), select')?.focus(); }
const org = createOrg({ h, S, api, toast, by, member, team, project, avatar, openTask, openModal, closeModal, makeDraggable, DRAG, fmtDate, can, render: () => render() });
const admin = createAdmin({ h, S, api, toast, member, team, avatar, openModal, closeModal, can, openMemberModal: org.openMemberModal, openLlmSettings: () => openLlmSettings(), render: () => render() });

/* ---------- Vues ---------- */
function card(t) {
  const m = member(t.assignee_id), p = project(t.project_id);
  const el = h('div', { class: 'card', draggable: true, onclick: () => openTask(t.id) },
    h('div', { class: 'meta' }, h('span', { class: `prio ${t.priority}`, title: PRIO[t.priority] }), h('span', { class: 'id' }, `#${t.id}`), p && h('span', { class: 'chip', title: p.name }, p.key),
      S.data.blocked.includes(t.id) && h('span', { class: 'lock', title: 'Bloquée par une autre tâche' }, '🔒 bloquée')),
    h('div', { class: 't' }, t.title),
    h('div', { class: 'meta' }, avatar(m), t.due_date && h('span', { class: `due ${late(t) ? 'late' : ''}` }, '📅 ' + fmtDate(t.due_date)),
      t.labels.slice(0, 2).map(l => h('span', { class: 'chip' }, l)), featureById(t.feature_id) && h('span', { class: 'chip feat', title: `Feature · squad ${org.squadOf(featureById(t.feature_id).squad_id)?.name}` }, featureById(t.feature_id).name)));
  makeDraggable(el, t.id);
  el.dataset.id = t.id;
  return el;
}

function toolbar({ lanes = false } = {}) {
  const opt = (list, sel, ph) => [h('option', { value: '' }, ph), ...list.map(x => h('option', { value: x.id, selected: String(x.id) === String(sel) }, x.name))];
  const sq = org.curSquad();
  const feats = S.data.features.filter(f => !sq || f.squad_id === +sq);
  return h('div', { class: 'toolbar' },
    h('input', { type: 'text', placeholder: 'Filtrer…', value: S.f.q, oninput: async e => { S.f.q = e.target.value; await render(); const i = $('#view input[type=text]'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }),
    h('select', { title: 'Squad', onchange: e => { S.f.squad = e.target.value; S.f.feature = ''; render(); } }, opt(S.data.squads, sq, 'Toutes les squads')),
    h('select', { title: 'Feature', onchange: e => { S.f.feature = e.target.value; render(); } }, opt(feats, S.f.feature, 'Toutes les features')),
    h('select', { title: 'Projet', onchange: e => { S.f.project = e.target.value; render(); } }, opt(S.data.projects, S.f.project, 'Tous les projets')),
    h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: S.f.mine, onchange: e => { S.f.mine = e.target.checked; render(); } }), 'Mes tâches'),
    lanes && h('label', { class: 'toggle', title: 'Une ligne par feature' }, h('input', { type: 'checkbox', checked: S.f.lanes, onchange: e => { S.f.lanes = e.target.checked; render(); } }), 'Par feature'));
}

/** Une colonne de statut ; `lane` = id de feature (ou null pour l'Inbox) quand le tableau est découpé par feature. */
function column(tasks, st, label, lane) {
  {
    const items = tasks.filter(t => t.status === st).sort((a, b) => (a.position ?? a.id * 1000) - (b.position ?? b.id * 1000));
    const col = h('div', { class: 'col', 'data-status': st }, h('h3', {}, label, h('span', {}, items.length)), items.map(card));
    col.addEventListener('dragover', e => {
      if (!DRAG.id) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
      document.querySelectorAll('.col.over').forEach(n => n !== col && n.classList.remove('over'));
      col.classList.add('over');
      const spot = dropSpot(col, e.clientY);
      if (spot.ref) spot.ref.classList.add(spot.before ? 'drop-before' : 'drop-after');
    });
    col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) { col.classList.remove('over'); clearDrop(); } });
    col.addEventListener('drop', e => {
      e.preventDefault();
      const id = DRAG.id, t = by(S.data.tasks, id);
      const spot = dropSpot(col, e.clientY);
      clearDrop();
      if (!t) return;
      // nouvelle position = milieu entre les deux voisins visibles (ou bord de colonne)
      const sibs = items.filter(x => x.id !== id), pos = x => x.position ?? x.id * 1000;
      let i = spot.ref ? sibs.findIndex(x => x.id === +spot.ref.dataset.id) + (spot.before ? 0 : 1) : sibs.length;
      if (i < 0) i = sibs.length;
      const prev = sibs[i - 1], next = sibs[i];
      const position = prev && next ? (pos(prev) + pos(next)) / 2 : prev ? pos(prev) + 1000 : next ? pos(next) - 1000 : 1000;
      const sameLane = lane === undefined || t.feature_id === lane;                 // changer de ligne (de feature) est un vrai changement même si statut et position coïncident
      if (t.status === st && sameLane && Math.abs(position - pos(t)) < 1e-9) return;
      const patch = t.status === st ? { position } : { status: st, position };
      if (lane !== undefined && t.feature_id !== lane) { patch.feature_id = lane; if (lane === null && org.curSquad()) patch.inbox_squad_id = +org.curSquad(); }    // déposé dans la ligne d'une autre feature (ou de l'Inbox)
      Object.assign(t, patch); render();             // mise à jour optimiste
      api(`/tasks/${id}`, 'PATCH', patch).catch(err => { toast(err.message); boot(); });
      if (patch.feature_id !== undefined) toast(patch.feature_id ? `#${id} → feature « ${featureById(patch.feature_id).name} »` : `#${id} → Inbox`);
      else if (patch.status) toast(`#${id} → ${STATUS[st]}`);
    });
    return col;
  }
}

function boardView() {
  const tasks = visibleTasks(), sq = org.curSquad();
  if (!(S.f.lanes && sq)) return h('div', {}, toolbar({ lanes: true }), h('div', { class: 'board' }, Object.entries(STATUS).map(([st, label]) => column(tasks, st, label))));
  const lanes = S.data.features.filter(f => f.squad_id === +sq && (!S.f.feature || f.id === +S.f.feature)).map(f => ({ f, tasks: tasks.filter(t => t.feature_id === f.id) }));
  const inbox = tasks.filter(t => !t.feature_id);
  const laneEl = (head, items, lane) => h('section', { class: 'lane' }, head, h('div', { class: 'board' }, Object.entries(STATUS).map(([st, label]) => column(items, st, label, lane))));
  return h('div', {}, toolbar({ lanes: true }),
    lanes.map(({ f, tasks: items }) => laneEl(h('div', { class: 'lanehead' }, h('span', { class: `health ${f.health}`, title: f.reasons.join('\n') }), h('strong', {}, f.name), h('span', { class: 'muted' }, `${f.done_count}/${f.task_count} · ${f.progress} %`), f.reasons.length > 0 && h('span', { class: 'muted' }, '— ' + f.reasons[0])), items, f.id)),
    inbox.length > 0 && laneEl(h('div', { class: 'lanehead' }, h('strong', {}, '📥 Inbox à trier'), h('span', { class: 'muted' }, 'sans feature — glissez dans la ligne d’une feature')), inbox, null));
}



function listView() {
  const rows = visibleTasks().sort((a, b) => (a.status === 'done') - (b.status === 'done') || b.id - a.id).map(t => h('tr', { onclick: () => openTask(t.id) },
    h('td', { class: 'id' }, `#${t.id}`),
    h('td', {}, t.title, S.data.blocked.includes(t.id) && h('span', { class: 'lock' }, ' 🔒')),
    h('td', {}, STATUS[t.status]), h('td', {}, h('span', { class: `prio ${t.priority}` }), ' ', PRIO[t.priority]),
    h('td', {}, h('span', { class: 'person' }, avatar(member(t.assignee_id)), member(t.assignee_id)?.name.split(' ')[0] || '')),
    h('td', {}, featureById(t.feature_id)?.name || h('span', { class: 'muted' }, '—')), h('td', { class: late(t) ? 'due late' : '' }, fmtDate(t.due_date))));
  const none = !rows.length && h('div', { class: 'panel empty' }, S.data.tasks.length ? 'Aucune tâche ne correspond aux filtres.' : 'Aucune tâche pour le moment. Ajoutez-en avec « ＋ Tâche » ou demandez à l’assistant.');
  return h('div', {}, toolbar(), none || h('table', {}, h('thead', {}, h('tr', {}, ['Réf.', 'Tâche', 'Statut', 'Priorité', 'Assigné', 'Feature', 'Échéance'].map(x => h('th', {}, x)))), h('tbody', {}, rows)));
}

function assignTo(taskId, memberId) {
  const t = by(S.data.tasks, taskId);
  if (!t || t.assignee_id === memberId) return;
  const m = memberId && member(memberId);
  const patch = { assignee_id: memberId, ...(m && !t.team_id ? { team_id: m.team_id } : {}) };
  api(`/tasks/${taskId}`, 'PATCH', patch).then(() => toast(m ? `#${taskId} assignée à ${m.name}` : `#${taskId} n’est plus assignée`)).catch(e => toast(e.message));
}
function dropTarget(el, memberId) {
  el.classList.add('person-drop');
  el.addEventListener('dragover', e => { if (DRAG.id) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('over'); } });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); assignTo(DRAG.id, memberId); });
  return el;
}
const taskLine = t => { const el = h('div', { class: 'meta nowrap', style: 'padding:2px 0', title: 'Glisser sur une personne pour (ré)assigner', onclick: () => openTask(t.id) }, h('span', { class: `prio ${t.priority}` }), t.title); makeDraggable(el, t.id); return el; };

function teamView() {
  const cards = S.data.workload.map(w => {
    const m = member(w.id), mine = S.data.tasks.filter(t => t.assignee_id === w.id && t.status !== 'done');
    return dropTarget(h('div', { class: 'panel' },
      h('div', { class: 'person' }, avatar(m), h('div', {}, h('strong', {}, w.name), h('div', { class: 'muted' }, `${w.role} · ${squadById(m.squad_id)?.name || 'sans squad'}`))),
      h('div', { class: 'bar' }, h('i', { class: w.pct > 100 ? 'over' : w.pct > 80 ? 'mid' : '', style: `width:${Math.min(w.pct, 100)}%` })),
      h('div', { class: 'muted' }, `${w.load_h} h à faire d’ici ${w.window_days} jours · capacité ${w.window_h} h (${w.pct} %)`, w.pct > 100 ? ' ⚠️ surchargé' : '', w.overdue ? ` · ${w.overdue} en retard` : ''),
      h('div', { style: 'margin-top:8px' }, mine.slice(0, 5).map(taskLine), mine.length > 5 && h('div', { class: 'muted' }, `+ ${mine.length - 5} autres`)),
      h('div', { class: 'meta', style: 'margin-top:6px' }, m.skills.map(s => h('span', { class: 'chip' }, s)))), w.id);
  });
  const free = S.data.tasks.filter(t => !t.assignee_id && t.status !== 'done');
  cards.unshift(dropTarget(h('div', { class: 'panel', style: 'border-style:dashed' },
    h('strong', {}, `Non assignées (${free.length})`), h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Glissez une tâche sur une personne pour l’assigner'),
    free.length ? free.map(taskLine) : h('div', { class: 'muted' }, 'Tout est assigné 👌')), null));
  // Blocages qui traversent les squads : le point faible classique des projets transverses
  const sqOf = t => squadById(featureById(t.feature_id)?.squad_id);
  const cross = S.data.links.filter(l => l.type === 'blocks').map(l => [by(S.data.tasks, l.from_id), by(S.data.tasks, l.to_id)])
    .filter(([a, b]) => a && b && a.status !== 'done' && sqOf(a) && sqOf(b) && sqOf(a).id !== sqOf(b).id);
  return h('div', {}, h('h2', {}, 'Charge individuelle — 2 prochaines semaines'), h('div', { class: 'grid' }, cards),
    h('h2', {}, 'Tâches bloquées par une autre squad'),
    h('div', { class: 'panel' }, cross.length ? cross.map(([a, b]) => h('div', { class: 'dep' },
      h('span', { class: 'chip' }, sqOf(a).name), h('a', { href: '#', onclick: e => { e.preventDefault(); openTask(a.id); } }, a.title),
      h('span', { class: 'tag blocks' }, 'bloque'), h('span', { class: 'chip' }, sqOf(b).name),
      h('a', { href: '#', onclick: e => { e.preventDefault(); openTask(b.id); } }, b.title))) : h('div', { class: 'empty' }, 'Aucun blocage entre squads. 👌')));
}

async function activityView() {
  const rows = await fetch('/api/activity').then(r => r.json());
  const wrap = h('div', {}, h('h2', {}, 'Journal d’activité'));
  const verb = { create: 'a créé', update: 'a modifié', link: 'a lié', unlink: 'a délié', delete: 'a supprimé', undo: 'a annulé', feature_create: 'a créé la feature', feature_update: 'a modifié la feature', feature_delete: 'a supprimé la feature',
    feature_dep: 'a ajouté une dépendance', feature_dep_remove: 'a retiré une dépendance', squad_create: 'a créé la squad', squad_update: 'a modifié la squad', squad_delete: 'a supprimé la squad', member_move: 'a déplacé',
    member_create: 'a ajouté', member_delete: 'a retiré', project_create: 'a créé le projet', project_update: 'a modifié le projet', project_delete: 'a supprimé le projet',
    team_create: 'a créé la fonction', team_update: 'a modifié la fonction', team_delete: 'a supprimé la fonction', reset: 'a effacé toutes les données' };
  const undo = async r => { try { const u = await api(`/undo-activity/${r.id}`, 'POST'); toast(u.undone ? 'Action annulée' : `Impossible : ${u.conflicts[0]?.reason || 'déjà annulée'}`, u.undone ? 2400 : 6000); } catch (e) { toast(e.message, 5000); } };
  const undoable = r => !r.undone && r.task_id && ['create', 'update', 'link', 'unlink', 'delete'].includes(r.action);
  wrap.append(rows.length ? h('div', { class: 'panel' }, rows.map(r => h('div', { class: 'dep', style: r.undone ? 'opacity:.45;text-decoration:line-through' : '' },
    h('span', { class: 'muted' }, new Date(r.ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })),
    h('strong', {}, r.actor), verb[r.action] || r.action,
    r.title && h('a', { href: '#', onclick: e => { e.preventDefault(); openTask(r.task_id); } }, `#${r.task_id} ${r.title}`),
    !r.task_id && r.after?.name && h('strong', {}, r.after.name),
    r.action === 'delete' && h('span', { class: 'muted' }, `#${r.task_id}`),
    r.action === 'undo' && h('span', { class: 'muted' }, `(${r.after?.count} action${r.after?.count > 1 ? 's' : ''})`),
    r.after?.tasks_unassigned > 0 && h('span', { class: 'muted' }, `(${r.after.tasks_unassigned} tâche(s) désassignée(s))`),
    r.action === 'member_move' && h('span', { class: 'muted' }, `→ ${r.after?.squad || 'sans squad'}`),
    r.action === 'update' && h('span', { class: 'muted' }, Object.keys(r.after || {}).join(', ')),
    h('span', { class: 'grow' }),
    undoable(r) && h('button', { class: 'ghost', title: 'Annuler cette action', onclick: () => undo(r) }, '↩ Annuler')))) : h('div', { class: 'panel empty' }, 'Aucune activité pour le moment.'));
  return wrap;
}

/* ---------- Fiche tâche ---------- */
function openTask(id) { S.open = id; renderDrawer(); }
function closeTask() { S.open = null; renderDrawer(); }

function renderDrawer() {
  const dr = $('#drawer');
  const t = S.open && by(S.data.tasks, S.open);
  if (!t) { dr.hidden = true; dr.replaceChildren(); return; }
  const patch = (k, v) => api(`/tasks/${t.id}`, 'PATCH', { [k]: v === '' ? null : v }).then(() => toast('Enregistré ✓', 900)).catch(e => { toast(e.message, 4500); render(); });
  const sel = (key, list, cur, ph) => h('select', { onchange: e => patch(key, e.target.value ? +e.target.value : null) },
    h('option', { value: '' }, ph), list.map(x => h('option', { value: x.id, selected: x.id === cur }, x.name)));
  const enumSel = (key, map, cur) => h('select', { onchange: e => patch(key, e.target.value) }, Object.entries(map).map(([k, v]) => h('option', { value: k, selected: k === cur }, v)));
  const links = S.data.links.filter(l => l.from_id === t.id || l.to_id === t.id);
  const others = S.data.tasks.filter(x => x.id !== t.id);
  let newType = 'relates', newTo = '';
  const sheet = h('div', { class: 'sheet', onclick: e => e.stopPropagation() },
    h('div', { class: 'meta' }, h('span', { class: 'id' }, `#${t.id}`), project(t.project_id) && h('span', { class: 'chip', title: project(t.project_id).name }, project(t.project_id).key), S.data.blocked.includes(t.id) && h('span', { class: 'lock' }, '🔒 bloquée'),
      h('span', { class: 'spacer' }), h('button', { class: 'ghost', onclick: closeTask }, '✕ Fermer')),
    h('input', { class: 'title', value: t.title, onchange: e => e.target.value.trim() && patch('title', e.target.value.trim()) }),
    h('div', { class: 'fields' },
      h('label', {}, 'Statut'), enumSel('status', STATUS, t.status),
      h('label', {}, 'Priorité'), enumSel('priority', PRIO, t.priority),
      h('label', {}, 'Assigné à'), sel('assignee_id', S.data.members, t.assignee_id, '— personne —'),
      h('label', {}, 'Feature'), org.featureSelect(t.feature_id, v => patch('feature_id', v)),
      t.feature_id ? [h('label', {}, 'Squad'), h('span', { class: 'muted' }, org.squadOf(featureById(t.feature_id)?.squad_id)?.name || '—')]
        : [h('label', {}, 'Inbox de'), h('select', { title: 'Squad dont le lead doit trier cette tâche', onchange: e => patch('inbox_squad_id', e.target.value ? +e.target.value : null) }, h('option', { value: '' }, '— aucune squad —'), S.data.squads.map(q => h('option', { value: q.id, selected: q.id === t.inbox_squad_id }, q.name)))],
      h('label', {}, 'Fonction'), sel('team_id', S.data.teams, t.team_id, '— aucune —'),
      h('label', {}, 'Projet'), sel('project_id', S.data.projects, t.project_id, '— aucun —'),
      h('label', {}, 'Échéance'), h('input', { type: 'date', value: t.due_date || '', onchange: e => patch('due_date', e.target.value) }),
      h('label', {}, 'Estimation (h)'), h('input', { type: 'number', min: 0, step: 0.5, value: t.estimate_h ?? '', onchange: e => patch('estimate_h', e.target.value === '' ? null : +e.target.value) }),
      h('label', {}, 'Étiquettes'), h('input', { type: 'text', value: t.labels.join(', '), onchange: e => patch('labels', e.target.value.split(',').map(s => s.trim()).filter(Boolean)) })),
    h('textarea', { placeholder: 'Description…', onchange: e => patch('description', e.target.value) }, t.description),
    h('h2', {}, 'Liens'),
    links.length ? links.map(l => {
      const out = l.from_id === t.id, o = by(S.data.tasks, out ? l.to_id : l.from_id);
      const label = l.type === 'blocks' ? (out ? 'bloque' : 'bloquée par') : LINKFR[l.type];
      return h('div', { class: 'linkrow' }, h('span', { class: `tag ${l.type}` }, label), h('a', { onclick: () => openTask(o.id) }, `#${o.id} ${o.title}`),
        h('span', { class: 'spacer' }), h('button', { class: 'ghost', title: 'Supprimer le lien', onclick: () => api(`/links/${l.id}`, 'DELETE') }, '✕'));
    }) : h('div', { class: 'muted' }, 'Aucun lien.'),
    h('div', { class: 'linkrow' },
      h('select', { onchange: e => newType = e.target.value }, Object.entries(LINKFR).map(([k, v]) => h('option', { value: k }, v))),
      h('select', { style: 'flex:1;min-width:0', onchange: e => newTo = e.target.value }, h('option', { value: '' }, 'Choisir une tâche…'), others.map(o => h('option', { value: o.id }, `#${o.id} ${o.title}`))),
      h('button', { onclick: () => newTo && api('/links', 'POST', { from_id: t.id, to_id: +newTo, type: newType }) }, 'Lier')),
    h('div', { style: 'margin-top:22px;display:flex;justify-content:space-between' },
      h('span', { class: 'muted' }, `Créée par ${t.created_by || '?'}`),
      h('button', { class: 'ghost', onclick: async e => {
        const b = e.currentTarget;
        if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Confirmer la suppression'; b.style.color = 'var(--bad)'; return; }
        try {
          const r = await api(`/tasks/${t.id}`, 'DELETE'); closeTask();
          toast(`Tâche #${t.id} supprimée`, 8000, { label: 'Annuler', run: async () => { const u = await api(`/undo-activity/${r.undo_id}`, 'POST'); toast(u.undone ? `Tâche #${t.id} restaurée` : 'Impossible de restaurer'); } });
        } catch (err) { toast(err.message, 4500); }
      } }, '🗑 Supprimer')));
  dr.replaceChildren(sheet); dr.hidden = false; dr.onclick = closeTask;
}

/* ---------- Rendu ---------- */
let renderToken = 0;
async function render() {
  if (!S.data) return;
  if ((!S.me || !member(S.me)) && S.data.members.length) { S.me = S.data.members[0].id; localStorage.me = S.me; }
  const me = S.me;
  $('#nav').replaceChildren(...[['features', 'Features'], ['board', 'Tableau'], ['list', 'Liste'], ['squads', 'Squads'], ['team', 'Charge'], ['activity', 'Activité'], ['settings', 'Réglages']].map(([k, label]) =>
    h('button', { class: S.view === k ? 'active' : '', onclick: () => { S.view = localStorage.view = k; render(); } }, label)));
  const u = $('#user');
  const sig = S.data.members.map(m => `${m.id}:${m.name}`).join('|');
  if (u.dataset.sig !== sig) {
    u.replaceChildren(...(S.data.members.length ? S.data.members.map(m => h('option', { value: m.id, selected: m.id === me }, m.name)) : [h('option', {}, '— aucune personne —')])); u.dataset.sig = sig;
  }
  u.value = me || '';
  const authOn = S.data.auth.enabled, user = S.data.auth.user;
  if (authOn && user) { S.me = user.id; localStorage.me = S.me; }
  document.querySelector('.who').hidden = authOn || !S.data.members.length;
  $('#whoami').hidden = !authOn; $('#logout').hidden = !authOn;
  if (authOn && user) $('#whoami').textContent = `${user.name}${user.is_admin ? ' · admin' : ''}`;
  renderBell();
  renderBadge();
  const token = ++renderToken;
  const view = (S.data.empty && S.view !== 'settings' ? admin.emptyView : ({ features: org.featuresView, board: boardView, list: listView, squads: org.squadsView, team: teamView, activity: activityView, settings: admin.settingsView })[S.view] || org.featuresView)();
  const node = await view;
  if (token !== renderToken) return;
  const scroll = $('#view').scrollTop;
  $('#view').replaceChildren(node); $('#view').scrollTop = scroll;
  makeFocusable($('#view'));
  if (S.open) renderDrawer();
}

/* ---------- Configuration LLM + ping de latence ---------- */
S.ping = null; S.pings = [];
const PING_MS = 30_000;
function renderBadge() {
  const b = $('#ai-badge'), ai = S.data.ai;
  if (!ai.enabled) { b.className = 'badge mock'; b.replaceChildren('IA : mode local'); b.title = 'Analyseur local simplifié — cliquer pour configurer un LLM'; return; }
  const p = S.ping;
  const cls = !p ? 'live' : !p.ok ? 'bad' : p.ms > 1500 ? 'mock' : 'live';
  b.className = `badge ${cls}`;
  b.replaceChildren(h('span', { class: 'dot' }), `${ai.model}`, p && (p.ok ? ` · ${p.ms} ms` : ' · hors ligne'));
  b.title = p ? (p.ok ? `LLM joignable (${p.ms} ms) — cliquer pour configurer` : `${p.error} — cliquer pour configurer`) : 'Vérification…';
}
async function pingNow() {
  if (!S.data?.ai.enabled) { S.ping = null; S.pings = []; return renderBadge(); }
  try {
    const r = await fetch('/api/llm/ping').then(r => r.json());
    if (r.mode) { S.ping = null; } else { S.ping = r; S.pings = [...S.pings.slice(-29), r]; }
  } catch { S.ping = { ok: false, ms: 0, error: 'Serveur WorkForce injoignable' }; }
  renderBadge(); if (!$('#modal').hidden) renderSpark();
}
setInterval(() => { if (!document.hidden) pingNow(); }, PING_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pingNow(); });

const PRESETS = { 'OpenAI': 'https://api.openai.com/v1', 'Azure / autre (personnalisé)': '', 'Ollama (local)': 'http://localhost:11434/v1', 'LM Studio (local)': 'http://localhost:1234/v1', 'OpenRouter': 'https://openrouter.ai/api/v1' };
function renderSpark() {
  const el = $('#spark'); if (!el) return;
  const max = Math.max(1000, ...S.pings.map(p => p.ms));
  el.replaceChildren(...S.pings.map(p => h('i', { class: p.ok ? '' : 'ko', style: `height:${Math.max(8, p.ms / max * 100)}%`, title: p.ok ? `${p.ms} ms` : p.error })));
  const ok = S.pings.filter(p => p.ok).map(p => p.ms);
  $('#spark-txt').textContent = ok.length ? `Latence : dernière ${S.pings.at(-1).ok ? S.pings.at(-1).ms + ' ms' : 'échec'} · moyenne ${Math.round(ok.reduce((a, b) => a + b, 0) / ok.length)} ms (ping toutes les ${PING_MS / 1000} s)` : 'Aucune mesure pour le moment';
}

function openLlmSettings() {
  const ai = S.data.ai;
  const f = { enabled: ai.enabled, baseUrl: ai.baseUrl, key: '', model: ai.model, sttModel: ai.sttModel };
  const result = h('div', { class: 'result', hidden: true });
  const bind = (k, extra = {}) => h('input', { type: k === 'key' ? 'password' : 'text', value: f[k], autocomplete: 'off', spellcheck: false, oninput: e => f[k] = e.target.value, ...extra });
  const baseInput = bind('baseUrl');
  const preset = h('select', { onchange: e => { if (e.target.value) { f.baseUrl = baseInput.value = e.target.value; } } },
    h('option', { value: '' }, 'Choisir un modèle d’URL…'), Object.entries(PRESETS).filter(([, v]) => v).map(([k, v]) => h('option', { value: v }, k)));
  const body = () => ({ ...f, clearKey: false });
  const show = (ok, text) => { result.hidden = false; result.className = `result ${ok ? 'ok' : 'ko'}`; result.textContent = text; };
  const testBtn = h('button', { onclick: async () => {
    testBtn.disabled = true; show(true, 'Test en cours…'); result.className = 'result';
    try {
      const r = await fetch('/api/llm/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then(r => r.json());
      if (r.error && r.ok === undefined) show(false, r.error);
      else if (r.ok) show(true, `✅ Connexion réussie en ${r.ms} ms — modèle ${r.model}${r.reply ? ` · réponse : « ${r.reply} »` : ''}`);
      else show(false, `❌ ${r.error} (${r.ms} ms)`);
    } catch (e) { show(false, e.message); }
    testBtn.disabled = false;
  } }, '⚡ Tester la connexion');
  const saveBtn = h('button', { class: 'primary', onclick: async () => {
    saveBtn.disabled = true;
    try {
      const r = await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
      S.data.ai = r; S.ping = null; S.pings = []; closeModal(); renderBadge();
      toast(r.enabled ? 'LLM activé — vérification de la latence…' : 'Retour au mode local'); pingNow();
    } catch (e) { show(false, e.message); saveBtn.disabled = false; }
  } }, 'Enregistrer');
  const m = h('div', { class: 'modal', onclick: e => e.stopPropagation() },
    h('h2', {}, 'Configuration du LLM'),
    h('div', { class: 'sub' }, 'Tout fournisseur compatible OpenAI. La clé reste sur le serveur et n’est jamais renvoyée au navigateur.'),
    h('label', { class: 'toggle', style: 'color:var(--text);font-weight:600' }, h('input', { type: 'checkbox', checked: f.enabled, onchange: e => f.enabled = e.target.checked }), 'Utiliser un LLM (sinon : mode local simplifié)'),
    h('div', { class: 'fields' },
      h('label', {}, 'Fournisseur'), preset,
      h('label', {}, 'URL de base'), baseInput,
      h('label', {}, 'Clé API'), bind('key', { placeholder: ai.hasKey ? `•••• ${ai.keyHint} (conservée si vide)` : 'sk-… (optionnelle pour Ollama / LM Studio)' }),
      h('label', {}, 'Modèle'), bind('model'),
      h('label', {}, 'Modèle voix'), bind('sttModel', { title: 'Transcription de secours (navigateurs sans reconnaissance vocale)' })),
    result,
    h('div', { id: 'spark', class: 'spark' }), h('div', { id: 'spark-txt', class: 'muted', style: 'font-size:12px;margin-top:4px' }),
    h('div', { class: 'actions' }, testBtn, h('span', { class: 'spacer' }),
      ai.hasKey && h('button', { class: 'ghost', title: 'Supprimer la clé enregistrée', onclick: async () => {
        await fetch('/api/llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(), enabled: false, clearKey: true }) }).then(r => r.json()).then(r => { S.data.ai = r; });
        closeModal(); renderBadge(); toast('Clé supprimée'); } }, 'Oublier la clé'),
      h('button', { onclick: closeModal }, 'Fermer'), saveBtn));
  const modal = $('#modal'); modal.replaceChildren(m); modal.hidden = false; modal.onclick = closeModal;
  renderSpark(); if (ai.enabled) pingNow();
}
function closeModal() { $('#modal').hidden = true; $('#modal').replaceChildren(); }
$('#ai-badge').addEventListener('click', () => can.admin ? openLlmSettings() : toast('La configuration du LLM est réservée aux administrateurs.'));

/* ---------- Chat ---------- */
const log = $('#log');
function say(text, cls = 'bot') { const m = h('div', { class: `msg ${cls}` }, text); log.append(m); log.scrollTop = log.scrollHeight; return m; }

function speakOut(text) {
  if (!S.speak || !('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text.replace(/[•🔥⚠️]/g, '')); u.lang = 'fr-FR';
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

function proposalCard(actions) {
  const state = actions.map(a => ({ on: true, a }));
  const foot = h('div', { class: 'prop-foot' });
  const box = h('div', { class: 'proposal' });
  const count = () => state.filter(s => s.on).length;
  const refreshFoot = () => { confirmBtn.textContent = `Confirmer (${count()})`; confirmBtn.disabled = !count(); };
  const kinds = { create_task: 'Nouvelle tâche', update_task: 'Modification', link_tasks: 'Lien' };

  actions.forEach((a, i) => {
    const row = h('div', { class: 'act' });
    const cb = h('input', { type: 'checkbox', checked: true, onchange: e => { state[i].on = e.target.checked; refreshFoot(); } });
    row.append(h('div', { class: 'act-head' }, cb, h('div', {}, h('div', { class: 'kind' }, kinds[a.type]),
      a.type === 'link_tasks' ? `#${a.from_id} ${LINKFR[a.link_type]} #${a.to_id}` : a.type === 'update_task' ? `#${a.id} ${a.title}` : a.title)));
    if (a.rows?.length) row.append(h('div', { class: 'rows' }, a.rows.flatMap(r => [h('span', {}, r.field), h('b', {}, r.from ? `${r.from} → ${r.value}` : r.value, r.auto && h('span', { class: 'auto', title: 'Classé automatiquement' }, 'auto'))])));
    for (const w of a.warnings || []) row.append(h('div', { class: 'warn' }, '⚠ ' + w));
    if (a.links?.length) {
      row.append(h('div', { class: 'sugg' }, h('h5', {}, 'Recoupements avec des tâches existantes'), a.links.map(l => h('label', {},
        h('input', { type: 'checkbox', checked: l.selected, onchange: e => l.selected = e.target.checked }),
        h('span', {}, h('span', { class: `tag ${l.type}` }, l.type === 'blocks' ? (l.direction === 'blocked_by' ? 'bloquée par' : 'bloque') : LINKFR[l.type]), ` #${l.task_id} ${l.title}`,
          l.assignee && h('span', { class: 'muted' }, ` (${l.assignee})`), h('div', { class: 'why' }, l.reason))))));
    }
    box.append(row);
  });

  const confirmBtn = h('button', { class: 'primary', onclick: async () => {
    confirmBtn.disabled = true;
    const chosen = state.filter(s => s.on).map(s => ({ ...s.a, links: (s.a.links || []).filter(l => l.selected) }));
    try {
      const r = await api('/chat/confirm', 'POST', { actions: chosen });
      const ok = r.results.filter(x => !x.error).length;
      foot.replaceChildren(h('span', { class: 'grow' }, `✅ ${ok} action${ok > 1 ? 's' : ''} appliquée${ok > 1 ? 's' : ''}`),
        h('button', { onclick: async e => { e.target.disabled = true; await api(`/undo/${r.batch}`, 'POST'); foot.replaceChildren(h('span', { class: 'grow' }, '↩ Annulé')); } }, 'Annuler'));
      box.querySelectorAll('input').forEach(i => i.disabled = true);
      speakOut(`${ok} action${ok > 1 ? 's' : ''} appliquée${ok > 1 ? 's' : ''}`);
    } catch (e) { toast(e.message); confirmBtn.disabled = false; }
  } });
  foot.append(h('span', { class: 'grow' }, 'Rien n’est enregistré avant confirmation'), h('button', { onclick: () => foot.replaceChildren(h('span', { class: 'grow' }, 'Ignoré')) }, 'Ignorer'), confirmBtn);
  refreshFoot(); box.append(foot);
  return box;
}

async function send(text) {
  text = text.trim(); if (!text) return;
  $('#chips').replaceChildren();
  say(text, 'user');
  const wait = say('Je réfléchis…', 'bot thinking');
  try {
    const r = await api('/chat', 'POST', { message: text, history: S.history });
    wait.remove();
    S.history.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
    if (r.reply) say(r.reply);
    if (r.actions.length) log.append(proposalCard(r.actions));
    log.scrollTop = log.scrollHeight;
    speakOut(r.reply);
  } catch (e) { wait.remove(); say('Erreur : ' + e.message); }
}

$('#form').addEventListener('submit', e => { e.preventDefault(); const i = $('#input'); const v = i.value; i.value = ''; i.style.height = ''; send(v); });
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); } });
$('#input').addEventListener('input', e => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#input').focus(); }
  if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); else if (S.open) closeTask(); }
});
$('#user').addEventListener('change', e => { S.me = +e.target.value; localStorage.me = S.me; render(); });
$('#speak').addEventListener('click', e => { S.speak = !S.speak; localStorage.speak = S.speak ? 1 : 0; e.target.textContent = S.speak ? '🔊' : '🔈'; e.target.setAttribute('aria-pressed', S.speak); if (!S.speak) speechSynthesis.cancel(); });

/* ---------- Voix ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recorder = null;
const mic = $('#mic');
function micOff() { mic.classList.remove('on'); mic.textContent = '🎙️'; }

async function recordFallback() {
  if (recorder) { recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia) return toast('Micro indisponible : ouvrez l’application via localhost ou HTTPS.', 5000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = []; recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); micOff();
      const blob = new Blob(chunks, { type: recorder.mimeType }); recorder = null;
      try { toast('Transcription…'); const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type, 'X-User': S.me || '' }, body: blob }).then(r => r.json());
        if (r.error) throw new Error(r.error); send(r.text); } catch (e) { toast(e.message, 5000); }
    };
    recorder.start(); mic.classList.add('on'); mic.textContent = '⏹';
  } catch { toast('Accès au micro refusé ou indisponible (HTTPS/localhost requis).', 5000); }
}

mic.addEventListener('click', () => {
  if (!SR) return recordFallback();
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = 'fr-FR'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onresult = e => { let interim = ''; for (const r of e.results) { if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; } $('#input').value = finalText + interim; };
  rec.onerror = e => { toast(e.error === 'not-allowed' ? 'Accès au micro refusé (HTTPS/localhost requis).' : `Voix : ${e.error}`, 4000); };
  rec.onend = () => { micOff(); rec = null; const v = $('#input').value; if (v.trim()) { $('#input').value = ''; send(v); } };
  rec.start(); mic.classList.add('on'); mic.textContent = '⏹';
});

/* ---------- Nouvelle tâche (sans passer par le chat) ---------- */
function openTaskModal(preset = {}) {
  const { modal, fields, opts, saver, errBox } = org.ui;
  const v = { title: '', feature_id: preset.feature_id ?? (S.f.feature ? +S.f.feature : ''), assignee_id: preset.assignee_id ?? '', priority: 'medium', due_date: '', estimate_h: '' };
  const err = errBox();
  const create = h('button', { class: 'primary' }, 'Créer la tâche');
  let createdId = null;
  create.onclick = saver(err, async () => {
    const r = await api('/tasks', 'POST', { title: v.title, feature_id: v.feature_id || null, assignee_id: v.assignee_id || null, priority: v.priority, due_date: v.due_date || null, estimate_h: v.estimate_h === '' ? null : +v.estimate_h });
    createdId = r.id;
    toast(`Tâche #${r.id} créée`, 6000, { label: 'Ouvrir', run: () => openTask(r.id) });
  });
  const title = h('input', { type: 'text', placeholder: 'Que faut-il faire ? (verbe + objet)', maxlength: 200, oninput: e => v.title = e.target.value, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); create.click(); } } });
  openModal(modal('Nouvelle tâche', 'Sans feature, la tâche ira dans l’Inbox que les leads trient. Astuce : l’assistant sait aussi la classer pour vous.',
    fields([['Titre', title], ['Feature', org.featureSelect(v.feature_id || null, id => v.feature_id = id ?? '', '— Inbox (à trier) —')],
      ['Assignée à', h('select', { onchange: e => v.assignee_id = e.target.value ? +e.target.value : '' }, opts(S.data.members, v.assignee_id, '— personne —'))],
      ['Priorité', h('select', { onchange: e => v.priority = e.target.value }, Object.entries(PRIO).map(([k, l]) => h('option', { value: k, selected: k === 'medium' }, l)))],
      ['Échéance', h('input', { type: 'date', onchange: e => v.due_date = e.target.value })],
      ['Estimation (h)', h('input', { type: 'number', min: 0, step: 0.5, onchange: e => v.estimate_h = e.target.value })]]),
    err, h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), create)));
  title.focus();
}
$('#new-task').addEventListener('click', () => openTaskModal());

/* ---------- Accessibilité clavier, fraîcheur multi-utilisateurs, mobile ---------- */
const ACTIVABLE = '.flink, .mini, .mrow, .card, .fn, .setrow';
function makeFocusable(root) { markDraggables(root); root.querySelectorAll(ACTIVABLE).forEach(el => { if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; el.setAttribute('role', 'button'); } }); }
document.addEventListener('keydown', e => {
  const typing = e.target.matches?.('input, textarea, select, [contenteditable]');
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.(ACTIVABLE)) { e.preventDefault(); e.target.click(); }
  else if (e.key === 'n' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && $('#modal').hidden && S.data) { e.preventDefault(); openTaskModal(); }
});

/** Les autres utilisateurs modifient aussi les données : on se resynchronise toutes les 15 s (sans casser une saisie ou un glisser-déposer en cours). */
const dataSig = d => JSON.stringify([d.tasks, d.members, d.squads, d.features, d.projects, d.teams, d.links, d.feature_deps, d.notifications]);
async function refresh() {
  if (document.hidden || DRAG.id || DRAG.member || !S.data) return;
  const a = document.activeElement;
  if (!$('#modal').hidden || (a && a.matches?.('input, select, textarea') && (a.closest('#view') || a.closest('#drawer')))) return;
  try {
    const d = await fetch('/api/bootstrap', { headers: idHeaders() }).then(r => { if (r.status === 401 && S.auth?.enabled) { showLogin(S.auth.providers); return Promise.reject(); } return r.ok ? r.json() : Promise.reject(); });
    const sig = dataSig(d);
    if (sig === dataSig(S.data)) return;      // rien de neuf (compare à ce qui est affiché, y compris après nos propres modifications)
    S.data = { ...S.data, ...d }; render();
  } catch { /* serveur momentanément indisponible : on réessaiera */ }
}
setInterval(refresh, 15_000);
window.addEventListener('focus', refresh);
$('#chat-toggle').addEventListener('click', () => document.body.classList.toggle('chat-open'));
$('#chat-close').addEventListener('click', () => document.body.classList.remove('chat-open'));

/* ---------- Connexion (OIDC) ---------- */
function showLogin(providers = []) {
  $('#login').replaceChildren(h('div', { class: 'login-card' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'WorkForce'), h('h2', {}, 'Connexion'),
    h('p', { class: 'muted' }, 'Identifiez-vous avec le compte de votre organisation.'),
    providers.length ? providers.map(p => h('a', { class: 'btn primary login-btn', href: `/auth/login/${p.id}` }, `Se connecter avec ${p.label}`)) : h('p', {}, 'Aucun fournisseur de connexion n’est configuré sur ce serveur.')));
  $('#login').hidden = false;
}
$('#logout').addEventListener('click', async () => { try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } finally { location.reload(); } });

/* ---------- Notifications ---------- */
const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'à l’instant' : s < 3600 ? `il y a ${Math.floor(s / 60)} min` : s < 86400 ? `il y a ${Math.floor(s / 3600)} h` : new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };
let seenMax = null;
function renderBell() {
  const n = S.data.notifications || { unread: 0, items: [] };
  const badge = $('#bell-n'); badge.hidden = !n.unread; badge.textContent = n.unread > 99 ? '99+' : n.unread;
  $('#bell').setAttribute('aria-label', n.unread ? `Notifications : ${n.unread} non lue${n.unread > 1 ? 's' : ''}` : 'Notifications');
  document.title = n.unread ? `(${n.unread}) WorkForce` : 'WorkForce';
  const maxId = n.items[0]?.id || 0;
  if (seenMax !== null && maxId > seenMax && document.hidden && 'Notification' in window && Notification.permission === 'granted' && localStorage.browserNotif === '1')
    n.items.filter(x => x.id > seenMax && !x.read_at).slice(0, 3).forEach(x => { try { new Notification('WorkForce', { body: x.text }); } catch { /* non supporté */ } });
  seenMax = maxId;
  if (!$('#notif').hidden) renderNotifPanel();
}
const markRead = body => api('/notifications/read', 'POST', body).catch(e => toast(e.message));
function openNotification(n) {
  if (!n.read_at) markRead({ ids: [n.id] });
  $('#notif').hidden = true;
  if (n.task_id && by(S.data.tasks, n.task_id)) openTask(n.task_id);
  else if (n.feature_id && S.data.features.find(f => f.id === n.feature_id)) { S.view = localStorage.view = 'features'; render(); }
  else if (n.kind === 'account') { S.view = localStorage.view = 'squads'; render(); }
}
function renderNotifPanel() {
  const n = S.data.notifications || { unread: 0, items: [] };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const browserOn = perm === 'granted' && localStorage.browserNotif === '1';
  $('#notif').replaceChildren(...[
    h('div', { class: 'notif-head' }, h('strong', {}, 'Notifications'), h('span', { class: 'grow' }), n.unread > 0 && h('button', { class: 'ghost', onclick: () => markRead({ all: true }) }, 'Tout marquer comme lu')),
    n.items.length ? h('div', { class: 'notif-list' }, n.items.map(x => h('button', { class: `notif-item ${x.read_at ? '' : 'unread'}`, onclick: () => openNotification(x) },
      h('span', { class: 'dot' }), h('span', { class: 'grow' }, x.text, h('span', { class: 'muted when' }, ago(x.created_at)))))) : h('div', { class: 'empty' }, 'Rien de neuf pour le moment. 👌'),
    perm !== 'unsupported' && perm !== 'denied' && h('div', { class: 'notif-foot' }, h('button', { class: 'ghost', onclick: async () => {
      if (browserOn) { localStorage.browserNotif = '0'; renderNotifPanel(); return; }
      const r = perm === 'granted' ? 'granted' : await Notification.requestPermission();
      if (r === 'granted') { localStorage.browserNotif = '1'; toast('Alertes du navigateur activées'); } renderNotifPanel();
    } }, browserOn ? '🔕 Désactiver les alertes du navigateur' : '🔔 Activer les alertes du navigateur')),
    perm === 'denied' && h('div', { class: 'notif-foot muted' }, 'Alertes du navigateur bloquées dans les réglages du site.')].filter(Boolean));
}
$('#bell').addEventListener('click', e => { e.stopPropagation(); const p = $('#notif'); p.hidden = !p.hidden; if (!p.hidden) { renderNotifPanel(); refresh(); } });
document.addEventListener('click', e => { const p = $('#notif'); if (!p.hidden && !p.contains(e.target) && !$('#bell').contains(e.target)) p.hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#notif').hidden = true; });

enableTouchDnd();

/* ---------- Démarrage ---------- */
async function boot() {
  try {
    S.auth = await fetch('/api/auth/me').then(r => r.json());
    if (S.auth.enabled && !S.auth.user) return showLogin(S.auth.providers);
    $('#login').hidden = true;
    S.data = await fetch('/api/bootstrap', { headers: idHeaders() }).then(async r => { if (r.status === 401) throw Object.assign(new Error('401'), { auth: true }); return r.json(); });
    S.auth = S.data.auth;
  }
  catch (e) { if (e.auth) return showLogin(S.auth?.providers); $('#view').replaceChildren(h('div', { class: 'panel empty' }, 'Impossible de joindre le serveur WorkForce. Vérifiez qu’il est démarré, puis rechargez la page.')); return; }
  if (S.data.members.length && (!S.me || !member(S.me))) { S.me = S.data.members[0].id; localStorage.me = S.me; }
  $('#speak').textContent = S.speak ? '🔊' : '🔈';
  await render(); pingNow();
  if (!log.children.length) {
    const first = member(S.me)?.name.split(' ')[0];
    say(first ? `Bonjour ${first} ! Dites-moi ce qui se passe, je m’occupe de créer, classer et relier les tâches. Vous pouvez aussi me parler avec 🎙️.`
      : 'Bonjour ! Commencez par construire votre organisation (personnes, squads, features). Ensuite, dites-moi ce qui se passe et je créerai, classerai et relierai vos tâches.');
    if (!S.data.empty) $('#chips').replaceChildren(...[
      'Il faut mettre à jour la documentation, plutôt urgent pour vendredi',
      'Qui est surchargé en ce moment ?',
      'Où en est-on sur les tâches bloquées ?',
      'Montre-moi mes tâches urgentes',
    ].map(s => h('button', { onclick: () => send(s) }, s)));
  }
}
boot();
