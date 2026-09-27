import assert from 'node:assert/strict';
import { fetchJson, RateLimitedError } from '../lib/common.js';
import { syncChatGPT } from '../providers/chatgpt.js';
import { syncClaude } from '../providers/claude.js';
import { syncGemini } from '../providers/gemini.js';
import { syncGrok } from '../providers/grok.js';
import { syncPerplexity } from '../providers/perplexity.js';

const quiet = { log: () => {}, report: async () => {}, register: async () => {} };
const noPush = async () => { throw new Error('unexpected push'); };
const nowSec = Math.floor(Date.now() / 1000) - 3600;
const nowIso = new Date(nowSec * 1000).toISOString();

// Empty parser output is a failed conversation and leaves every provider watermark intact.
globalThis.fetch = async url => {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'chatgpt.com') {
    if (pathname === '/api/auth/session') return Response.json({ accessToken: 'token' });
    if (pathname.includes('/accounts/check/')) return Response.json({ accounts: { a: { account: { account_id: 'acct' } } } });
    if (pathname === '/backend-api/conversations') return Response.json({ total: 1, items: [{ id: 'empty-gpt', update_time: nowSec }] });
    if (pathname.endsWith('/empty-gpt')) return Response.json({ current_node: 'n', mapping: { n: { parent: null, message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [] } } } } });
  }
  throw new Error(`unexpected request ${url}`);
};
const gptResult = await syncChatGPT({ ...quiet, state: { accounts: { acct: { lastSyncMs: 123 } } }, push: noPush });
assert.equal(gptResult.state.accounts.acct.lastSyncMs, 123);

globalThis.fetch = async url => {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'claude.ai') {
    if (pathname === '/api/organizations') return Response.json([{ uuid: 'org-empty' }]);
    if (pathname.endsWith('/chat_conversations')) return Response.json([{ uuid: 'empty-claude', updated_at: nowIso }]);
    if (pathname.endsWith('/empty-claude')) return Response.json({ uuid: 'empty-claude', chat_messages: [] });
  }
  throw new Error(`unexpected request ${url}`);
};
const claudeResult = await syncClaude({ ...quiet, state: { orgs: { orgempty: { lastSyncMs: 234 } } }, push: noPush });
assert.equal(claudeResult.state.orgs.orgempty.lastSyncMs, 234);

const html = '<script>{"SNlM0e":"csrf","FdrFJe":"sid","cfb2h":"build"}</script>';
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname === '/app') return new Response(html);
  const rpc = parsed.searchParams.get('rpcids');
  if (rpc === 'MaZiqc') return new Response(`)]}'\n${JSON.stringify([["wrb.fr", rpc, JSON.stringify([null, null, [["c_empty", "empty", null, null, null, [nowSec, 0]]]]), null]])}`);
  if (rpc === 'hNvQHb') return new Response(`)]}'\n${JSON.stringify([["wrb.fr", rpc, JSON.stringify([[], null]), null]])}`);
  throw new Error(`unexpected request ${url}`);
};
const geminiResult = await syncGemini({ ...quiet, state: { lastSyncMs: 345 }, push: noPush });
assert.equal(geminiResult.state.lastSyncMs, 345);

globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/list_ask_threads')) return Response.json([{ slug: 'empty-pplx', last_query_datetime: nowIso }]);
  if (parsed.pathname.includes('/rest/thread/empty-pplx')) return Response.json({ entries: [] });
  throw new Error(`unexpected request ${url}`);
};
const pplxResult = await syncPerplexity({ ...quiet, state: { lastSyncMs: 456 }, push: noPush });
assert.equal(pplxResult.state.lastSyncMs, 456);

globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname === '/rest/app-chat/conversations') return Response.json({ conversations: [{ conversationId: 'empty-grok', modifyTime: nowIso }] });
  if (parsed.pathname.endsWith('/responses')) return Response.json({ responses: [] });
  throw new Error(`unexpected request ${url}`);
};
const grokResult = await syncGrok({ ...quiet, state: { lastSyncMs: 567 }, push: noPush });
assert.equal(grokResult.state.lastSyncMs, 567);

// Perplexity 250-entry details page with offsets and reject repeated pages before any push.
let offsets = [];
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/list_ask_threads')) return Response.json([{ slug: 'large', last_query_datetime: nowIso }]);
  if (parsed.pathname.includes('/rest/thread/large')) {
    const offset = Number(parsed.searchParams.get('offset'));
    offsets.push(offset);
    const count = offset < 200 ? 100 : 50;
    const entries = Array.from({ length: count }, (_, index) => ({ uuid: `${offset + index}`, query_str: `q${offset + index}`, blocks: [{ markdown_block: { answer: `a${offset + index}` } }] }));
    return Response.json({ entries });
  }
  throw new Error(`unexpected request ${url}`);
};
let largeConversations = [];
await syncPerplexity({ ...quiet, state: {}, push: async (_s, _a, batch) => { largeConversations.push(...batch); return batch.length; } });
assert.deepEqual(offsets, [0, 100, 200]);
assert.equal(largeConversations[0].messages.length, 500);

