// Utilitaires texte partagés : normalisation, tokenisation, similarité.
const STOP = new Set(('le la les un une des de du d l et ou à a au aux en dans sur pour par avec sans ce cet cette ces ' +
  'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs qui que quoi dont où il elle on nous vous ils elles ' +
  'je tu me te se y est sont être avoir faut fait faire the of to and for is it be ne pas plus moins très si ' +
  'peux peut veux voudrais merci svp stp ajoute ajouter crée créer cree creer nouvelle nouveau tâche tache ticket').split(/\s+/));

export const strip = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function tokens(text = '') {
  return strip(text)
    .replace(/[^a-z0-9#\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/(s|x)$/, ''))
    .filter(t => t.length > 2 && !STOP.has(t));
}

export function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Date AAAA-MM-JJ dans le fuseau LOCAL du serveur (et non UTC, qui décale « demain » et les retards autour de minuit). */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const today = () => localDate();
export const now = () => new Date().toISOString();
export const isRealDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && localDate(new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))) === s;

/** Erreur « métier » : renvoyée au client avec son code (400, 404…) au lieu d'un 500. */
export class HttpError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
/** Dates relatives en français ("demain", "vendredi", "dans 3 jours", "fin de semaine") -> AAAA-MM-JJ */
export function parseDateFr(text = '', from = new Date()) {
  const s = strip(text);
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const add = n => { const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + n); return localDate(d); };
  if (/apres[- ]demain/.test(s)) return add(2);
  if (/\bdemain\b/.test(s)) return add(1);
  if (/aujourd'?hui|ce jour|\bce soir\b/.test(s)) return add(0);
  let m = s.match(/dans (\d+) (jour|semaine|mois)/);
  if (m) return add(+m[1] * ({ jour: 1, semaine: 7, mois: 30 })[m[2]]);
  if (/semaine prochaine/.test(s)) return add(7);
  if (/fin de (la )?semaine/.test(s)) return add((5 - from.getDay() + 7) % 7 || 7);
  if (/fin de (ce )?mois/.test(s)) return localDate(new Date(from.getFullYear(), from.getMonth() + 1, 0));
  m = s.match(new RegExp(`\\b(${DAYS.join('|')})\\b`));
  if (m) return add(((DAYS.indexOf(m[1]) - from.getDay() + 7) % 7) || 7);
  return null;
}

/** Part des mots de `query` retrouvés (radical de 5 lettres) dans `text` : tolère configurer/configuration. */
export function coverage(query, text) {
  const stem = t => t.slice(0, 5);
  const T = new Set(tokens(text).map(stem));
  const Q = tokens(query).map(stem);
  if (!Q.length) return { matched: 0, score: 0 };
  const matched = Q.filter(q => T.has(q)).length;
  return { matched, score: matched / Q.length };
}
