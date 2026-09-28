// Shared helpers for Chronicle web capture providers.

let partCounter = 0;

export function textPart(text) {
  return { id: `p-${++partCounter}`, type: 'text', text };
}

export function thinkingPart(text) {
  return { id: `p-${++partCounter}`, type: 'thinking', text };
}

export function toolCallPart(toolCallId, name, input) {
  return { id: `p-${++partCounter}`, type: 'tool_call', toolCallId, name, input };
}

export function toolResultPart(toolCallId, output) {
  return { id: `p-${++partCounter}`, type: 'tool_result', toolCallId, output };
}

export class NotLoggedInError extends Error {
  constructor(service) {
    super(`${service}: not logged in`);
    this.name = 'NotLoggedInError';
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function sleepWithJitter(baseMs, jitterMs = 300) {
  const jitter = Math.floor((Math.random() * 2 - 1) * jitterMs);
  return sleep(Math.max(100, baseMs + jitter));
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function assertNotCloudflareChallenge(response, provider) {
  if (response.headers?.get('cf-mitigated')?.toLowerCase() === 'challenge') {
    throw new RateLimitedError(`${provider} request blocked by Cloudflare challenge`, { status: 403 });
  }
}

/** Cap on how long we honor a server-provided Retry-After (ms). */
const MAX_BACKOFF_MS = 60_000;

/**
 * fetch() with retry-and-backoff on rate limits (429) and transient server
 * errors (502/503). Honors the `Retry-After` header when present, otherwise
 * uses exponential backoff with jitter. 401/403 fail fast as "not logged in"
 * — retrying those is pointless. Other non-2xx statuses throw HttpError.
 * `timeoutMs` bounds each attempt separately.
 */
export async function fetchWithBackoff(
  url,
  init = {},
  { retries = 2, baseDelayMs = 1000, timeoutMs = null } = {}
) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    assertNotCloudflareChallenge(res, new URL(url).hostname);

    if (res.status === 401 || res.status === 403) {
      throw new NotLoggedInError(new URL(url).hostname);
    }

    if (res.status === 429) {
      const retryAfterMs = retryAfterMilliseconds(res.headers.get('retry-after'));

      // If retry-after is substantial (> 2s), or attempt >= retries, fail fast as RateLimitedError
      // so the provider circuit breaker can immediately enter a protective cooldown.
      if (attempt >= retries || (retryAfterMs !== null && retryAfterMs > 2000)) {
        throw new RateLimitedError(
          `${init.method ?? 'GET'} ${url} -> 429 Too Many Requests`,
          { retryAfterMs, status: 429 }
        );
      }

      const backoffMs = retryAfterMs ?? (baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500));
      await sleep(Math.min(MAX_BACKOFF_MS, backoffMs));
      continue;
    }

    if (res.status === 502 || res.status === 503) {
      if (attempt >= retries) {
        throw new HttpError(
          `${init.method ?? 'GET'} ${url} -> ${res.status} (gave up after ${retries} retries)`,
          res.status
        );
      }
      const backoffMs = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500);
      await sleep(Math.min(MAX_BACKOFF_MS, backoffMs));
      continue;
    }

    if (!res.ok) {
      throw new HttpError(`${init.method ?? 'GET'} ${url} -> ${res.status}`, res.status);
    }
    return res;
  }
}

/** GET/POST JSON through fetchWithBackoff. */
export async function fetchJson(url, init = {}, options = {}) {
  const res = await fetchWithBackoff(url, init, options);
  return res.json();
}

export class RateLimitedError extends Error {
  constructor(message, { retryAfterMs = null, status = 429 } = {}) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Statuses that mean the conversation is gone for good (deleted, revoked). */
const GONE_STATUSES = new Set([404, 410]);
/** Deterministic failures (bad shape, 400/422) are retried this many runs. */
const MAX_FAILED_ATTEMPTS = 3;
/** Bound the persisted skip list so chrome.storage stays small. */
const MAX_FAILED_ENTRIES = 500;

/** Failures that say nothing about the conversation itself: retry them
 * forever (holding the watermark) without counting an attempt. */
function isTransient(err) {
  if (err instanceof RateLimitedError || err instanceof NotLoggedInError) return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  if (err instanceof TypeError) return true; // fetch() network failure
  return err instanceof HttpError && (err.status === 429 || err.status >= 500);
}

/**
 * Tracks per-conversation failures across runs so one broken conversation
 * cannot pin a provider's incremental watermark forever.
 *
 * - Transient failures (429, 5xx, network, logged out) hold the watermark.
 * - 404/410 put the conversation on the skip list immediately.
 * - Other failures hold the watermark for MAX_FAILED_ATTEMPTS runs, then skip.
 *
 * A skipped conversation is retried as soon as the platform reports a newer
 * update time for it; a full resync clears provider state and the list.
 */
export function createFailureTracker(previous = {}) {
  const failed = { ...(previous && typeof previous === 'object' ? previous : {}) };
  let blocking = 0;
  let skipped = 0;

  return {
    /** True when `id` is on the skip list and has not changed since. */
    shouldSkip(id, updatedMs) {
      const entry = failed[id];
      if (!entry?.skipped) return false;
      if (updatedMs && entry.updatedMs && updatedMs > entry.updatedMs) return false;
      skipped++;
      return true;
    },
    /** Record a failure; returns true when the conversation is now skipped. */
    recordFailure(id, updatedMs, err) {
      if (isTransient(err)) {
        blocking++;
        return false;
      }
      const previousEntry = failed[id];
      const attempts =
        previousEntry && (!updatedMs || previousEntry.updatedMs === updatedMs)
          ? (previousEntry.attempts ?? 0) + 1
          : 1;
      const gone = err instanceof HttpError && GONE_STATUSES.has(err.status);
      const entry = {
        attempts,
        updatedMs: updatedMs ?? null,
        lastError: String(err?.message ?? err).slice(0, 200),
        lastFailedMs: Date.now(),
        skipped: gone || attempts >= MAX_FAILED_ATTEMPTS,
      };
      failed[id] = entry;
      if (entry.skipped) {
        skipped++;
      } else {
        blocking++;
      }
      return entry.skipped;
    },
    recordSuccess(id) {
      delete failed[id];
    },
    /** Failures that must keep the watermark in place this run. */
    get blocking() {
      return blocking;
    },
    /** Conversations skipped (newly or previously) this run. */
    get skipped() {
      return skipped;
    },
    /** Persistable skip list, newest failures first, bounded in size. */
    toState() {
      const entries = Object.entries(failed)
        .sort(([, a], [, b]) => (b.lastFailedMs ?? 0) - (a.lastFailedMs ?? 0))
        .slice(0, MAX_FAILED_ENTRIES);
      return Object.fromEntries(entries);
    },
  };
}

export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds (possibly fractional) vs milliseconds.
    return Math.floor(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function shortId(id) {
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
}
