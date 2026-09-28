// ChatGPT provider: syncs conversations (personal + Teams workspaces, including
// archived and project conversations) via the chatgpt.com backend API,
// authenticated with the browser session cookies.

import {
  HttpError,
  NotLoggedInError,
  RateLimitedError,
  createFailureTracker,
  fetchJson,
  shortId,
  sleep,
  sleepWithJitter,
  textPart,
  thinkingPart,
  toMs,
} from '../lib/common.js';

const BASE = 'https://chatgpt.com';
const PAGE_SIZE = 50;
const PROJECT_PAGE_SIZE = 50;
// Refetch a little history on every run so near-simultaneous edits are not
// missed between polls.
const OVERLAP_MS = 5 * 60 * 1000;
// Pace detail requests to stay well under ChatGPT's rate limit. Pacing avoids
// tripping 429 in the first place and prevents disturbing foreground web sessions.
const THROTTLE_MS = 1500;

async function getAccessToken() {
  const data = await fetchJson(`${BASE}/api/auth/session`);
  if (!data?.accessToken) throw new NotLoggedInError('chatgpt.com');
  return data.accessToken;
}

function authHeaders(token, accountId) {
  const headers = { Authorization: `Bearer ${token}` };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

/** Enumerate accounts (personal + Teams workspaces). Falls back to the
 * default account when the accounts endpoint is unavailable. */
async function listAccounts(token) {
  try {
    const data = await fetchJson(`${BASE}/backend-api/accounts/check/v4-2023-04-27`, {
      headers: authHeaders(token),
    });
    const accounts = [];
    for (const entry of Object.values(data?.accounts ?? {})) {
      const account = entry?.account ?? entry;
      const id = account?.account_id ?? account?.id;
      if (!id || account?.is_deactivated) continue;
      if (accounts.some(a => a.id === id)) continue;
      accounts.push({
        id,
        name: account?.organization_name || account?.name || account?.plan_type || 'personal',
        isWorkspace: (account?.structure ?? account?.plan_type) === 'workspace',
      });
    }
    if (accounts.length > 0) return accounts;
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    // Endpoint shape changed or unavailable: sync the default account only.
  }
  return [{ id: null, name: 'default', isWorkspace: false }];
}

/** Walk an offset-paged conversation list ordered by update time (newest
 * first), stopping at the first item at or before `sinceMs`. The reported
 * `total` is not trusted as a stop condition: only a short page ends the walk. */
async function* listUpdatedConversations(token, accountId, sinceMs, { archived = false } = {}) {
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const archivedParam = archived ? '&is_archived=true' : '';
    const data = await fetchJson(
      `${BASE}/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated${archivedParam}`,
      { headers: authHeaders(token, accountId) }
    );
    const items = data?.items ?? [];
    for (const item of items) {
      const updatedMs = toMs(item.update_time);
      if (sinceMs && updatedMs && updatedMs <= sinceMs) return;
      yield archived ? { ...item, is_archived: true } : item;
    }
    if (items.length < PAGE_SIZE) return;
  }
}

/** Projects ("snorlax" gizmos) keep their conversations out of the main list. */
async function listProjects(token, accountId) {
  const projects = [];
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const cursorParam = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const data = await fetchJson(
      `${BASE}/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursorParam}`,
      { headers: authHeaders(token, accountId) }
    );
    for (const entry of data?.items ?? []) {
      const gizmo = entry?.gizmo?.gizmo ?? entry?.gizmo;
      if (gizmo?.id) projects.push({ id: gizmo.id, name: gizmo.display?.name ?? gizmo.id });
    }
    const next = data?.cursor ?? null;
    if (next === null || next === cursor) break;
    cursor = next;
  }
  return projects;
}

/** Walk one project's cursor-paged conversation list. Its ordering is not
 * documented, so items are filtered individually and the walk stops once a
 * non-empty page is entirely at or before `sinceMs`. */
