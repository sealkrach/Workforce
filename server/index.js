import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize as pnorm } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// Chargement minimal de .env (aucune dépendance)
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !l.trim().startsWith('#') && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { openDb, parseTask, workload, blockedIds, loadSetting, saveSetting } = await import('./db.js');
const { handleChat } = await import('./agent.js');
const actions = await import('./actions.js');
const org = await import('./squads.js');
const admin = await import('./admin.js');
const { createAuth, authConfig } = await import('./auth.js');
const { notificationsFor, markRead, notify, adminIds } = await import('./notify.js');
const { llmConfig, publicConfig, setLlmSettings, testConnection, ping, transcribe } = await import('./llm.js');
const { HttpError } = await import('./util.js');
const { context, execute, createTask, updateTask, deleteTask, addLink, removeLink, undoBatch, undoActivity, tx } = actions;

const MAX_JSON = 1_000_000;          // 1 Mo : largement assez pour une tâche ou une proposition du chat
const MAX_AUDIO = 25_000_000;        // 25 Mo : limite des API de transcription
export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Options réseau :
 *  - loopbackOnly : n'accepter que les en-têtes Host locaux (protège contre le « DNS rebinding » quand le serveur n'écoute qu'en local)
 *  - allowedHosts : noms d'hôte supplémentaires autorisés (ALLOWED_HOSTS), p. ex. l'adresse publique du reverse proxy
 *  - trustProxy   : faire confiance à X-Forwarded-Host (TRUST_PROXY=1) quand un reverse proxy réécrit l'en-tête Host
 */