offsets = [];
let partialPushes = 0;
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/list_ask_threads')) return Response.json([{ slug: 'repeats', last_query_datetime: nowIso }]);
  if (parsed.pathname.includes('/rest/thread/repeats')) {
    offsets.push(Number(parsed.searchParams.get('offset')));
    return Response.json({ entries: Array.from({ length: 100 }, (_, index) => ({ uuid: `same-${index}`, query_str: `q${index}` })) });
  }
  throw new Error(`unexpected request ${url}`);
};
await assert.rejects(syncPerplexity({ ...quiet, state: {}, push: async () => { partialPushes++; } }), /repeated detail page/);
assert.deepEqual(offsets, [0, 100]);
assert.equal(partialPushes, 0);

// Gemini fails closed on repeated list/detail cursors and a 200-page cap.
function rpcResponse(id, value) {
  return new Response(`)]}'\n${JSON.stringify([["wrb.fr", id, JSON.stringify(value), null]])}`);
}
async function geminiWithPages(mode) {
  let listPage = 0;
  let detailPage = 0;
  let pushes = 0;
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/app') return new Response(html);
    const id = parsed.searchParams.get('rpcids');
    if (id === 'MaZiqc') {
      listPage++;
      if (mode === 'list-repeat') return rpcResponse(id, [null, 'cursor', []]);
      if (mode === 'list-cap') return rpcResponse(id, [null, `cursor-${listPage}`, []]);
      return rpcResponse(id, [null, null, [["c_one", "one", null, null, null, [nowSec, 0]]]]);
    }
    if (id === 'hNvQHb') {
      detailPage++;
      const cursor = mode === 'detail-repeat' ? 'same' : `cursor-${detailPage}`;
      return rpcResponse(id, [[[null, null, [['q']], [[[null, ['a']]]]]], cursor]);
    }
    throw new Error(`unexpected request ${url}`);
  };
  await assert.rejects(
    syncGemini({ ...quiet, state: { lastSyncMs: 789 }, push: async () => { pushes++; } }),
    mode.endsWith('repeat') ? /repeated its pagination cursor/ : /200-page safety limit/
  );
  assert.equal(pushes, 0);
  if (mode === 'list-cap') assert.equal(listPage, 200);
  if (mode === 'detail-cap') assert.equal(detailPage, 200);
}
await geminiWithPages('list-repeat');
await geminiWithPages('list-cap');
await geminiWithPages('detail-repeat');
await geminiWithPages('detail-cap');

// Iterative string recovery handles nesting beyond the JS call-stack limit.
let nested = 'deeply nested payload';
for (let i = 0; i < 20_000; i++) nested = { nested };
globalThis.fetch = async url => {
  const { pathname } = new URL(url);
  if (pathname === '/api/auth/session') return Response.json({ accessToken: 'token' });
  if (pathname.includes('/accounts/check/')) return Response.json({ accounts: {} });
  if (pathname === '/backend-api/conversations') return Response.json({ total: 1, items: [{ id: 'deep', update_time: nowSec }] });
  if (pathname.endsWith('/deep')) return { ok: true, json: async () => ({ current_node: 'n', mapping: { n: { parent: null, message: { author: { role: 'user' }, content: { content_type: 'unknown', nested } } } } }) };
  throw new Error(`unexpected request ${url}`);
};
let deepText = '';
await syncChatGPT({ ...quiet, state: {}, push: async (_s, _a, conversations) => { deepText = conversations[0].messages[0].content; return 1; } });
assert.equal(deepText, 'deeply nested payload');

// Retry-After accepts HTTP dates, and Cloudflare's explicit challenge marker is rate-limit class.
const retryDate = new Date(Date.now() + 30_000).toUTCString();
globalThis.fetch = async () => new Response('limited', { status: 429, headers: { 'retry-after': retryDate } });
await assert.rejects(fetchJson('https://example.test/path'), error => error instanceof RateLimitedError && error.retryAfterMs > 0);
globalThis.fetch = async () => new Response('<html>challenge</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
await assert.rejects(fetchJson('https://example.test/path'), error => error instanceof RateLimitedError && error.status === 403);

// Gemini session bootstrap uses the same 429 parsing path as RPC calls.
globalThis.fetch = async () => new Response('limited', { status: 429, headers: { 'retry-after': retryDate } });
await assert.rejects(syncGemini({ ...quiet, state: {}, push: noPush }), error => error instanceof RateLimitedError && error.retryAfterMs > 0);

console.log('PASS provider reliability regressions: empty watermarks, pagination, deep strings, Retry-After, Cloudflare');
