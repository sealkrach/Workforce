// Sauvegarde cohérente de la base (SQLite « VACUUM INTO », sans arrêter l'application) avec rotation.
// Usage : node scripts/backup.mjs [dossier=<dossier de la base>/backups] [conservation=14]
//   Docker :  docker compose exec -T workforce node scripts/backup.mjs
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH || new URL('../data/workforce.db', import.meta.url).pathname);
if (!existsSync(dbPath)) { console.error(`Base introuvable : ${dbPath}`); process.exit(1); }
const dir = resolve(process.argv[2] || join(dirname(dbPath), 'backups')), keep = Math.max(1, Number(process.argv[3]) || 14);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);   // à la milliseconde : deux sauvegardes rapprochées ne se heurtent pas
let out = join(dir, `workforce-${stamp}.db`);
for (let n = 1; existsSync(out); n++) out = join(dir, `workforce-${stamp}-${n}.db`);
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
const old = readdirSync(dir).filter(f => /^workforce-.*\.db$/.test(f)).sort().slice(0, -keep);
for (const f of old) rmSync(join(dir, f));
console.log(`Sauvegarde : ${out} (${readdirSync(dir).filter(f => f.endsWith('.db')).length} conservée(s), rotation à ${keep})`);