async function* listProjectConversations(token, accountId, project, sinceMs) {
  let cursor = '0';
  for (let page = 0; page < 200; page++) {
    await sleep(THROTTLE_MS);
    const data = await fetchJson(
      `${BASE}/backend-api/gizmos/${encodeURIComponent(project.id)}/conversations?cursor=${encodeURIComponent(cursor)}&limit=${PROJECT_PAGE_SIZE}`,
      { headers: authHeaders(token, accountId) }
    );
    const items = data?.items ?? [];
    let fresh = 0;
    for (const item of items) {
      const updatedMs = toMs(item.update_time);
      if (sinceMs && updatedMs && updatedMs <= sinceMs) continue;
      fresh++;
      yield { ...item, project };
    }
    const next = data?.cursor ?? null;
    if (next === null || String(next) === cursor) return;
    if (items.length > 0 && fresh === 0) return;
    cursor = String(next);
  }
}

/** Secondary lists (archive, projects) may be unavailable on some account
 * types. A 4xx other than 429 means "not supported here": log and move on.
 * Anything else holds the watermark so the list is retried next run. */
function isUnsupportedList(err) {
  return err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

/** Every conversation updated since `sinceMs` across the main list, the
 * archive, and each project, deduplicated by id. */
async function* listAllUpdatedConversations(token, accountId, sinceMs, { log, onListError }) {
  const seen = new Set();
  const fresh = item => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  };

  for await (const item of listUpdatedConversations(token, accountId, sinceMs)) {
    if (fresh(item)) yield item;
  }

  const secondary = [
    ['archived conversations', () => listUpdatedConversations(token, accountId, sinceMs, { archived: true })],
  ];
  let projects = [];
  try {
    projects = await listProjects(token, accountId);
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    if (!isUnsupportedList(err)) onListError(err);
    log(`chatgpt: cannot list projects: ${err.message}`);
  }
  for (const project of projects) {
    secondary.push([
      `project ${project.name}`,
      () => listProjectConversations(token, accountId, project, sinceMs),
    ]);
  }

  for (const [label, list] of secondary) {
    try {
      for await (const item of list()) {
        if (fresh(item)) yield item;
      }
    } catch (err) {
      if (err instanceof RateLimitedError) throw err;
      if (!isUnsupportedList(err)) onListError(err);
      log(`chatgpt: cannot list ${label}: ${err.message}`);
    }
  }
}

/** Linearize the active branch of the mapping tree (current_node -> root).
 * If ChatGPT returns a broken parent chain, preserve all message-bearing nodes
 * in deterministic chronological order rather than silently losing the prefix. */
function linearize(detail) {
  const mapping = detail?.mapping ?? {};
  const chain = [];
  const visited = new Set();
  let nodeId = detail?.current_node;
  let incomplete = !nodeId;

  while (nodeId) {
    if (!mapping[nodeId] || visited.has(nodeId)) {
      incomplete = true;
      break;
    }
    visited.add(nodeId);
    chain.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }

  if (!incomplete) {
    chain.reverse();
    return chain;
  }

  const compareEntries = (left, right) =>
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id) ||
    left.key.localeCompare(right.key);
  const seenIds = new Set();
  const entries = Object.entries(mapping)
    .map(([key, node]) => ({
      key,
      node,
      id: String(node?.id ?? key),
      createdAt: toMs(node?.message?.create_time ?? node?.create_time) ?? 0,
    }))
    .sort(compareEntries)
    .filter(entry => {
      if (seenIds.has(entry.id)) return false;
      seenIds.add(entry.id);
      return true;
    });

  // A topological sort keeps parents before children when ChatGPT assigns the
  // same timestamp to several nodes. The chronological/id ordering of the
  // ready queue makes the result deterministic across repeated syncs.
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const children = new Map();
  const indegree = new Map(entries.map(entry => [entry.id, 0]));
  for (const entry of entries) {
    const parentKey = entry.node?.parent;
    const parentId = parentKey ? String(mapping[parentKey]?.id ?? parentKey) : null;
    if (!parentId || parentId === entry.id || !byId.has(parentId)) continue;
    indegree.set(entry.id, 1);
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry.id);
    children.set(parentId, siblings);
  }

  const ready = entries.filter(entry => indegree.get(entry.id) === 0).sort(compareEntries);
  const ordered = [];
  while (ready.length > 0) {
    const entry = ready.shift();
    ordered.push(entry);
    for (const childId of children.get(entry.id) ?? []) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) {
        ready.push(byId.get(childId));
        ready.sort(compareEntries);
      }
    }
  }

  if (ordered.length < entries.length) {
    const orderedIds = new Set(ordered.map(entry => entry.id));
    ordered.push(...entries.filter(entry => !orderedIds.has(entry.id)).sort(compareEntries));
  }

  return ordered.filter(entry => entry.node?.message).map(entry => entry.node);
}

