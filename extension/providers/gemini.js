// Gemini web sync through the authenticated batchexecute RPCs used by the web UI.

import {
  NotLoggedInError,
  createFailureTracker,
  fetchWithBackoff,
  sleep,
  textPart,
  toMs,
} from '../lib/common.js';

const BASE = 'https://gemini.google.com';
const OVERLAP_MS = 5 * 60 * 1000;
const PAGE_SIZE = 20;
const SYNC_CHUNK_SIZE = 10;
const REQUEST_TIMEOUT_MS = 20_000;
// Pace chat reads; fetchWithBackoff handles 429 bursts, pacing avoids them.
const THROTTLE_MS = 500;
// Sanity window for [seconds, nanos] turn timestamps (2015..2096).
const MIN_EPOCH_S = 1_420_070_400;
const MAX_EPOCH_S = 4_000_000_000;

function extractSession(html) {
  const read = key => html.match(new RegExp(`"${key}":"((?:\\\\.|[^"\\\\])*)"`))?.[1];
  const decode = value => value ? JSON.parse(`"${value}"`) : '';
  return {
    at: decode(read('SNlM0e')),
    sid: decode(read('FdrFJe')),
    bl: decode(read('cfb2h')),
  };
}

function parseRpcResponse(text, rpcId) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('[[')) continue;
    try {
      const outer = JSON.parse(line);
      const entry = outer?.[0];
      if (entry?.[0] === 'wrb.fr' && entry?.[1] === rpcId && typeof entry?.[2] === 'string') {
        return JSON.parse(entry[2]);
      }
    } catch {
      // Streaming responses contain size lines and unrelated chunks.
    }
  }
  throw new Error(`Gemini returned an unreadable ${rpcId} response`);
}

async function getSession() {
  const res = await fetchWithBackoff(`${BASE}/app`, {}, { timeoutMs: REQUEST_TIMEOUT_MS });
  if (res.url.includes('accounts.google.com')) {
    throw new NotLoggedInError('gemini.google.com');
  }
  const session = extractSession(await res.text());
  if (!session.at) throw new NotLoggedInError('gemini.google.com');
  const userIndex = res.url.match(/\/u\/(\d+)\//)?.[1] ?? null;
  return { ...session, userIndex };
}

async function batchExecute(session, rpcId, arg) {
  const reqId = Math.floor(Math.random() * 900000) + 100000;
  const accountPath = session.userIndex === null ? '' : `/u/${session.userIndex}`;
  const url = new URL(`${BASE}${accountPath}/_/BardChatUi/data/batchexecute`);
  url.searchParams.set('rpcids', rpcId);
  url.searchParams.set('source-path', '/app');
  url.searchParams.set('_reqid', String(reqId));
  url.searchParams.set('rt', 'c');
  if (session.bl) url.searchParams.set('bl', session.bl);
  if (session.sid) url.searchParams.set('f.sid', session.sid);

  const body = new URLSearchParams();
  body.set('f.req', JSON.stringify([[[rpcId, JSON.stringify(arg), null, 'generic']]]));
  body.set('at', session.at);
  const res = await fetchWithBackoff(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', 'X-Same-Domain': '1' },
      body,
    },
    { timeoutMs: REQUEST_TIMEOUT_MS }
  );
  return parseRpcResponse(await res.text(), rpcId);
}

