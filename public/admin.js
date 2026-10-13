// Réglages & administration : personnes, projets, fonctions, données, accueil d'une base vide.
// Module autonome : reçoit ses dépendances (état, helpers) de app.js.
export function createAdmin(c) {
  const { h, S, api, toast, member, team, avatar, openModal, closeModal, openMemberModal, openLlmSettings, can, uc } = c;
  const squadOf = id => S.data.squads.find(s => s.id === id);
  const plural = (n, s, p = s + 's') => `${n} ${n > 1 ? p : s}`;
  const errBox = () => h('div', { class: 'result ko', hidden: true });
  const modal = (title, sub, ...body) => h('div', { class: 'modal', onclick: e => e.stopPropagation() }, h('h2', {}, title), sub && h('div', { class: 'sub' }, sub), ...body);
  const fields = rows => h('div', { class: 'fields' }, rows.flatMap(([l, el]) => [h('label', {}, l), el]));
  function saver(errEl, run) {
    return async e => { const b = e.currentTarget; b.disabled = true; errEl.hidden = true;
      try { await run(); closeModal(); } catch (err) { errEl.textContent = err.message; errEl.hidden = false; b.disabled = false; } };
  }
  /** Bouton de suppression « armé » : un premier clic demande confirmation, le second exécute. */
  const armed = (label, confirmLabel, run, errEl) => {
    const b = h('button', { class: 'ghost' }, label);
    b.onclick = async () => {
      if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = confirmLabel; b.style.color = 'var(--bad)'; return; }
      try { await run(); closeModal(); } catch (e) { errEl.textContent = e.message; errEl.hidden = false; delete b.dataset.armed; b.textContent = label; b.style.color = ''; }
    };
    return b;
  };

  /* ---------- Projets ---------- */
  function openProjectModal(id) {
    const p = id ? S.data.projects.find(x => x.id === id) : null;
    const v = { name: p?.name || '', key: p?.key || '', description: p?.description || '' };
    const err = errBox();
    const save = h('button', { class: 'primary' }, p ? 'Enregistrer' : 'Créer le projet');
    save.onclick = saver(err, () => api(p ? `/projects/${p.id}` : '/projects', p ? 'PATCH' : 'POST', { ...v, key: v.key || undefined }));
    const nTasks = p ? S.data.tasks.filter(t => t.project_id === p.id).length : 0;
    openModal(modal(p ? 'Modifier le projet' : 'Nouveau projet', 'Un projet (ou initiative) regroupe des features. La clé sert d’étiquette courte.',
      fields([['Nom', h('input', { type: 'text', value: v.name, oninput: e => v.name = e.target.value })],
        ['Clé', h('input', { type: 'text', value: v.key, maxlength: 6, placeholder: 'auto (ex. PORT)', oninput: e => v.key = e.target.value.toUpperCase() })],
        ['Description', h('input', { type: 'text', value: v.description, oninput: e => v.description = e.target.value })]]),
      err, h('div', { class: 'actions' }, p && armed('🗑 Supprimer', `Confirmer (${plural(nTasks, 'tâche')} sans projet)`, () => api(`/projects/${p.id}`, 'DELETE'), err), h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), save)));
  }

  /* ---------- Fonctions ---------- */
  function openTeamModal(id) {
    const t = id ? S.data.teams.find(x => x.id === id) : null;
    const v = { name: t?.name || '', color: t?.color || '#64748b' };
    const err = errBox();
    const save = h('button', { class: 'primary' }, t ? 'Enregistrer' : 'Créer la fonction');
    save.onclick = saver(err, () => api(t ? `/teams/${t.id}` : '/teams', t ? 'PATCH' : 'POST', v));
    const n = t ? S.data.members.filter(m => m.team_id === t.id).length : 0;
    openModal(modal(t ? 'Modifier la fonction' : 'Nouvelle fonction', 'Une fonction est une compétence (Dev, Infra, Sécurité, Produit…). Elle est indépendante de la squad.',
      fields([['Nom', h('input', { type: 'text', value: v.name, oninput: e => v.name = e.target.value })], ['Couleur', h('input', { type: 'color', value: v.color, onchange: e => v.color = e.target.value })]]),
      err, h('div', { class: 'actions' }, t && armed('🗑 Supprimer', `Confirmer (${plural(n, 'personne')} sans fonction)`, () => api(`/teams/${t.id}`, 'DELETE'), err), h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), save)));
  }

  /* ---------- Données ---------- */
  function openResetModal() {
    let typed = '';
    const err = errBox();
    const go = h('button', { class: 'primary', style: 'background:var(--bad);border-color:var(--bad)', disabled: true }, 'Tout effacer');
    go.onclick = saver(err, async () => { const r = await api('/reset', 'POST', { confirm: typed }); toast(r.backup ? 'Données effacées — sauvegarde conservée dans data/backups/' : 'Données effacées', 6000); });
    openModal(modal('Effacer toutes les données ?', 'Personnes, squads, features, projets, tâches et journal seront supprimés. Une sauvegarde de la base est écrite dans data/backups/ avant l’effacement. Les réglages du LLM sont conservés.',
      h('div', { class: 'fields' }, h('label', {}, 'Tapez EFFACER'), h('input', { type: 'text', autocomplete: 'off', oninput: e => { typed = e.target.value; go.disabled = typed !== 'EFFACER'; } })),
      err, h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { onclick: closeModal }, 'Annuler'), go)));
  }

  /* ---------- Vue « Réglages » ---------- */
  function settingsView() {
    const D = S.data;
    const people = D.members.slice().sort((a, b) => a.name.localeCompare(b.name, 'fr')).map(m => h('tr', { tabindex: 0, onclick: () => (can.admin || m.id === S.me || can.leadOf(m.squad_id)) && openMemberModal(m.id), onkeydown: e => e.key === 'Enter' && (can.admin || m.id === S.me || can.leadOf(m.squad_id)) && openMemberModal(m.id) },
      h('td', {}, h('span', { class: 'person' }, avatar(m), h('strong', {}, m.name))), h('td', {}, m.role || h('span', { class: 'muted' }, '—')), h('td', {}, team(m.team_id)?.name || h('span', { class: 'muted' }, '—')),
      h('td', {}, squadOf(m.squad_id)?.name || h('span', { class: 'chip bad' }, 'Sans squad')), h('td', {}, `${m.capacity_h} h`)));
    const projects = D.projects.map(p => h('div', { class: 'setrow', tabindex: 0, onclick: () => can.admin && openProjectModal(p.id), onkeydown: e => e.key === 'Enter' && can.admin && openProjectModal(p.id) },
      h('span', { class: 'chip' }, p.key), h('strong', {}, p.name), h('span', { class: 'muted grow' }, p.description || ''), h('span', { class: 'muted' }, plural(D.features.filter(f => f.project_id === p.id).length, 'feature'))));
    const teams = D.teams.map(t => h('span', { class: 'fn', tabindex: 0, onclick: () => can.admin && openTeamModal(t.id), onkeydown: e => e.key === 'Enter' && can.admin && openTeamModal(t.id), style: `border-color:${t.color}` },
      h('i', { style: `background:${t.color}` }), t.name, h('span', { class: 'muted' }, ` · ${D.members.filter(m => m.team_id === t.id).length}`)));
    const ai = D.ai;
    return h('div', { class: 'settings' },
      h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, `Personnes (${D.members.length})`), can.admin && h('button', { class: 'primary', onclick: () => openMemberModal(null) }, '＋ Personne')),
        D.members.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Nom', 'Rôle', 'Fonction', 'Squad', 'Capacité / sem.'].map(x => h('th', {}, x)))), h('tbody', {}, people)) : h('div', { class: 'panel empty' }, 'Aucune personne pour le moment.')),
      h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, `Projets (${D.projects.length})`), can.admin && h('button', { onclick: () => openProjectModal(null) }, '＋ Projet')),
        h('div', { class: 'panel' }, projects.length ? projects : h('div', { class: 'empty' }, 'Aucun projet. Un projet regroupe plusieurs features (facultatif).'))),
      h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, `Fonctions (${D.teams.length})`), can.admin && h('button', { onclick: () => openTeamModal(null) }, '＋ Fonction')),
        h('div', { class: 'panel fns' }, teams.length ? teams : h('div', { class: 'empty' }, 'Aucune fonction (Dev, Infra, Sécurité…).'))),
      h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, 'Assistant IA')),
        h('div', { class: 'panel setrow' }, h('span', {}, ai.enabled ? `LLM activé : ${ai.model}` : 'Mode local (analyseur simplifié, sans LLM)'), h('span', { class: 'grow' }), can.admin && h('button', { onclick: openLlmSettings }, 'Configurer le LLM'))),
      uc.settingsSection(),
      can.admin && h('section', {}, h('div', { class: 'sechead' }, h('h2', {}, 'Données')),
        h('div', { class: 'panel' }, h('p', { class: 'muted', style: 'margin-top:0' }, 'Tout est stocké dans data/workforce.db sur le serveur. Copiez ce fichier pour sauvegarder. L’export JSON ne contient pas la clé du LLM.'),
          h('div', { class: 'actions', style: 'margin:0' }, h('a', { class: 'btn', href: '/api/export', download: '' }, '⬇ Exporter (JSON)'),
            D.empty && h('button', { onclick: async () => { await api('/demo/load', 'POST', {}); toast('Données de démonstration chargées'); } }, 'Charger la démo'),
            h('span', { class: 'spacer' }), h('button', { class: 'ghost', style: 'color:var(--bad)', onclick: openResetModal }, '🗑 Effacer toutes les données…')))));
  }

  /* ---------- Accueil d'une base vide ---------- */
  function emptyView() {
    const go = async (fn) => { try { await fn(); } catch (e) { toast(e.message, 5000); } };
    return h('div', { class: 'welcome' }, h('div', { class: 'panel' },
      h('h2', {}, 'Bienvenue dans WorkForce 👋'),
      h('p', { class: 'muted' }, 'L’outil est vide : aucune donnée de démonstration n’est imposée. Construisez votre organisation en quelques minutes, puis parlez à l’assistant pour créer vos tâches.'),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Les fonctions'), ' — Dev, Infra, Sécurité, Produit… (compétences, facultatif).'),
        h('li', {}, h('strong', {}, 'Les personnes'), ' — nom, rôle, capacité hebdomadaire.'),
        h('li', {}, h('strong', {}, 'Les squads'), ' — 3 à 5 personnes et un lead, propriétaires de leurs features.'),
        h('li', {}, h('strong', {}, 'Les features'), ' — les résultats à livrer. Les tâches s’y rattachent.')),
      h('div', { class: 'actions', style: 'margin-top:14px' },
        h('button', { class: 'primary', onclick: () => { S.view = localStorage.view = 'settings'; c.render(); setTimeout(() => openMemberModal(null), 50); } }, 'Commencer : ajouter une personne'),
        h('button', { onclick: () => go(async () => { await api('/demo/load', 'POST', {}); S.view = localStorage.view = 'features'; c.render(); toast('Démo chargée — vous pourrez tout effacer dans Réglages › Données'); }) }, 'Charger la démo pour explorer'))));
  }

  return { settingsView, emptyView, openProjectModal, openTeamModal };
}