const NON_TEXT_METADATA_KEYS = new Set([
  'content_type',
  'language',
  'message_type',
  'model',
  'model_slug',
  'request_id',
  'status',
]);

function recoverStrings(value, output) {
  const stack = [value];
  while (stack.length) {
    const current = stack.pop();
    if (typeof current === 'string') {
      const text = current.trim();
      if (text) output.push(text);
    } else if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) stack.push(current[index]);
    } else if (current && typeof current === 'object') {
      const entries = Object.entries(current);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [childKey, childValue] = entries[index];
        if (NON_TEXT_METADATA_KEYS.has(childKey) || childKey === 'asset_pointer' || childKey.endsWith('_id') || childKey.endsWith('_slug')) continue;
        stack.push(childValue);
      }
    }
  }
}

function extractMessage(node) {
  const msg = node?.message;
  if (!msg) return null;
  const role = msg.author?.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (msg.metadata?.is_visually_hidden_from_conversation) return null;

  const parts = [];
  const texts = [];
  const content = msg.content ?? {};
  const addText = text => {
    const trimmed = text?.trim();
    if (!trimmed) return;
    texts.push(trimmed);
    parts.push(textPart(trimmed));
  };

  if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
    for (const part of content.parts ?? []) {
      if (typeof part === 'string') {
        addText(part);
      } else if (part?.content_type === 'image_asset_pointer') {
        addText(`[image] ${part.asset_pointer ?? ''}`.trim());
      } else {
        const recovered = [];
        recoverStrings(part, recovered);
        for (const text of recovered) addText(text);
      }
    }
  } else if (content.content_type === 'code' && content.text) {
    addText(`\`\`\`${content.language ?? ''}\n${content.text}\n\`\`\``);
  } else if (content.content_type === 'thoughts') {
    for (const thought of content.thoughts ?? []) {
      const text = thought?.content ?? thought?.summary;
      if (text) parts.push(thinkingPart(text));
    }
  } else if (content.content_type === 'image_asset_pointer') {
    addText(`[image] ${content.asset_pointer ?? ''}`.trim());
  } else {
    const recovered = [];
    recoverStrings(content, recovered);
    for (const text of recovered) addText(text);
  }

  if (texts.length === 0 && parts.length === 0) {
    const recovered = [];
    recoverStrings(msg.metadata, recovered);
    for (const text of recovered) addText(text);
  }

  const contentStr = texts.join('\n').trim();
  if (!contentStr && parts.length === 0) return null;

  return {
    role,
    content: contentStr,
    createdAt: toMs(msg.create_time),
    model: msg.metadata?.model_slug ?? null,
    parts,
  };
}

