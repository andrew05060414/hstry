// Regression test: a provider without site access (Edge/Chrome "On click")
// fails with an actionable message instead of a CORS "Failed to fetch" that
// reads like the local API being offline. Usage: bun extension/test/site-access.js

import assert from 'node:assert/strict';

const stored = {
  settings: {
    port: 3000,
    token: '',
    intervalMinutes: 15,
    providers: { chatgpt: true, claude: false, gemini: false, grok: false, perplexity: false },
  },
  status: {},
};

let messageListener;
globalThis.chrome = {
  action: {
    onClicked: { addListener: () => {} },
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  },
  alarms: { get: async () => null, create: async () => {}, onAlarm: { addListener: () => {} } },
  permissions: { contains: async ({ origins }) => !origins.includes('https://chatgpt.com/*') },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: listener => (messageListener = listener) },
  },
  storage: {
    local: {
      get: async keys => {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter(name => name in stored).map(name => [name, stored[name]]));
      },
      set: async values => Object.assign(stored, structuredClone(values)),
    },
  },
};

const providerRequests = [];
globalThis.fetch = async url => {
  const parsed = new URL(url);
  if (parsed.hostname === '127.0.0.1') return Response.json({ ok: true });
  providerRequests.push(parsed.pathname);
  throw new TypeError('Failed to fetch');
};

await import(`../background.js?site-access-test=${Date.now()}`);
messageListener({ type: 'syncNow' }, {}, () => {});
for (let attempt = 0; attempt < 100 && stored.status.chatgpt?.running !== false; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 5));
}

assert.equal(stored.status.chatgpt.running, false);
assert.equal(
  stored.status.chatgpt.lastError,
  'site access to chatgpt.com is not granted — open the extension\'s details page and set Site access to "On all sites"'
);
assert.deepEqual(providerRequests, [], 'no provider request is attempted without site access');
console.log('PASS missing site access is reported before any provider request');
