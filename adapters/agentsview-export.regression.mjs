// Verify that web conversations are serialized in the public AgentsView seams.
// Run with: node adapters/agentsview-export.regression.mjs

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function request(adapter, method, params) {
  const result = spawnSync(
    'node',
    ['--experimental-strip-types', '--experimental-transform-types', join(REPO_ROOT, 'adapters', adapter, 'adapter.ts')],
    {
      env: {
        ...process.env,
        HSTRY_REQUEST: JSON.stringify({ method, params }),
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, `${adapter} exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const conversation = {
  externalId: 'web-conversation-1',
  title: 'AgentsView bridge fixture',
  createdAt: Date.parse('2026-09-26T00:00:00.000Z'),
  updatedAt: Date.parse('2026-09-26T00:02:00.000Z'),
  model: 'fixture-model',
  messages: [
    {
      role: 'user',
      content: 'hello from the web',
      createdAt: Date.parse('2026-09-26T00:00:01.000Z'),
    },
    {
      role: 'assistant',
      content: 'hello from the assistant',
      createdAt: Date.parse('2026-09-26T00:00:02.000Z'),
      model: 'fixture-model',
    },
  ],
};

const chatgpt = request('chatgpt-web', 'export', {
  conversations: [conversation],
  opts: { format: 'chatgpt', pretty: true },
});
const chatgptConversation = JSON.parse(chatgpt.content)[0];
assert.equal(chatgptConversation.id, conversation.externalId);
assert.equal(chatgptConversation.mapping['msg-1'].message.author.role, 'user');

const claude = request('claude-web', 'export', {
  conversations: [conversation],
  opts: { format: 'claude-ai', pretty: true },
});
const claudeConversation = JSON.parse(claude.content)[0];
assert.equal(claudeConversation.uuid, conversation.externalId);
assert.match(claudeConversation.created_at, /^2026-09-26T00:00:00\.000Z$/);
assert.equal(claudeConversation.chat_messages[0].sender, 'human');
assert.equal(claudeConversation.chat_messages[1].content[0].text, 'hello from the assistant');

const gemini = request('gemini-cli', 'export', {
  conversations: [conversation],
  opts: { format: 'gemini-cli' },
});
assert.equal(gemini.files[0].path, 'tmp/gemini-web/chats/session-web-conversation-1.jsonl');
const geminiRecords = gemini.files[0].content.trim().split('\n').map(JSON.parse);
assert.equal(geminiRecords[0].kind, 'main');
assert.equal(geminiRecords[0].sessionId, conversation.externalId);
assert.equal(geminiRecords[1].type, 'user');
assert.equal(geminiRecords[2].type, 'gemini');

const grok = request('grok', 'export', {
  conversations: [conversation],
  opts: { format: 'grok' },
});
const grokSummary = grok.files.find(file => file.path.endsWith('/summary.json'));
const grokHistory = grok.files.find(file => file.path.endsWith('/chat_history.jsonl'));
assert.ok(grokSummary);
assert.ok(grokHistory);
assert.match(grokSummary.path, /grok-web\/web-conversation-1\/summary\.json$/);
assert.equal(JSON.parse(grokSummary.content).chat_format_version, 1);
const grokRecords = grokHistory.content.trim().split('\n').map(JSON.parse);
assert.equal(grokRecords[0].type, 'user');
assert.equal(grokRecords[1].type, 'assistant');
assert.equal(grokRecords[1].model_id, 'fixture-model');

console.log('PASS AgentsView export contracts for ChatGPT, Claude, Gemini, and Grok');
