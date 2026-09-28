// Regression test: ChatGPT project and archived conversations are synced, and
// a conversation that keeps failing is skip-listed instead of pinning the
// watermark. Usage: bun extension/test/chatgpt-projects.js

import assert from 'node:assert/strict';
import { syncChatGPT } from '../providers/chatgpt.js';

const OLD_S = Date.now() / 1000 - 3600;

function detail(id, text, extra = {}) {
  return {
    title: `title ${id}`,
    create_time: OLD_S,
    update_time: OLD_S,
    current_node: 'a',
    mapping: {
      u: { id: 'u', parent: null, message: { author: { role: 'user' }, content: { content_type: 'text', parts: [text] } } },
      a: { id: 'a', parent: 'u', message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: [`re ${text}`] } } },
    },
    ...extra,
  };
}

const item = id => ({ id, title: id, create_time: OLD_S, update_time: OLD_S });

const details = {
  main: detail('main', 'main question'),
  archived: detail('archived', 'archived question', { is_archived: true }),
  'proj-1': detail('proj-1', 'project question', { gizmo_id: 'g-p-alpha' }),
  'proj-2': detail('proj-2', 'second page question', { gizmo_id: 'g-p-beta' }),
};

const requested = [];
let brokenStatus = 404;

const realFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const { pathname, searchParams } = new URL(url);
  requested.push(`${pathname}?${searchParams}`);
  if (pathname === '/api/auth/session') return Response.json({ accessToken: 'fixture-token' });
  if (pathname === '/backend-api/accounts/check/v4-2023-04-27') {
    return Response.json({ accounts: { default: { account: { account_id: 'acc-1', structure: 'personal' } } } });
  }
  if (pathname === '/backend-api/conversations') {
    if (searchParams.get('is_archived') === 'true') return Response.json({ total: 1, items: [item('archived')] });
    // total under-reports the list; the provider must not trust it.
    return Response.json({ total: 0, items: [item('main'), item('broken')] });
  }
  if (pathname === '/backend-api/gizmos/snorlax/sidebar') {
    if (!searchParams.get('cursor')) {
      return Response.json({
        cursor: 'next-page',
        items: [{ gizmo: { gizmo: { id: 'g-p-alpha', display: { name: 'Alpha' } } }, conversations: { items: [] } }],
      });
    }
    return Response.json({
      cursor: null,
      items: [{ gizmo: { gizmo: { id: 'g-p-beta', display: { name: 'Beta' } } }, conversations: { items: [] } }],
    });
  }
  if (pathname === '/backend-api/gizmos/g-p-alpha/conversations') {
    // The main conversation also shows up here; it must be fetched once.
    return Response.json({ cursor: null, items: [item('proj-1'), item('main')] });
  }
  if (pathname === '/backend-api/gizmos/g-p-beta/conversations') {
    if (searchParams.get('cursor') === '0') return Response.json({ cursor: 'c2', items: [] });
    return Response.json({ cursor: null, items: [item('proj-2')] });
  }
  if (pathname === '/backend-api/conversation/broken') {
    if (brokenStatus === 'network') throw new TypeError('Failed to fetch');
    return new Response('broken', { status: brokenStatus });
  }
  const id = pathname.match(/^\/backend-api\/conversation\/(.+)$/)?.[1];
  if (id && details[id]) return Response.json(details[id]);
  return new Response('not found', { status: 404 });
};

async function run(state) {
  const pushed = [];
  const result = await syncChatGPT({
    state,
    log: () => {},
    push: async (_sourceId, _adapter, conversations) => {
      pushed.push(...conversations);
      return conversations.length;
    },
  });
  return { result, pushed };
}

try {
  // Run 1: every list is walked; the 404 conversation is skip-listed at once.
  const first = await run({});
  assert.deepEqual(
    first.pushed.map(conv => [conv.externalId, conv.metadata]).sort(),
    [
      ['archived', { url: 'https://chatgpt.com/c/archived', accountId: 'acc-1', archived: true }],
      ['main', { url: 'https://chatgpt.com/c/main', accountId: 'acc-1' }],
      ['proj-1', { url: 'https://chatgpt.com/c/proj-1', accountId: 'acc-1', projectId: 'g-p-alpha', projectName: 'Alpha' }],
      ['proj-2', { url: 'https://chatgpt.com/c/proj-2', accountId: 'acc-1', projectId: 'g-p-beta', projectName: 'Beta' }],
    ]
  );
  assert.equal(
    requested.filter(path => path.startsWith('/backend-api/conversation/main')).length,
    1,
    'a conversation listed twice is fetched once'
  );
  const account = first.result.state.accounts.acc1;
  assert.ok(account.lastSyncMs, '404 conversation must not pin the watermark');
  assert.equal(account.failed.broken.skipped, true);
  console.log('PASS chatgpt syncs main, archived, and project conversations');

  // A skip-listed conversation is not refetched until it changes.
  requested.length = 0;
  await run({ accounts: { acc1: { lastSyncMs: null, failed: account.failed } } });
  assert.equal(requested.filter(path => path.startsWith('/backend-api/conversation/broken')).length, 0);
  console.log('PASS chatgpt skip list suppresses unchanged failed conversation');

  // Deterministic non-404 failures hold the watermark for 3 runs, then skip.
  brokenStatus = 400;
  let state = {};
  const watermarks = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { result } = await run(state);
    state = result.state;
    watermarks.push(state.accounts.acc1.lastSyncMs);
  }
  assert.deepEqual(watermarks.map(Boolean), [false, false, true]);
  assert.equal(state.accounts.acc1.failed.broken.attempts, 3);
  console.log('PASS chatgpt repeated failure skip-listed after 3 runs');

  // Transient failures never skip-list and always hold the watermark.
  brokenStatus = 'network';
  state = {};
  for (let attempt = 0; attempt < 4; attempt++) {
    const { result } = await run(state);
    state = result.state;
    assert.equal(state.accounts.acc1.lastSyncMs, null);
  }
  assert.deepEqual(state.accounts.acc1.failed, {});
  console.log('PASS chatgpt transient failure keeps retrying');
} finally {
  globalThis.fetch = realFetch;
}
