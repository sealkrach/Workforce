// Intégration SmartUC (registre des use cases IA) : client MCP en lecture, cache local, liens feature ↔ UC, planification.
// SmartUC reste la source de vérité des use cases et de la gouvernance ; WorkForce porte la livraison.
// v1 : lecture seule (aucune écriture vers SmartUC). Synchronisation par interrogation (SmartUC n'émet pas de webhook).
import { loadSetting, saveSetting, logActivity } from './db.js';
import { McpClient } from './mcp-client.js';
import { HttpError, now } from './util.js';
import { notify, leadOf, adminIds } from './notify.js';
import { createFeature } from './squads.js';
import { createTask, tx } from './actions.js';
import { arr, parseUc, featureDraft, playbook, suggestSquads } from './uc-plan.js';

export const REF = /^UC-\d{1,6}$/;
export const normRef = s => String(s ?? '').trim().toUpperCase();
const cut = (v, n) => (v == null ? v : String(v).slice(0, n));
const row = (db, sql, ...p) => db.prepare(sql).get(...p);
const trimSlash = s => String(s || '').replace(/\/+$/, '');

/* ---------- Configuration (clé côté serveur uniquement) ---------- */
export function smartucConfig(db, env = process.env) {
  const saved = loadSetting(db, 'smartuc') || {};
  const url = trimSlash(saved.url ?? env.SMARTUC_MCP_URL ?? '');
  const key = saved.key ?? env.SMARTUC_API_KEY ?? '';
  let publicUrl = trimSlash(saved.publicUrl ?? env.SMARTUC_PUBLIC_URL ?? '');
  if (!publicUrl && url) { try { publicUrl = new URL(url).origin; } catch { /* URL invalide : pas de lien profond */ } }
  const poll = Number(saved.pollMinutes ?? env.SMARTUC_POLL_MINUTES ?? 5);
  return { enabled: saved.enabled ?? Boolean(url && key), url, key, publicUrl, pollMinutes: Math.min(120, Math.max(1, Number.isFinite(poll) ? poll : 5)) };
}

