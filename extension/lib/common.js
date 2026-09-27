// Shared helpers for hstry sync providers.

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
 * GET/POST JSON with retry-and-backoff on rate limits (429) and transient
 * server errors (502/503). Honors the `Retry-After` header when present,
 * otherwise uses exponential backoff with jitter. 401/403 fail fast as
 * "not logged in" — retrying those is pointless.
 */
export async function fetchJson(url, init = {}, { retries = 2, baseDelayMs = 1000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: 'include', ...init });

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
        throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} (gave up after ${retries} retries)`);
      }
      const backoffMs = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 500);
      await sleep(Math.min(MAX_BACKOFF_MS, backoffMs));
      continue;
    }

    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status}`);
    }
    return res.json();
  }
}

export function extractRetryAfter(response) {
  return retryAfterMilliseconds(response.headers?.get('retry-after'));
}

export class RateLimitedError extends Error {
  constructor(message, { retryAfterMs = null, status = 429 } = {}) {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
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
