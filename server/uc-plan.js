// Du use case SmartUC au plan de livraison WorkForce : brouillon de feature, paquet de tâches propre à l'IA, squad suggérée.
// Tout est déterministe et explicable (aucun appel LLM) : un lead doit pouvoir comprendre POURQUOI cette squad est proposée.
import { coverage, strip, tokens, isRealDate } from './util.js';
import { orgSnapshot } from './squads.js';

export const arr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : (v ? [String(v).trim()] : []);
const norm = s => strip(String(s)).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const EFFORT = { S: 0.5, M: 1, L: 1.5, XL: 2 };
const FEATURE_STATUS = { approved: 'discovery', in_build: 'building', in_production: 'live' };
const round = h => Math.max(1, Math.round(h * 2) / 2);

/** Ligne du cache → objet manipulable (données détaillées désérialisées). */
export const parseUc = row => row && ({ ...row, data: JSON.parse(row.data || '{}'), relations: JSON.parse(row.relations || '{"links":[],"entities":[]}') });

export function featureDraft(uc) {
  const d = uc.data || {};
  return {
    name: String(uc.title || uc.ref).slice(0, 120),
    outcome: String(d.summary || d.problem_statement || '').slice(0, 300),
    status: FEATURE_STATUS[uc.status] || 'discovery',
    target_date: isRealDate(d.target_date) ? d.target_date : null,
  };
}

/** Paquet de tâches typique d'un use case IA, dimensionné par l'effort estimé (S/M/L/XL). L'utilisateur coche ce qu'il garde. */
export function playbook(uc) {
  const d = uc.data || {}, k = EFFORT[d.estimated_effort] ?? 1, out = [];
  const labels = (...extra) => ['uc', uc.ref.toLowerCase(), 'ia', ...extra];
  const add = (title, description, hours, priority, ...tags) => out.push({ title: title.slice(0, 200), description, estimate_h: round(hours * k), priority, labels: labels(...tags) });
  add('Valider le périmètre et la définition de « terminé » avec le sponsor', [d.problem_statement && `Problème : ${d.problem_statement}`, d.sponsor && `Sponsor : ${d.sponsor}`].filter(Boolean).join('\n'), 4, 'high', 'cadrage');
  for (const src of arr(d.data_sources).slice(0, 4)) add(`Vérifier l’accès et la qualité des données : ${src}`, 'Disponibilité, volumétrie, qualité, droits d’usage.', 8, 'high', 'data');
  if (/personal/.test(d.data_sensitivity || '')) add('Analyser l’impact sur les données personnelles (RGPD / DPIA)', `Sensibilité déclarée : ${d.data_sensitivity}`, 8, 'high', 'data', 'conformite');
  const systems = [...new Set([...arr(d.source_systems), ...arr(d.target_systems)])].slice(0, 5);
  for (const sys of systems) add(`Spécifier et réaliser l’intégration avec ${sys}`, 'Contrat d’interface, authentification, gestion d’erreurs, environnement de test.', 12, 'medium', 'integration');
  if (d.build_approach === 'buy' || d.build_approach === 'partner') add('Sélectionner et contractualiser la solution (achat / partenaire)', `Approche déclarée : ${d.build_approach}`, 16, 'high', 'build');
  else if (d.build_approach === 'reuse_existing_platform') add('Cadrer la réutilisation de la plateforme existante', 'Capacités, limites, quotas, dépendances vers l’équipe plateforme.', 8, 'high', 'build');
  add(`Réaliser un prototype${d.ai_capability ? ` (${d.ai_capability})` : ''} sur un périmètre restreint`, 'Preuve de faisabilité technique avant le passage à l’échelle.', 24, 'high', 'build');
  if (['review_before_action', 'exception_only'].includes(d.human_in_the_loop)) add(`Concevoir le parcours de validation humaine (${d.human_in_the_loop})`, 'Écrans, règles d’escalade, traçabilité des décisions.', 12, 'medium', 'hitl');
  add('Constituer le jeu d’évaluation et les critères d’acceptation', 'Cas représentatifs, métriques, seuils d’acceptation partagés avec le métier.', 12, 'high', 'eval');
  for (const kpi of arr(d.kpis).slice(0, 4)) add(`Mesurer la situation de départ du KPI : ${kpi}`, 'Sans mesure de départ, le gain ne sera pas démontrable à la revue de go-live.', 4, 'medium', 'eval', 'kpi');
  if (/high/.test(d.eu_ai_act_tier || uc.risk_tier || '')) add('Constituer la documentation technique et la traçabilité (EU AI Act, haut risque)', `Tier validé : ${d.eu_ai_act_tier || uc.risk_tier}`, 24, 'high', 'risque', 'conformite');
  for (const m of arr(d.mitigations).slice(0, 5)) add(`Mettre en place la mitigation : ${m}`, 'Mesure de réduction du risque déclarée dans le canvas SmartUC.', 8, 'high', 'risque');
  add('Mettre en place le suivi en production (qualité, dérive, coûts)', 'Tableaux de bord et alertes ; condition de la porte de go-live.', 12, 'medium', 'monitoring');
  add('Préparer la revue de go-live (résultats d’évaluation, suivi, mitigations)', 'Dossier pour la porte « go-live » dans SmartUC.', 6, 'high', 'golive');
  return out.slice(0, 24);
}

