// Regression test: Gemini keeps per-turn timestamps, prefers the selected
// draft, and retries rate limits; Perplexity pages through long threads.
// Usage: bun extension/test/gemini-perplexity-robustness.js

import assert from 'node:assert/strict';
import { syncGemini } from '../providers/gemini.js';
import { syncPerplexity } from '../providers/perplexity.js';

function rpc(rpcId, data) {
  return `)]}'\n${JSON.stringify([['wrb.fr', rpcId, JSON.stringify(data), null]])}\n`;
}

async function capture(sync) {
  const pushed = [];
  const result = await sync({
    state: {},
    log: () => {},
    push: async (_source, _adapter, conversations) => {
      pushed.push(...conversations);
      return conversations.length;
    },
  });
  return { result, pushed };
}

// --- Gemini ---
const listSec = Math.floor(Date.now() / 1000) - 3600;
const firstTurnSec = listSec - 600;
const secondTurnSec = listSec - 60;
let rateLimited = 0;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  if (parsed.pathname === '/app') {
    return new Response('<script>{"SNlM0e":"csrf","FdrFJe":"sid","cfb2h":"build"}</script>');
  }
  const rpcId = parsed.searchParams.get('rpcids');
  if (rpcId === 'MaZiqc') {
    return new Response(rpc('MaZiqc', [null, null, [['c_timed', 'Timed chat', null, null, null, [listSec, 0]]]]));
  }
  if (rpcId === 'hNvQHb') {
    if (rateLimited++ === 0) return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    // Newest turn first, as the RPC returns them; each carries [sec, nanos].
    const second = [
      ['c_timed', 'r_2'],
      ['c_timed', 'r_2', 'rc_b'],
      [['second question']],
      [[['rc_a', ['draft a']], ['rc_b', ['selected draft b']]]],
      [secondTurnSec, 500_000_000],
    ];
    const first = [['c_timed', 'r_1'], ['c_timed', 'r_1'], [['first question']], [[['rc_x', ['only draft']]]], [firstTurnSec, 0]];
    return new Response(rpc('hNvQHb', [[second, first], null]));
  }
  throw new Error(`unexpected Gemini request: ${url} ${init.method ?? 'GET'}`);
};

const gemini = await capture(syncGemini);
assert.equal(rateLimited, 2, 'a 429 is retried instead of failing the chat');
const timed = gemini.pushed[0];
assert.deepEqual(
  timed.messages.map(message => [message.role, message.content, message.createdAt, message.metadata ?? null]),
  [
    ['user', 'first question', firstTurnSec * 1000, null],
    ['assistant', 'only draft', firstTurnSec * 1000, null],
    ['user', 'second question', secondTurnSec * 1000 + 500, null],
    ['assistant', 'selected draft b', secondTurnSec * 1000 + 500, { drafts: 2 }],
  ]
);
assert.equal(timed.createdAt, firstTurnSec * 1000);
assert.ok(gemini.result.state.lastSyncMs, 'clean run advances the watermark');
console.log('PASS gemini per-turn timestamps, selected draft, and 429 retry');

// --- Perplexity ---
const iso = sec => new Date(sec * 1000).toISOString();
const threadRequests = [];
const entry = index => ({
  query_str: `question ${index}`,
  updated_datetime: iso(listSec - 1000 + index),
  blocks: [{ markdown_block: { answer: `answer ${index}` } }],
});
const allEntries = Array.from({ length: 130 }, (_, index) => entry(index));

globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/list_ask_threads')) {
    return Response.json([{ slug: 'long-thread', context_uuid: 'long', title: 'Long', last_query_datetime: iso(listSec) }]);
  }
  if (parsed.pathname === '/rest/thread/long-thread') {
    const offset = Number(parsed.searchParams.get('offset'));
    const limit = Number(parsed.searchParams.get('limit'));
    threadRequests.push(offset);
    const page = allEntries.slice(offset, offset + limit);
    return Response.json({ entries: page, has_next_page: offset + limit < allEntries.length });
  }
  throw new Error(`unexpected Perplexity request: ${url}`);
};

const perplexity = await capture(syncPerplexity);
assert.deepEqual(threadRequests, [0, 100]);
const long = perplexity.pushed[0];
assert.equal(long.messages.length, 260);
assert.deepEqual(long.messages.at(-1), {
  role: 'assistant',
  content: 'answer 129',
  createdAt: Date.parse(iso(listSec - 1000 + 129)),
  model: null,
  parts: long.messages.at(-1).parts,
});
console.log('PASS perplexity pages through long threads');