function toParsedConversation(detail, conversationId, accountId, item = {}) {
  const messages = linearize(detail)
    .map(extractMessage)
    .filter(Boolean);
  if (messages.length === 0) return null;

  const model = [...messages].reverse().find(m => m.model)?.model ?? null;
  const templateId = detail?.conversation_template_id ?? detail?.gizmo_id ?? '';
  const projectId = item.project?.id ?? (templateId.startsWith('g-p-') ? templateId : null);

  return {
    externalId: conversationId,
    title: detail?.title ?? null,
    createdAt: toMs(detail?.create_time) ?? messages[0].createdAt ?? Date.now(),
    updatedAt: toMs(detail?.update_time),
    model,
    provider: 'openai',
    messages,
    metadata: {
      url: `${BASE}/c/${conversationId}`,
      ...(accountId ? { accountId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(item.project?.name ? { projectName: item.project.name } : {}),
      ...(item.is_archived || detail?.is_archived ? { archived: true } : {}),
    },
  };
}

export async function syncChatGPT({ state, push, register = async () => {}, log, report = async () => {} }) {
  await report({ phase: 'discovering' });
  const token = await getAccessToken();
  const accounts = await listAccounts(token);
  const newState = { ...state, accounts: {} };
  let total = 0;
  let detected = 0;
  let processed = 0;

  for (const account of accounts) {
    const key = account.id ? shortId(account.id) : 'default';
    const sourceId = account.id && account.isWorkspace ? `chatgpt-web-${key}` : 'chatgpt-web';
    await register(sourceId, 'chatgpt-web');
    const lastSyncMs = state?.accounts?.[key]?.lastSyncMs ?? null;
    const since = lastSyncMs ? lastSyncMs - OVERLAP_MS : null;
    const runStartedMs = Date.now();
    const failures = createFailureTracker(state?.accounts?.[key]?.failed);
    let listFailures = 0;

    let batch = [];
    let first = true;
    const listed = listAllUpdatedConversations(token, account.id, since, {
      log,
      onListError: () => listFailures++,
    });
    for await (const item of listed) {
      const updatedMs = toMs(item.update_time);
      if (failures.shouldSkip(item.id, updatedMs)) continue;
      detected++;
      await report({ phase: 'importing', detected, processed });
      if (!first) await sleepWithJitter(THROTTLE_MS, 400);
      first = false;
      try {
        const detail = await fetchJson(`${BASE}/backend-api/conversation/${item.id}`, {
          headers: authHeaders(token, account.id),
        });
        const conv = toParsedConversation(detail, item.id, account.id, item);
        if (!conv) throw new Error('ChatGPT returned no parseable conversation messages');
        batch.push(conv);
        failures.recordSuccess(item.id);
      } catch (err) {
        if (err instanceof RateLimitedError) {
          if (batch.length > 0) total += await push(sourceId, 'chatgpt-web', batch);
          throw err;
        }
        const skipped = failures.recordFailure(item.id, updatedMs, err);
        log(`chatgpt: ${skipped ? 'skip-listing' : 'skipping'} conversation ${item.id}: ${err.message}`);
      }
      processed++;
      await report({ detected, processed });
      if (batch.length >= 10) {
        total += await push(sourceId, 'chatgpt-web', batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      total += await push(sourceId, 'chatgpt-web', batch);
    }

    // Only advance the watermark when nothing retryable failed. Transient
    // failures (429, 5xx, a list that could not be read) keep the old
    // watermark so the next sync retries them; conversations that failed
    // permanently are skip-listed instead of pinning the watermark forever.
    // Re-pushes dedupe server-side.
    const holding = failures.blocking + listFailures;
    if (holding > 0) {
      log(`chatgpt: ${holding} retryable failure(s); keeping watermark to retry next run`);
    }
    newState.accounts[key] = {
      lastSyncMs: holding > 0 ? lastSyncMs : runStartedMs,
      name: account.name,
      failed: failures.toState(),
    };
  }

  await report({ phase: 'complete', detected, processed });

  return { state: newState, conversations: total };
}

export const chatgptInternals = { toParsedConversation, recoverStrings };
