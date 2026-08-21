/**
 * Antigravity adapter for hstry
 *
 * Sources (all adapter name `antigravity`):
 *   ~/.gemini/tmp                  — legacy Gemini CLI JSONL (session-*.jsonl)
 *   ~/.gemini/antigravity          — Antigravity 2.0 app (conversations/*.db)
 *   ~/.gemini/antigravity-cli      — agy CLI (same SQLite schema)
 *   ~/.gemini/antigravity-ide      — IDE 1 leftovers (*.pb + optional brain JSONL)
 *
 * SQLite `step_payload` is protobuf. Brain transcript.jsonl is a display fallback.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import type {
  Adapter,
  AdapterInfo,
  CanonPart,
  Conversation,
  Message,
  ParseOptions,
} from '../types/index.ts';
import {
  runAdapter,
  textPart,
  thinkingPart,
  textOnlyParts,
  toolCallPart,
  toolResultPart,
  isUnderAnyCanonicalRoot,
} from '../types/index.ts';
import { findFirstRealUserMessage, formatFrumTitle, isSystemContext } from '../types/first-message.ts';
import {
  extractAgentText,
  extractTimestampMs,
  extractTitle,
  extractToolCall,
  extractUserText,
  toUint8,
} from './protobuf.ts';

const HOME = homedir();
const ROOT_TMP = join(HOME, '.gemini', 'tmp');
const ROOT_APP = join(HOME, '.gemini', 'antigravity');
const ROOT_CLI = join(HOME, '.gemini', 'antigravity-cli');
const ROOT_IDE = join(HOME, '.gemini', 'antigravity-ide');
const CANONICAL_ROOTS = [ROOT_TMP, ROOT_APP, ROOT_CLI, ROOT_IDE];

const STEP_USER = 14;
const STEP_ASSISTANT = 15;
const STEP_TITLE = 23;

let openDb: ((path: string) => SqliteDb) | null = null;

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}

try {
  if (typeof Bun !== 'undefined') {
    // @ts-ignore Bun-only
    const { Database: BunDb } = await import('bun:sqlite');
    openDb = (path: string) => new BunDb(path, { readonly: true }) as unknown as SqliteDb;
  } else {
    const mod = await import('better-sqlite3');
    const BetterSqlite = mod.default;
    openDb = (path: string) => BetterSqlite(path, { readonly: true }) as unknown as SqliteDb;
  }
} catch {
  openDb = null;
}

declare const Bun: unknown;

const adapter: Adapter = {
  info(): AdapterInfo {
    return {
      name: 'antigravity',
      displayName: 'Antigravity',
      version: '2.0.0',
      defaultPaths: CANONICAL_ROOTS,
    };
  },

  async detect(path: string): Promise<number | null> {
    if (!isUnderAnyCanonicalRoot(path, CANONICAL_ROOTS)) return null;
    if (isUnderTmp(path)) {
      const files = await findSessionFiles(path, { shallowOnly: true });
      return files.length > 0 ? 0.85 : null;
    }
    const dbs = await findStoreFiles(path);
    return dbs.length > 0 ? 0.9 : null;
  },

  async parse(path: string, opts?: ParseOptions): Promise<Conversation[]> {
    const jsonl = await parseJsonlRoot(path, opts);
    const remaining = opts?.limit ? Math.max(0, opts.limit - jsonl.length) : undefined;
    const storeOpts = remaining === undefined ? opts : { ...opts, limit: remaining };
    const store = remaining === 0 ? [] : await parseStoreRoot(path, storeOpts);
    const conversations = [...jsonl, ...store];
    conversations.sort((a, b) => b.createdAt - a.createdAt);
    return opts?.limit ? conversations.slice(0, opts.limit) : conversations;
  },
};

function isUnderTmp(path: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(path);
  const r = norm(ROOT_TMP);
  return c === r || c.startsWith(r + '/');
}

// --- legacy Gemini CLI JSONL ------------------------------------------------

interface SessionHeader {
  sessionId?: string;
  kind?: string;
  startTime?: string;
  lastUpdated?: string;
}

interface CliMessage {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: string | Array<{ text?: string }>;
  thoughts?: Array<{ subject?: string; description?: string; timestamp?: string }>;
  model?: string;
}

interface SetEnvelope {
  $set?: {
    messages?: CliMessage[];
    lastUpdated?: string;
  };
}

async function parseJsonlRoot(path: string, opts?: ParseOptions): Promise<Conversation[]> {
  const files = await findSessionFiles(path, { shallowOnly: false });
  if (files.length === 0) return [];

  const conversations: Conversation[] = [];
  for (const filePath of files) {
    const conv = await parseSessionFile(filePath, opts);
    if (conv) conversations.push(conv);
    if (opts?.limit && conversations.length >= opts.limit) break;
  }
  conversations.sort((a, b) => b.createdAt - a.createdAt);
  return conversations;
}

async function parseSessionFile(
  filePath: string,
  opts?: ParseOptions,
): Promise<Conversation | null> {
  const raw = await readFile(filePath, 'utf-8').catch(() => null);
  if (!raw) return null;

  let header: SessionHeader | undefined;
  const cliMessages: CliMessage[] = [];
  const seenIds = new Set<string>();
  let skippedLogs = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if ('$set' in parsed) {
      const envelope = parsed as SetEnvelope;
      for (const msg of envelope.$set?.messages ?? []) {
        ingestCliMessage(msg, cliMessages, seenIds);
      }
      continue;
    }

    if (parsed.kind === 'main' && parsed.sessionId) {
      header = parsed as SessionHeader;
      continue;
    }

    const msgType = parsed.type as string | undefined;
    if (msgType === 'warning' || msgType === 'info' || msgType === 'error') {
      skippedLogs++;
      continue;
    }

    if (msgType === 'user' || msgType === 'gemini') {
      ingestCliMessage(parsed as CliMessage, cliMessages, seenIds);
    }
  }

  if (cliMessages.length === 0) return null;

  const externalId = header?.sessionId ?? basename(filePath, '.jsonl');
  const createdAt = parseIso(header?.startTime)
    ?? parseIso(cliMessages[0]?.timestamp)
    ?? Date.now();
  let updatedAt = parseIso(header?.lastUpdated) ?? createdAt;
  let model: string | undefined;

  const messages: Message[] = [];

  for (const cli of cliMessages) {
    const ts = parseIso(cli.timestamp) ?? createdAt;
    if (ts > updatedAt) updatedAt = ts;

    if (cli.type === 'user') {
      const text = extractContent(cli.content);
      if (!text.trim()) continue;
      if (isSessionBootstrap(text)) continue;
      messages.push({
        role: 'user',
        content: text,
        parts: textOnlyParts(text),
        createdAt: ts,
      });
      continue;
    }

    if (cli.type === 'gemini') {
      const text = extractContent(cli.content);
      const parts: CanonPart[] = [];
      const thinking = formatThoughts(cli.thoughts);
      if (thinking) parts.push(thinkingPart(thinking));
      if (text.trim()) parts.push(textPart(text));
      if (parts.length === 0) continue;

      messages.push({
        role: 'assistant',
        content: text,
        parts,
        createdAt: ts,
        model: cli.model,
      });
      if (cli.model) model = cli.model;
    }
  }

  if (messages.length === 0) return null;

  if (opts?.since && createdAt < opts.since && updatedAt < opts.since) {
    return null;
  }

  const frum = findFirstRealUserMessage(
    messages.map(m => ({ role: m.role, content: m.content })),
  );
  const title = frum ? formatFrumTitle(frum) : undefined;

  return {
    externalId,
    title,
    createdAt,
    updatedAt,
    model,
    provider: 'google',
    messages,
    metadata: {
      file: filePath,
      surface: 'gemini-cli-jsonl',
      skippedLogs,
    },
  };
}

function ingestCliMessage(
  msg: CliMessage,
  out: CliMessage[],
  seenIds: Set<string>,
): void {
  const id = msg.id;
  if (id) {
    if (seenIds.has(id)) return;
    seenIds.add(id);
  }
  if (msg.type === 'user' || msg.type === 'gemini') {
    out.push(msg);
  }
}

function extractContent(content?: string | Array<{ text?: string }>): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map(block => block.text ?? '').join('\n');
}

function formatThoughts(
  thoughts?: Array<{ subject?: string; description?: string }>,
): string {
  if (!thoughts?.length) return '';
  return thoughts
    .map(t => {
      const subject = t.subject?.trim();
      const description = t.description?.trim();
      if (subject && description) return `**${subject}**\n${description}`;
      return subject ?? description ?? '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function isSessionBootstrap(text: string): boolean {
  if (text.includes('<session_context>')) return true;
  return isSystemContext(text);
}

function parseIso(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isSessionFile(name: string): boolean {
  return name.startsWith('session-') && name.endsWith('.jsonl');
}

async function findSessionFiles(
  path: string,
  opts: { shallowOnly: boolean },
): Promise<string[]> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return [];

  if (stats.isFile()) {
    return isSessionFile(basename(path)) ? [path] : [];
  }
  if (!stats.isDirectory()) return [];

  const files: string[] = [];
  await walkDir(path, files, opts.shallowOnly ? 4 : 12, (name) => isSessionFile(name));
  files.sort();
  return files;
}

async function walkDir(
  dir: string,
  files: string[],
  maxDepth: number,
  accept: (name: string) => boolean,
): Promise<void> {
  if (maxDepth <= 0) return;

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(entryPath, files, maxDepth - 1, accept);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!accept(entry.name)) continue;
    files.push(entryPath);
  }
}

// --- Antigravity 2.0 / agy CLI / IDE 1 store --------------------------------

interface StoreRef {
  id: string;
  dbPath?: string;
  pbPath?: string;
  surface: 'app' | 'cli' | 'ide' | 'store';
}

async function parseStoreRoot(path: string, opts?: ParseOptions): Promise<Conversation[]> {
  const refs = await findStoreFiles(path);
  const conversations: Conversation[] = [];
  for (const ref of refs) {
    const conv = await parseStoreRef(path, ref, opts);
    if (conv) conversations.push(conv);
    if (opts?.limit && conversations.length >= opts.limit) break;
  }
  conversations.sort((a, b) => b.createdAt - a.createdAt);
  return conversations;
}

async function findStoreFiles(path: string): Promise<StoreRef[]> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return [];

  if (stats.isFile()) {
    const name = basename(path);
    const id = name.replace(/\.(db|pb)$/i, '');
    if (name.endsWith('.db')) return [{ id, dbPath: path, surface: surfaceOf(path) }];
    if (name.endsWith('.pb')) return [{ id, pbPath: path, surface: surfaceOf(path) }];
    return [];
  }

  const convDir = existsSync(join(path, 'conversations'))
    ? join(path, 'conversations')
    : path;

  const entries = await readdir(convDir, { withFileTypes: true }).catch(() => []);
  const byId = new Map<string, StoreRef>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(convDir, entry.name);
    if (entry.name.endsWith('.db-wal') || entry.name.endsWith('.db-shm')) continue;
    if (entry.name.endsWith('.db')) {
      const id = entry.name.slice(0, -3);
      const existing = byId.get(id) ?? { id, surface: surfaceOf(path) };
      existing.dbPath = full;
      byId.set(id, existing);
    } else if (entry.name.endsWith('.pb')) {
      const id = entry.name.slice(0, -3);
      const existing = byId.get(id) ?? { id, surface: surfaceOf(path) };
      existing.pbPath = full;
      byId.set(id, existing);
    }
  }
  return [...byId.values()];
}

function surfaceOf(path: string): StoreRef['surface'] {
  const n = path.replace(/\\/g, '/').toLowerCase();
  if (n.includes('antigravity-cli')) return 'cli';
  if (n.includes('antigravity-ide')) return 'ide';
  if (n.includes('/antigravity')) return 'app';
  return 'store';
}

async function parseStoreRef(
  root: string,
  ref: StoreRef,
  opts?: ParseOptions,
): Promise<Conversation | null> {
  let conv: Conversation | null = null;
  if (ref.dbPath && openDb) {
    conv = parseSqliteConversation(ref, root);
  }
  if (!conv || conv.messages.length === 0) {
    const fromBrain = await parseBrainTranscript(root, ref.id, ref.surface);
    if (fromBrain) conv = fromBrain;
  }
  if (!conv) return null;
  if (opts?.since && conv.createdAt < opts.since && (conv.updatedAt ?? conv.createdAt) < opts.since) {
    return null;
  }
  return conv;
}

interface StepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: unknown;
  step_payload: unknown;
}

function parseSqliteConversation(ref: StoreRef, root: string): Conversation | null {
  if (!ref.dbPath || !openDb) return null;
  let db: SqliteDb;
  try {
    db = openDb(ref.dbPath);
  } catch {
    return null;
  }

  try {
    const meta = db.prepare(
      'SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1',
    ).get() as { cascade_id?: string; trajectory_id?: string } | undefined;
    const externalId = meta?.cascade_id || ref.id;

    const rows = db.prepare(
      'SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx',
    ).all() as StepRow[];

    const messages: Message[] = [];
    let title: string | undefined;
    const knownTs: number[] = [];

    for (const row of rows) {
      const payload = toUint8(row.step_payload);
      const metaBytes = toUint8(row.metadata);
      const ts = extractTimestampMs(metaBytes, payload);
      if (ts !== undefined) knownTs.push(ts);

      if (row.step_type === STEP_TITLE) {
        title = extractTitle(payload) ?? title;
        continue;
      }

      if (row.step_type === STEP_USER) {
        const text = extractUserText(payload);
        if (!text?.trim()) continue;
        messages.push({
          role: 'user',
          content: text,
          parts: textOnlyParts(text),
          createdAt: ts,
        });
        continue;
      }

      if (row.step_type === STEP_ASSISTANT) {
        const text = extractAgentText(payload) ?? '';
        const tool = extractToolCall(payload);
        const parts: CanonPart[] = [];
        if (text.trim()) parts.push(textPart(text));
        if (tool) {
          parts.push(toolCallPart(`step-${row.idx}`, tool.name || 'tool', tryJson(tool.inputJson)));
        }
        if (parts.length === 0) continue;
        messages.push({
          role: 'assistant',
          content: text,
          parts,
          createdAt: ts,
        });
        continue;
      }

      const tool = extractToolCall(payload);
      if (tool) {
        messages.push({
          role: 'tool',
          content: tool.inputJson || tool.name,
          parts: [toolResultPart(`step-${row.idx}`, tool.inputJson, { name: tool.name })],
          createdAt: ts,
          toolCalls: [{ toolName: tool.name, input: tryJson(tool.inputJson), status: 'success' }],
        });
      }
    }

    if (messages.length === 0) return null;
    const fallback = knownTs.length > 0 ? Math.min(...knownTs) : Date.now();
    const createdAt = Math.floor(fallback);
    const updatedAt = Math.floor(knownTs.length > 0 ? Math.max(...knownTs) : fallback);
    for (const msg of messages) {
      msg.createdAt = Math.floor(msg.createdAt ?? fallback);
    }

    const frum = findFirstRealUserMessage(
      messages.map(m => ({ role: m.role, content: m.content })),
    );
    title ??= frum ? formatFrumTitle(frum) : undefined;

    return {
      externalId,
      title,
      createdAt: Math.floor(createdAt),
      updatedAt: Math.floor(updatedAt),
      provider: 'google',
      messages,
      metadata: {
        file: ref.dbPath,
        surface: ref.surface,
        store: 'sqlite',
      },
    };
  } finally {
    db.close();
  }
}

function tryJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface BrainLine {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  thinking?: string;
  tool_calls?: Array<{ name?: string; args?: unknown }>;
}

async function parseBrainTranscript(
  root: string,
  id: string,
  surface: StoreRef['surface'],
): Promise<Conversation | null> {
  const storeRoot = existsSync(join(root, 'brain')) ? root : dirname(root);
  const transcript = join(
    storeRoot,
    'brain',
    id,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  const raw = await readFile(transcript, 'utf-8').catch(() => null);
  if (!raw) return null;

  const messages: Message[] = [];
  let createdAt = 0;
  let updatedAt = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: BrainLine;
    try {
      parsed = JSON.parse(trimmed) as BrainLine;
    } catch {
      continue;
    }
    const ts = parseIso(parsed.created_at) ?? Date.now();
    if (!createdAt) createdAt = ts;
    if (ts > updatedAt) updatedAt = ts;

    const type = parsed.type ?? '';
    if (type === 'USER_INPUT' || parsed.source === 'USER_EXPLICIT') {
      const text = stripUserEnvelope(parsed.content ?? '');
      if (!text.trim()) continue;
      messages.push({
        role: 'user',
        content: text,
        parts: textOnlyParts(text),
        createdAt: ts,
      });
      continue;
    }
    if (type === 'CHECKPOINT' || type === 'SYSTEM_MESSAGE') continue;
    if (type === 'GENERIC') {
      const text = (parsed.content ?? '').trim();
      if (!text) continue;
      messages.push({
        role: 'tool',
        content: text.slice(0, 8000),
        parts: [toolResultPart(`brain-${parsed.step_index ?? messages.length}`, text.slice(0, 8000))],
        createdAt: ts,
      });
      continue;
    }
    if (type === 'PLANNER_RESPONSE' || parsed.source === 'MODEL') {
      const text = (parsed.content ?? '').trim();
      const thinking = (parsed.thinking ?? '').trim();
      const parts: CanonPart[] = [];
      if (thinking) parts.push(thinkingPart(thinking));
      if (text) parts.push(textPart(text));
      if (parsed.tool_calls?.length) {
        for (const [i, call] of parsed.tool_calls.entries()) {
          parts.push(toolCallPart(
            `brain-${parsed.step_index ?? 0}-${i}`,
            call.name || 'tool',
            call.args,
          ));
        }
      }
      if (parts.length === 0) continue;
      messages.push({
        role: 'assistant',
        content: text,
        parts,
        createdAt: ts,
      });
    }
  }

  if (messages.length === 0) return null;
  const frum = findFirstRealUserMessage(
    messages.map(m => ({ role: m.role, content: m.content })),
  );

  return {
    externalId: id,
    title: frum ? formatFrumTitle(frum) : undefined,
    createdAt: Math.floor(createdAt),
    updatedAt: Math.floor(updatedAt),
    provider: 'google',
    messages,
    metadata: {
      file: transcript,
      surface,
      store: 'brain-transcript',
    },
  };
}

function stripUserEnvelope(text: string): string {
  return text
    .replace(/<USER_REQUEST>\s*/g, '')
    .replace(/\s*<\/USER_REQUEST>[\s\S]*$/g, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*$/g, '')
    .trim();
}

runAdapter(adapter);
