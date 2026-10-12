// Vérifie le chemin "vrai LLM" contre un faux serveur compatible OpenAI (aucune clé réelle nécessaire).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { handleChat } from '../server/agent.js';

const calls = [];
const fake = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ url: req.url, auth: req.headers.authorization, body });
  const reply = m => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: m }] })); };
  if (body.response_format) return reply({ content: JSON.stringify({ links: [{ task_id: 6, type: 'relates', reason: 'Même sujet de sauvegarde' }] }) });
  const last = body.messages.at(-1);
  if (last.role === 'user') return reply({ role: 'assistant', content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ title: 'Tester la restauration des sauvegardes', priority: 'high', assignee: 'Hugo', labels: ['backup'] }) } }] });
  reply({ role: 'assistant', content: 'Je te propose de créer cette tâche pour Hugo.' });
});
await new Promise(r => fake.listen(0, r));
process.env.LLM_BASE_URL = `http://localhost:${fake.address().port}/v1`;
process.env.LLM_API_KEY = 'sk-test';
test.after(() => fake.close());

test('boucle function-calling OpenAI : outils, résolution des noms, jugement JSON', async () => {
  const db = openDb(':memory:'); seed(db);
  const r = await handleChat(db, { message: 'Il faudrait tester la restauration des sauvegardes, Hugo peut le faire', userId: 1 });
  assert.equal(r.reply, 'Je te propose de créer cette tâche pour Hugo.');
  assert.equal(r.actions.length, 1);
  const a = r.actions[0];
  assert.equal(a.patch.assignee_id, db.prepare("SELECT id FROM members WHERE name LIKE 'Hugo%'").get().id);
  assert.equal(a.patch.team_id, db.prepare("SELECT id FROM teams WHERE name = 'Infra'").get().id, 'équipe déduite de l\'assigné');
  assert.equal(a.links[0].task_id, 6);
  assert.equal(calls[0].url, '/v1/chat/completions');
  assert.equal(calls[0].auth, 'Bearer sk-test');
  assert.ok(calls[0].body.tools.some(t => t.function.name === 'create_task'));
  assert.match(calls[0].body.messages[0].content, /Date du jour/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 14, 'rien d\'écrit avant confirmation');
});