export function buildApp(db, { loopbackOnly = false, allowedHosts = [], trustProxy = false, auth: authCfg = authConfig({}) } = {}) {   // authentification DÉSACTIVÉE par défaut : seul start.js lit l'environnement
  const allowed = new Set(allowedHosts.map(h => h.toLowerCase()));
  const authn = createAuth(db, authCfg);
  setLlmSettings(loadSetting(db, 'llm') || {});
  const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  const SECURITY = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const send = (res, status, headers, payload) => { if (res.headersSent) return res.end(); res.writeHead(status, { ...SECURITY, ...headers }); res.end(payload); };
  const json = (res, data, status = 200, extra = {}) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, JSON.stringify(data));

  /** Lit le corps avec une limite stricte (413 au-delà), sans jamais tout charger en mémoire. */
  const body = async (req, max) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) throw new HttpError('Requête trop volumineuse', 413);
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw new HttpError('Requête trop volumineuse', 413); chunks.push(c); }
    return Buffer.concat(chunks);
  };
  const parseJson = raw => {
    if (!raw.length) return {};
    try { const v = JSON.parse(raw.toString('utf8')); return v && typeof v === 'object' ? v : (() => { throw 0; })(); }
    catch { throw new HttpError('Corps JSON invalide', 400); }
  };
  /** Qui agit : la session (authentification activée) ou, sinon, le sélecteur « Connecté en tant que » (tous admins). */
  const actorOf = req => {
    if (authn.enabled) {
      const m = authn.sessionMember(req);
      return m ? { id: m.id, name: m.name, is_admin: !!m.is_admin, authenticated: true } : { id: null, name: 'anonyme', is_admin: false, authenticated: false };
    }
    const id = Number(req.headers['x-user']) || null;
    const m = id && db.prepare('SELECT * FROM members WHERE id = ?').get(id);
    return { id: m?.id || null, name: m?.name || 'anonyme', is_admin: true, authenticated: true };
  };
  const forbid = m => { throw new HttpError(m, 403); };
  const needAdmin = actor => { if (!actor.is_admin) forbid('Action réservée aux administrateurs.'); };
  /** Droit de gérer une squad : administrateur, ou lead de cette squad (sans authentification, tout le monde). */
  const isLeadOf = (actor, squadId) => !authn.enabled || actor.is_admin || (squadId && db.prepare('SELECT 1 FROM squads WHERE id = ? AND lead_id = ?').get(squadId, actor.id));
  const needLead = (actor, squadId, what = 'cette squad') => { if (!isLeadOf(actor, squadId)) forbid(`Réservé au lead de ${what} ou à un administrateur.`); };

  const snapshot = (actor = { id: null }) => ({
    teams: db.prepare('SELECT * FROM teams').all(),
    members: db.prepare('SELECT * FROM members').all().map(m => ({ ...m, skills: JSON.parse(m.skills || '[]') })),
    projects: db.prepare('SELECT * FROM projects').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all().map(parseTask),
    links: db.prepare('SELECT * FROM links').all(),
    blocked: blockedIds(db),
    workload: workload(db),
    ai: publicConfig(),
    empty: admin.isEmpty(db),
    auth: { enabled: authn.enabled, providers: authn.providers, user: actor.id ? { id: actor.id, name: actor.name, is_admin: actor.is_admin } : null },
    notifications: notificationsFor(db, actor.id),
    ...org.orgSnapshot(db),
  });

  /** Protection contre les requêtes déclenchées depuis un autre site (CSRF) ou par rebinding DNS. */
  const hostOk = h => { h = String(h || '').toLowerCase(); return allowed.has(h) || allowed.has(h.replace(/:\d+$/, '')); };
  const guard = (req, mutating) => {
    const host = String(req.headers.host || '');
    const forwarded = trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
    if (loopbackOnly && !LOOPBACK.has(host.replace(/:\d+$/, '').toLowerCase()) && !hostOk(host) && !(forwarded && hostOk(forwarded)))
      throw new HttpError(`Hôte « ${host} » non autorisé. Derrière un reverse proxy, déclarez son adresse dans ALLOWED_HOSTS (et TRUST_PROXY=1 s'il transmet X-Forwarded-Host).`, 403);
    const origin = req.headers.origin;
    if (!mutating || !origin) return;
    let oh = ''; try { oh = new URL(origin).host; } catch { /* origine illisible */ }
    // Même site : l'origine du navigateur correspond à l'hôte demandé, à l'hôte transmis par le proxy de confiance, ou à un hôte déclaré.
    if (!oh || origin === 'null' || !(oh === host || (forwarded && oh === forwarded) || hostOk(oh)))
      throw new HttpError(`Origine « ${origin} » non autorisée. Si l'outil est servi derrière un reverse proxy, déclarez son adresse dans ALLOWED_HOSTS (ou TRUST_PROXY=1).`, 403);
  };

  /** Fonction de confirmation du chat : re-valide TOUT côté serveur, atomiquement. */
  const confirm = (data, actor) => {
    const list = Array.isArray(data.actions) ? data.actions.slice(0, 10) : [];
    if (!list.length) throw new HttpError('Aucune action à confirmer');
    const batch = randomUUID();
    const results = tx(db, () => list.map(a => {
      if (!a || typeof a !== 'object') throw new HttpError('Action invalide');
      if (a.type === 'create_task') return execute(db, { type: a.type, patch: a.patch, links: a.links }, actor.name, batch);
      if (a.type === 'update_task') return execute(db, { type: a.type, id: a.id, patch: a.patch }, actor.name, batch);
      if (a.type === 'link_tasks') return execute(db, { type: a.type, from_id: a.from_id, to_id: a.to_id, link_type: a.link_type }, actor.name, batch);
      throw new HttpError(`Action inconnue : ${a.type}`);
    }));
    return { batch, results };
  };

  const llmCandidate = data => {
    const cur = llmConfig();
    const baseUrl = String(data.baseUrl || cur.baseUrl).trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(baseUrl)) throw new HttpError('L’URL doit commencer par http:// ou https://');
    // La clé enregistrée n'est JAMAIS envoyée vers une autre URL que celle pour laquelle elle a été saisie.
    const sameBase = baseUrl === cur.baseUrl;
    return {
      enabled: !!data.enabled, baseUrl, model: String(data.model || cur.model).trim(), sttModel: String(data.sttModel || cur.sttModel).trim(),
      key: data.clearKey ? '' : data.key ? String(data.key).trim() : sameBase ? cur.key : '',
    };
  };

  const route = async (req, res, p) => {
    const method = req.method, mutating = method !== 'GET' && method !== 'HEAD';
    guard(req, mutating);
    const actor = actorOf(req);
    const A = actor.name;
    if (method === 'GET' && p === '/api/health') return json(res, { ok: true });
    if (method === 'GET' && p === '/api/auth/me') return json(res, { enabled: authn.enabled, providers: authn.providers, user: actor.id ? { id: actor.id, name: actor.name, is_admin: actor.is_admin } : null });
    if (method === 'POST' && p === '/api/auth/logout') { authn.logout(req); return json(res, { ok: true }, 200, { 'Set-Cookie': authn.clearCookie() }); }
    if (authn.enabled && !actor.authenticated) throw new HttpError('Connexion requise', 401);

    if (method === 'GET' && p === '/api/bootstrap') return json(res, snapshot(actor));
    if (method === 'GET' && p === '/api/activity') {
      const rows = db.prepare(`SELECT a.*, t.title FROM activity a LEFT JOIN tasks t ON t.id = a.task_id ORDER BY a.id DESC LIMIT 80`).all();
      return json(res, rows.map(r => ({ ...r, before: undefined, after: r.after && JSON.parse(r.after) })));
    }
    if (method === 'GET' && p === '/api/export') { needAdmin(actor); return json(res, admin.exportAll(db), 200, { 'Content-Disposition': `attachment; filename="workforce-export-${new Date().toISOString().slice(0, 10)}.json"` }); }
    if (method === 'GET' && p === '/api/llm') return json(res, publicConfig());
    if (method === 'GET' && p === '/api/llm/ping') return json(res, llmConfig().enabled ? await ping() : { mode: 'mock' });
    if (!mutating) return json(res, { error: 'Route inconnue' }, 404);

    if (p === '/api/transcribe') {
      const type = String(req.headers['content-type'] || '');
      if (!type.startsWith('audio/') && !type.startsWith('video/webm')) throw new HttpError('Audio attendu', 415);
      return json(res, { text: await transcribe(await body(req, MAX_AUDIO), type) });
    }
    // Toute autre écriture : JSON uniquement (refuse les requêtes « text/plain » d'un site tiers)
    const raw = await body(req, MAX_JSON);
    if (raw.length && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError('Content-Type application/json requis', 415);
    const data = parseJson(raw);
    let m;
    const row = (sql, ...a) => db.prepare(sql).get(...a);

    if (method === 'POST' && p === '/api/notifications/read') { if (!actor.id) throw new HttpError('Personne non identifiée'); markRead(db, actor.id, data); return json(res, snapshot(actor)); }
    if (method === 'POST' && p === '/api/chat') {
      const message = typeof data.message === 'string' ? data.message.trim() : '';
      if (!message) throw new HttpError('Message vide');
      if (message.length > 4000) throw new HttpError('Message trop long (4 000 caractères maximum)');
      const history = Array.isArray(data.history) ? data.history.filter(h => h && typeof h.content === 'string').slice(-10) : [];
      try { return json(res, await handleChat(db, { message, history, userId: actor.id })); }
      catch (e) { if (e.status) throw e; console.error('chat:', e.message); throw new HttpError(`Le LLM n’a pas pu répondre (${String(e.message).slice(0, 160)}). Vérifiez la configuration via le badge « IA ».`, 502); }
    }
    if (method === 'POST' && p === '/api/chat/confirm') return json(res, { ...confirm(data, actor), ...snapshot(actor) });
    if (method === 'POST' && (m = p.match(/^\/api\/undo\/([\w-]{8,64})$/))) { const r = undoBatch(db, m[1], A); return json(res, { ...r, ...snapshot(actor) }); }
    if (method === 'POST' && (m = p.match(/^\/api\/undo-activity\/(\d+)$/))) { const r = undoActivity(db, m[1], A); return json(res, { ...r, ...snapshot(actor) }); }

    if (method === 'POST' && p === '/api/tasks') { const id = createTask(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/tasks\/(\d+)$/))) {
      if (method === 'PATCH') { updateTask(db, +m[1], data, A); return json(res, snapshot(actor)); }
      if (method === 'DELETE') { const undo_id = deleteTask(db, +m[1], A); return json(res, { undo_id, ...snapshot(actor) }); }
    }
    if (method === 'POST' && p === '/api/links') { addLink(db, data.from_id, data.to_id, data.type || 'relates', A); return json(res, snapshot(actor)); }
    if (method === 'DELETE' && (m = p.match(/^\/api\/links\/(\d+)$/))) { removeLink(db, +m[1], A); return json(res, snapshot(actor)); }

    // ----- Organisation : administrateurs et leads -----
    if (method === 'POST' && p === '/api/squads') { needAdmin(actor); const id = org.createSquad(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/squads\/(\d+)$/))) {
      if (method === 'PATCH') { needLead(actor, +m[1]); if ('lead_id' in data) needAdmin(actor); org.updateSquad(db, m[1], data, A); return json(res, snapshot(actor)); }
      if (method === 'DELETE') { needAdmin(actor); org.deleteSquad(db, m[1], A); return json(res, snapshot(actor)); }
    }
    if (method === 'POST' && p === '/api/members') { needAdmin(actor); const id = admin.createMember(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/members\/(\d+)$/))) {
      if (method === 'PATCH') {
        const target = row('SELECT * FROM members WHERE id = ?', +m[1]);
        if (authn.enabled && !actor.is_admin && target) {
          const self = actor.id === target.id;
          for (const k of Object.keys(data)) {
            if (['name', 'role', 'skills'].includes(k)) { if (!self && !isLeadOf(actor, target.squad_id)) forbid('Vous ne pouvez modifier que votre propre fiche.'); }
            else if (['squad_id', 'loan_squad_id', 'loan_pct'].includes(k)) { if (!isLeadOf(actor, target.squad_id) && !(k === 'squad_id' && data.squad_id && isLeadOf(actor, +data.squad_id))) forbid('Réservé au lead de la squad concernée ou à un administrateur.'); }
            else forbid('Action réservée aux administrateurs.');
          }
        }
        org.updateMember(db, m[1], data, A); return json(res, snapshot(actor));
      }
      if (method === 'DELETE') { needAdmin(actor); admin.deleteMember(db, m[1], A); return json(res, snapshot(actor)); }
    }
    if (method === 'POST' && p === '/api/features') { needLead(actor, +data.squad_id); const id = org.createFeature(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/features\/(\d+)$/))) {
      const f = row('SELECT squad_id FROM features WHERE id = ?', +m[1]);
      if (f) needLead(actor, f.squad_id, 'la squad propriétaire de cette feature');
      if (method === 'PATCH') { if (data.squad_id != null && f && +data.squad_id !== f.squad_id) needLead(actor, +data.squad_id); org.updateFeature(db, m[1], data, A); return json(res, snapshot(actor)); }
      if (method === 'DELETE') { org.deleteFeature(db, m[1], A); return json(res, snapshot(actor)); }
    }
    if (method === 'POST' && p === '/api/feature-deps') { const f = row('SELECT squad_id FROM features WHERE id = ?', +data.from_feature_id); if (f) needLead(actor, f.squad_id, 'la squad qui exprime la dépendance'); org.addFeatureDep(db, data.from_feature_id, data.to_feature_id, data.note, A); return json(res, snapshot(actor)); }
    if (method === 'DELETE' && (m = p.match(/^\/api\/feature-deps\/(\d+)$/))) { const f = row('SELECT f.squad_id FROM feature_deps d JOIN features f ON f.id = d.from_feature_id WHERE d.id = ?', +m[1]); if (f) needLead(actor, f.squad_id, 'la squad qui exprime la dépendance'); org.removeFeatureDep(db, m[1], A); return json(res, snapshot(actor)); }

    // ----- Réglages : administrateurs -----
    if (method === 'POST' && p === '/api/projects') { needAdmin(actor); const id = admin.createProject(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/projects\/(\d+)$/))) {
      needAdmin(actor);
      if (method === 'PATCH') { admin.updateProject(db, m[1], data, A); return json(res, snapshot(actor)); }
      if (method === 'DELETE') { admin.deleteProject(db, m[1], A); return json(res, snapshot(actor)); }
    }
    if (method === 'POST' && p === '/api/teams') { needAdmin(actor); const id = admin.createTeam(db, data, A); return json(res, { id, ...snapshot(actor) }); }
    if ((m = p.match(/^\/api\/teams\/(\d+)$/))) {
      needAdmin(actor);
      if (method === 'PATCH') { admin.updateTeam(db, m[1], data, A); return json(res, snapshot(actor)); }
      if (method === 'DELETE') { admin.deleteTeam(db, m[1], A); return json(res, snapshot(actor)); }
    }
    if (method === 'POST' && p === '/api/demo/load') { needAdmin(actor); admin.loadDemo(db); return json(res, snapshot(actor)); }
    if (method === 'POST' && p === '/api/reset') { needAdmin(actor); const r = admin.resetAll(db, data.confirm, A); return json(res, { ...r, ...snapshot(actor) }); }

    if (method === 'POST' && (p === '/api/llm' || p === '/api/llm/test')) {
      needAdmin(actor);
      const next = llmCandidate(data);
      if (p.endsWith('/test')) return json(res, await testConnection(next));
      saveSetting(db, 'llm', next); setLlmSettings(next);
      return json(res, publicConfig());
    }
    return json(res, { error: 'Route inconnue' }, 404);
  };

  /** Pages de connexion OIDC (navigations du navigateur, pas des appels API). */
  const errorPage = (title, message) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:0 20px"><h2>${title}</h2><p>${String(message).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</p><p><a href="/">Retour à WorkForce</a></p></body>`;
  const page = (res, status, title, message) => send(res, status, { 'Content-Type': 'text/html; charset=utf-8' }, errorPage(title, message));
  const authRoute = async (req, res, p, url) => {
    guard(req, false);
    let m;
    if (!authn.enabled || req.method !== 'GET') return page(res, 404, 'Introuvable', 'La connexion externe n’est pas activée sur ce serveur.');
    if ((m = p.match(/^\/auth\/login\/(\w+)$/))) { const { url: to, state } = await authn.startLogin(m[1]); return send(res, 302, { Location: to, 'Set-Cookie': authn.setFlowCookie(state), 'Cache-Control': 'no-store' }, ''); }
    if ((m = p.match(/^\/auth\/callback\/(\w+)$/))) {
      try {
        const r = await authn.finishLogin(m[1], Object.fromEntries(url.searchParams), authn.flowCookieOf(req));
        if (r.created) notify(db, { to: adminIds(db), kind: 'account', actor: r.member.name, text: `${r.member.name} s’est connecté·e pour la première fois (compte créé automatiquement) : placez-le dans une squad.` });
        return send(res, 302, { Location: '/', 'Set-Cookie': [authn.setCookie(r.token, r.maxAge), authn.clearFlowCookie()], 'Cache-Control': 'no-store' }, '');
      } catch (e) { if (!(e instanceof HttpError)) throw e; return send(res, e.status, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': authn.clearFlowCookie() }, errorPage('Connexion impossible', e.message)); }
    }
    return page(res, 404, 'Introuvable', 'Page inconnue.');
  };

  return async (req, res) => {
    try {
      const p = new URL(req.url, 'http://x').pathname;
      if (p.startsWith('/api/')) return await route(req, res, p);
      if (p.startsWith('/auth/')) return await authRoute(req, res, p, new URL(req.url, 'http://x'));
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { Allow: 'GET, HEAD' }, 'Méthode non autorisée');
      guard(req, false);
      let rel; try { rel = decodeURIComponent(p); } catch { return send(res, 400, {}, 'Requête invalide'); }
      const file = pnorm(join(PUBLIC, rel === '/' ? 'index.html' : rel));
      if (!file.startsWith(PUBLIC)) return send(res, 403, {}, 'Interdit');
      let content;
      try { content = await readFile(file); }                      // lire AVANT d'écrire les en-têtes : un fichier absent n'est qu'un 404
      catch (e) { if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(e.code)) return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Introuvable'); throw e; }
      return send(res, 200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, req.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!e.status || e.status >= 500) console.error(e);
      const known = e instanceof HttpError;
      json(res, { error: known ? e.message : /FOREIGN KEY|constraint/i.test(e.message) ? 'Données invalides ou référence inexistante' : 'Erreur interne du serveur' }, known ? e.status : 500);
    }
  };
}
