// Client LLM compatible OpenAI (chat completions + function calling) et analyseur local "mock".
import { mockChat, mockJudge } from './mock.js';

// Réglages enregistrés depuis l'interface (prioritaires sur .env).
let saved = {};
export const setLlmSettings = s => { saved = s || {}; };

export function llmConfig() {
  const e = process.env;
  const key = saved.key ?? e.LLM_API_KEY ?? '';
  const enabled = saved.enabled ?? Boolean(e.LLM_API_KEY);
  return {
    enabled, provider: enabled ? 'openai' : 'mock', key,
    baseUrl: (saved.baseUrl || e.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: saved.model || e.LLM_MODEL || 'gpt-4o-mini',
    sttModel: saved.sttModel || e.STT_MODEL || 'whisper-1',
  };
}

/** Vue publique de la config : la clé ne sort jamais du serveur. */
export function publicConfig() {
  const { key, ...c } = llmConfig();
  return { ...c, hasKey: Boolean(key), keyHint: key ? key.slice(-4) : '' };
}

async function post(path, body, isForm = false, c = llmConfig()) {
  const res = await fetch(`${c.baseUrl}${path}`, {
    method: 'POST',
    headers: { ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}), ...(isForm ? {} : { 'Content-Type': 'application/json' }) },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const explain = status => status === 401 || status === 403 ? 'Clé API refusée' : status === 404 ? 'Modèle ou URL introuvable' : status === 429 ? 'Quota ou limite de débit atteint' : `Erreur HTTP ${status}`;

/** Test complet : une vraie requête de complétion (valide URL, clé ET modèle). */
export async function testConnection(c) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${c.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}) },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'Réponds uniquement : ok' }] }),
    });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, ms, error: `${explain(res.status)} — ${(await res.text()).slice(0, 100)}` };
    const data = await res.json();
    return { ok: true, ms, model: data.model || c.model, reply: data.choices?.[0]?.message?.content?.trim().slice(0, 40) };
  } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: e.name === 'TimeoutError' ? 'Délai dépassé (20 s)' : `Connexion impossible : ${e.cause?.code || e.message}` }; }
}

/** Ping léger et gratuit (GET /models) pour surveiller la latence ; aucun jeton consommé. */
export async function ping(c = llmConfig()) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${c.baseUrl}/models`, { headers: c.key ? { Authorization: `Bearer ${c.key}` } : {}, signal: AbortSignal.timeout(10_000) });
    const ms = Math.round(performance.now() - t0);
    if (res.status === 401 || res.status === 403) return { ok: false, ms, error: explain(res.status) };
    if (res.status >= 500) return { ok: false, ms, error: explain(res.status) };
    return { ok: true, ms };   // 404 sur /models = serveur joignable (certains fournisseurs ne l'exposent pas)
  } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: e.name === 'TimeoutError' ? 'Délai dépassé (10 s)' : `Injoignable : ${e.cause?.code || e.message}` }; }
}

/** Un tour de conversation avec outils. Retourne le message assistant ({content, tool_calls}). */
export async function chat({ messages, tools, hint }) {
  if (llmConfig().provider === 'mock') return mockChat({ messages, tools, hint });
  const data = await post('/chat/completions', { model: llmConfig().model, messages, tools, tool_choice: 'auto' });
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('Réponse vide du fournisseur LLM');
  return msg;
}

/** Demande une réponse JSON (jugement de liens entre tâches). */
export async function judge({ system, payload, hint }) {
  if (llmConfig().provider === 'mock') return mockJudge(payload, hint);
  const data = await post('/chat/completions', {
    model: llmConfig().model, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(payload) }],
  });
  try { const v = JSON.parse(data.choices?.[0]?.message?.content); return v && typeof v === 'object' ? v : { links: [] }; } catch { return { links: [] }; }
}

/** Transcription audio (repli quand le navigateur n'a pas de reconnaissance vocale native). */
export async function transcribe(buffer, mime = 'audio/webm') {
  if (llmConfig().provider === 'mock') throw new Error('Transcription indisponible en mode mock (aucune clé LLM configurée)');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), `voice.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
  form.append('model', llmConfig().sttModel);
  form.append('language', 'fr');
  return (await post('/audio/transcriptions', form, true)).text;
}
