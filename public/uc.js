// Use cases SmartUC dans WorkForce : puces, fiche UC (lecture seule), « à planifier », création d'une feature depuis un UC,
// réglages de l'intégration. Module autonome : reçoit ses dépendances de app.js. SmartUC reste la source de vérité.
export function createUc(c) {
  const { h, S, api, toast, can, ui, render } = c;
  const { modal, fields, opts, saver, errBox } = ui;
  const STATUS_FR = { draft: 'Brouillon', submitted: 'Soumis', qualified: 'Qualifié', approved: 'Approuvé', in_build: 'En construction', in_production: 'En production', retired: 'Retiré', rejected: 'Rejeté' };
  const TONE = { approved: 'good', in_build: 'info', in_production: 'good', rejected: 'bad', retired: 'bad', submitted: 'warn', qualified: 'warn' };
  const FSTATUS = { discovery: 'Cadrage', building: 'Réalisation', shipping: 'Livraison', live: 'En ligne' };
  const PRIO_FR = { low: 'basse', medium: 'moyenne', high: 'haute', urgent: 'urgente' };
  const ucOf = ref => S.data.ucs.find(u => u.ref === ref);
  const squadOf = id => S.data.squads.find(s => s.id === id);
  const enabled = () => !!S.data.smartuc?.enabled;
  const deep = ref => S.data.smartuc?.publicUrl ? `${S.data.smartuc.publicUrl}/usecases/${ref}` : null;
  const plural = (n, s, p = s + 's') => `${n} ${n > 1 ? p : s}`;
  const score = v => v == null ? '—' : Math.round(v);
  const ago = iso => { if (!iso) return 'jamais'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'à l’instant' : s < 3600 ? `il y a ${Math.floor(s / 60)} min` : s < 86400 ? `il y a ${Math.floor(s / 3600)} h` : new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };

  /** Puce d'un UC : statut en couleur, clic = fiche. */
  function chip(ref, { removable = null } = {}) {
    const u = ucOf(ref);
    const el = h('a', { class: `chip uc ${u?.deleted ? 'bad' : TONE[u?.status] || ''}`, role: 'button', tabindex: 0, title: u ? `${u.title} — ${STATUS_FR[u.status] || u.status}${u.deleted ? ' (supprimé dans SmartUC)' : ''}` : 'UC inconnu : lancez une synchronisation', onclick: () => openUcModal(ref) },
      '🧠 ', ref, u ? ` · ${u.deleted ? 'supprimé' : STATUS_FR[u.status] || u.status}` : '');
    return removable ? h('span', { class: 'ucchip' }, el, h('button', { class: 'ghost x', title: 'Retirer le lien', onclick: removable }, '✕')) : el;
  }

  /** Bandeau d'état : seulement quand quelque chose ne va pas. */
  function banner() {
    const s = S.data.smartuc; if (!s?.enabled || s.ok !== false) return null;
    return h('div', { class: 'guards' }, h('div', { class: 'guard alert' }, h('span', {}, '⚠️'), h('span', {}, `SmartUC est injoignable ou refuse la connexion : ${s.error || 'erreur inconnue'}. Les use cases affichés datent de la dernière synchronisation réussie (${ago(s.last_sync_at)}).`)));
  }

  /* ---------- Fiche d'un UC (lecture seule) ---------- */
  function openUcModal(ref) {
    const u = ucOf(ref); if (!u) return toast('UC inconnu : lancez une synchronisation (Réglages › Intégrations).', 4000);
    const d = u.data || {}, rel = u.relations || { links: [], entities: [] };
    const features = S.data.uc_links.filter(l => l.uc_ref === ref).map(l => S.data.features.find(f => f.id === l.feature_id)).filter(Boolean);
    const list = (label, items) => items?.length ? [h('label', {}, label), h('div', { class: 'ucval' }, items.map(x => h('div', {}, '• ' + x)))] : [];
    const row = (label, v) => v ? [h('label', {}, label), h('div', { class: 'ucval' }, v)] : [];
    const planable = ['approved', 'in_build'].includes(u.status) && !u.deleted && !features.length && can.anyLead;
    openModal(modal(`${u.ref} · ${u.title}`, u.deleted ? '⚠️ Ce use case n’existe plus dans SmartUC.' : 'Lecture seule : SmartUC est la source de vérité des use cases et de leur gouvernance.',
      h('div', { class: 'meta', style: 'margin-bottom:8px' }, h('span', { class: `chip uc ${TONE[u.status] || ''}` }, STATUS_FR[u.status] || u.status), u.risk_tier && h('span', { class: 'chip' }, `Risque : ${u.risk_tier}`), u.ai_capability && h('span', { class: 'chip' }, u.ai_capability), u.business_unit && h('span', { class: 'chip' }, u.business_unit)),
      h('div', { class: 'fields ucfields' },
        ...row('Résumé', d.summary), ...row('Scores', `Valeur ${score(u.value_score)} · Faisabilité ${score(u.feasibility_score)} · Priorité ${score(u.priority_score)}`),
        ...row('Porteur', [d.owner && `${d.owner.name} (${d.owner.email})`, d.product_owner && `PO : ${d.product_owner}`, d.sponsor && `sponsor : ${d.sponsor}`].filter(Boolean).join(' — ')),
        ...row('Livraison', [d.estimated_effort && `effort ${d.estimated_effort}`, d.target_date && `cible ${d.target_date}`, d.build_approach && d.build_approach].filter(Boolean).join(' · ')),
        ...list('KPIs', d.kpis), ...list('Mitigations', d.mitigations), ...list('Données', d.data_sources), ...list('Systèmes', [...new Set([...(d.source_systems || []), ...(d.target_systems || [])])]),
        ...row('Équipes citées', (d.teams_involved || []).join(', ')),
        ...(rel.links.length ? [h('label', {}, 'Relations confirmées'), h('div', { class: 'ucval' }, rel.links.map(l => h('div', {}, `${l.direction === 'out' ? '→' : '←'} `, chip(l.other), ` ${l.type}`, l.explanation && h('span', { class: 'muted' }, ` — ${l.explanation}`))))] : []),
        ...row('Entités partagées', (rel.entities || []).join(', ')),
        ...(features.length ? [h('label', {}, 'Features WorkForce'), h('div', { class: 'ucval' }, features.map(f => h('div', {}, `${f.name} `, h('span', { class: 'muted' }, `(${squadOf(f.squad_id)?.name}, ${FSTATUS[f.status]})`))))] : []),
        !d.summary && !u.deleted ? [h('label', {}), h('div', { class: 'muted ucval' }, 'Détails non synchronisés : ils sont lus pour les UC approuvés, en construction ou liés à une feature.')] : []),
      h('div', { class: 'actions' }, deep(ref) && h('a', { class: 'btn', href: deep(ref), target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir dans SmartUC ↗'), h('span', { class: 'spacer' }),
        planable && h('button', { class: 'primary', onclick: () => { closeModal(); openPlanModal(ref); } }, 'Planifier…'), h('button', { onclick: closeModal }, 'Fermer'))));
  }
  const { openModal, closeModal } = c;

  /* ---------- Planifier : feature + paquet de tâches IA ---------- */
  async function openPlanModal(ref) {
    let plan;
    try { plan = await api(`/ucs/${ref}/plan`); } catch (e) { return toast(e.message, 5000); }
    const leadable = S.data.squads.filter(q => can.leadOf(q.id));
    if (!leadable.length) return toast('Vous devez être lead d’une squad (ou administrateur) pour planifier un UC.', 5000);
    const v = { name: plan.draft.name, outcome: plan.draft.outcome, squad_id: leadable.find(q => q.id === plan.suggested_squad_id)?.id ?? leadable[0].id, status: plan.draft.status, target_date: plan.draft.target_date || '' };
    const picked = new Set(plan.playbook.map((_, i) => i));
    const err = errBox();
    const total = h('span', { class: 'muted' });
    const sync = () => { const hrs = plan.playbook.reduce((a, t, i) => a + (picked.has(i) ? t.estimate_h : 0), 0); total.textContent = `${picked.size}/${plan.playbook.length} tâches · ${hrs} h`; };
    const rank = h('div', { class: 'rank' });
    const drawRank = () => rank.replaceChildren(...plan.ranking.map(s => h('button', { type: 'button', class: `rankrow ${s.squad_id === v.squad_id ? 'on' : ''}`, disabled: !can.leadOf(s.squad_id), title: can.leadOf(s.squad_id) ? '' : 'Vous ne dirigez pas cette squad', onclick: () => { v.squad_id = s.squad_id; squadSel.value = s.squad_id; drawRank(); } },
      h('strong', {}, s.name), h('span', { class: `chip ${s.score > 0 ? 'good' : s.score < 0 ? 'bad' : ''}` }, `${s.score > 0 ? '+' : ''}${s.score}`), h('span', { class: 'muted grow' }, s.reasons.length ? s.reasons.join(' · ') : 'aucun signal'))));
    const squadSel = h('select', { onchange: e => { v.squad_id = +e.target.value; drawRank(); } }, opts(leadable, v.squad_id));
    const taskRows = plan.playbook.map((t, i) => h('label', { class: 'plantask' }, h('input', { type: 'checkbox', checked: true, onchange: e => { e.target.checked ? picked.add(i) : picked.delete(i); sync(); } }),
      h('span', { class: 'grow' }, t.title, h('span', { class: 'muted' }, ` — ${t.estimate_h} h · priorité ${PRIO_FR[t.priority] || t.priority}`))));
    const create = h('button', { class: 'primary' }, 'Créer la feature');
    create.onclick = saver(err, async () => {
      const r = await api(`/ucs/${ref}/create-feature`, 'POST', { name: v.name, outcome: v.outcome, squad_id: v.squad_id, status: v.status, target_date: v.target_date || null, tasks: plan.playbook.filter((_, i) => picked.has(i)) });
      S.f.squad = String(v.squad_id); S.view = localStorage.view = 'features'; render();
      toast(`Feature créée avec ${plural(r.tasks_created, 'tâche')} — rattachée à ${ref}`, 6000);
    });
    openModal(modal(`Planifier ${ref}`, plan.has_details ? 'La feature reprend le use case ; vous gardez la main sur la squad, les dates et les tâches proposées.' : '⚠️ Les détails de ce UC ne sont pas encore synchronisés : le brouillon est incomplet.',
      fields([['Nom', h('input', { type: 'text', value: v.name, maxlength: 120, oninput: e => v.name = e.target.value })], ['Résultat attendu', h('input', { type: 'text', value: v.outcome, oninput: e => v.outcome = e.target.value })],
        ['Squad', squadSel], ['Statut', h('select', { onchange: e => v.status = e.target.value }, Object.entries(FSTATUS).map(([k, l]) => h('option', { value: k, selected: k === v.status }, l)))],
        ['Échéance', h('input', { type: 'date', value: v.target_date, onchange: e => v.target_date = e.target.value })]]),
      h('div', { class: 'sechead-mini' }, 'Squad suggérée'), rank,
      h('div', { class: 'sechead-mini' }, 'Paquet de tâches IA ', total, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'ghost', onclick: () => { const all = picked.size < plan.playbook.length; picked.clear(); if (all) plan.playbook.forEach((_, i) => picked.add(i)); taskRows.forEach((r, i) => r.querySelector('input').checked = picked.has(i)); sync(); } }, 'Tout cocher / décocher')),
      h('div', { class: 'plantasks' }, taskRows), err,
      h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), create)));
    drawRank(); sync();
  }

  /* ---------- Panneau « à planifier » (vue Features) ---------- */
  function plannerPanel() {
    if (!enabled() || !can.anyLead) return null;
    const linked = new Set(S.data.uc_links.map(l => l.uc_ref));
    const list = S.data.ucs.filter(u => ['approved', 'in_build'].includes(u.status) && !u.ignored && !u.deleted && !linked.has(u.ref)).sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
    if (!list.length) return null;
    return h('div', { class: 'panel uplanner' },
      h('strong', {}, `🧠 Use cases SmartUC à planifier (${list.length})`),
      h('div', { class: 'muted', style: 'margin-bottom:8px' }, 'Approuvés dans SmartUC mais sans feature. Planifier crée la feature, la rattache à l’UC et propose un paquet de tâches propre à l’IA.'),
      list.slice(0, 8).map(u => h('div', { class: 'inrow ucrow' }, chip(u.ref), h('span', { class: 'grow ucname' }, u.title), h('span', { class: 'muted why', title: 'Valeur / Faisabilité / Priorité' }, `V${score(u.value_score)} F${score(u.feasibility_score)} P${score(u.priority_score)}`),
        h('button', { class: 'primary', onclick: () => openPlanModal(u.ref) }, 'Planifier…'),
        h('button', { class: 'ghost', title: 'Ne plus proposer cet UC', onclick: () => api(`/ucs/${u.ref}/ignore`, 'POST', { on: true }).then(() => toast(`${u.ref} ignoré`)).catch(e => toast(e.message)) }, 'Ignorer'))),
      list.length > 8 && h('div', { class: 'muted more' }, `+ ${list.length - 8} autres`));
  }

  /* ---------- Section « Use cases » de la fiche d'une feature ---------- */
  function featureSection(f, reopen) {
    const refs = S.data.uc_links.filter(l => l.feature_id === f.id).map(l => l.uc_ref);
    if (!enabled() && !refs.length) return [];
    let pick = '';
    const free = S.data.ucs.filter(u => !refs.includes(u.ref) && !u.deleted);
    return [h('h2', { style: 'font-size:14px;margin:14px 0 6px' }, 'Use cases SmartUC liés'),
      refs.length ? h('div', { class: 'meta' }, refs.map(r => chip(r, { removable: () => api(`/features/${f.id}/ucs/${r}`, 'DELETE').then(reopen).catch(e => toast(e.message)) }))) : h('div', { class: 'muted' }, 'Aucun use case lié.'),
      enabled() && free.length > 0 && h('div', { class: 'linkrow' }, h('select', { style: 'flex:1;min-width:0', onchange: e => pick = e.target.value }, h('option', { value: '' }, 'Lier un use case…'),
        free.map(u => h('option', { value: u.ref }, `${u.ref} — ${u.title} (${STATUS_FR[u.status] || u.status})`))),
        h('button', { onclick: () => pick && api(`/features/${f.id}/ucs`, 'POST', { uc_ref: pick }).then(reopen).catch(e => toast(e.message)) }, 'Lier'))];
  }

  /* ---------- Réglages › Intégrations ---------- */
  async function openConfigModal() {
    try { S.smartucConfig = await api('/smartuc'); } catch (e) { return toast(e.message, 4000); }
    const cfg = S.data.smartuc, pub = S.smartucConfig;
    const v = { enabled: cfg.enabled || !cfg.configured, url: pub.url ?? '', key: '', publicUrl: pub.publicUrl ?? cfg.publicUrl ?? '', pollMinutes: cfg.pollMinutes ?? 5 };
    const result = h('div', { class: 'result', hidden: true });
    const show = (ok, ...lines) => { result.hidden = false; result.className = `result ${ok ? 'ok' : 'ko'}`; result.replaceChildren(...lines.filter(Boolean).map(t => h('div', {}, t))); };
    const testBtn = h('button', { onclick: async () => {
      testBtn.disabled = true; show(true, 'Test en cours…'); result.className = 'result';
      try { const r = await api('/smartuc/test', 'POST', v);
        r.ok ? show(true, `✅ Connecté à « ${r.server} » en ${r.ms} ms — ${plural(r.uc_count, 'use case')} visibles${r.role ? `, compte « ${r.role} »${r.user ? ` (${r.user})` : ''}` : ''}`, ...(r.warnings || []).map(w => `⚠️ ${w}`)) : show(false, `❌ ${r.error}`);
      } catch (e) { show(false, e.message); }
      testBtn.disabled = false; } }, '⚡ Tester la connexion');
    const err = errBox();
    const save = h('button', { class: 'primary' }, 'Enregistrer');
    save.onclick = saver(err, async () => { S.smartucConfig = await api('/smartuc', 'POST', v); toast(v.enabled ? 'Intégration SmartUC enregistrée' : 'Intégration SmartUC désactivée'); if (v.enabled) syncNow(true); });
    const inp = (k, extra = {}) => h('input', { type: k === 'key' ? 'password' : 'text', value: v[k], autocomplete: 'off', spellcheck: false, oninput: e => v[k] = e.target.value, ...extra });
    openModal(modal('SmartUC — connexion MCP', 'WorkForce lit le registre des use cases par MCP (lecture seule). La clé reste sur le serveur et n’est jamais renvoyée au navigateur.',
      h('label', { class: 'toggle', style: 'color:var(--text);font-weight:600' }, h('input', { type: 'checkbox', checked: v.enabled, onchange: e => v.enabled = e.target.checked }), 'Activer l’intégration'),
      fields([['URL MCP', inp('url', { placeholder: 'https://smartuc.entreprise.fr/mcp' })],
        ['Clé API', inp('key', { placeholder: S.smartucConfig?.hasKey ? `•••• ${S.smartucConfig.keyHint} (conservée si vide)` : 'uch_… (SmartUC › MCP & API › Create key)' })],
        ['URL de l’interface', inp('publicUrl', { placeholder: 'https://smartuc.entreprise.fr (liens « Ouvrir dans SmartUC »)' })],
        ['Fréquence (min)', h('input', { type: 'number', min: 1, max: 120, value: v.pollMinutes, onchange: e => v.pollMinutes = +e.target.value })]]),
      h('div', { class: 'muted', style: 'font-size:12px' }, 'Utilisez un compte de service « reviewer » ou « admin » dans SmartUC : un compte « requester » ne voit que ses propres UC.'),
      result, err, h('div', { class: 'actions' }, testBtn, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Fermer'), save)));
  }

  async function syncNow(quiet) {
    try { const r = await api('/smartuc/sync', 'POST', {}); const s = r.sync || {};
      if (!quiet || s.ok === false) toast(s.ok ? `SmartUC synchronisé : ${plural(s.uc_count, 'use case')}${s.partial ? ` (${s.partial} en échec partiel)` : ''}` : s.skipped === 'throttled' ? 'Synchronisation déjà demandée à l’instant' : s.skipped === 'busy' ? 'Synchronisation déjà en cours' : s.skipped === 'disabled' ? 'Intégration désactivée' : `Échec : ${s.error}`, s.ok ? 2600 : 6000);
    } catch (e) { toast(e.message, 5000); }
  }

  function settingsSection() {
    const s = S.data.smartuc, ok = s.enabled && s.ok;
    return h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, 'Intégrations')),
      h('div', { class: 'panel setrow', style: 'cursor:default' }, h('span', { class: `chip ${!s.enabled ? '' : ok ? 'good' : s.ok === false ? 'bad' : 'warn'}` }, !s.enabled ? 'inactif' : ok ? 'connecté' : s.ok === false ? 'en échec' : 'en attente'),
        h('strong', {}, 'SmartUC (use cases IA)'),
        h('span', { class: 'muted grow' }, !s.enabled ? 'Non configuré — lien entre vos use cases et vos features.' : `${plural(s.uc_count ?? 0, 'use case')} · dernière synchronisation ${ago(s.last_sync_at)}${s.latency_ms != null ? ` · ${s.latency_ms} ms` : ''} · toutes les ${s.pollMinutes} min${s.ok === false ? ` · ${s.error}` : ''}`),
        s.enabled && can.anyLead && h('button', { onclick: () => syncNow(false) }, 'Synchroniser'), can.admin && h('button', { onclick: openConfigModal }, 'Configurer')));
  }

  return { chip, banner, plannerPanel, featureSection, settingsSection, openUcModal, openPlanModal, ucOf };
}
