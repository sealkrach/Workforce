// Authentification OpenID Connect (Keycloak, Google, tout fournisseur OIDC) — sans dépendance.
// Flux « authorization code » + PKCE (S256), state et nonce à usage unique, id_token vérifié (signature RS256 via JWKS,
// émetteur, audience, expiration, nonce). Sessions stockées en base (seul un hachage du jeton est conservé).
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { HttpError, now } from './util.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
const sha256 = s => createHash('sha256').update(s).digest();
const list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const trimSlash = s => String(s || '').replace(/\/+$/, '');
export const SESSION_COOKIE = 'wf_session';
export const FLOW_COOKIE = 'wf_flow';

/** Configuration lue dans l'environnement (ou passée en options dans les tests). Sans fournisseur : authentification désactivée. */
export function authConfig(env = process.env) {
  const providers = {};
  if (env.KEYCLOAK_ISSUER && env.KEYCLOAK_CLIENT_ID)
    providers.keycloak = { label: 'Keycloak', issuer: trimSlash(env.KEYCLOAK_ISSUER), clientId: env.KEYCLOAK_CLIENT_ID, clientSecret: env.KEYCLOAK_CLIENT_SECRET || '' };
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    providers.google = { label: 'Google', issuer: trimSlash(env.GOOGLE_ISSUER || 'https://accounts.google.com'), clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, requireVerifiedEmail: true,
      altIssuers: ['accounts.google.com', 'https://accounts.google.com'] };   // Google documente ces deux formes d'« iss »
  return {
    enabled: Object.keys(providers).length > 0, providers,
    publicUrl: trimSlash(env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`),
    domains: list(env.ALLOWED_EMAIL_DOMAINS).map(d => d.toLowerCase().replace(/^@/, '')),
    adminEmails: list(env.ADMIN_EMAILS).map(e => e.toLowerCase()),
    sessionDays: Math.max(1, +env.SESSION_DAYS || 14),
  };
}

export function createAuth(db, cfg) {
  const secureCookie = cfg.publicUrl.startsWith('https://');
  // Les administrateurs déclarés (ADMIN_EMAILS) le sont dès le démarrage, même avant leur première connexion
  for (const e of cfg.adminEmails) db.prepare('UPDATE members SET is_admin = 1 WHERE lower(email) = ?').run(e);
  const cache = new Map();            // découverte OIDC et JWKS (1 h)
  const getJson = async (url) => {
    const hit = cache.get(url);
    if (hit && hit.exp > Date.now()) return hit.value;
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(8000) }); } catch { throw new HttpError('Le fournisseur d’identité est injoignable. Réessayez dans un instant.', 502); }
    if (!res.ok) throw new HttpError(`Réponse inattendue du fournisseur d’identité (${res.status})`, 502);
    const value = await res.json(); cache.set(url, { value, exp: Date.now() + 3_600_000 }); return value;
  };
  const provider = id => { const p = cfg.providers[id]; if (!p) throw new HttpError('Fournisseur de connexion inconnu', 404); return p; };
  const discovery = async p => {
    const d = await getJson(`${p.issuer}/.well-known/openid-configuration`);
    if (trimSlash(d.issuer) !== p.issuer) throw new HttpError('Émetteur OIDC inattendu : vérifiez l’URL de l’émetteur (issuer).', 502);
    return d;
  };
  const redirectUri = id => `${cfg.publicUrl}/auth/callback/${id}`;

  /** Étape 1 : URL de redirection vers le fournisseur. */
  async function startLogin(id) {
    const p = provider(id), d = await discovery(p);
    const state = b64u(randomBytes(24)), nonce = b64u(randomBytes(24)), verifier = b64u(randomBytes(48));
    db.prepare("DELETE FROM auth_flows WHERE created_at < ?").run(new Date(Date.now() - 600_000).toISOString());
    db.prepare('INSERT INTO auth_flows(state, provider, nonce, verifier, created_at) VALUES (?,?,?,?,?)').run(state, id, nonce, verifier, now());
    const q = new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: redirectUri(id), scope: 'openid email profile', state, nonce,
      code_challenge: b64u(sha256(verifier)), code_challenge_method: 'S256', ...(id === 'google' ? { prompt: 'select_account' } : {}) });
    return { url: `${d.authorization_endpoint}${d.authorization_endpoint.includes('?') ? '&' : '?'}${q}`, state };
  }

  async function verifyIdToken(p, d, token, nonce) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new HttpError('Jeton d’identité invalide', 401);
    let header, claims;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new HttpError('Jeton d’identité illisible', 401); }
    if (header.alg !== 'RS256') throw new HttpError('Algorithme de signature refusé (RS256 attendu)', 401);   // jamais « none » ni HS256
    let jwks = await getJson(d.jwks_uri), jwk = jwks.keys?.find(k => k.kid === header.kid && (!k.use || k.use === 'sig'));
    if (!jwk) { cache.delete(d.jwks_uri); jwks = await getJson(d.jwks_uri); jwk = jwks.keys?.find(k => k.kid === header.kid); }   // rotation de clés
    if (!jwk) throw new HttpError('Clé de signature inconnue', 401);
    const ok = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new HttpError('Signature du jeton invalide', 401);
    const t = Math.floor(Date.now() / 1000), aud = [].concat(claims.aud || []);
    if (![p.issuer, ...(p.altIssuers || [])].includes(trimSlash(claims.iss))) throw new HttpError('Émetteur du jeton invalide', 401);
    if (!aud.includes(p.clientId) || (aud.length > 1 && claims.azp !== p.clientId)) throw new HttpError('Jeton destiné à une autre application', 401);
    if (!(claims.exp > t - 60)) throw new HttpError('Jeton expiré', 401);
    if (claims.iat && claims.iat > t + 120) throw new HttpError('Jeton émis dans le futur', 401);
    if (claims.nonce !== nonce) throw new HttpError('Nonce invalide (rejeu possible)', 401);
    return claims;
  }

  /** Associe l'identité OIDC à une personne de WorkForce (par e-mail) ; applique la politique d'accès. */
  function memberFor(p, claims) {
    const email = String(claims.email || '').trim().toLowerCase();
    if (!email) throw new HttpError('Le fournisseur n’a pas transmis d’adresse e-mail : impossible de vous identifier.', 403);
    if (claims.email_verified === false || (p.requireVerifiedEmail && claims.email_verified !== true)) throw new HttpError('Votre adresse e-mail n’est pas vérifiée chez le fournisseur.', 403);
    let m = db.prepare('SELECT * FROM members WHERE lower(email) = ?').get(email);
    let created = false;
    if (!m) {
      const domain = email.split('@')[1];
      // Une adresse listée dans ADMIN_EMAILS peut toujours créer son compte (sinon une base neuve ou vidée ne serait plus accessible à personne)
      if (!cfg.domains.includes(domain) && !cfg.adminEmails.includes(email))
        throw new HttpError(`Le compte ${email} n’est pas enregistré dans WorkForce. Demandez à un administrateur de vous ajouter (Réglages › Personnes) avec cette adresse e-mail.`, 403);
      const name = String(claims.name || email.split('@')[0]).trim().slice(0, 80);
      const taken = db.prepare('SELECT 1 FROM members WHERE lower(name) = lower(?)').get(name);
      const id = Number(db.prepare('INSERT INTO members(name, email, role, skills, capacity_h) VALUES (?,?,?,?,?)').run(taken ? `${name} (${email})` : name, email, '', '[]', 30).lastInsertRowid);
      m = db.prepare('SELECT * FROM members WHERE id = ?').get(id); created = true;
    }
    // Administrateurs : liste ADMIN_EMAILS ; à défaut de liste et d'admin existant, le premier compte autorisé l'est (amorçage).
    const hasAdmin = db.prepare('SELECT 1 FROM members WHERE is_admin = 1').get();
    if (!m.is_admin && (cfg.adminEmails.includes(email) || (!cfg.adminEmails.length && !hasAdmin))) { db.prepare('UPDATE members SET is_admin = 1 WHERE id = ?').run(m.id); m.is_admin = 1; }
    return { member: m, created };
  }

  /** Étape 2 : retour du fournisseur. Retourne le jeton de session à poser en cookie. */
  async function finishLogin(id, query, flowCookie) {
    const p = provider(id);
    if (query.error) throw new HttpError(`Connexion refusée par le fournisseur (${String(query.error).slice(0, 60)}).`, 401);
    const flow = db.prepare('SELECT * FROM auth_flows WHERE state = ?').get(String(query.state || ''));
    if (flow) db.prepare('DELETE FROM auth_flows WHERE state = ?').run(flow.state);       // usage unique
    if (!flow || flow.provider !== id || Date.parse(flow.created_at) < Date.now() - 600_000) throw new HttpError('Session de connexion expirée ou invalide : recommencez.', 400);
    if (!flowCookie || flowCookie !== flow.state) throw new HttpError('Cette connexion n’a pas été démarrée dans ce navigateur : recommencez depuis WorkForce.', 400);   // empêche de faire ouvrir à un tiers un lien de retour préparé par un attaquant
    if (!query.code) throw new HttpError('Code d’autorisation manquant', 400);
    const d = await discovery(p);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: String(query.code), redirect_uri: redirectUri(id), client_id: p.clientId, code_verifier: flow.verifier });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (p.clientSecret) body.set('client_secret', p.clientSecret);
    let res;
    try { res = await fetch(d.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) }); } catch { throw new HttpError('Le fournisseur d’identité est injoignable.', 502); }
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.id_token) throw new HttpError(`Échec de l’échange du code (${tok.error_description || tok.error || res.status}).`, 401);
    const claims = await verifyIdToken(p, d, tok.id_token, flow.nonce);
    const { member, created } = memberFor(p, claims);
    const token = b64u(randomBytes(32)), maxAge = cfg.sessionDays * 86400;
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO sessions(token_hash, member_id, created_at, expires_at) VALUES (?,?,?,?)').run(sha256(token).toString('hex'), member.id, now(), new Date(Date.now() + maxAge * 1000).toISOString());
    return { token, maxAge, member, created };
  }

  const readCookie = (req, name) => { for (const part of String(req.headers.cookie || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); } return null; };
  const cookieOf = req => readCookie(req, SESSION_COOKIE);
  /** Personne connectée d'après le cookie de session (ou null). */
  function sessionMember(req) {
    const t = cookieOf(req); if (!t) return null;
    return db.prepare(`SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(t).toString('hex'), now()) || null;
  }
  const logout = req => { const t = cookieOf(req); if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t).toString('hex')); };
  const flags = `HttpOnly; SameSite=Lax; Path=/${secureCookie ? '; Secure' : ''}`;

  return {
    enabled: cfg.enabled, publicUrl: cfg.publicUrl,
    providers: Object.entries(cfg.providers).map(([id, p]) => ({ id, label: p.label })),
    startLogin, finishLogin, sessionMember, logout, flowCookieOf: req => readCookie(req, FLOW_COOKIE),
    setFlowCookie: state => `${FLOW_COOKIE}=${state}; Max-Age=600; HttpOnly; SameSite=Lax; Path=/auth${secureCookie ? '; Secure' : ''}`,
    clearFlowCookie: () => `${FLOW_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/auth${secureCookie ? '; Secure' : ''}`,
    setCookie: (token, maxAge) => `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; ${flags}`,
    clearCookie: () => `${SESSION_COOKIE}=; Max-Age=0; ${flags}`,
  };
}