async function listChats(session, sinceMs) {
  const chats = new Map();
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const arg = cursor === null ? [PAGE_SIZE] : [PAGE_SIZE, cursor];
    const data = await batchExecute(session, 'MaZiqc', arg);
    const nextCursor = data?.[1] ?? null;
    const items = Array.isArray(data?.[2]) ? data[2] : [];
    let reachedOld = false;
    for (const item of items) {
      const rawId = String(item?.[0] ?? '');
      if (!rawId) continue;
      const updatedAt = toMs(item?.[5]?.[0]);
      if (sinceMs && updatedAt && updatedAt <= sinceMs) {
        reachedOld = true;
        continue;
      }
      chats.set(rawId, {
        rawId,
        id: rawId.replace(/^c_/, ''),
        title: String(item?.[1] ?? 'Untitled conversation'),
        updatedAt,
      });
    }
    if (reachedOld || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return [...chats.values()];
}

/** A turn carries its own `[seconds, nanos]` pair as a direct child; its
 * index has moved between UI versions, so scan from the end for the last
 * plausible pair. */
function turnTimestampMs(turn) {
  if (!Array.isArray(turn)) return null;
  for (let index = turn.length - 1; index >= 0; index--) {
    const child = turn[index];
    if (!Array.isArray(child) || child.length < 2) continue;
    const [seconds, nanos] = child;
    if (typeof seconds !== 'number' || typeof nanos !== 'number') continue;
    if (seconds < MIN_EPOCH_S || seconds > MAX_EPOCH_S) continue;
    return Math.floor(seconds * 1000 + nanos / 1e6);
  }
  return null;
}

/** Gemini can produce several drafts per turn. When the turn's id triple
 * (`turn[1]`) names a candidate id that matches one of the drafts, use that
 * draft; otherwise use the first draft, which the UI shows by default. The
 * draft count is kept in message metadata. */
function assistantReply(turn) {
  const candidates = Array.isArray(turn?.[3]?.[0]) ? turn[3][0] : [];
  const textOf = candidate => {
    const text = candidate?.[1]?.[0];
    return typeof text === 'string' ? text : '';
  };
  const selectedId = turn?.[1]?.[2];
  const selected =
    (typeof selectedId === 'string' && candidates.find(candidate => candidate?.[0] === selectedId)) ||
    candidates[0];
  return { text: textOf(selected), drafts: candidates.filter(candidate => textOf(candidate)).length };
}

async function readChat(session, summary) {
  const turns = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const data = await batchExecute(session, 'hNvQHb', [summary.rawId, 20, cursor, 1, [0], [4], null, 1]);
    const pageTurns = Array.isArray(data?.[0]) ? data[0] : [];
    turns.push(...pageTurns);
    const nextCursor = data?.[1] ?? null;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  turns.reverse();

  const messages = [];
  for (const turn of turns) {
    const user = turn?.[2]?.[0]?.[0];
    const reply = assistantReply(turn);
    const createdAt = turnTimestampMs(turn) ?? summary.updatedAt;
    if (typeof user === 'string' && user.trim()) {
      messages.push({ role: 'user', content: user, createdAt, model: null, parts: [textPart(user)] });
    }
    if (reply.text.trim()) {
      messages.push({
        role: 'assistant',
        content: reply.text,
        createdAt,
        model: 'gemini',
        parts: [textPart(reply.text)],
        ...(reply.drafts > 1 ? { metadata: { drafts: reply.drafts } } : {}),
      });
    }
  }
  if (messages.length === 0) return null;
  return {
    externalId: summary.id,
    title: summary.title,
    createdAt: messages.find(message => message.createdAt)?.createdAt ?? summary.updatedAt ?? Date.now(),
    updatedAt: summary.updatedAt,
    model: 'gemini',
    provider: 'google',
    messages,
    metadata: { url: `${BASE}/app/${summary.id}` },
  };
}

export async function syncGemini({ state, push, register = async () => {}, log, report = async () => {} }) {
  await report({ phase: 'discovering' });
  const session = await getSession();
  await register('gemini-web', 'gemini');
  const lastSyncMs = state?.lastSyncMs ?? null;
  const since = lastSyncMs ? lastSyncMs - OVERLAP_MS : null;
  const pending = state?.pending;
  const runStartedMs = pending?.runStartedMs ?? Date.now();
  const summaries = Array.isArray(pending?.summaries)
    ? pending.summaries
    : await listChats(session, since);
  const startIndex = Number.isInteger(pending?.nextIndex) ? pending.nextIndex : 0;
  const endIndex = Math.min(startIndex + SYNC_CHUNK_SIZE, summaries.length);
  await report({ phase: 'importing', detected: summaries.length, processed: startIndex });
  const failures = createFailureTracker(state?.failed);
  let total = 0;
  let processed = startIndex;
  let batch = [];
  let first = true;
  for (const summary of summaries.slice(startIndex, endIndex)) {
    processed++;
    if (failures.shouldSkip(summary.id, summary.updatedAt)) continue;
    if (!first) await sleep(THROTTLE_MS);
    first = false;
    try {
      const conversation = await readChat(session, summary);
      if (conversation) batch.push(conversation);
      failures.recordSuccess(summary.id);
    } catch (error) {
      const skipped = failures.recordFailure(summary.id, summary.updatedAt, error);
      log(`gemini: ${skipped ? 'skip-listing' : 'skipping'} conversation ${summary.id}: ${error.message}`);
    }
    await report({ processed });
    if (batch.length >= 10) {
      total += await push('gemini-web', 'gemini', batch);
      batch = [];
    }
  }
  if (batch.length) total += await push('gemini-web', 'gemini', batch);
  const hasMore = endIndex < summaries.length;
  // Retryable failures anywhere in a chunked run keep the old watermark;
  // permanently failing chats are skip-listed instead.
  const hadFailures = Boolean(pending?.hadFailures) || failures.blocking > 0;
  await report({ phase: hasMore ? 'queued' : 'complete', processed });
  return {
    state: hasMore
      ? {
          lastSyncMs,
          failed: failures.toState(),
          pending: {
            runStartedMs,
            summaries,
            nextIndex: endIndex,
            hadFailures,
          },
        }
      : { lastSyncMs: hadFailures ? lastSyncMs : runStartedMs, failed: failures.toState() },
    conversations: total,
    hasMore,
  };
}

export const geminiInternals = { extractSession, parseRpcResponse, turnTimestampMs, assistantReply };
