// Client MCP (Model Context Protocol) minimal, sans dépendance : transport « Streamable HTTP », JSON-RPC 2.0.
// Gère la session (en-tête Mcp-Session-Id), les réponses JSON ou SSE, l'expiration de session (reconnexion unique),
// les erreurs d'outil (isError) et les délais. La clé d'API ne suit jamais une redirection vers une autre adresse.
import { HttpError } from './util.js';

const PROTOCOL = '2025-06-18';

export class McpError extends Error { constructor(message, { status = 502, code = 'mcp' } = {}) { super(message); this.status = status; this.code = code; } }
export class McpAuthError extends McpError { constructor(m = 'Clé d’API refusée par le serveur MCP') { super(m, { status: 401, code: 'auth' }); } }
/** Échec « métier » renvoyé par un outil (équivalent d'un 404/403 côté application distante). */
export class McpToolError extends McpError { constructor(message) { super(message, { status: 422, code: 'tool' }); } }

export class McpClient {
  constructor({ url, key = '', timeoutMs = 15_000, fetchImpl = globalThis.fetch, clientInfo = { name: 'workforce', version: '1.0' } }) {
    if (!/^https?:\/\//.test(url || '')) throw new McpError('URL MCP invalide : elle doit commencer par http:// ou https://', { status: 400, code: 'config' });
    Object.assign(this, { url, key, timeoutMs, fetchImpl, clientInfo, sessionId: null, nextId: 1, server: null });
  }

  #headers(extra = {}) {
    return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL,
      ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}), ...extra };
  }

  async #post(body) {
    let res;
    try {
      res = await this.fetchImpl(this.url, { method: 'POST', headers: this.#headers(), body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new McpError(e.name === 'TimeoutError' ? `Délai dépassé (${Math.round(this.timeoutMs / 1000)} s) en contactant le serveur MCP` : `Serveur MCP injoignable (${e.cause?.code || e.message})`, { status: 504, code: 'network' });
    }
    // Une redirection enverrait la clé ailleurs : on refuse et on demande l'adresse définitive.
    if (res.status >= 300 && res.status < 400) throw new McpError(`Le serveur MCP redirige vers ${res.headers.get('location') || 'une autre adresse'} : utilisez directement l’adresse finale.`, { status: 502, code: 'redirect' });
    if (res.status === 401 || res.status === 403) throw new McpAuthError(res.status === 403 ? 'Accès refusé par le serveur MCP (droits insuffisants)' : undefined);
    return res;
  }

  /** Lit une réponse JSON-RPC, qu'elle soit en JSON simple ou en flux SSE (on retient le message portant notre id). */
  async #read(res, id) {
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    let msg;
    if (type.includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === id) { msg = m; break; } } catch { /* évènement non JSON */ }
      }
    } else { try { msg = JSON.parse(text); } catch { /* traité ci-dessous */ } }
    if (!msg) throw new McpError(`Réponse MCP illisible (HTTP ${res.status})`);
    if (msg.error) throw new McpError(`Erreur MCP ${msg.error.code} : ${msg.error.message}`, { status: 502, code: 'rpc' });
    return msg.result;
  }

  async connect() {
    this.sessionId = null;
    const id = this.nextId++;
    const res = await this.#post({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: this.clientInfo } });
    if (!res.ok) throw new McpError(`Initialisation MCP refusée (HTTP ${res.status})`);
    this.sessionId = res.headers.get('mcp-session-id');
    this.server = (await this.#read(res, id))?.serverInfo || null;
    const note = await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await note.arrayBuffer().catch(() => {});
    return this.server;
  }

  async #request(method, params, retried = false) {
    if (!this.server) await this.connect();
    const id = this.nextId++;
    const res = await this.#post({ jsonrpc: '2.0', id, method, params });
    if (res.status === 404 && this.sessionId && !retried) { this.server = null; await this.connect(); return this.#request(method, params, true); }   // session expirée côté serveur
    if (!res.ok) throw new McpError(`Le serveur MCP a répondu HTTP ${res.status}`);
    return this.#read(res, id);
  }

  async listTools() { return (await this.#request('tools/list', {}))?.tools || []; }

  /** Appelle un outil ; retourne le JSON contenu dans la réponse texte (ou le texte brut s'il n'est pas du JSON). */
  async callTool(name, args = {}) {
    const result = await this.#request('tools/call', { name, arguments: args });
    const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result?.isError) throw new McpToolError(text || `L’outil ${name} a échoué`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async close() {
    if (!this.sessionId) return;
    try { await this.fetchImpl(this.url, { method: 'DELETE', headers: this.#headers(), redirect: 'manual', signal: AbortSignal.timeout(3000) }); } catch { /* fermeture au mieux */ }
    this.sessionId = null; this.server = null;
  }
}

export { HttpError };
