// Authentification OIDC (Keycloak / Google) testée contre un faux fournisseur d'identité qui vérifie réellement PKCE et signe de vrais jetons RS256.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildApp } from '../server/index.js';
import { authConfig } from '../server/auth.js';

const b64u = x => Buffer.from(x).toString('base64url');
const sign = (payload, priv, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
  const head = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${head}.${header.alg === 'RS256' ? createSign('RSA-SHA256').update(head).sign(priv, 'base64url') : ''}`;
};
const good = generateKeyPairSync('rsa', { modulusLength: 2048 }), evil = generateKeyPairSync('rsa', { modulusLength: 2048 });

// ---- Faux fournisseur d'identité ----
const idp = { codes: new Map(), identity: null, tamper: null, issuer: '', secret: 's3cret', seen: [] };
const idpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const json = (o, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` });
  if (url.pathname === '/jwks') return json({ keys: [{ ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
  if (url.pathname === '/authorize') {
    const q = Object.fromEntries(url.searchParams); idp.seen.push(q);
    const code = 'code-' + Math.random().toString(36).slice(2);
    idp.codes.set(code, { ...q, identity: idp.identity });
    res.writeHead(302, { Location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}` }); return res.end();
  }
  if (url.pathname === '/token') {
    let body = ''; for await (const c of req) body += c; const f = Object.fromEntries(new URLSearchParams(body));
    const c = idp.codes.get(f.code); idp.codes.delete(f.code);
    if (!c || f.client_secret !== idp.secret || f.redirect_uri !== c.redirect_uri || f.client_id !== c.client_id) return json({ error: 'invalid_grant' }, 400);
    if (b64u(createHash('sha256').update(f.code_verifier).digest()) !== c.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
    const t = Math.floor(Date.now() / 1000);
    let claims = { iss: idp.issuer, aud: c.client_id, sub: 'u-' + c.identity.email, iat: t, exp: t + 300, nonce: c.nonce, email_verified: true, ...c.identity };
    let key = good.privateKey, header;
    switch (idp.tamper) {
      case 'badsig': key = evil.privateKey; break;
      case 'nonce': claims.nonce = 'autre'; break;
      case 'aud': claims.aud = 'une-autre-app'; break;
      case 'iss': claims.iss = 'https://evil.example'; break;
      case 'expired': claims.exp = t - 3600; break;
      case 'alt-iss': claims.iss = 'accounts.google.com'; break;
      case 'none': header = { alg: 'none', typ: 'JWT' }; break;
      case 'hs256': header = { alg: 'HS256', kid: 'k1' }; break;
    }
    return json({ id_token: sign(claims, key, header), access_token: 'x', token_type: 'Bearer' });
  }
  res.writeHead(404); res.end();
});
await new Promise(r => idpServer.listen(0, '127.0.0.1', r));
idp.issuer = `http://127.0.0.1:${idpServer.address().port}/realms/corp`;
// le faux IdP sert tous ses chemins sous /realms/corp : on retire ce préfixe
const origHandler = idpServer.listeners('request')[0]; idpServer.removeAllListeners('request');
idpServer.on('request', (req, res) => { req.url = req.url.replace('/realms/corp', ''); return origHandler(req, res); });

// ---- Application ----
const db = openDb(':memory:'); seed(db);
const mid = n => db.prepare('SELECT id FROM members WHERE name LIKE ?').get(n + '%').id;
db.prepare('UPDATE members SET email = ? WHERE id = ?').run('lea@corp.example', mid('Léa'));       // lead Cloud
db.prepare('UPDATE members SET email = ? WHERE id = ?').run('camille@corp.example', mid('Camille')); // lead Portail
db.prepare('UPDATE members SET email = ? WHERE id = ?').run('yanis@corp.example', mid('Yanis'));     // simple membre
db.prepare('UPDATE members SET email = ? WHERE id = ?').run('ines@corp.example', mid('Inès'));       // admin
const appServer = createServer(); await new Promise(r => appServer.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${appServer.address().port}`;
const cfg = authConfig({ KEYCLOAK_ISSUER: idp.issuer, KEYCLOAK_CLIENT_ID: 'workforce', KEYCLOAK_CLIENT_SECRET: idp.secret,
  GOOGLE_CLIENT_ID: 'g-client', GOOGLE_CLIENT_SECRET: idp.secret, GOOGLE_ISSUER: idp.issuer,
  PUBLIC_URL: base, ALLOWED_EMAIL_DOMAINS: 'corp.example', ADMIN_EMAILS: 'ines@corp.example' });
appServer.on('request', buildApp(db, { auth: cfg }));
test.after(() => { idpServer.close(); appServer.close(); });

/** Joue le trajet du navigateur : /auth/login → IdP → /auth/callback. Retourne { status, cookie, text }. */
async function browserLogin(provider, identity, tamper = null) {
  idp.identity = identity; idp.tamper = tamper;
  const step1 = await fetch(`${base}/auth/login/${provider}`, { redirect: 'manual' });
  assert.equal(step1.status, 302);
  const flow = (step1.headers.get('set-cookie') || '').split(';')[0];            // cookie de flux posé par WorkForce : le navigateur le renvoie au retour
  const step2 = await fetch(step1.headers.get('location'), { redirect: 'manual' });
  const step3 = await fetch(step2.headers.get('location'), { redirect: 'manual', headers: flow ? { cookie: flow } : {} });
  return { status: step3.status, cookie: step3.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('wf_session=')) || '', setCookie: step3.headers.getSetCookie().join(' || '), text: await step3.text(), callback: step2.headers.get('location'), authorizeUrl: step1.headers.get('location') };
}
const api = async (path, { cookie, method = 'GET', body, headers = {} } = {}) => {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: body && JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};

test('sans session : 401 partout, le sélecteur X-User ne donne aucun accès, la page propose les fournisseurs', async () => {
  assert.equal((await api('/bootstrap')).status, 401);
  assert.equal((await api('/bootstrap', { headers: { 'x-user': String(mid('Inès')) } })).status, 401, 'X-User ignoré quand l’authentification est active');
  const me = await api('/auth/me'); assert.equal(me.enabled, true); assert.equal(me.user, null);
  assert.deepEqual(me.providers.map(p => p.id).sort(), ['google', 'keycloak']);
  assert.equal((await api('/health')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200, 'l’application (HTML/JS) se charge pour afficher l’écran de connexion');
});

test('connexion Keycloak : PKCE S256, state, nonce, session HttpOnly ; l’utilisateur est reconnu par e-mail', async () => {
  const r = await browserLogin('keycloak', { email: 'yanis@corp.example', name: 'Yanis B.' });
  assert.equal(r.status, 302);
  const u = new URL(r.authorizeUrl);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256'); assert.ok(u.searchParams.get('state').length >= 20); assert.ok(u.searchParams.get('nonce').length >= 20);
  assert.equal(u.searchParams.get('redirect_uri'), `${base}/auth/callback/keycloak`);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/);
  const me = await api('/auth/me', { cookie: r.cookie });
  assert.equal(me.user.id, mid('Yanis')); assert.equal(me.user.is_admin, false);
  const boot = await api('/bootstrap', { cookie: r.cookie });
  assert.equal(boot.status, 200); assert.equal(boot.auth.user.name, 'Yanis Benali'); assert.ok(boot.tasks.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c >= 1, true);
  assert.ok(!db.prepare('SELECT token_hash FROM sessions').all().some(s => r.cookie.includes(s.token_hash)), 'seul un hachage du jeton est stocké');
});

test('jetons falsifiés refusés : signature, nonce, audience, émetteur, expiration, alg none/HS256', async () => {
  for (const tamper of ['badsig', 'nonce', 'aud', 'iss', 'expired', 'none', 'hs256']) {
    const r = await browserLogin('keycloak', { email: 'yanis@corp.example' }, tamper);
    assert.equal(r.status, 401, `${tamper} doit être refusé (obtenu ${r.status})`);
    assert.equal(r.cookie, '', `aucun cookie pour ${tamper}`);
    assert.match(r.text, /Connexion impossible/);
  }
  idp.tamper = null;
});

test('state à usage unique : rejouer le callback échoue ; un state inconnu aussi', async () => {
  idp.identity = { email: 'yanis@corp.example' }; idp.tamper = null;
  const s1 = await fetch(`${base}/auth/login/keycloak`, { redirect: 'manual' });
  const flow = s1.headers.get('set-cookie').split(';')[0];
  const s2 = await fetch(s1.headers.get('location'), { redirect: 'manual' });
  const cb = s2.headers.get('location');
  assert.equal((await fetch(cb, { redirect: 'manual', headers: { cookie: flow } })).status, 302);
  assert.equal((await fetch(cb, { redirect: 'manual', headers: { cookie: flow } })).status, 400, 'rejeu refusé');
  assert.equal((await fetch(`${base}/auth/callback/keycloak?code=x&state=inconnu`, { redirect: 'manual' })).status, 400);
  assert.equal((await fetch(`${base}/auth/callback/keycloak?error=access_denied`, { redirect: 'manual' })).status, 401);
});

test('politique d’accès : inconnu refusé, domaine autorisé = compte créé + admins prévenus', async () => {
  const stranger = await browserLogin('keycloak', { email: 'intrus@gmail.com', name: 'Intrus' });
  assert.equal(stranger.status, 403); assert.match(stranger.text, /pas enregistré/); assert.equal(stranger.cookie, '');
  assert.equal(db.prepare("SELECT 1 FROM members WHERE email = 'intrus@gmail.com'").get(), undefined);
  const before = db.prepare('SELECT COUNT(*) c FROM members').get().c;
  const nouvelle = await browserLogin('keycloak', { email: 'awa@corp.example', name: 'Awa Diallo' });
  assert.equal(nouvelle.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM members').get().c, before + 1);
  const awa = db.prepare("SELECT * FROM members WHERE email = 'awa@corp.example'").get();
  assert.equal(awa.squad_id, null); assert.equal(awa.is_admin, 0);
  const ines = await browserLogin('keycloak', { email: 'ines@corp.example' });
  const notifs = (await api('/bootstrap', { cookie: ines.cookie })).notifications;
  assert.ok(notifs.items.some(n => n.kind === 'account' && /Awa Diallo/.test(n.text)), 'les administrateurs sont prévenus du nouveau compte');
});

test('Google : e-mail vérifié obligatoire, sélecteur de compte, même moteur OIDC', async () => {
  const unverified = await browserLogin('google', { email: 'camille@corp.example', email_verified: false });
  assert.equal(unverified.status, 403); assert.match(unverified.text, /pas vérifiée/);
  const ok = await browserLogin('google', { email: 'camille@corp.example', email_verified: true });
  assert.equal(ok.status, 302); assert.match(ok.authorizeUrl, /prompt=select_account/);
  assert.equal((await api('/auth/me', { cookie: ok.cookie })).user.id, mid('Camille'));
});

test('permissions : membre / lead / administrateur', async () => {
  const member = (await browserLogin('keycloak', { email: 'yanis@corp.example' })).cookie;
  const lead = (await browserLogin('keycloak', { email: 'camille@corp.example' })).cookie;     // lead Portail Client
  const adminC = (await browserLogin('keycloak', { email: 'ines@corp.example' })).cookie;
  const portail = db.prepare("SELECT id FROM squads WHERE name = 'Portail Client'").get().id, cloud = db.prepare("SELECT id FROM squads WHERE name LIKE 'Cloud%'").get().id;
  const featPortail = db.prepare('SELECT id FROM features WHERE squad_id = ? LIMIT 1').get(portail).id;
  // tout membre travaille sur les tâches
  assert.equal((await api('/tasks', { cookie: member, method: 'POST', body: { title: 'Depuis Yanis' } })).status, 200);
  assert.equal(db.prepare("SELECT created_by FROM tasks WHERE title = 'Depuis Yanis'").get().created_by, 'Yanis Benali', 'l’auteur vient de la session, pas d’un en-tête');
  // réservé aux administrateurs
  for (const [path, method, body] of [['/reset', 'POST', { confirm: 'EFFACER' }], ['/demo/load', 'POST', {}], ['/llm', 'POST', { enabled: false }], ['/projects', 'POST', { name: 'X' }], ['/teams', 'POST', { name: 'X' }], ['/members', 'POST', { name: 'Nouveau' }], ['/squads', 'POST', { name: 'S' }]]) {
    assert.equal((await api(path, { cookie: member, method, body })).status, 403, `membre refusé : ${method} ${path}`);
    assert.equal((await api(path, { cookie: lead, method, body })).status, 403, `lead refusé : ${method} ${path}`);
  }
  assert.equal((await api('/export', { cookie: member })).status, 403);
  // leads : leur squad seulement
  assert.equal((await api(`/squads/${portail}`, { cookie: lead, method: 'PATCH', body: { mission: 'Nouvelle mission' } })).status, 200);
  assert.equal((await api(`/squads/${cloud}`, { cookie: lead, method: 'PATCH', body: { mission: 'Piratage' } })).status, 403);
  assert.equal((await api(`/squads/${portail}`, { cookie: lead, method: 'PATCH', body: { lead_id: mid('Yanis') } })).status, 403, 'changer de lead = administrateur');
  assert.equal((await api('/features', { cookie: lead, method: 'POST', body: { name: 'Ma feature', squad_id: portail } })).status, 200);
  assert.equal((await api('/features', { cookie: lead, method: 'POST', body: { name: 'Chez les autres', squad_id: cloud } })).status, 403);
  assert.equal((await api(`/features/${featPortail}`, { cookie: member, method: 'PATCH', body: { name: 'Renommée' } })).status, 403, 'un simple membre ne gère pas les features');
  assert.equal((await api(`/members/${mid('Yanis')}`, { cookie: member, method: 'PATCH', body: { role: 'Dev senior' } })).status, 200, 'chacun peut éditer sa fiche');
  assert.equal((await api(`/members/${mid('Yanis')}`, { cookie: member, method: 'PATCH', body: { is_admin: true } })).status, 403, 'pas d’auto-promotion');
  assert.equal((await api(`/members/${mid('Hugo')}`, { cookie: member, method: 'PATCH', body: { role: 'x' } })).status, 403);
  // administrateur
  assert.equal((await api('/projects', { cookie: adminC, method: 'POST', body: { name: 'Projet admin' } })).status, 200);
  assert.equal((await api(`/members/${mid('Yanis')}`, { cookie: adminC, method: 'PATCH', body: { email: 'yanis2@corp.example' } })).status, 200);
  db.prepare('UPDATE members SET email = ? WHERE id = ?').run('yanis@corp.example', mid('Yanis'));
  // dernier administrateur protégé
  const ines = mid('Inès');
  assert.match((await api(`/members/${ines}`, { cookie: adminC, method: 'PATCH', body: { is_admin: false } })).error, /au moins un administrateur/);
});

test('l’origine est toujours vérifiée avec une session, et la déconnexion invalide le cookie', async () => {
  const c = (await browserLogin('keycloak', { email: 'yanis@corp.example' })).cookie;
  assert.equal((await api('/tasks', { cookie: c, method: 'POST', body: { title: 'csrf' }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await api('/auth/logout', { cookie: c, method: 'POST', body: {} })).status, 200);
  assert.equal((await api('/bootstrap', { cookie: c })).status, 401, 'la session est supprimée côté serveur');
});

test('sans fournisseur configuré, l’authentification est désactivée (mode sélecteur d’utilisateur)', async () => {
  const off = authConfig({}); assert.equal(off.enabled, false);
  const s = createServer(buildApp(db, { auth: off })); await new Promise(r => s.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/bootstrap`, { headers: { 'x-user': String(mid('Yanis')) } });
    assert.equal(r.status, 200); const d = await r.json(); assert.equal(d.auth.enabled, false); assert.equal(d.auth.user.name, 'Yanis Benali');
    assert.equal((await fetch(`http://127.0.0.1:${s.address().port}/auth/login/keycloak`)).status, 404);
  } finally { s.close(); }
});

test('CSRF de connexion : un lien de retour préparé par un attaquant ne connecte pas la victime', async () => {
  idp.identity = { email: 'yanis@corp.example' }; idp.tamper = null;
  // L'attaquant démarre SA connexion et récupère l'URL de retour, sans la rejouer
  const a1 = await fetch(`${base}/auth/login/keycloak`, { redirect: 'manual' });
  const attackerFlow = a1.headers.get('set-cookie').split(';')[0];
  const a2 = await fetch(a1.headers.get('location'), { redirect: 'manual' });
  const trap = a2.headers.get('location');
  // La victime ouvre ce lien dans SON navigateur : pas de cookie de flux, ou celui d'un autre flux
  const noCookie = await fetch(trap, { redirect: 'manual' });
  assert.equal(noCookie.status, 400); assert.equal(noCookie.headers.getSetCookie().some(c => c.startsWith('wf_session=') && !c.includes('Max-Age=0')), false);
  assert.match(await noCookie.text(), /pas été démarrée dans ce navigateur/);
  const b1 = await fetch(`${base}/auth/login/keycloak`, { redirect: 'manual' });
  const otherFlow = b1.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(trap, { redirect: 'manual', headers: { cookie: otherFlow } })).status, 400, 'le cookie d’un autre flux ne convient pas');
  assert.match(a1.headers.get('set-cookie'), /HttpOnly/); assert.match(a1.headers.get('set-cookie'), /Path=\/auth/);
  void attackerFlow;
});

test('Google accepte les deux formes d’« iss » documentées ; Keycloak reste strict', async () => {
  assert.equal((await browserLogin('google', { email: 'camille@corp.example', email_verified: true }, 'alt-iss')).status, 302);
  assert.equal((await browserLogin('keycloak', { email: 'camille@corp.example' }, 'alt-iss')).status, 401);
  idp.tamper = null;
});

test('base neuve ou vidée : ADMIN_EMAILS peut toujours créer son compte, les autres restent refusés', async () => {
  const fresh = openDb(':memory:');                                       // aucune personne, aucun domaine autorisé
  const cfg2 = authConfig({ KEYCLOAK_ISSUER: idp.issuer, KEYCLOAK_CLIENT_ID: 'workforce', KEYCLOAK_CLIENT_SECRET: idp.secret, PUBLIC_URL: '', ADMIN_EMAILS: 'boss@gmail.com' });
  const s2 = createServer(); await new Promise(r => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const cfgOk = { ...cfg2, publicUrl: b2 }; s2.on('request', buildApp(fresh, { auth: cfgOk }));
  const login = async email => {
    idp.identity = { email, name: 'Boss' }; idp.tamper = null;
    const s1 = await fetch(`${b2}/auth/login/keycloak`, { redirect: 'manual' }); const flow = s1.headers.get('set-cookie').split(';')[0];
    const sa = await fetch(s1.headers.get('location'), { redirect: 'manual' });
    return fetch(sa.headers.get('location'), { redirect: 'manual', headers: { cookie: flow } });
  };
  try {
    const stranger = await login('autre@gmail.com'); assert.equal(stranger.status, 403);
    const boss = await login('boss@gmail.com'); assert.equal(boss.status, 302);
    const cookie = boss.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('wf_session='));
    const me = await (await fetch(`${b2}/api/auth/me`, { headers: { cookie } })).json();
    assert.equal(me.user.is_admin, true); assert.equal(fresh.prepare('SELECT COUNT(*) c FROM members').get().c, 1);
    // « Effacer toutes les données » supprime aussi les personnes (et leurs sessions) : l'administrateur doit pouvoir revenir
    const r = await fetch(`${b2}/api/reset`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'EFFACER' }) });
    assert.equal(r.status, 200);
    assert.equal((await fetch(`${b2}/api/bootstrap`, { headers: { cookie } })).status, 401, 'ancienne session invalidée');
    assert.equal((await login('boss@gmail.com')).status, 302, 'l’administrateur déclaré peut se reconnecter après un effacement');
  } finally { s2.close(); }
});

test('l’environnement (.env) ne désactive pas les anciens usages : buildApp(db) sans option = sans authentification', async () => {
  const saved = { i: process.env.KEYCLOAK_ISSUER, c: process.env.KEYCLOAK_CLIENT_ID };
  process.env.KEYCLOAK_ISSUER = 'http://nowhere.invalid/realms/x'; process.env.KEYCLOAK_CLIENT_ID = 'x';
  const s2 = createServer(buildApp(db)); await new Promise(r => s2.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${s2.address().port}/api/bootstrap`, { headers: { 'x-user': String(mid('Yanis')) } });
    assert.equal(r.status, 200);
  } finally {
    s2.close();
    for (const [k, v] of [['KEYCLOAK_ISSUER', saved.i], ['KEYCLOAK_CLIENT_ID', saved.c]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
