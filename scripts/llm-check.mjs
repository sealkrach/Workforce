// Contrôle du LLM configuré : envoie quelques demandes réalistes en français et affiche ce que l'assistant proposerait.
// Usage : npm run llm:check        (utilise LLM_API_KEY / LLM_BASE_URL / LLM_MODEL de .env ou de l'environnement)
// Travaille sur une base de démonstration EN MÉMOIRE : rien n'est écrit dans vos données.
import '../server/index.js';                    // charge .env
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { handleChat } from '../server/agent.js';
import { llmConfig } from '../server/llm.js';

const cfg = llmConfig();
console.log(cfg.provider === 'mock'
  ? '⚠️  Aucun LLM configuré : exécution avec l’analyseur local. Renseignez LLM_API_KEY (et LLM_BASE_URL / LLM_MODEL) dans .env pour tester votre modèle.\n'
  : `Modèle : ${cfg.model} @ ${cfg.baseUrl}\n`);

const db = openDb(':memory:'); seed(db);
const userId = db.prepare("SELECT id FROM members WHERE name LIKE 'Camille%'").get().id;
const names = id => id ? db.prepare('SELECT name FROM members WHERE id = ?').get(id)?.name : undefined;
const feat = id => db.prepare('SELECT f.name n, s.name s FROM features f JOIN squads s ON s.id = f.squad_id WHERE f.id = ?').get(id);

const CASES = [
  ['Création complète', 'Il faut renouveler le certificat SSL du portail client, urgent pour vendredi, assigne à Léa',
    r => r.actions.length === 1 && r.actions[0].type === 'create_task' && r.actions[0].patch.priority === 'urgent' && names(r.actions[0].patch.assignee_id)?.startsWith('Léa')],
  ['Mise à jour par description', "J'ai terminé la configuration des sauvegardes",
    r => r.actions.length === 1 && r.actions[0].type === 'update_task' && r.actions[0].patch.status === 'done'],
  ['Deux tâches dans un message', 'Ajoute deux tâches : documenter la procédure de restauration, et planifier un test de bascule avec Hugo',
    r => r.actions.filter(a => a.type === 'create_task').length === 2],
  ['Question de charge', 'Qui est surchargé en ce moment ?', r => r.actions.length === 0 && r.reply.length > 10],
  ['Recherche par squad', 'Montre-moi les tâches de la squad Portail Client', r => r.actions.length === 0 && r.reply.length > 10],
  ['Politesse (aucune action attendue)', 'Merci beaucoup !', r => r.actions.length === 0],
  ['Hors périmètre → Inbox', 'Il faut commander des chaises ergonomiques pour la salle de pause', r => r.actions.length === 1 && !r.actions[0].patch.feature_id],
];

let ko = 0, errors = 0;
for (const [label, message, check] of CASES) {
  const t0 = performance.now();
  try {
    const r = await handleChat(db, { message, history: [], userId });
    const ms = Math.round(performance.now() - t0);
    const ok = !!check(r); if (!ok) ko++;
    console.log(`${ok ? '✅' : '⚠️ '} ${label} — ${ms} ms\n   « ${message} »`);
    if (r.reply) console.log(`   → ${r.reply.replace(/\n/g, '\n     ')}`);
    for (const a of r.actions) {
      const f = a.patch?.feature_id && feat(a.patch.feature_id);
      if (a.type === 'create_task') console.log(`   + créer « ${a.title} » | feature: ${f ? `${f.n} (${f.s})` : '— Inbox'} | priorité: ${a.patch.priority} | assigné: ${names(a.patch.assignee_id) || '—'} | échéance: ${a.patch.due_date || '—'} | liens suggérés: ${a.links?.length || 0}`);
      else if (a.type === 'update_task') console.log(`   ~ modifier #${a.id} « ${a.title} » : ${a.rows.map(x => `${x.field} ${x.from} → ${x.value}`).join(', ')}`);
      else console.log(`   ⇄ lier #${a.from_id} ${a.link_type} #${a.to_id}`);
      for (const w of a.warnings || []) console.log(`     ⚠ ${w}`);
    }
  } catch (e) { errors++; console.log(`❌ ${label} : ${e.message}`); }
  console.log('');
}
console.log(errors ? `❌ ${errors} appel(s) en erreur : vérifiez la clé, l’URL et le modèle (badge « IA » › Tester la connexion).`
  : ko ? `⚠️  ${CASES.length - ko}/${CASES.length} comportements conformes. Relisez les propositions ci-dessus : c’est le signal pour ajuster le modèle ou le prompt (server/agent.js).`
  : `✅ ${CASES.length}/${CASES.length} comportements conformes.`);
process.exit(errors ? 1 : 0);
