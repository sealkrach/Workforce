// Organisation : squads (3–5 personnes + lead), features, garde-fous, carte des dépendances.
// Module autonome : reçoit ses dépendances (état, helpers) de app.js, sans import circulaire.
export function createOrg(c) {
  const { h, S, api, toast, by, member, team, project, avatar, openTask, openModal, closeModal, makeDraggable, DRAG, fmtDate, can } = c;
  const FSTATUS = { discovery: 'Cadrage', building: 'Réalisation', shipping: 'Livraison', live: 'En ligne' };
  const HEALTH_FR = { green: 'Tout va bien', orange: 'À surveiller', red: 'En difficulté' };
  const squadOf = id => S.data.squads.find(s => s.id === id);
  const featureOf = id => S.data.features.find(f => f.id === id);
  const today = () => new Date().toLocaleDateString('sv-SE');
  const mySquadId = () => member(S.me)?.squad_id || null;
  /** Squad affichée : celle de l'utilisateur par défaut, '' = toutes. */
  const curSquad = () => S.f.squad == null ? (mySquadId() ? String(mySquadId()) : '') : S.f.squad;
  const plural = (n, s, p = s + 's') => `${n} ${n > 1 ? p : s}`;

  /* ---------- Briques ---------- */
  const health = f => h('span', { class: `health ${f.health}`, title: `${HEALTH_FR[f.health]}${f.reasons.length ? '\n• ' + f.reasons.join('\n• ') : ''}` });
  const sizeChip = sq => h('span', { class: `chip ${sq.size < S.data.rules.min || sq.size > S.data.rules.max ? 'bad' : 'good'}`, title: `Cible : ${S.data.rules.min} à ${S.data.rules.max} personnes` }, plural(sq.size, 'personne'));
  const leadChip = sq => { const m = member(sq.lead_id); return m ? h('span', { class: 'chip lead', title: 'Lead de la squad' }, '★ ', m.name) : h('span', { class: 'chip bad' }, 'Pas de lead'); };
  const loadBar = sq => h('div', { class: 'loadline', title: `${sq.load_h} h à faire sur les ${sq.window_days} prochains jours pour ${sq.capacity_h} h de capacité (prêts de temps inclus)` },
    h('div', { class: 'bar' }, h('i', { class: sq.pct > 100 ? 'over' : sq.pct > 80 ? 'mid' : '', style: `width:${Math.min(sq.pct, 100)}%` })), h('span', { class: 'muted' }, `charge 2 sem. ${sq.pct} %`));

  function featureSelect(current, onchange, placeholder = '— Inbox (aucune feature) —') {
    return h('select', { onchange: e => onchange(e.target.value ? +e.target.value : null) }, h('option', { value: '' }, placeholder),
      S.data.squads.map(sq => h('optgroup', { label: sq.name }, S.data.features.filter(f => f.squad_id === sq.id).map(f =>
        h('option', { value: f.id, selected: f.id === current }, `${f.name}${f.status === 'live' ? ' (en ligne)' : ''}`)))));
  }

  const miniTask = t => {
    const el = h('div', { class: 'mini', title: 'Glisser vers une autre feature pour la rattacher', onclick: () => openTask(t.id) },
      h('span', { class: `prio ${t.priority}` }), h('span', { class: 'mt' }, t.title), S.data.blocked.includes(t.id) && h('span', { class: 'lock' }, '🔒'), avatar(member(t.assignee_id)));
    makeDraggable(el, t.id); return el;
  };

  function attachTask(taskId, featureId) {
    const t = by(S.data.tasks, taskId); if (!t || t.feature_id === featureId) return;
    const f = featureId && featureOf(featureId);
    api(`/tasks/${taskId}`, 'PATCH', { feature_id: featureId }).then(() => toast(f ? `#${taskId} → « ${f.name} » (${squadOf(f.squad_id).name})` : `#${taskId} renvoyée dans l’Inbox`)).catch(e => toast(e.message));
  }
  function dropZone(el, onDrop, kind = 'id') {
    el.addEventListener('dragover', e => { if (DRAG[kind]) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('over'); } });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); onDrop(DRAG[kind]); });
    return el;
  }
  function memberDraggable(el, id) {
    el.draggable = true;
    el.addEventListener('dragstart', e => { DRAG.member = id; e.dataTransfer.setData('text/plain', 'm' + id); e.dataTransfer.effectAllowed = 'move'; requestAnimationFrame(() => el.classList.add('dragging')); });
    el.addEventListener('dragend', () => { DRAG.member = null; el.classList.remove('dragging'); document.querySelectorAll('.over').forEach(n => n.classList.remove('over')); });
  }
  const moveMember = (id, squadId) => {
    const m = member(id); if (!m || m.squad_id === squadId) return;
    api(`/members/${id}`, 'PATCH', { squad_id: squadId }).then(() => toast(squadId ? `${m.name} rejoint « ${squadOf(squadId).name} »` : `${m.name} n’a plus de squad`)).catch(e => toast(e.message, 4500));
  };

  const banner = list => list.length ? h('div', { class: 'guards' }, list.map(g => h('div', { class: `guard ${g.level === 'warn' ? 'alert' : 'note'}` },
    h('span', {}, g.level === 'warn' ? '⚠️' : 'ℹ️'), h('span', {}, g.message)))) : null;

  /* ---------- Vue « Features » (accueil du lead) ---------- */
  function featureCard(f) {
    const sq = squadOf(f.squad_id), tasks = S.data.tasks.filter(t => t.feature_id === f.id && t.status !== 'done');
    const needs = S.data.feature_deps.filter(d => d.from_feature_id === f.id).map(d => ({ d, p: featureOf(d.to_feature_id) })).filter(x => x.p);
    const lateDate = f.target_date && f.target_date < today() && f.status !== 'live';
    const el = h('div', { class: `fcard ${f.health}` },
      h('div', { class: 'fhead' }, health(f), h('a', { class: 'flink', onclick: () => can.leadOf(f.squad_id) ? openFeatureModal(f.id) : toast(`Seul le lead de « ${sq.name} » (ou un administrateur) peut modifier cette feature.`, 4000) }, f.name), h('span', { class: `chip st-${f.status}` }, FSTATUS[f.status])),
      f.outcome && h('div', { class: 'muted fout' }, f.outcome),
      h('div', { class: 'bar', title: `${f.progress} % du travail estimé est terminé` }, h('i', { style: `width:${f.progress}%` })),
      h('div', { class: 'meta' }, `${f.done_count}/${f.task_count} tâches · ${f.progress} %`,
        f.target_date && h('span', { class: `due ${lateDate ? 'late' : ''}` }, '🎯 ' + fmtDate(f.target_date)),
        f.project_id && h('span', { class: 'chip' }, project(f.project_id).key),
        f.blocked > 0 && h('span', { class: 'lock' }, `🔒 ${f.blocked}`), f.overdue > 0 && h('span', { class: 'due late' }, `⏰ ${f.overdue}`)),
      f.reasons.length > 0 && h('ul', { class: `reasons ${f.health}` }, f.reasons.map(r => h('li', {}, r))),
      needs.length > 0 && h('div', { class: 'needs' }, h('span', { class: 'muted' }, 'Dépend de '), needs.map(({ p }) =>
        h('span', { class: `chip ${p.status !== 'live' && p.squad_id !== f.squad_id ? 'warn' : ''}`, title: `${squadOf(p.squad_id).name} · ${FSTATUS[p.status]}` }, p.name, p.squad_id !== f.squad_id ? ` · ${squadOf(p.squad_id).name}` : ''))),
      h('div', { class: 'minis' }, tasks.slice(0, 4).map(miniTask), tasks.length > 4 && h('div', { class: 'muted more' }, `+ ${tasks.length - 4} autres`), !tasks.length && h('div', { class: 'muted more' }, f.task_count ? 'Tout est terminé 🎉' : 'Aucune tâche — glissez-en une ici')));
    return dropZone(el, id => attachTask(id, f.id));
  }

  function squadHeader(sq, { edit = true } = {}) {
    return h('div', { class: 'sqhead', style: `border-left-color:${sq.color}` },
      h('div', { class: 'grow' }, h('strong', { class: 'sqname' }, sq.name), h('div', { class: 'muted' }, sq.mission || '—')),
      leadChip(sq), sizeChip(sq), loadBar(sq),
      h('span', { class: `chip ${sq.active_features > sq.max_active_features ? 'bad' : ''}`, title: 'Features actives / limite de travail en parallèle' }, `${sq.active_features}/${sq.max_active_features} features actives`),
      edit && can.leadOf(sq.id) && h('button', { class: 'ghost', title: 'Modifier la squad', onclick: () => openSquadModal(sq.id) }, '⚙︎'));
  }

  /** Rattache une tâche à une feature, ou l'adresse à l'Inbox d'une autre squad. */
  const sendToSquad = (taskId, squadId) => api(`/tasks/${taskId}`, 'PATCH', { feature_id: null, inbox_squad_id: squadId }).then(() => toast(`#${taskId} → Inbox de « ${squadOf(squadId).name} »`)).catch(e => toast(e.message));

  /** Une Inbox par squad : le lead trie les tâches qui lui sont adressées. squadId null = tâches sans squad destinataire. */
  function inboxPanel(squadId) {
    const tasks = S.data.tasks.filter(t => !t.feature_id && t.status !== 'done' && (t.inbox_squad_id || null) === squadId);
    if (!tasks.length) return null;
    const sq = squadId ? squadOf(squadId) : null;
    const groups = [...S.data.squads].sort((a, b) => (b.id === squadId) - (a.id === squadId));          // les features de CETTE squad d'abord
    const attach = t => h('select', { 'aria-label': 'Rattacher à une feature', onchange: e => { const v = e.target.value; if (v.startsWith('f')) attachTask(t.id, +v.slice(1)); else if (v.startsWith('s')) sendToSquad(t.id, +v.slice(1)); } },
      h('option', { value: '' }, 'Rattacher à…'),
      groups.map(q => h('optgroup', { label: q.id === squadId ? `Features de ${q.name}` : q.name }, S.data.features.filter(f => f.squad_id === q.id && f.status !== 'live').map(f => h('option', { value: 'f' + f.id }, f.name)))),
      h('optgroup', { label: 'Envoyer à une autre squad' }, S.data.squads.filter(q => q.id !== squadId).map(q => h('option', { value: 's' + q.id }, `Inbox de ${q.name}`))));
    const why = t => t.assignee_id && member(t.assignee_id)?.squad_id === squadId ? `assignée à ${member(t.assignee_id).name}` : t.created_by ? `créée par ${t.created_by}` : '';
    const el = h('div', { class: 'panel inbox' },
      h('strong', {}, sq ? `📥 Inbox de « ${sq.name} » (${tasks.length})` : `📥 Sans squad destinataire (${tasks.length})`),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, sq ? 'Tâches adressées à cette squad, sans feature. Le lead les rattache à une feature, ou les renvoie vers la bonne squad.' : 'Ces tâches ne sont adressées à aucune squad : envoyez-les à la bonne squad.'),
      tasks.map(t => h('div', { class: 'inrow' }, miniTask(t), h('span', { class: 'muted why' }, why(t)), attach(t))));
    return sq ? dropZone(el, id => { const t = by(S.data.tasks, id); if (t && (t.feature_id || t.inbox_squad_id !== sq.id)) sendToSquad(id, sq.id); }) : el;
  }

  function featuresView() {
    const sel = curSquad(), squads = S.data.squads.filter(s => !sel || String(s.id) === sel);
    const guards = S.data.guardrails.filter(g => !sel || g.squad_id === +sel || g.squads?.includes(+sel) || (g.kind === 'inbox' && g.squad_id == null));
    const bar = h('div', { class: 'toolbar' },
      h('select', { onchange: e => { S.f.squad = e.target.value; c.render(); } }, h('option', { value: '' }, 'Toutes les squads'), S.data.squads.map(s => h('option', { value: s.id, selected: String(s.id) === sel }, s.name))),
      h('span', { class: 'grow' }), can.anyLead && h('button', { class: 'primary', onclick: () => openFeatureModal(null) }, '＋ Nouvelle feature'));
    if (!S.data.squads.length) return h('div', {}, bar, h('div', { class: 'panel empty' }, 'Aucune squad pour le moment. ', h('a', { class: 'flink', onclick: () => openSquadModal(null) }, 'Créez la première')));
    return h('div', {}, bar, banner(guards), squads.map(sq => inboxPanel(sq.id)), can.anyLead && inboxPanel(null),   // « sans squad destinataire » : visible des leads et administrateurs, quelle que soit la squad affichée
      squads.map(sq => {
        const feats = S.data.features.filter(f => f.squad_id === sq.id).sort((a, b) => (a.status === 'live') - (b.status === 'live') || ['red', 'orange', 'green'].indexOf(a.health) - ['red', 'orange', 'green'].indexOf(b.health));
        return h('section', { class: 'squadsec' }, squadHeader(sq),
          feats.length ? h('div', { class: 'fgrid' }, feats.map(featureCard)) : h('div', { class: 'muted', style: 'padding:10px 4px' }, 'Aucune feature. ', h('a', { class: 'flink', onclick: () => openFeatureModal(null, { squad_id: sq.id }) }, 'En créer une')));
      }));
  }

  /* ---------- Vue « Squads » ---------- */
  const svgEl = (tag, attrs = {}, ...kids) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids.flat().filter(Boolean)); return e; };

  function orgMap() {
    const sqs = S.data.squads; if (sqs.length < 2) return null;
    const W = 640, H = 300, cx = W / 2, cy = H / 2 - 6, pos = {};
    sqs.forEach((s, i) => { const a = i / sqs.length * Math.PI * 2 - Math.PI / 2; pos[s.id] = { x: cx + Math.cos(a) * 230, y: cy + Math.sin(a) * 100 }; });
    const edges = S.data.coupling.map(k => {
      const A = pos[k.a], B = pos[k.b], col = k.count >= 3 ? 'var(--bad)' : k.count === 2 ? 'var(--warn)' : 'var(--muted)';
      return svgEl('g', {}, svgEl('line', { x1: A.x, y1: A.y, x2: B.x, y2: B.y, stroke: col, 'stroke-width': 1.5 + k.count * 2, opacity: .7, 'stroke-linecap': 'round' }, svgEl('title', {}, k.links.map(l => `${l.from} → ${l.to}`).join('\n'))),
        svgEl('text', { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 + 4, 'text-anchor': 'middle', class: 'edge-n' }, String(k.count)));
    });
    const nodes = sqs.map(s => { const p = pos[s.id], r = 16 + s.size * 3.5, ok = s.size >= S.data.rules.min && s.size <= S.data.rules.max;
      return svgEl('g', { class: 'node' }, svgEl('circle', { cx: p.x, cy: p.y, r, fill: s.color, opacity: .92, stroke: ok ? 'none' : 'var(--bad)', 'stroke-width': 3, 'stroke-dasharray': ok ? '' : '4 3' }, svgEl('title', {}, `${s.name} — ${plural(s.size, 'personne')}`)),
        svgEl('text', { x: p.x, y: p.y + 5, 'text-anchor': 'middle', class: 'node-n' }, String(s.size)), svgEl('text', { x: p.x, y: p.y + r + 15, 'text-anchor': 'middle', class: 'node-l' }, s.name)); });
    return h('div', { class: 'panel' }, h('div', { class: 'maphead' }, h('strong', {}, 'Carte des dépendances entre squads'), h('span', { class: 'muted' }, 'Épaisseur = nombre de dépendances entre features. Le chiffre dans la bulle = taille de la squad (pointillé rouge : hors de 3–5).')),
      svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'orgmap', role: 'img', 'aria-label': 'Carte des dépendances entre squads' }, edges, nodes));
  }

  function memberRow(m, sq, loan) {
    const lead = sq.lead_id === m.id, fn = team(m.team_id)?.name;
    const el = h('div', { class: `mrow ${loan ? 'loan' : ''}`, title: loan ? 'Prêtée à cette squad' : 'Cliquer pour modifier · glisser vers une autre squad pour déplacer', onclick: () => (can.admin || can.leadOf(m.squad_id) || m.id === S.me) ? openMemberModal(m.id) : toast('Seul le lead de sa squad, un administrateur ou la personne elle-même peut modifier cette fiche.', 4000) },
      avatar(m), h('div', { class: 'grow' }, h('strong', {}, m.name), h('div', { class: 'muted' }, `${m.role}${fn ? ' · ' + fn : ''}`)),
      lead && h('span', { class: 'chip lead' }, '★ lead'), loan && h('span', { class: 'chip' }, `${loan} % · de ${squadOf(m.squad_id)?.name || '—'}`),
      !loan && m.loan_squad_id && h('span', { class: 'chip', title: `Prête ${m.loan_pct} % de son temps` }, `${m.loan_pct} % → ${squadOf(m.loan_squad_id)?.name}`));
    if (!loan) memberDraggable(el, m.id);
    return el;
  }

  function squadsView() {
    const D = S.data;
    const loose = D.members.filter(m => !m.squad_id);
    const cards = D.squads.map(sq => {
      const crew = D.members.filter(m => m.squad_id === sq.id).sort((a, b) => (b.id === sq.lead_id) - (a.id === sq.lead_id));
      const loaned = D.members.filter(m => m.loan_squad_id === sq.id && m.loan_pct > 0);
      const feats = D.features.filter(f => f.squad_id === sq.id);
      return dropZone(h('div', { class: 'panel squadcard', style: `border-top:4px solid ${sq.color}` }, squadHeaderCompact(sq),
        h('div', { class: 'crew' }, crew.map(m => memberRow(m, sq)), loaned.map(m => memberRow(m, sq, m.loan_pct)), !crew.length && h('div', { class: 'muted', style: 'padding:8px' }, 'Glissez des personnes ici')),
        h('div', { class: 'feats' }, h('div', { class: 'muted', style: 'font-size:12px;margin:8px 0 4px' }, 'Features'), feats.length ? feats.map(f => h('a', { class: 'flink fline', onclick: () => openFeatureModal(f.id) }, health(f), f.name)) : h('span', { class: 'muted' }, 'Aucune'))), id => moveMember(id, sq.id), 'member');
    });
    const looseCard = loose.length ? dropZone(h('div', { class: 'panel', style: 'border-style:dashed' }, h('strong', {}, `Sans squad (${loose.length})`),
      h('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Glissez chaque personne vers une squad'), loose.map(m => memberRow(m, { lead_id: null })) ), id => moveMember(id, null), 'member') : null;
    return h('div', {}, h('div', { class: 'toolbar' }, h('div', { class: 'rule' }, `Règle d’or : ${D.rules.min} à ${D.rules.max} personnes, 1 lead, 1 propriétaire par feature.`), h('span', { class: 'grow' }),
      can.admin && h('button', { onclick: () => openMemberModal(null) }, '＋ Personne'), can.admin && h('button', { class: 'primary', onclick: () => openSquadModal(null) }, '＋ Nouvelle squad')),
      banner(D.guardrails.filter(g => g.kind !== 'inbox')), orgMap(), h('h2', {}, 'Squads'), h('div', { class: 'grid squads' }, cards, looseCard));
  }
  function squadHeaderCompact(sq) {
    return h('div', { class: 'sqcompact' }, h('div', { class: 'sqtop' }, h('strong', { class: 'sqname' }, sq.name), h('span', { class: 'grow' }), sizeChip(sq), can.leadOf(sq.id) && h('button', { class: 'ghost', title: 'Modifier la squad', onclick: () => openSquadModal(sq.id) }, '⚙︎')),
      h('div', { class: 'muted' }, sq.mission || '—'), h('div', { class: 'meta', style: 'margin:6px 0' }, leadChip(sq), h('span', { class: `chip ${sq.active_features > sq.max_active_features ? 'bad' : ''}` }, `${sq.active_features}/${sq.max_active_features} features actives`)), loadBar(sq));
  }

  /* ---------- Fenêtres de modification ---------- */
  const modal = (title, sub, ...body) => h('div', { class: 'modal', onclick: e => e.stopPropagation() }, h('h2', {}, title), sub && h('div', { class: 'sub' }, sub), ...body);
  const fields = rows => h('div', { class: 'fields' }, rows.flatMap(([l, el]) => [h('label', {}, l), el]));
  const opts = (list, cur, none) => [none != null && h('option', { value: '' }, none), ...list.map(x => h('option', { value: x.id, selected: x.id === cur }, x.name))];
  function saver(errEl, run) {
    return async e => { const b = e.currentTarget; b.disabled = true; errEl.hidden = true;
      try { await run(); closeModal(); } catch (err) { errEl.textContent = err.message; errEl.hidden = false; b.disabled = false; } };
  }
  const errBox = () => h('div', { class: 'result ko', hidden: true });

  function openFeatureModal(id, draft = {}) {
    const f = id ? featureOf(id) : null;
    const v = { name: f?.name || '', outcome: f?.outcome || '', squad_id: f?.squad_id || (can.leadOf(+curSquad()) ? +curSquad() : S.data.squads.find(q => can.leadOf(q.id))?.id), project_id: f?.project_id ?? '', status: f?.status || 'discovery', target_date: f?.target_date || '', ...draft };
    const err = errBox();
    const text = (k, extra = {}) => h('input', { type: 'text', value: v[k], oninput: e => v[k] = e.target.value, ...extra });
    const selv = (k, list, none, num = true) => h('select', { onchange: e => v[k] = e.target.value === '' ? '' : num ? +e.target.value : e.target.value }, opts(list, v[k], none));
    const payload = () => ({ ...v, project_id: v.project_id || null, target_date: v.target_date || null });
    const needs = f ? S.data.feature_deps.filter(d => d.from_feature_id === f.id) : [], needed = f ? S.data.feature_deps.filter(d => d.to_feature_id === f.id) : [];
    const depLine = (d, other, removable) => h('div', { class: 'linkrow' }, h('span', { class: `tag ${squadOf(other.squad_id).id !== v.squad_id ? 'blocks' : 'relates'}` }, squadOf(other.squad_id).name), h('span', {}, other.name), d.note && h('span', { class: 'muted' }, `— ${d.note}`), h('span', { class: 'spacer' }),
      removable && h('button', { class: 'ghost', title: 'Retirer la dépendance', onclick: async () => { await api(`/feature-deps/${d.id}`, 'DELETE'); openFeatureModal(id, v); } }, '✕'));
    let newDep = '', newNote = '';
    const candidates = f ? S.data.features.filter(x => x.id !== f.id && !needs.some(d => d.to_feature_id === x.id)) : [];
    const delBtn = f && h('button', { class: 'ghost', onclick: e => {
      const n = S.data.tasks.filter(t => t.feature_id === f.id).length;
      if (e.currentTarget.dataset.armed) return api(`/features/${f.id}`, 'DELETE').then(closeModal).catch(x => toast(x.message));
      e.currentTarget.dataset.armed = 1; e.currentTarget.textContent = `Confirmer (${plural(n, 'tâche')} → Inbox)`; e.currentTarget.style.color = 'var(--bad)';
    } }, '🗑 Supprimer');
    const save = h('button', { class: 'primary' }, f ? 'Enregistrer' : 'Créer la feature');
    save.onclick = saver(err, async () => { await api(f ? `/features/${f.id}` : '/features', f ? 'PATCH' : 'POST', payload()); if (!f) toast('Feature créée'); });
    openModal(modal(f ? 'Modifier la feature' : 'Nouvelle feature', 'Une feature = un résultat livrable, portée par une seule squad.',
      fields([['Nom', text('name', { placeholder: 'Ex : Connexion & SSO' })], ['Résultat attendu', text('outcome', { placeholder: 'Ce que les utilisateurs pourront faire' })],
        ['Squad', selv('squad_id', S.data.squads.filter(q => can.leadOf(q.id)))], ['Projet', selv('project_id', S.data.projects, '— aucun —')],
        ['Statut', h('select', { onchange: e => v.status = e.target.value }, Object.entries(FSTATUS).map(([k, l]) => h('option', { value: k, selected: k === v.status }, l)))],
        ['Échéance', h('input', { type: 'date', value: v.target_date, onchange: e => v.target_date = e.target.value })]]),
      f && h('h2', { style: 'font-size:14px;margin:14px 0 6px' }, 'Cette feature a besoin de'),
      f && (needs.length ? needs.map(d => depLine(d, featureOf(d.to_feature_id), true)) : h('div', { class: 'muted' }, 'Aucune dépendance.')),
      f && h('div', { class: 'linkrow' }, h('select', { style: 'flex:1;min-width:0', onchange: e => newDep = e.target.value }, h('option', { value: '' }, 'Ajouter une dépendance…'),
        S.data.squads.map(sq => h('optgroup', { label: sq.name }, candidates.filter(x => x.squad_id === sq.id).map(x => h('option', { value: x.id }, x.name))))),
        h('input', { type: 'text', placeholder: 'Raison (facultatif)', style: 'flex:1;min-width:120px', oninput: e => newNote = e.target.value }),
        h('button', { onclick: async () => { if (!newDep) return; try { await api('/feature-deps', 'POST', { from_feature_id: f.id, to_feature_id: +newDep, note: newNote }); openFeatureModal(id, v); } catch (e) { err.textContent = e.message; err.hidden = false; } } }, 'Ajouter')),
      f && needed.length > 0 && h('div', { class: 'muted', style: 'margin-top:8px' }, 'Attendue par : ', needed.map(d => featureOf(d.from_feature_id).name).join(', ')),
      err, h('div', { class: 'actions' }, delBtn, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), save)));
  }

  function openSquadModal(id) {
    const sq = id ? squadOf(id) : null;
    const v = { name: sq?.name || '', mission: sq?.mission || '', lead_id: sq?.lead_id || '', max_active_features: sq?.max_active_features || 3, color: sq?.color || '#6366f1' };
    const err = errBox();
    const candidates = sq ? S.data.members.filter(m => m.squad_id === sq.id) : S.data.members;
    const save = h('button', { class: 'primary' }, sq ? 'Enregistrer' : 'Créer la squad');
    save.onclick = saver(err, async () => { const { lead_id, ...rest } = v; await api(sq ? `/squads/${sq.id}` : '/squads', sq ? 'PATCH' : 'POST', { ...rest, ...(can.admin ? { lead_id: lead_id || null } : {}) }); if (!sq) toast('Squad créée — ajoutez 2 à 4 personnes'); });
    const del = sq && can.admin && h('button', { class: 'ghost', onclick: () => api(`/squads/${sq.id}`, 'DELETE').then(closeModal).catch(e => { err.textContent = e.message; err.hidden = false; }) }, '🗑 Supprimer');
    openModal(modal(sq ? 'Modifier la squad' : 'Nouvelle squad', `${S.data.rules.min} à ${S.data.rules.max} personnes et un lead. Le lead rejoint automatiquement la squad.`,
      fields([['Nom', h('input', { type: 'text', value: v.name, oninput: e => v.name = e.target.value })], ['Mission', h('input', { type: 'text', value: v.mission, placeholder: 'Pourquoi cette squad existe', oninput: e => v.mission = e.target.value })],
        ['Lead', h('select', { disabled: !can.admin, title: can.admin ? '' : 'Seul un administrateur change le lead', onchange: e => v.lead_id = e.target.value ? +e.target.value : '' }, opts(candidates, v.lead_id, '— choisir —'))],
        ['Features max', h('input', { type: 'number', min: 1, max: 10, value: v.max_active_features, onchange: e => v.max_active_features = +e.target.value, title: 'Limite de features menées en parallèle' })],
        ['Couleur', h('input', { type: 'color', value: v.color, onchange: e => v.color = e.target.value })]]),
      err, h('div', { class: 'actions' }, del, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), save)));
  }

  /** Fiche d'une personne : identité, fonction, squad, prêt de temps. id = null → ajout. */
  function openMemberModal(id) {
    const m = id ? member(id) : null;
    const v = { email: m?.email || '', is_admin: !!m?.is_admin, name: m?.name || '', team_id: m?.team_id || '', squad_id: m?.squad_id || '', role: m?.role || '', capacity_h: m?.capacity_h ?? 30,
      skills: (m?.skills || []).join(', '), loan_squad_id: m?.loan_squad_id || '', loan_pct: m?.loan_pct || 20 };
    const err = errBox();
    const skills = () => v.skills.split(',').map(x => x.trim()).filter(Boolean);
    const save = h('button', { class: 'primary' }, m ? 'Enregistrer' : 'Ajouter la personne');
    save.onclick = saver(err, async () => {
      if (!m) { await api('/members', 'POST', { name: v.name, email: v.email || null, team_id: v.team_id || null, role: v.role, capacity_h: v.capacity_h, skills: skills(), squad_id: v.squad_id || null }); toast(`${v.name} ajouté·e`); return; }
      const mine = m.id === S.me, lead = can.leadOf(m.squad_id);
      // On n'envoie que ce que le serveur autorisera : un lead gère l'appartenance, chacun sa propre fiche, l'administrateur tout.
      await api(`/members/${id}`, 'PATCH', { ...(can.admin || mine || lead ? { name: v.name, role: v.role, skills: skills() } : {}),
        ...(can.admin || lead || can.leadOf(+v.squad_id) ? { squad_id: v.squad_id || null, loan_squad_id: v.loan_squad_id || null, loan_pct: v.loan_pct } : {}),
        ...(can.admin ? { team_id: v.team_id || null, capacity_h: v.capacity_h, email: v.email || null, is_admin: v.is_admin } : {}) });
    });
    let askDelete = false;
    const del = m && can.admin && h('button', { class: 'ghost', onclick: async e => {
      const n = S.data.tasks.filter(t => t.assignee_id === m.id && t.status !== 'done').length;
      if (!askDelete) { askDelete = true; e.currentTarget.textContent = `Confirmer (${plural(n, 'tâche')} deviendront non assignées)`; e.currentTarget.style.color = 'var(--bad)'; return; }
      try { await api(`/members/${id}`, 'DELETE'); closeModal(); toast(`${m.name} retiré·e`); } catch (x) { err.textContent = x.message; err.hidden = false; }
    } }, '🗑 Retirer');
    const sel = (key, list, none) => h('select', { onchange: e => v[key] = e.target.value ? +e.target.value : '' }, opts(list, v[key], none));
    openModal(modal(m ? m.name : 'Nouvelle personne', m ? 'L’appartenance principale va à une seule squad ; on peut prêter 5 à 50 % de son temps à une autre.' : 'Ajoutez les personnes réelles de votre équipe. Vous pourrez les placer dans une squad ensuite (glisser-déposer).',
      fields([['Nom', h('input', { type: 'text', value: v.name, placeholder: 'Prénom Nom', oninput: e => v.name = e.target.value })],
        ['Fonction', sel('team_id', S.data.teams, '— aucune —')],
        ['Rôle', h('input', { type: 'text', value: v.role, placeholder: 'Ex : Développeuse front', oninput: e => v.role = e.target.value })],
        ['Squad', sel('squad_id', S.data.squads, '— aucune —')],
        ...(m ? [['Prêt à', sel('loan_squad_id', S.data.squads.filter(s => s.id !== m.squad_id), '— personne —')], ['Part prêtée (%)', h('input', { type: 'number', min: 5, max: 50, step: 5, value: v.loan_pct, onchange: e => v.loan_pct = +e.target.value })]] : []),
        ['Capacité (h/sem.)', h('input', { type: 'number', min: 0, max: 80, value: v.capacity_h, disabled: !can.admin, onchange: e => v.capacity_h = +e.target.value })],
        ...(can.admin ? [['E-mail (connexion)', h('input', { type: 'text', value: v.email, placeholder: 'prenom.nom@entreprise.fr', oninput: e => v.email = e.target.value })], ['Administrateur', h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: v.is_admin, onchange: e => v.is_admin = e.target.checked }), 'Peut gérer les réglages, les personnes et le LLM')]] : []),
        ['Compétences', h('input', { type: 'text', value: v.skills, placeholder: 'react, node, audit…', oninput: e => v.skills = e.target.value })]]),
      err, h('div', { class: 'actions' }, del, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), save)));
  }

  return { featuresView, squadsView, openFeatureModal, openSquadModal, openMemberModal, featureSelect, curSquad, squadOf, featureOf, ui: { modal, fields, opts, saver, errBox } };
}
