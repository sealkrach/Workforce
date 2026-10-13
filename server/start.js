// Point d'entrée : toujours lance le serveur (indépendant du chemin d'installation : espaces, accents, liens symboliques, Windows, pm2).
import { createServer } from 'node:http';

// Le serveur s'appuie sur node:sqlite (db.isTransaction, db.location()) : on vérifie avant de démarrer, avec un message clair.
async function checkRuntime() {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { /* traité plus bas */ }
  const probe = sqlite && new sqlite.DatabaseSync(':memory:');
  if (!probe || !('isTransaction' in probe) || typeof probe.location !== 'function') {
    console.error(`WorkForce nécessite Node.js 24 ou plus récent (module node:sqlite complet). Version détectée : ${process.version}. Testé avec Node 25.9.`);
    process.exit(1);
  }
  probe.close();
}
await checkRuntime();

// Un défaut isolé ne doit jamais arrêter l'outil pour toute l'équipe : on journalise et on continue.
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
process.on('uncaughtException', e => console.error('uncaughtException:', e));

const { buildApp, LOOPBACK } = await import('./index.js');   // charge aussi .env
const { openDb } = await import('./db.js');
const { isEmpty, loadDemo } = await import('./admin.js');
const { llmConfig } = await import('./llm.js');
const { authConfig } = await import('./auth.js');
const { createSmartuc } = await import('./smartuc.js');

const db = openDb();
if (process.env.SEED_DEMO === '1' && isEmpty(db)) loadDemo(db);
const host = process.env.HOST || '127.0.0.1';
const port = +process.env.PORT || 3000;
const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const auth = authConfig();
const smartuc = createSmartuc(db);   // lit SMARTUC_* de l'environnement, surchargé par les réglages enregistrés
// L'adresse publique (PUBLIC_URL) est forcément un hôte légitime : elle sert aux redirections de connexion
const publicHost = auth.enabled ? new URL(auth.publicUrl).host : null;
const options = { loopbackOnly: LOOPBACK.has(host), allowedHosts: [...list(process.env.ALLOWED_HOSTS), ...(publicHost ? [publicHost] : [])], trustProxy: process.env.TRUST_PROXY === '1', auth, smartuc };

if (auth.enabled && !auth.adminEmails.length && !auth.domains.length && !db.prepare('SELECT 1 FROM members WHERE email IS NOT NULL').get())
  console.warn('⚠️  Authentification activée sans ADMIN_EMAILS, sans ALLOWED_EMAIL_DOMAINS et sans personne ayant une adresse e-mail : personne ne pourra se connecter. Renseignez ADMIN_EMAILS dans .env.');
const server = createServer(buildApp(db, options));
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Le port ${port} est déjà utilisé. Changez PORT ou arrêtez l'autre programme.` : e); process.exit(1); });
server.listen(port, host, () => {
  const c = llmConfig();
  console.log(`WorkForce → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${host === '0.0.0.0' ? '  (accessible depuis le réseau — pas d’authentification : réseau de confiance uniquement)' : ''}`);
  console.log(auth.enabled ? `Connexion : ${auth.providers ? Object.values(auth.providers).map(p => p.label).join(' + ') : ''} (adresse publique ${auth.publicUrl})` : 'Connexion : aucune authentification configurée — sélecteur d’utilisateur, à n’utiliser que sur un réseau de confiance (voir README).');
  if (auth.enabled && !auth.publicUrl.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(auth.publicUrl)) console.warn('⚠️  PUBLIC_URL n’est pas en HTTPS : les cookies de session ne seront pas « Secure ». Placez l’outil derrière HTTPS.');
  console.log(`IA : ${c.provider === 'mock' ? 'mode local (configurez un LLM via le badge « IA » ou LLM_API_KEY)' : `${c.model} @ ${c.baseUrl}`}`);
  { const u = smartuc.config(); console.log(u.enabled ? `SmartUC : ${u.url} (synchronisation toutes les ${u.pollMinutes} min)` : 'SmartUC : non configuré (Réglages › Intégrations).'); }
  if (isEmpty(db)) console.log('Base vide : l’interface propose de créer l’organisation ou de charger la démo (SEED_DEMO=1 pour la charger au démarrage).');
});
smartuc.start();                     // interrogation périodique de SmartUC (inactive si non configuré)
const stop = () => { smartuc.stop(); server.close(); db.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
