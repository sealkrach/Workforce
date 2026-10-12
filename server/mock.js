// Analyseur local simplifié : imite le comportement d'un LLM avec appels d'outils.
// Sert de démonstration hors-ligne et de base de test déterministe. Un vrai LLM comprend bien davantage.
import { strip, parseDateFr, jaccard, coverage, tokens } from './util.js';
import { resolveMember } from './actions.js';

const SMALLTALK = /^(merci|bravo|super|parfait|top|genial|ok|d'accord|bonjour|bonsoir|salut|hello|coucou|bien recu|c'est note)(?:[\s!.,]+(?:beaucoup|bien|a|tous|tout|le|monde|pour|l'aide|ton|votre|aide|encore|vous|toi))*[\s!.,]*$/;
const call = (name, args, i) => ({ id: `mock_${Date.now()}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const DONE = /\b(termine|fini|finie|fait|faite|clos|cloture|boucle|livre|deploye|resolu|resolue)\b/;
const DOING = /(en cours|je commence|je demarre|demarre|commence|je m'y mets|je travaille sur)/;
const REVIEW = /(en revue|a relire|relecture|review|a valider|en validation)/;
const TODO = /(a faire|repasse en todo|remets? a faire|reporte)/;

const VERBS = /\b(j'ai|termin\w*|fini\w*|fait|faite|clos|boucl\w*|livr\w*|deploy\w*|resolu\w*|commenc\w*|demarr\w*|decal\w*|repouss\w*|assign\w*|confi\w*|passe\w*|priorit\w*|urgent\w*)\b/g;
function findTaskByText(text, tasks) {
  const q = strip(text).replace(VERBS, ' ');
  let best = null, bestScore = 0;
  for (const t of tasks) {
    const { matched, score } = coverage(q, t.title);
    const s = score + matched * 0.01;
    if (matched >= 1 && score >= 0.5 && s > bestScore) { best = t; bestScore = s; }
  }
  return best;
}

function analyzeClause(raw, hint, i) {
  const text = strip(raw);
  const { ctx, openTasks } = hint;
  const idm = text.match(/(?:#|tache\s*n?°?\s*|ticket\s*)(\d+)/);

  // 1) mise à jour d'une tâche existante (par numéro ou par description)
  const status = REVIEW.test(text) ? 'review' : DONE.test(text) ? 'done' : DOING.test(text) ? 'doing' : TODO.test(text) ? 'todo' : null;
  const reassign = text.match(/(?:assigne|confie|reaffecte|passe)\w*\s+(?:la |le |#?\d+ )?(?:a|à)\s+(\w+)/);
  const createCue = /^(?:peux[- ]tu |pourrais[- ]tu )?(?:il (?:me )?faut|faut|il faudrait|faudrait|je dois|on doit|ajoute|ajouter|cree|creer|note|rajoute|pense|n'oublie|rappelle)/.test(text.trim());
  const target = idm ? { id: +idm[1] } : createCue ? null : (status || reassign || /priorite|decale|repousse|echeance/.test(text)) ? findTaskByText(raw, openTasks) : null;
  if (target && (status || reassign || /priorite|decale|repousse|echeance/.test(text))) {
    const args = { id: target.id };
    if (status) args.status = status;
    if (/urgent|critique/.test(text)) args.priority = 'urgent';
    else if (/priorite haute|prioritaire|important/.test(text)) args.priority = 'high';
    if (reassign) args.assignee = reassign[1];
    const d = /decale|repousse|echeance|pour le|avant/.test(text) ? parseDateFr(raw) : null;
    if (d) args.due_date = d;
    return call('update_task', args, i);
  }

  // 2) lectures
  if (/charge|surcharg|disponib|qui peut|capacite|qui est libre/.test(text)) return call('get_workload', {}, i);
  if (/^(montre|affiche|liste|cherche|trouve|quelles?|quels?|qu'est|y a.t.il|ou en est)|\?\s*$/.test(text.trim())) {
    const args = { query: tokens(raw).filter(t => !/^(tache|montre|affiche|liste|cherche|trouve|quel|quelle|mes)$/.test(t)).join(' ') };
    if (/\bmes\b/.test(text)) args.assignee = 'moi';
    if (/urgent/.test(text)) args.priority = 'urgent';
    const m = ctx.members.find(m => text.includes(strip(m.name.split(' ')[0])));
    if (m) args.assignee = m.name;
    if (/en cours/.test(text)) args.status = 'doing';
    return call('search_tasks', args, i);
  }

  // 3) création
  let title = raw.trim()
    .replace(/^(?:peux[- ]tu |pourrais[- ]tu )?(?:ajoute|ajouter|cree|creer|crée|créer|note|noter|rajoute)\s+(?:une |la |l'|un )?(?:nouvelle |nouveau )?(?:tache|ticket)?\s*(?:pour|:|-)?\s*/i, '')
    .replace(/\s*[,;]?\s*(?:et )?(?:assigne|confie|donne|attribue)\w*\s+(?:la |le |ca |ça )?(?:a|à)\s+\p{L}+/iu, '')
    .replace(/^(?:il (?:me )?faut|faut|je dois|on doit|il faudrait|faudrait|pense[zr]? a|n'oublie pas de|rappelle[- ]moi de|je vais|on va)\s+/i, '');
  const pr = /urgent|critique|asap|tout de suite/.test(text) ? 'urgent' : /prioritaire|important|bloquant/.test(text) ? 'high' : /quand tu peux|pas urgent|basse priorite|sans urgence/.test(text) ? 'low' : undefined;
  const dueRaw = parseDateFr(raw);
  const est = text.match(/(\d+(?:[.,]\d+)?)\s*(?:h|heures?)\b/);
  const named = ctx.members.find(m => new RegExp(`\\b(?:pour|a|avec|confie a|assigne a|par)\\s+${strip(m.name.split(' ')[0])}\\b`).test(text))
    || ctx.members.find(m => new RegExp(`\\b${strip(m.name.split(' ')[0])}\\b`).test(text));
  const self = /\b(je dois|je vais|rappelle[- ]moi|pour moi|a moi|mon)\b/.test(text);
  const args = { title: title.replace(/\s*[,.]?\s*(?:c'est |cest )?(urgent|prioritaire|critique|asap)\b\.?/gi, '')
    .replace(/\s*(?:pour|avant|d'ici)\s+(?:demain|aujourd'hui|(?:ce )?(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|la fin de (?:la )?semaine|la semaine prochaine|dans \d+ \w+)/i, '')
    .replace(/\s*\(?\b\d+\s*h(?:eures?)?\)?/i, '').trim().replace(/^./, c => c.toUpperCase()) };
  if (pr) args.priority = pr;
  if (dueRaw) args.due_date = dueRaw;
  if (est) args.estimate_h = +est[1].replace(',', '.');
  if (named && !(self && !/\bpour\b/.test(text))) args.assignee = named.name; else if (self && hint.user) args.assignee = 'moi';
  const labels = [];
  if (/bug|erreur|plante|lenteur|ne marche pas/.test(text)) labels.push('bug');
  if (/incident|panne|down/.test(text)) labels.push('incident');
  if (/doc|documenter|rediger/.test(text)) labels.push('doc');
  if (labels.length) args.labels = labels;
  return call('create_task', args, i);
}

export function mockChat({ messages, hint }) {
  const last = messages[messages.length - 1];
  if (last.role === 'user') {
    const clauses = last.content.split(/\n+|;|\bensuite\b|\bpuis\b|\bet aussi\b/i).map(s => s.trim()).filter(s => s.length > 3 && !SMALLTALK.test(strip(s)));
    if (!clauses.length) return { role: 'assistant', content: 'Avec plaisir ! Dites-moi quand vous avez une tâche à ajouter ou à mettre à jour.' };
    return { role: 'assistant', content: null, tool_calls: clauses.slice(0, 6).map((c, i) => analyzeClause(c, hint, i)) };
  }
  // Tour de synthèse après les résultats d'outils
  const results = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift(JSON.parse(messages[i].content));
  const lines = [], proposals = [];
  for (const r of results) {
    if (r.status === 'proposed') proposals.push(r.summary);
    else if (r.tasks) lines.push(r.tasks.length ? r.tasks.map(t => `• #${t.id} ${t.title} — ${t.status}${t.assignee ? `, ${t.assignee}` : ''}${t.priority === 'urgent' ? ' 🔥' : ''}`).join('\n') : 'Aucune tâche ne correspond.');
    else if (r.members) lines.push(r.members.map(m => `• ${m.name} : ${m.pct}% (${m.load_h} h à faire d’ici ${m.window_days} j, capacité ${m.window_h} h)${m.pct > 100 ? ' ⚠️ surchargé' : ''}`).join('\n'));
    else if (r.error) lines.push(`⚠️ ${r.error}`);
  }
  if (proposals.length) lines.unshift(`Voici ce que je te propose (${proposals.length}) — vérifie puis confirme :`);
  return { role: 'assistant', content: lines.join('\n') || 'Je n\'ai rien compris à cette demande, peux-tu reformuler ?' };
}

/** Jugement local : similarité lexicale -> doublon / lié. */
export function mockJudge({ task, candidates }) {
  const links = [];
  for (const c of candidates) {
    const s = Math.max(jaccard(task.title, c.title), jaccard(`${task.title} ${task.description || ''}`, `${c.title} ${c.description || ''}`));
    if (s >= 0.55 && c.status !== 'done') links.push({ task_id: c.id, type: 'duplicates', reason: `Intitulé très proche (${Math.round(s * 100)} % de termes communs)` });
    else if (s >= 0.2) links.push({ task_id: c.id, type: 'relates', reason: 'Sujet voisin (termes communs)' });
  }
  return { links };
}
