// Perplexity web sync via the authenticated thread endpoints used by its UI.

import { RateLimitedError, createFailureTracker, fetchJson, sleepWithJitter, textPart, toMs } from '../lib/common.js';

const BASE = 'https://www.perplexity.ai';
const LIST_URL = `${BASE}/rest/thread/list_ask_threads?version=2.18&source=default`;
const PAGE_SIZE = 20;
const OVERLAP_MS = 5 * 60 * 1000;
const ENTRY_PAGE_SIZE = 100;
const MAX_PAGES = 101;
// Pace requests well under the rate limit; a 429 aborts the run so the
// background circuit breaker can cool the provider down.
const THROTTLE_MS = 1500;

const headers = {
  accept: '*/*',
  'content-type': 'application/json',
  'x-app-apiclient': 'default',
  'x-app-apiversion': '2.18',
};

async function listThreads(sinceMs) {
  const threads = [];
  const seenPages = new Set();
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += PAGE_SIZE) {
    if (offset > 0) await sleepWithJitter(THROTTLE_MS, 400);
    const data = await fetchJson(LIST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ limit: PAGE_SIZE, ascending: false, offset, search_term: '' }),
    });
    const items = Array.isArray(data) ? data : data?.threads;
    if (!Array.isArray(items)) throw new Error('Perplexity returned malformed thread list');
    const signature = JSON.stringify(items.map(item => item?.slug ?? item?.uuid ?? item?.context_uuid));
    if (seenPages.has(signature)) throw new Error('Perplexity thread list repeated a page');
    seenPages.add(signature);
    let reachedOld = false;
    for (const item of items) {
      const updatedAt = toMs(item.last_query_datetime);
      if (sinceMs && updatedAt && updatedAt <= sinceMs) {
        reachedOld = true;
        continue;
      }
      threads.push({ ...item, updatedAt });
    }
    if (reachedOld || items.length < PAGE_SIZE) return threads;
    if (page === MAX_PAGES - 1) throw new Error('Perplexity thread list exceeded its safety page limit');
  }
  return threads;
}

function answerText(entry) {
  const markdown = (entry.blocks ?? []).find(block => block?.markdown_block)?.markdown_block;
  if (typeof markdown?.answer === 'string' && markdown.answer.trim()) return markdown.answer;
  if (Array.isArray(markdown?.chunks)) return markdown.chunks.join('').trim();
  return '';
}

/** A thread's entries come back oldest first in pages; long threads span
 * several. `has_next_page` is authoritative when present, otherwise a full
 * page means there may be more. */
async function readThreadEntries(slug) {
  const entries = [];
  const seenPages = new Set();
  for (let page = 0, offset = 0; page < MAX_PAGES; page++, offset += ENTRY_PAGE_SIZE) {
    if (offset > 0) await sleepWithJitter(THROTTLE_MS, 400);
    const url = `${BASE}/rest/thread/${encodeURIComponent(slug)}?with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=${ENTRY_PAGE_SIZE}&offset=${offset}&from_first=true`;
    const data = await fetchJson(url, { headers });
    if (!Array.isArray(data?.entries)) throw new Error(`Perplexity returned malformed detail for ${slug}`);
    const pageEntries = data.entries;
    const signature = JSON.stringify(
      pageEntries.map(entry => entry?.uuid ?? entry?.id ?? [entry?.query_str, entry?.updated_datetime])
    );
    if (pageEntries.length && seenPages.has(signature)) throw new Error(`Perplexity repeated detail page for ${slug}`);
    seenPages.add(signature);
    entries.push(...pageEntries);
    const hasNext =
      typeof data.has_next_page === 'boolean' ? data.has_next_page : pageEntries.length >= ENTRY_PAGE_SIZE;
    if (!hasNext || pageEntries.length === 0) return entries;
  }
  throw new Error(`Perplexity detail exceeded its safety page limit for ${slug}`);
}

async function readThread(summary) {
  const entries = await readThreadEntries(summary.slug);
  const messages = [];
  for (const entry of entries) {
    const createdAt = toMs(entry.updated_datetime ?? entry.entry_updated_datetime) ?? summary.updatedAt;
    if (typeof entry.query_str === 'string' && entry.query_str.trim()) {
      messages.push({ role: 'user', content: entry.query_str, createdAt, model: null, parts: [textPart(entry.query_str)] });
    }
    const answer = answerText(entry);
    if (answer) {
      messages.push({ role: 'assistant', content: answer, createdAt, model: entry.display_model ?? null, parts: [textPart(answer)] });
    }
  }
  if (!messages.length) throw new Error(`Perplexity returned no parseable messages for ${summary.slug}`);
  const externalId = String(summary.context_uuid ?? summary.uuid ?? summary.slug);
  return {
    externalId,
    title: summary.title ?? null,
    createdAt: summary.updatedAt ?? messages[0].createdAt ?? Date.now(),
    updatedAt: summary.updatedAt,
    model: summary.display_model ?? null,
    provider: 'perplexity',
    messages,
    metadata: { url: `${BASE}/search/${summary.slug}`, slug: summary.slug },
  };
}

export async function syncPerplexity({ state, push, register = async () => {}, log, report = async () => {} }) {
  await report({ phase: 'discovering' });
  const lastSyncMs = state?.lastSyncMs ?? null;
  await register('perplexity-web', 'perplexity');
  const since = lastSyncMs ? lastSyncMs - OVERLAP_MS : null;
  const runStartedMs = Date.now();
  const summaries = await listThreads(since);
  await report({ phase: 'importing', detected: summaries.length, processed: 0 });
  const failures = createFailureTracker(state?.failed);
  let total = 0;
  let processed = 0;
  let batch = [];
  let first = true;
  for (const summary of summaries) {
    processed++;
    if (failures.shouldSkip(summary.slug, summary.updatedAt)) continue;
    if (!first) await sleepWithJitter(THROTTLE_MS, 400);
    first = false;
    try {
      batch.push(await readThread(summary));
      failures.recordSuccess(summary.slug);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        if (batch.length) total += await push('perplexity-web', 'perplexity', batch);
        throw error;
      }
      const skipped = failures.recordFailure(summary.slug, summary.updatedAt, error);
      log(`perplexity: ${skipped ? 'skip-listing' : 'skipping'} thread ${summary.slug}: ${error.message}`);
    }
    await report({ processed });
    if (batch.length >= 10) {
      total += await push('perplexity-web', 'perplexity', batch);
      batch = [];
    }
  }
  if (batch.length) total += await push('perplexity-web', 'perplexity', batch);
  await report({ phase: 'complete', processed });
  return {
    state: {
      lastSyncMs: failures.blocking > 0 ? lastSyncMs : runStartedMs,
      failed: failures.toState(),
    },
    conversations: total,
  };
}

export const perplexityInternals = { answerText, listThreads, readThread };
