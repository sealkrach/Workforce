// Contrôle de la connexion SmartUC : teste le serveur MCP, lit le registre et montre ce que WorkForce proposerait de planifier.
// Usage : npm run smartuc:check     (utilise SMARTUC_MCP_URL / SMARTUC_API_KEY de .env ou de l'environnement)
// Travaille sur une base EN MÉMOIRE (démo) : rien n'est écrit dans vos données, rien n'est écrit dans SmartUC (lecture seule).
import '../server/index.js';                    // charge .env
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { createSmartuc } from '../server/smartuc.js';

const db = openDb(':memory:'); seed(db);
const uc = createSmartuc(db);
const cfg = uc.config();
if (!cfg.url || !cfg.key) { console.log('⚠️  Renseignez SMARTUC_MCP_URL et SMARTUC_API_KEY (clé créée dans SmartUC › MCP & API).'); process.exit(1); }
console.log(`SmartUC : ${cfg.url}\n`);
const t = await uc.test({ enabled: true });
if (!t.ok) { console.log(`❌ ${t.error}`); process.exit(1); }
console.log(`✅ Connecté à « ${t.server} » en ${t.ms} ms — ${t.tools} outils, ${t.uc_count} use cases visibles${t.role ? `, compte « ${t.role} »` : ''}`);
for (const w of t.warnings) console.log(`⚠️  ${w}`);
const s = await uc.sync();
console.log(s.ok ? `✅ Synchronisation : ${s.uc_count} UC${s.partial ? `, ${s.partial} lecture(s) de détail en échec` : ''}` : `❌ ${s.error}`);
const todo = uc.snapshot().ucs.filter(u => ['approved', 'in_build'].includes(u.status));
console.log(`\n${todo.length} UC approuvés ou en construction (candidats à la planification) :`);
for (const u of todo) {
  const p = uc.plan(u.ref), top = p.ranking[0];
  console.log(`  ${u.ref} [${u.status}] ${u.title}\n     → feature « ${p.draft.name.slice(0, 50)} » (${p.draft.status}) · ${p.playbook.length} tâches · ${p.playbook.reduce((a, x) => a + x.estimate_h, 0)} h · squad suggérée : ${top.score > 0 ? `${top.name} (${top.reasons[0]})` : 'aucun signal (squads de démonstration)'}`);
}
console.log('\nLecture seule : aucune donnée n’a été modifiée dans SmartUC.');
process.exit(0);
