// Regression test: RateLimitedError trips circuit breaker cooldown and avoids hammering provider.
// Usage: bun extension/test/rate-limit-circuit-breaker.js

import assert from 'node:assert/strict';
import { RateLimitedError } from '../lib/common.js';

const now = new Date(Date.now() - 3_600_000).toISOString();
const nowSec = Date.now() / 1000 - 3600;
const stored = {
  settings: {
    port: 3000,
    token: '',
    intervalMinutes: 60,
    providers: { chatgpt: true, claude: false, gemini: false, perplexity: false },
  },
  status: { gemini: { continuationPending: true, progress: { phase: 'queued' } } },
};

let messageListener;
let activeTabUrl = 'https://chatgpt.com/c/123';
let failInitialStorageRead = true;
let failNextStorageWrite = false;
const createdAlarms = [];

let alarmListener;
globalThis.chrome = {
  action: {
    onClicked: { addListener: () => {} },
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  alarms: {
    get: async () => null,
    create: async (name, info) => createdAlarms.push({ name, info }),
    onAlarm: { addListener: listener => (alarmListener = listener) },
  },
  tabs: {
    query: async () => [{ url: activeTabUrl }],
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: listener => (messageListener = listener) },
  },
  storage: {
    local: {
      get: async keys => {
        if (failInitialStorageRead) {
          failInitialStorageRead = false;
          throw new Error('temporary storage read failure');
        }
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(name => name in stored).map(name => [name, stored[name]]));
      },
      set: async values => {
        if (failNextStorageWrite) {
          failNextStorageWrite = false;
          throw new Error('temporary storage write failure');
        }
        Object.assign(stored, structuredClone(values));
      },
    },
  },
};

let chatgptCalls = 0;
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1') {
    if (parsed.pathname === '/sources') return Response.json({ ok: true });
    if (parsed.pathname === '/ingest') return Response.json({ conversations: 0, created: 0, updated: 0 });
  }
  if (parsed.hostname === 'chatgpt.com') {
    chatgptCalls++;
    if (parsed.pathname === '/api/auth/session') return Response.json({ accessToken: 'token' });
    if (parsed.pathname.includes('/accounts/check/')) return Response.json({ accounts: {} });
    if (parsed.pathname === '/backend-api/conversations') {
      return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } });
    }
  }
  return new Response('not found', { status: 404 });
};

await import(`../background.js?circuit-breaker-test=${Date.now()}`);

// 1. Test Active Tab Avoidance: when user is on chatgpt.com, alarm sync should defer
activeTabUrl = 'https://chatgpt.com/c/active-chat';
await alarmListener({ name: 'hstry-sync' });

await alarmListener({ name: 'hstry-sync' });
for (let attempt = 0; attempt < 50; attempt++) {
  if (createdAlarms.some(alarm => alarm.name === 'hstry-sync-continue-gemini')) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(createdAlarms.some(alarm => alarm.name === 'hstry-sync-continue-gemini'), 'pending continuation is restored after worker startup recovers');

for (let attempt = 0; attempt < 50; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10));
  if (stored.status?.chatgpt?.lastNotice) break;
}

assert.ok(
  stored.status.chatgpt?.lastNotice?.includes('Deferred while chatgpt.com is active'),
  'chatgpt sync must be deferred when user has chatgpt active'
);
assert.equal(chatgptCalls, 0, 'no network requests when tab is active');

// 2. Test 429 circuit breaker: manual sync triggers ChatGPT which returns 429
activeTabUrl = 'https://google.com'; // user navigated away
messageListener({ type: 'syncNow' }, {}, () => {});

for (let attempt = 0; attempt < 50; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10));
  if (stored.status?.chatgpt && !stored.status.chatgpt.running) break;
}

assert.equal(stored.status.chatgpt.running, false);
assert.equal(stored.status.chatgpt.progress?.phase, 'rate_limited');
assert.ok(stored.status.chatgpt.cooldownUntilMs > Date.now(), 'cooldownUntilMs must be set in the future');
assert.ok(stored.status.chatgpt.lastError.includes('Rate limited by ChatGPT'), 'lastError should explain rate limiting');

// 3. Test Cooldown: subsequent alarm skips the provider during cooldown
const callsBeforeAlarm = chatgptCalls;
await alarmListener({ name: 'hstry-sync' });
assert.equal(chatgptCalls, callsBeforeAlarm, 'cooldown must prevent network calls during alarm');

// 4. A rejected status write must release the provider and allow the next sync.
failNextStorageWrite = true;
messageListener({ type: 'syncNow' }, {}, () => {});
for (let attempt = 0; attempt < 50; attempt++) {
  if (stored.status.chatgpt?.progress?.phase === 'failed' && !stored.status.chatgpt.running) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
const callsBeforeRetry = chatgptCalls;
messageListener({ type: 'syncNow' }, {}, () => {});
for (let attempt = 0; attempt < 50; attempt++) {
  if (chatgptCalls > callsBeforeRetry && stored.status.chatgpt?.running === false) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(chatgptCalls > callsBeforeRetry, 'provider is released and a later sync can run after status storage rejects');

console.log('PASS cooldown, active-tab deferral, startup recovery, continuation restore, and status-write recovery');
