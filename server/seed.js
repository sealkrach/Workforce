import { reindex } from './db.js';
import { now } from './util.js';

const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/** Données de démonstration. N'est JAMAIS appelé automatiquement : uniquement via SEED_DEMO=1 ou le bouton « Charger la démo » sur une base vide. */
export function seed(db) {
  if (db.prepare('SELECT COUNT(*) c FROM teams').get().c) return;
  const team = db.prepare('INSERT INTO teams(name, color) VALUES (?,?)');
  const T = {};
  for (const [n, c] of [['Dev', '#6366f1'], ['Infra', '#0ea5e9'], ['Sécurité', '#ef4444'], ['Produit', '#f59e0b'], ['Support', '#10b981']])
    T[n] = Number(team.run(n, c).lastInsertRowid);

  const mem = db.prepare('INSERT INTO members(name, team_id, role, skills, capacity_h) VALUES (?,?,?,?,?)');
  const M = {};
  for (const [n, t, r, s, c] of [
    ['Camille Durand', 'Dev', 'Tech lead', ['react', 'node', 'api'], 30],
    ['Yanis Benali', 'Dev', 'Développeur', ['react', 'ui', 'tests'], 30],
    ['Léa Martin', 'Infra', 'DevOps', ['cloud', 'kubernetes', 'terraform'], 30],
    ['Hugo Petit', 'Infra', 'Admin sys', ['linux', 'réseau', 'sauvegarde'], 24],
    ['Inès Moreau', 'Sécurité', 'RSSI', ['iso27001', 'audit', 'iam'], 28],
    ['Nora Lefèvre', 'Produit', 'Product owner', ['roadmap', 'ux', 'recueil'], 30],
    ['Tom Garcia', 'Support', 'Support N2', ['incidents', 'glpi', 'client'], 32],
    ['Sarah Roux', 'Support', 'Support N1', ['client', 'formation'], 32],
  ]) M[n.split(' ')[0]] = Number(mem.run(n, T[t], r, JSON.stringify(s), c).lastInsertRowid);

  const proj = db.prepare('INSERT INTO projects(name, key, description, keywords) VALUES (?,?,?,?)');
  const P = {};
  for (const [n, k, d, kw] of [
    ['Refonte Portail Client', 'PORT', 'Nouveau portail self-service pour les clients', 'portail client front ui ux react page écran interface connexion'],
    ['Migration Cloud', 'CLD', 'Migration des workloads on-prem vers le cloud', 'cloud migration kubernetes terraform serveur déploiement infra sauvegarde backup réseau vpn'],
    ['Conformité ISO 27001', 'SEC', 'Préparation de la certification ISO 27001', 'iso sécurité audit politique mfa iam accès vulnérabilité pentest conformité'],
    ['Support & Incidents', 'SUP', 'Traitement des incidents et demandes', 'incident ticket support panne client glpi sla'],
  ]) P[k] = Number(proj.run(n, k, d, kw).lastInsertRowid);

  const task = db.prepare(`INSERT INTO tasks(title, description, status, priority, assignee_id, team_id, project_id,
    labels, due_date, estimate_h, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = {};
  const add = (key, title, desc, status, prio, who, team, proj, labels, due, est) => {
    ids[key] = Number(task.run(title, desc, status, prio, M[who] ?? null, T[team], P[proj], JSON.stringify(labels),
      due === null ? null : day(due), est, 'seed', now(), now()).lastInsertRowid);
    reindex(db, ids[key]);
  };
  add('a', 'Maquettes de la page de connexion du portail', 'Écran login + mot de passe oublié, version mobile incluse', 'doing', 'high', 'Nora', 'Produit', 'PORT', ['ux'], 3, 8);
  add('b', 'Intégrer le SSO dans le portail client', 'Brancher OIDC sur la page de connexion', 'todo', 'high', 'Camille', 'Dev', 'PORT', ['auth', 'api'], 10, 16);
  add('c', 'Activer le MFA pour tous les comptes administrateurs', 'Exigence ISO : MFA obligatoire sur les comptes à privilèges', 'todo', 'urgent', 'Inès', 'Sécurité', 'SEC', ['iam', 'mfa'], 5, 6);
  add('d', 'Rédiger la politique de gestion des accès', 'Document de référence pour l\'audit', 'doing', 'medium', 'Inès', 'Sécurité', 'SEC', ['doc'], 14, 10);
  add('e', 'Migrer la base de données de production vers le cloud', 'Plan de bascule avec fenêtre de maintenance', 'todo', 'high', 'Léa', 'Infra', 'CLD', ['database'], 20, 24);
  add('f', 'Configurer les sauvegardes automatiques sur le cloud', 'Rétention 30 jours, test de restauration mensuel', 'doing', 'high', 'Hugo', 'Infra', 'CLD', ['backup'], 7, 12);
  add('g', 'Mettre en place le VPN site-à-site vers le cloud', '', 'review', 'medium', 'Hugo', 'Infra', 'CLD', ['réseau'], 2, 8);
  add('h', 'Corriger la lenteur d\'affichage du tableau de bord client', 'Temps de chargement > 6 s signalé par 3 clients', 'doing', 'urgent', 'Yanis', 'Dev', 'PORT', ['perf', 'bug'], 1, 6);
  add('i', 'Incident : impossible de se connecter depuis l\'application mobile', 'Plusieurs tickets clients depuis lundi', 'todo', 'urgent', 'Tom', 'Support', 'SUP', ['incident', 'auth'], 0, 4);
  add('j', 'Former le support N1 sur le nouveau portail', 'Session de 2 h + guide pas-à-pas', 'todo', 'low', 'Sarah', 'Support', 'PORT', ['formation'], 25, 5);
  add('k', 'Lancer un test d\'intrusion externe', 'Prestataire à sélectionner, périmètre portail + API', 'todo', 'medium', null, 'Sécurité', 'SEC', ['pentest'], 30, 20);
  add('l', 'Documenter l\'architecture cible cloud', 'Schémas réseau, flux, responsabilités', 'done', 'medium', 'Léa', 'Infra', 'CLD', ['doc'], -3, 10);
  add('m', 'Revue de code du module d\'authentification', '', 'review', 'medium', 'Camille', 'Dev', 'PORT', ['review', 'auth'], 4, 3);
  add('n', 'Recueillir les besoins des clients pour le tableau de bord', 'Interviews avec 5 clients pilotes', 'done', 'medium', 'Nora', 'Produit', 'PORT', ['recueil'], -10, 12);

  const link = db.prepare('INSERT INTO links(from_id, to_id, type, created_at) VALUES (?,?,?,?)');
  for (const [a, b, t] of [['a', 'b', 'blocks'], ['c', 'd', 'relates'], ['f', 'e', 'blocks'], ['g', 'e', 'blocks'], ['i', 'm', 'relates'], ['b', 'm', 'relates']])
    link.run(ids[a], ids[b], t, now());
  seedOrg(db);
  db.prepare('UPDATE tasks SET position = id * 1000 WHERE position IS NULL').run();
}

/** Organisation de démonstration : 4 squads transverses (3–5 + lead) et leurs features. Idempotent. */
export function seedOrg(db) {
  if (db.prepare('SELECT COUNT(*) c FROM squads').get().c) return;
  const fn = name => db.prepare('SELECT id FROM teams WHERE name = ?').get(name)?.id ?? null;
  const ensure = (first, full, team, role, skills, cap) => {
    const ex = db.prepare('SELECT id FROM members WHERE name LIKE ?').get(`${first}%`);
    if (ex) return ex.id;
    return Number(db.prepare('INSERT INTO members(name, team_id, role, skills, capacity_h) VALUES (?,?,?,?,?)').run(full, fn(team), role, JSON.stringify(skills), cap).lastInsertRowid);
  };
  ensure('Lucas', 'Lucas Bernard', 'Produit', 'UX designer', ['ux', 'design', 'recherche'], 30);
  ensure('Maxime', 'Maxime Roche', 'Dev', 'Dev backend', ['node', 'api', 'kubernetes'], 30);
  ensure('Paul', 'Paul Girard', 'Sécurité', 'Analyste GRC', ['audit', 'politique', 'risques'], 28);
  ensure('Emma', 'Emma Faure', 'Support', 'Support N1', ['client', 'formation'], 32);
  const id = first => db.prepare('SELECT id FROM members WHERE name LIKE ?').get(`${first}%`).id;

  const sq = db.prepare('INSERT INTO squads(name, mission, color, lead_id, max_active_features) VALUES (?,?,?,?,?)');
  const setSquad = db.prepare('UPDATE members SET squad_id = ? WHERE id = ?');
  const S = {};
  for (const [name, mission, color, lead, crew] of [
    ['Portail Client', 'Livrer un portail self-service que les clients adoptent', '#6366f1', 'Camille', ['Yanis', 'Nora', 'Lucas']],
    ['Cloud & Plateforme', 'Faire tourner nos workloads dans un cloud fiable', '#0ea5e9', 'Léa', ['Hugo', 'Maxime']],
    ['Conformité & Sécurité', 'Obtenir et garder la certification ISO 27001', '#ef4444', 'Inès', ['Paul']],
    ['Support & Incidents', 'Résoudre vite et former les utilisateurs', '#10b981', 'Tom', ['Sarah', 'Emma']],
  ]) {
    S[name] = Number(sq.run(name, mission, color, id(lead), 3).lastInsertRowid);
    for (const m of [lead, ...crew]) setSquad.run(S[name], id(m));
  }
  db.prepare('UPDATE members SET loan_squad_id = ?, loan_pct = 20 WHERE id = ?').run(S['Conformité & Sécurité'], id('Maxime'));

  const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const proj = key => db.prepare('SELECT id FROM projects WHERE key = ?').get(key)?.id ?? null;
  const feat = db.prepare('INSERT INTO features(name, outcome, squad_id, project_id, status, target_date, created_at) VALUES (?,?,?,?,?,?,?)');
  const attach = db.prepare('UPDATE tasks SET feature_id = ? WHERE title LIKE ?');
  const F = {};
  for (const [key, name, outcome, squad, project, status, due, titles] of [
    ['sso', 'Connexion & SSO', 'Les clients se connectent en une étape avec leur SSO', 'Portail Client', 'PORT', 'building', 10, ['Maquettes de la page%', 'Intégrer le SSO%', 'Revue de code du module%']],
    ['dash', 'Tableau de bord client', 'Les clients suivent leurs indicateurs sans lenteur', 'Portail Client', 'PORT', 'building', 12, ['Corriger la lenteur%', 'Recueillir les besoins%']],
    ['socle', 'Socle réseau & sauvegardes', 'Un socle cloud sûr et sauvegardé', 'Cloud & Plateforme', 'CLD', 'shipping', 8, ['Configurer les sauvegardes%', 'Mettre en place le VPN%', 'Documenter l\'architecture%']],
    ['bascule', 'Bascule de la base de production', 'Migrer la production sans coupure', 'Cloud & Plateforme', 'CLD', 'discovery', 25, ['Migrer la base de données%']],
    ['mfa', 'MFA & politique d\'accès', 'Accès privilégiés protégés conformément à ISO 27001', 'Conformité & Sécurité', 'SEC', 'building', 14, ['Activer le MFA%', 'Rédiger la politique%']],
    ['pentest', 'Test d\'intrusion externe', 'Valider la sécurité du périmètre exposé', 'Conformité & Sécurité', 'SEC', 'discovery', 30, ['Lancer un test d\'intrusion%']],
    ['inc', 'Traitement des incidents', 'Incidents résolus dans le SLA', 'Support & Incidents', 'SUP', 'building', null, ['Incident : impossible%']],
    ['adopt', 'Adoption du nouveau portail', 'Le support sait accompagner les clients sur le portail', 'Support & Incidents', 'PORT', 'discovery', 25, ['Former le support N1%']],
  ]) {
    F[key] = Number(feat.run(name, outcome, S[squad], proj(project), status, due === null ? null : day(due), now()).lastInsertRowid);
    for (const t of titles) attach.run(F[key], t);
  }
  const dep = db.prepare('INSERT OR IGNORE INTO feature_deps(from_feature_id, to_feature_id, note) VALUES (?,?,?)');
  dep.run(F.sso, F.mfa, 'Le SSO réutilise la politique MFA');
  dep.run(F.adopt, F.sso, 'Formation après la mise en ligne du SSO');
  dep.run(F.inc, F.sso, 'Les incidents de connexion viennent du SSO');
  dep.run(F.bascule, F.socle, 'Pas de bascule sans sauvegardes');
  dep.run(F.pentest, F.sso, 'Le périmètre inclut la connexion');
}