export function createSmartuc(db, { clientFactory = cfg => new McpClient({ url: cfg.url, key: cfg.key }), fetchImpl = globalThis.fetch, env = process.env } = {}) {
  let running = false, timer = null, lastManual = 0;
  const cfg = () => smartucConfig(db, env);
  const state = () => loadSetting(db, 'smartuc_state') || { ok: null, last_sync_at: null, error: null, latency_ms: null };
  const setState = patch => saveSetting(db, 'smartuc_state', { ...state(), ...patch });

  const publicConfig = () => {
    const c = cfg();
    return { enabled: c.enabled, url: c.url, publicUrl: c.publicUrl, pollMinutes: c.pollMinutes, hasKey: Boolean(c.key), keyHint: c.key ? c.key.slice(-4) : '', state: state() };
  };

  /** Candidat de configuration : la clé enregistrée n'est JAMAIS envoyée vers une autre URL que celle pour laquelle elle a été saisie. */
  function candidate(d = {}) {
    const cur = cfg();
    const url = trimSlash(String(d.url ?? cur.url).trim());
    if (!/^https?:\/\//.test(url)) throw new HttpError('L’URL MCP doit commencer par http:// ou https:// (ex. https://smartuc.entreprise.fr/mcp)');
    const same = url === cur.url;
    const poll = Number(d.pollMinutes ?? cur.pollMinutes);
    return { enabled: !!d.enabled, url, publicUrl: trimSlash(String(d.publicUrl ?? cur.publicUrl).trim()), pollMinutes: Math.min(120, Math.max(1, Number.isFinite(poll) ? poll : 5)),
      key: d.clearKey ? '' : d.key ? String(d.key).trim() : same ? cur.key : '' };
  }
  const save = d => { const c = candidate(d); saveSetting(db, 'smartuc', c); restart(); return publicConfig(); };

  /** Test complet : connexion, outils requis, lecture du registre, rôle du compte (un « requester » ne verrait que ses propres UC). */
  async function test(d) {
    const c = candidate(d), warnings = [], t0 = performance.now();
    if (!c.key) return { ok: false, error: 'Aucune clé d’API : créez-en une dans SmartUC (page « MCP & API »).' };
    const client = clientFactory(c);
    try {
      const server = await client.connect();
      const tools = (await client.listTools()).map(t => t.name);
      const missing = ['list_use_cases', 'get_use_case', 'list_relations'].filter(n => !tools.includes(n));
      if (missing.length) return { ok: false, error: `Ce serveur MCP n’expose pas les outils attendus : ${missing.join(', ')}. Est-ce bien SmartUC ?` };
      const rows = await client.callTool('list_use_cases', { limit: 500 });
      const ms = Math.round(performance.now() - t0);
      let role = null, user = null;
      try {   // même origine que /mcp : l'API REST de SmartUC indique le rôle de la clé
        const r = await fetchImpl(`${new URL(c.url).origin}/api/auth/me`, { headers: { Authorization: `Bearer ${c.key}` }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        if (r.ok) { const me = await r.json(); role = me.role; user = me.full_name || me.email; }
      } catch { /* rôle inconnu : on n'en fait pas une erreur */ }
      if (role === 'requester') warnings.push('Ce compte a le rôle « requester » : il ne voit que ses propres UC. Utilisez un compte « reviewer » ou « admin » pour synchroniser tout le portefeuille.');
      if (rows.length === 0) warnings.push('Le registre est vide ou ce compte ne voit aucun UC.');
      return { ok: true, ms, server: server?.name, tools: tools.length, uc_count: rows.length, role, user, warnings };
    } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: e.message }; }
    finally { await client.close().catch(() => {}); }
  }

  /* ---------- Synchronisation ---------- */
  const linkedRefs = () => new Set(db.prepare('SELECT DISTINCT uc_ref FROM feature_ucs').all().map(r => r.uc_ref));

  function detail(u, rels) {
    const f = u.fields || {};
    const links = [], entities = new Set();
    for (const r of Array.isArray(rels) ? rels : []) {
      if (r.type === 'shares_entity') { if (r.entity?.name) entities.add(r.entity.name); continue; }
      const outgoing = r.source_ref === u.ref;
      links.push({ type: r.type, direction: outgoing ? 'out' : 'in', other: outgoing ? r.target_ref : r.source_ref, explanation: cut(r.explanation, 200) });
    }
    return {
      data: {
        summary: cut(u.summary, 600), owner: u.owner ? { name: u.owner.full_name, email: u.owner.email } : null,
        sponsor: cut(f.sponsor, 120), product_owner: cut(f.product_owner, 120), target_date: cut(f.target_date, 10), estimated_effort: cut(f.estimated_effort, 4),
        build_approach: cut(f.build_approach, 40), ai_capability: cut(f.ai_capability || u.ai_capability, 40), human_in_the_loop: cut(f.human_in_the_loop, 40),
        data_sensitivity: cut(f.data_sensitivity, 40), eu_ai_act_tier: cut(f.eu_ai_act_tier, 40), problem_statement: cut(f.problem_statement, 500),
        kpis: arr(f.kpis).slice(0, 8).map(x => cut(x, 160)), mitigations: arr(f.mitigations).slice(0, 8).map(x => cut(x, 160)),
        data_sources: arr(f.data_sources).slice(0, 10).map(x => cut(x, 120)), source_systems: arr(f.source_systems).slice(0, 10).map(x => cut(x, 80)),
        target_systems: arr(f.target_systems).slice(0, 10).map(x => cut(x, 80)), teams_involved: arr(f.teams_involved).slice(0, 10).map(x => cut(x, 80)),
        allowed_transitions: (u.allowed_transitions || []).map(t => t.to),
      },
      relations: { links: links.slice(0, 30), entities: [...entities].slice(0, 12) },
    };
  }

  /** Tuples (squads propriétaires, features) concernés par un UC lié : pour savoir qui prévenir. */
  const stakeholders = ref => {
    const fs = db.prepare('SELECT f.id, f.name, f.squad_id FROM feature_ucs fu JOIN features f ON f.id = fu.feature_id WHERE fu.uc_ref = ?').all(ref);
    return { features: fs, leads: [...new Set(fs.map(f => leadOf(db, f.squad_id)).filter(Boolean))] };
  };

  function events(before, after, firstSync) {
    if (firstSync) return;                                                   // premier import : pas de déluge de notifications
    const ref = after.ref, who = stakeholders(ref), label = `${ref} « ${cut(after.title, 60)} »`;
    const at = who.features[0]?.id ?? null;
    if (before && before.status !== after.status)
      notify(db, { to: [...who.leads, ...(['rejected', 'retired'].includes(after.status) && who.leads.length ? adminIds(db) : [])], kind: 'uc', feature_id: at, actor: 'SmartUC',
        text: `L’UC ${label} est passé de « ${before.status} » à « ${after.status} » dans SmartUC${who.features.length ? ` (feature${who.features.length > 1 ? 's' : ''} ${who.features.map(f => `« ${f.name} »`).join(', ')})` : ''}` });
    if (before && !before.risk_tier && after.risk_tier && who.leads.length)
      notify(db, { to: who.leads, kind: 'uc', feature_id: at, actor: 'SmartUC', text: `Le tier de risque de l’UC ${label} a été validé : ${after.risk_tier}` });
    if (after.status === 'approved' && (!before || before.status !== 'approved') && !who.features.length)
      notify(db, { to: [...adminIds(db), ...db.prepare('SELECT lead_id FROM squads WHERE lead_id IS NOT NULL').all().map(r => r.lead_id)], kind: 'uc', actor: 'SmartUC', text: `Nouvel UC approuvé, prêt à planifier : ${label}` });
  }

  function relationEvents(ref, beforeRel, afterRel, firstSync) {
    if (firstSync || !beforeRel) return;
    const key = l => `${l.type}|${l.direction}|${l.other}`, had = new Set(beforeRel.links.map(key));
    const fresh = afterRel.links.filter(l => !had.has(key(l)));
    const who = stakeholders(ref);
    for (const l of fresh) notify(db, { to: who.leads, kind: 'uc', feature_id: who.features[0]?.id ?? null, actor: 'SmartUC', text: `Nouvelle relation confirmée dans SmartUC : ${ref} ${l.direction === 'out' ? '→' : '←'} ${l.other} (${l.type})` });
  }

  async function sync({ manual = false } = {}) {
    const c = cfg();
    if (!c.enabled || !c.url || !c.key) return { skipped: 'disabled' };
    if (running) return { skipped: 'busy' };
    if (manual) { if (Date.now() - lastManual < 5000) return { skipped: 'throttled' }; lastManual = Date.now(); }
    running = true;
    const t0 = performance.now(), client = clientFactory(c);
    let partial = 0;
    try {
      await client.connect();
      const rows = await client.callTool('list_use_cases', { limit: 500 });
      if (!Array.isArray(rows)) throw new Error('Réponse inattendue de list_use_cases');
      const latency = Math.round(performance.now() - t0);
      const cached = new Map(db.prepare('SELECT * FROM uc_cache').all().map(r => [r.ref, r]));
      const firstSync = cached.size === 0;
      const linked = linkedRefs();
      for (const r of rows) {
        if (!REF.test(normRef(r.ref))) continue;
        const ref = normRef(r.ref), old = cached.get(ref);
        const watch = linked.has(ref) || ['approved', 'in_build'].includes(r.status);
        const changed = !old || old.uc_updated_at !== r.updated_at || old.status !== r.status || old.deleted;
        let d = null;
        if (watch && (changed || !old.data)) {
          try {
            const full = await client.callTool('get_use_case', { ref });
            const rels = await client.callTool('list_relations', { ref, status: 'confirmed', include_structural: true, limit: 100 });
            d = detail(full, rels);
          } catch (e) { partial++; if (e.code === 'auth' || e.code === 'network') throw e; }   // un UC en échec n'arrête pas la synchronisation
        }
        const data = d ? JSON.stringify(d.data) : old?.data ?? null, relations = d ? JSON.stringify(d.relations) : old?.relations ?? null;
        db.prepare(`INSERT INTO uc_cache(ref, uc_id, title, status, business_unit, risk_tier, ai_capability, value_score, feasibility_score, priority_score, completeness, suggested_relations, uc_updated_at, data, relations, ignored, deleted, synced_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
          ON CONFLICT(ref) DO UPDATE SET uc_id=excluded.uc_id, title=excluded.title, status=excluded.status, business_unit=excluded.business_unit, risk_tier=excluded.risk_tier, ai_capability=excluded.ai_capability,
            value_score=excluded.value_score, feasibility_score=excluded.feasibility_score, priority_score=excluded.priority_score, completeness=excluded.completeness, suggested_relations=excluded.suggested_relations,
            uc_updated_at=excluded.uc_updated_at, data=excluded.data, relations=excluded.relations, deleted=0, synced_at=excluded.synced_at`)
          .run(ref, r.id, cut(r.title, 200), r.status, cut(r.business_unit, 120), r.risk_tier ?? null, r.ai_capability ?? null, r.value_score ?? null, r.feasibility_score ?? null, r.priority_score ?? null,
            r.completeness ?? null, r.suggested_relations ?? 0, r.updated_at, data, relations, old?.ignored ?? 0, now());
        const after = { ref, title: r.title, status: r.status, risk_tier: r.risk_tier ?? null };
        if (old || !firstSync) events(old ? { status: old.status, risk_tier: old.risk_tier } : null, after, firstSync);
        if (d && old?.relations) relationEvents(ref, JSON.parse(old.relations), d.relations, firstSync);
      }
      // UC disparus du registre : marqués « supprimés » (jamais effacés, un lien peut encore y pointer). Liste vide = suspect (droits ?) : on ne touche à rien.
      if (rows.length) {
        const seen = new Set(rows.map(r => normRef(r.ref)));
        for (const ref of cached.keys()) if (!seen.has(ref)) db.prepare('UPDATE uc_cache SET deleted = 1 WHERE ref = ?').run(ref);
      }
      setState({ ok: true, error: null, last_sync_at: now(), latency_ms: latency, uc_count: rows.length, partial });
      return { ok: true, uc_count: rows.length, partial, ms: latency };
    } catch (e) {
      setState({ ok: false, error: e.message, last_attempt_at: now() });
      return { ok: false, error: e.message };
    } finally { running = false; await client.close().catch(() => {}); }
  }

  /** Interrogation périodique (SmartUC n'a pas de webhook). La fréquence est relue à chaque tour : un changement de réglage s'applique sans redémarrage. */
  function start() {
    stop();
    const tick = async () => { await sync().catch(() => {}); timer = setTimeout(tick, cfg().pollMinutes * 60_000); timer.unref?.(); };
    timer = setTimeout(tick, 3000); timer.unref?.();
  }
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  const restart = () => { if (timer) start(); };

  /* ---------- Liens, ignorés, planification ---------- */
  const cacheRow = ref => parseUc(row(db, 'SELECT * FROM uc_cache WHERE ref = ?', normRef(ref)));
  const needUc = ref => { const r = REF.test(normRef(ref)) ? cacheRow(ref) : null; if (!r) throw new HttpError(`UC « ${ref} » introuvable dans le cache SmartUC : lancez une synchronisation.`, 404); return r; };

  function link(featureId, ref, actor) {
    const uc = needUc(ref), f = row(db, 'SELECT id, name FROM features WHERE id = ?', +featureId);
    if (!f) throw new HttpError('Feature introuvable', 404);
    const r = db.prepare('INSERT OR IGNORE INTO feature_ucs(feature_id, uc_ref, created_at) VALUES (?,?,?)').run(f.id, uc.ref, now());
    if (r.changes) logActivity(db, { actor, action: 'uc_link', after: { name: `${f.name} ↔ ${uc.ref}` } });
    if (!uc.data?.summary && cfg().enabled) { /* détails récupérés à la prochaine synchronisation */ }
    return uc.ref;
  }
  function unlink(featureId, ref, actor) {
    const f = row(db, 'SELECT name FROM features WHERE id = ?', +featureId);
    const r = db.prepare('DELETE FROM feature_ucs WHERE feature_id = ? AND uc_ref = ?').run(+featureId, normRef(ref));
    if (r.changes) logActivity(db, { actor, action: 'uc_unlink', after: { name: `${f?.name ?? featureId} ✕ ${normRef(ref)}` } });
  }
  const ignore = (ref, on = true) => { needUc(ref); db.prepare('UPDATE uc_cache SET ignored = ? WHERE ref = ?').run(on ? 1 : 0, normRef(ref)); };

  /** Aperçu de planification : brouillon de feature, squad suggérée (avec ses raisons) et paquet de tâches. */
  function plan(ref) {
    const uc = needUc(ref);
    const squads = suggestSquads(db, uc);
    // Clés volontairement distinctes de celles de l'instantané (tasks, squads…) pour ne jamais être confondues avec lui
    return { ref: uc.ref, title: uc.title, uc_status: uc.status, draft: featureDraft(uc), ranking: squads, suggested_squad_id: squads[0]?.score > 0 ? squads[0].squad_id : null, playbook: playbook(uc), has_details: !!uc.data?.summary };
  }

  function createFeatureFromUc(ref, input, actor) {
    const uc = needUc(ref);
    if (uc.deleted) throw new HttpError('Cet UC n’existe plus dans SmartUC.', 409);
    const draft = featureDraft(uc);
    return tx(db, () => {
      const featureId = createFeature(db, { name: input.name ?? draft.name, outcome: input.outcome ?? draft.outcome, squad_id: input.squad_id, status: input.status ?? draft.status,
        target_date: 'target_date' in input ? input.target_date : draft.target_date, project_id: input.project_id ?? null }, actor);
      link(featureId, uc.ref, actor);
      let created = 0;
      for (const t of (Array.isArray(input.tasks) ? input.tasks : []).slice(0, 30)) {
        createTask(db, { title: t.title, description: String(t.description ?? '').slice(0, 2000), estimate_h: t.estimate_h, priority: t.priority || 'medium', labels: Array.isArray(t.labels) ? t.labels : [], feature_id: featureId }, actor);
        created++;
      }
      return { feature_id: featureId, tasks_created: created };      // pas « tasks » : la réponse HTTP porte aussi la liste complète des tâches
    });
  }

  /** Part de l'instantané envoyé à l'interface. */
  function snapshot() {
    const c = cfg(), s = state();
    const ucs = db.prepare('SELECT * FROM uc_cache ORDER BY ref').all().map(r => ({
      ref: r.ref, title: r.title, status: r.status, business_unit: r.business_unit, risk_tier: r.risk_tier, ai_capability: r.ai_capability,
      value_score: r.value_score, feasibility_score: r.feasibility_score, priority_score: r.priority_score, completeness: r.completeness,
      updated_at: r.uc_updated_at, ignored: !!r.ignored, deleted: !!r.deleted, data: r.data ? JSON.parse(r.data) : null, relations: r.relations ? JSON.parse(r.relations) : null }));
    return {
      smartuc: { enabled: c.enabled, configured: Boolean(c.url && c.key), publicUrl: c.publicUrl, pollMinutes: c.pollMinutes, ok: s.ok, error: s.error, last_sync_at: s.last_sync_at, latency_ms: s.latency_ms, uc_count: s.uc_count ?? ucs.length },
      ucs, uc_links: db.prepare('SELECT feature_id, uc_ref FROM feature_ucs').all(),
    };
  }

  return { publicConfig, save, test, sync, start, stop, link, unlink, ignore, plan, createFeatureFromUc, snapshot, config: cfg };
}
