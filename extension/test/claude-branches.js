// Regression test: Claude conversations with edited/regenerated branches keep
// only the active branch (current leaf back to the root), in order.
// Usage: bun extension/test/claude-branches.js

import assert from 'node:assert/strict';
import { syncClaude } from '../providers/claude.js';

const now = new Date(Date.now() - 3_600_000).toISOString();
const ROOT = '00000000-0000-4000-8000-000000000000';
const msg = (uuid, parent, sender, text) => ({
  uuid,
  parent_message_uuid: parent,
  sender,
  created_at: now,
  content: [{ type: 'text', text }],
});

const conversations = {
  // Array order interleaves the abandoned branch; the leaf is on the edit.
  branched: {
    current_leaf_message_uuid: 'a2-edit',
    chat_messages: [
      msg('u1', ROOT, 'human', 'first question'),
      msg('a1', 'u1', 'assistant', 'first answer'),
      msg('u2', 'a1', 'human', 'original follow-up'),
      msg('a2', 'u2', 'assistant', 'answer to original'),
      msg('u2-edit', 'a1', 'human', 'edited follow-up'),
      msg('a2-edit', 'u2-edit', 'assistant', 'answer to edit'),
    ],
  },
  // Broken chain (missing parent): fall back to every message in array order.
  broken: {
    current_leaf_message_uuid: 'b2',
    chat_messages: [
      msg('b1', ROOT, 'human', 'kept question'),
      msg('b2', 'missing', 'assistant', 'kept answer'),
    ],
  },
  // No tree fields at all (older responses): array order.
  flat: {
    chat_messages: [
      { sender: 'human', created_at: now, content: [{ type: 'text', text: 'flat question' }] },
      { sender: 'assistant', created_at: now, content: [{ type: 'text', text: 'flat answer' }] },
    ],
  },
};

globalThis.fetch = async url => {
  const { pathname } = new URL(url);
  if (pathname === '/api/organizations') return Response.json([{ uuid: 'org-1', name: 'Personal' }]);
  if (pathname === '/api/organizations/org-1/chat_conversations') {
    return Response.json(Object.keys(conversations).map(uuid => ({ uuid, updated_at: now })));
  }
  const uuid = pathname.match(/chat_conversations\/(.+)$/)?.[1];
  if (uuid && conversations[uuid]) {
    return Response.json({ uuid, name: uuid, created_at: now, updated_at: now, ...conversations[uuid] });
  }
  return new Response('not found', { status: 404 });
};

const pushed = {};
await syncClaude({
  state: {},
  log: () => {},
  push: async (_sourceId, _adapter, convs) => {
    for (const conv of convs) pushed[conv.externalId] = conv;
    return convs.length;
  },
});

const transcript = id => pushed[id].messages.map(message => [message.role, message.content]);

assert.deepEqual(transcript('branched'), [
  ['user', 'first question'],
  ['assistant', 'first answer'],
  ['user', 'edited follow-up'],
  ['assistant', 'answer to edit'],
]);
assert.deepEqual(pushed.branched.metadata, {
  url: 'https://claude.ai/chat/branched',
  orgId: 'org-1',
  currentLeafMessageUuid: 'a2-edit',
  offBranchMessages: 2,
});
console.log('PASS claude keeps only the active branch');

assert.deepEqual(transcript('broken'), [
  ['user', 'kept question'],
  ['assistant', 'kept answer'],
]);
assert.deepEqual(transcript('flat'), [
  ['user', 'flat question'],
  ['assistant', 'flat answer'],
]);
console.log('PASS claude falls back to array order without a usable tree');
