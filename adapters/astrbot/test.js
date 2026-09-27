import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';

const root = await mkdtemp(join(tmpdir(), 'chronicle-astrbot-'));
const dbPath = join(root, 'data_v4.db');
const adapterPath = fileURLToPath(new URL('./adapter.ts', import.meta.url));

function request(method, path, opts = {}) {
  const result = Bun.spawnSync(['bun', 'run', adapterPath], {
    env: {
      ...process.env,
      HSTRY_REQUEST: JSON.stringify({ method, params: { path, opts } }),
    },
  });
  if (!result.success) {
    throw new Error(`adapter failed: ${result.stderr.toString()}`);
  }
  const response = JSON.parse(result.stdout.toString());
  if (response?.error) throw new Error(response.error);
  return response;
}

try {
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE conversations (
      inner_conversation_id INTEGER PRIMARY KEY,
      conversation_id TEXT UNIQUE NOT NULL,
      platform_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT,
      title TEXT,
      persona_id TEXT,
      token_usage INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE platform_message_history (
      id INTEGER PRIMARY KEY,
      platform_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      llm_checkpoint_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE webchat_threads (
      id INTEGER PRIMARY KEY,
      thread_id TEXT UNIQUE NOT NULL,
      creator TEXT NOT NULL,
      parent_session_id TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL,
      base_checkpoint_id TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(
    `INSERT INTO conversations
      (conversation_id, platform_id, user_id, content, title, persona_id, token_usage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'conv-qq-1',
      'aiocqhttp',
      'qq:FriendMessage:42',
      JSON.stringify([
        { role: 'system', content: 'persona prompt' },
        { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:01Z' },
        { role: 'assistant', content: '你好，我是 AstrBot。', model: 'test-model', timestamp: '2026-01-01T00:00:02Z' },
        { role: '_checkpoint', content: 'checkpoint marker' },
      ]),
      'QQ greeting',
      'persona-main',
      12,
      '2026-01-01 00:00:00.000000',
      '2026-01-01 00:00:03.000000',
    ],
  );

  db.run(
    `INSERT INTO platform_message_history
      (id, platform_id, user_id, sender_id, sender_name, content, llm_checkpoint_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      'gewechat',
      'wechat:FriendMessage:7',
      'wx-user-7',
      'Andrew',
      JSON.stringify({ type: 'user', message: [{ type: 'plain', text: '微信你好' }] }),
      null,
      '2026-01-03T00:00:00Z',
      '2026-01-03T00:00:00Z',
    ],
  );
  db.run(
    `INSERT INTO platform_message_history
      (id, platform_id, user_id, sender_id, sender_name, content, llm_checkpoint_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      2,
      'gewechat',
      'wechat:FriendMessage:7',
      'astrbot',
      'AstrBot',
      JSON.stringify({ type: 'bot', message: [{ type: 'plain', text: '你好，微信会话已保留。' }] }),
      'checkpoint-1',
      '2026-01-03T00:00:01Z',
      '2026-01-03T00:00:01Z',
    ],
  );

  db.run(
    `INSERT INTO webchat_threads
      (id, thread_id, creator, parent_session_id, parent_message_id, base_checkpoint_id, selected_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      'thread-1',
      'Andrew',
      'webchat-session-1',
      10,
      'checkpoint-web-1',
      '这段 WebChat 选中的上下文',
      '2026-01-04T00:00:00Z',
      '2026-01-04T00:00:00Z',
    ],
  );
  db.close();

  const info = request('info', dbPath);
  assert.equal(info.name, 'astrbot');
  assert.deepEqual(request('detect', dbPath), 0.98);
  assert.deepEqual(request('detect', root), 0.98);
  assert.equal(request('detect', join(root, 'not-astrbot.db')), null);

  const conversations = request('parse', dbPath);
  assert.equal(conversations.length, 3);

  const structured = conversations.find(item => item.externalId === 'conv-qq-1');
  assert.ok(structured);
  assert.equal(structured.metadata.platform, 'qq');
  assert.equal(structured.metadata.personaId, 'persona-main');
  assert.equal(structured.messages[0].role, 'system');
  assert.equal(structured.messages[0].createdAt, undefined);
  assert.equal(structured.messages[1].createdAt, Date.parse('2026-01-01T00:00:01Z'));
  assert.equal(structured.messages[2].model, 'test-model');
  assert.equal(structured.messages[3].role, 'system');
  assert.equal(structured.messages[3].metadata.sourceRole, '_checkpoint');
  assert.equal(structured.createdAt, Date.parse('2026-01-01T00:00:00Z'));

  const wechat = conversations.find(item => item.metadata?.sourceTable === 'platform_message_history');
  assert.ok(wechat);
  assert.equal(wechat.metadata.platform, 'wechat');
  assert.deepEqual(wechat.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(wechat.messages[0].metadata.senderName, 'Andrew');
  assert.equal(wechat.messages[1].metadata.llmCheckpointId, 'checkpoint-1');

  const thread = conversations.find(item => item.externalId === 'webchat-thread:thread-1');
  assert.ok(thread);
  assert.equal(thread.metadata.platform, 'webui');
  assert.equal(thread.messages[0].content, '这段 WebChat 选中的上下文');

  const since = request('parse', dbPath, { since: Date.parse('2026-01-03T00:00:00Z') });
  assert.deepEqual(
    since.map(item => item.externalId).sort(),
    ['platform-session:gewechat:wechat:FriendMessage:7', 'webchat-thread:thread-1'].sort(),
  );

  const firstBatch = request('parseStream', dbPath, { batchSize: 1 });
  assert.equal(firstBatch.conversations.length, 1);
  assert.equal(firstBatch.done, false);
  const secondBatch = request('parseStream', dbPath, {
    batchSize: 10,
    cursor: firstBatch.cursor,
  });
  assert.equal(secondBatch.done, true);
  assert.equal(firstBatch.conversations.length + secondBatch.conversations.length, conversations.length);

  console.log('astrbot adapter fixture passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