const entitiesOf = d => [...arr(d.data_sources), ...arr(d.source_systems), ...arr(d.target_systems), ...arr(d.teams_involved)].map(norm).filter(Boolean);

/**
 * Classe les squads pour un use case. Signaux : porteur du UC dans la squad (même Keycloak ⇒ rapprochement par e-mail),
 * équipes citées, entités partagées avec les UC déjà portés, compétences, puis pénalités de capacité.
 */
export function suggestSquads(db, uc) {
  const d = uc.data || {}, org = orgSnapshot(db);
  const members = db.prepare('SELECT id, name, email, skills, squad_id FROM members').all();
  const score = new Map(org.squads.map(s => [s.id, { squad_id: s.id, name: s.name, score: 0, reasons: [] }]));
  const bump = (squadId, pts, why) => { const e = score.get(squadId); if (e) { e.score += pts; e.reasons.push(why); } };
  const squadName = id => org.squads.find(s => s.id === id)?.name;

  // 1) Porteurs : propriétaire de la fiche, product owner, sponsor
  const people = [[uc.data?.owner?.email || null, uc.data?.owner?.name || null, 4, 'propriétaire de la fiche'], [null, d.product_owner, 4, 'product owner'], [null, d.sponsor, 2, 'sponsor']];
  for (const [email, name, pts, role] of people) {
    const m = members.find(x => (email && x.email && x.email.toLowerCase() === email.toLowerCase())
      || (name && (String(name).toLowerCase().includes((x.email || '\0').toLowerCase()) || norm(x.name) === norm(name) || (norm(name).length > 4 && norm(name).includes(norm(x.name))))));
    if (m?.squad_id) bump(m.squad_id, pts, `${m.name} (${role}) est dans la squad « ${squadName(m.squad_id)} »`);
  }
  // 2) Équipes citées dans le canvas ≈ nom de squad
  for (const team of arr(d.teams_involved)) for (const s of org.squads) {
    const { matched, score: cov } = coverage(team, s.name);
    if (matched >= 1 && cov >= 0.5) bump(s.id, 3, `l’équipe « ${team} » est citée et ressemble à la squad « ${s.name} »`);
  }
  // 3) Entités (systèmes, données, équipes) partagées avec les UC déjà portés par une squad
  const mine = new Set(entitiesOf(d));
  const linked = db.prepare(`SELECT fu.uc_ref, f.squad_id, c.data FROM feature_ucs fu JOIN features f ON f.id = fu.feature_id JOIN uc_cache c ON c.ref = fu.uc_ref WHERE fu.uc_ref != ?`).all(uc.ref);
  const shared = new Map();
  for (const l of linked) {
    const common = entitiesOf(JSON.parse(l.data || '{}')).filter(e => mine.has(e));
    if (common.length) { const e = shared.get(l.squad_id) || { n: 0, refs: new Set(), names: new Set() }; e.n += common.length; e.refs.add(l.uc_ref); common.forEach(c => e.names.add(c)); shared.set(l.squad_id, e); }
  }
  for (const [sid, e] of shared) bump(sid, Math.min(4, e.n), `partage ${e.names.size} entité${e.names.size > 1 ? 's' : ''} (${[...e.names].slice(0, 3).join(', ')}) avec ${[...e.refs].join(', ')}, déjà porté${e.refs.size > 1 ? 's' : ''} par cette squad`);
  // 4) Compétences des membres
  const want = new Set(tokens([uc.ai_capability, ...arr(d.source_systems), ...arr(d.target_systems), ...arr(d.data_sources)].join(' ')));
  for (const s of org.squads) {
    const hit = new Set();
    for (const m of members.filter(x => x.squad_id === s.id)) for (const sk of JSON.parse(m.skills || '[]')) for (const t of tokens(sk)) if (want.has(t)) hit.add(sk);
    if (hit.size) bump(s.id, Math.min(3, hit.size), `compétences en phase : ${[...hit].slice(0, 4).join(', ')}`);
  }
  // 5) Capacité
  for (const s of org.squads) {
    if (s.pct > 100) bump(s.id, -2, `squad déjà surchargée (${s.pct} %)`);
    if (s.active_features >= s.max_active_features) bump(s.id, -2, `limite de ${s.max_active_features} features en parallèle atteinte`);
  }
  return [...score.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'));
}
