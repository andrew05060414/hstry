/**
 * DeepSeek Harness (dsh) adapter for hstry
 *
 * Canonical root: ~/.dsh/sessions
 * Layout:
 *   <workspace-slug>/session-<id>/session.jsonl
 *   <workspace-slug>/session-<id>/session.jsonl.zstd
 *
 * Logs are SessionEvent JSONL. The first line may be a persistence header
 * `{ type: "session", id, createdAt, cwd }`. Surface events:
 *   user/message, assistant/message, tool/call, tool/result
 *
 * Default encoding is concatenated zstd frames (Node 22+ zlib.zstd).
 */

import { readdir, readFile, stat } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import * as zlib from 'node:zlib';
import type {
  Adapter,
  AdapterInfo,
  Conversation,
  Message,
  ParseOptions,
} from '../types/index.ts';
import {
  runAdapter,
  textOnlyParts,
  toolCallPart,
  toolResultPart,
  isUnderCanonicalRoot,
} from '../types/index.ts';
import { findFirstRealUserMessage, formatFrumTitle } from '../types/first-message.ts';

const DEFAULT_DSH_PATH = join(homedir(), '.dsh', 'sessions');

interface SessionHeader {
  type?: string;
  id?: string;
  createdAt?: number;
  cwd?: string;
  agentPreset?: string;
}

interface SessionEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
}

const adapter: Adapter = {
  info(): AdapterInfo {
    return {
      name: 'dsh',
      displayName: 'DeepSeek Harness',
      version: '1.0.0',
      defaultPaths: [DEFAULT_DSH_PATH],
    };
  },

  async detect(path: string): Promise<number | null> {
    if (!isUnderCanonicalRoot(path, DEFAULT_DSH_PATH)) return null;
    const files = await findSessionLogs(path, true);
    return files.length > 0 ? 0.9 : null;
  },

  async parse(path: string, opts?: ParseOptions): Promise<Conversation[]> {
    const files = await findSessionLogs(path, false);
    const conversations: Conversation[] = [];
    for (const filePath of files) {
      const conv = await parseSessionLog(filePath, opts);
      if (conv) conversations.push(conv);
      if (opts?.limit && conversations.length >= opts.limit) break;
    }
    conversations.sort((a, b) => b.createdAt - a.createdAt);
    return conversations;
  },
};

function isSessionLogName(name: string): boolean {
  return name === 'session.jsonl' || name === 'session.jsonl.zstd';
}

async function findSessionLogs(path: string, shallowOnly: boolean): Promise<string[]> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return [];
  if (stats.isFile()) {
    return isSessionLogName(basename(path)) ? [path] : [];
  }
  const files: string[] = [];
  await walk(path, files, shallowOnly ? 4 : 8);
  files.sort();
  return files;
}

async function walk(dir: string, files: string[], maxDepth: number): Promise<void> {
  if (maxDepth <= 0) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files, maxDepth - 1);
      continue;
    }
    if (entry.isFile() && isSessionLogName(entry.name)) {
      files.push(entryPath);
    }
  }
}

async function parseSessionLog(
  filePath: string,
  opts?: ParseOptions,
): Promise<Conversation | null> {
  const buf = await readFile(filePath).catch(() => null);
  if (!buf || buf.length === 0) return null;

  const text = filePath.endsWith('.zstd')
    ? await decompressZstd(buf)
    : buf.toString('utf8');
  if (!text.trim()) return null;

  let header: SessionHeader | undefined;
  const messages: Message[] = [];
  let createdAt = 0;
  let updatedAt = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === 'session' && !('seq' in parsed)) {
      header = parsed as SessionHeader;
      if (typeof header.createdAt === 'number') {
        createdAt = Math.floor(header.createdAt);
      }
      continue;
    }

    const event = parsed as SessionEvent;
    const ts = Math.floor(typeof event.time === 'number' ? event.time : createdAt || Date.now());
    if (!createdAt) createdAt = ts;
    if (ts > updatedAt) updatedAt = ts;

    const msg = eventToMessage(event, ts);
    if (msg) messages.push(msg);
  }

  if (messages.length === 0) return null;
  if (!createdAt) createdAt = messages[0]?.createdAt ?? Date.now();
  if (!updatedAt) updatedAt = createdAt;
  if (opts?.since && createdAt < opts.since && updatedAt < opts.since) return null;

  const frum = findFirstRealUserMessage(
    messages.map(m => ({ role: m.role, content: m.content })),
  );
  const idFromDir = basename(filePath.replace(/[/\\]session\.jsonl(?:\.zstd)?$/, ''));

  return {
    externalId: header?.id ?? idFromDir,
    title: frum ? formatFrumTitle(frum) : undefined,
    createdAt: Math.floor(createdAt),
    updatedAt: Math.floor(updatedAt),
    workspace: header?.cwd,
    provider: 'deepseek',
    messages,
    metadata: {
      file: filePath,
      agentPreset: header?.agentPreset,
    },
  };
}

function eventToMessage(event: SessionEvent, ts: number): Message | null {
  const type = event.type ?? '';
  const data = event.data ?? {};

  if (type === 'user/message') {
    const text = messageText(data);
    if (!text.trim()) return null;
    return {
      role: 'user',
      content: text,
      parts: textOnlyParts(text),
      createdAt: ts,
    };
  }

  if (type === 'assistant/message') {
    const nested = (data.message as Record<string, unknown> | undefined) ?? data;
    const text = messageText(nested);
    if (!text.trim()) return null;
    const model = typeof nested.model === 'string' ? nested.model : undefined;
    return {
      role: 'assistant',
      content: text,
      parts: textOnlyParts(text),
      createdAt: ts,
      model,
    };
  }

  if (type === 'tool/call') {
    const name = String(data.name ?? 'tool');
    const args = data.arguments;
    const content = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    return {
      role: 'assistant',
      content,
      parts: [toolCallPart(String(data.callId ?? `seq-${event.seq}`), name, tryJson(content))],
      createdAt: ts,
      toolCalls: [{ toolName: name, input: tryJson(content), status: 'pending' }],
    };
  }

  if (type === 'tool/result') {
    const nested = (data.message as Record<string, unknown> | undefined) ?? data;
    const text = messageText(nested) || JSON.stringify(nested);
    const name = String(nested.name ?? data.name ?? 'tool');
    return {
      role: 'tool',
      content: text,
      parts: [toolResultPart(String(data.callId ?? nested.callId ?? `seq-${event.seq}`), text, { name })],
      createdAt: ts,
      toolCalls: [{ toolName: name, output: text, status: 'success' }],
    };
  }

  return null;
}

function messageText(data: Record<string, unknown>): string {
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.content)) {
    return data.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: string }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  if (typeof data.text === 'string') return data.text;
  return '';
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function decompressZstd(buf: Buffer): Promise<string> {
  const sync = (zlib as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
  if (typeof sync !== 'function') {
    return buf.toString('utf8');
  }

  try {
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < buf.length) {
      offset = skipToZstdMagic(buf, offset);
      if (offset < 0) break;
      const end = zstdFrameEnd(buf, offset);
      parts.push(Buffer.from(sync(buf.subarray(offset, end))));
      offset = end;
    }
    if (parts.length) return Buffer.concat(parts).toString('utf8');
  } catch {
    // fall through
  }

  try {
    return Buffer.from(sync(buf)).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function skipToZstdMagic(buf: Buffer, from: number): number {
  const idx = buf.indexOf(ZSTD_MAGIC, from);
  return idx;
}

/** Return the exclusive end offset of the zstd frame starting at `offset`. */
function zstdFrameEnd(buf: Buffer, offset: number): number {
  if (offset + 5 > buf.length) {
    throw new RangeError('truncated zstd magic');
  }
  let i = offset + 4;
  const desc = buf[i++];
  const fcsFlag = desc >>> 6;
  const singleSegment = (desc & 0x20) !== 0;
  const contentChecksum = (desc & 0x04) !== 0;
  const dictIdFlag = desc & 0x03;

  if (!singleSegment) i += 1;
  i += [0, 1, 2, 4][dictIdFlag] ?? 0;
  let fcsBytes = [0, 2, 4, 8][fcsFlag] ?? 0;
  if (singleSegment && fcsFlag === 0) fcsBytes = 1;
  i += fcsBytes;

  while (i + 3 <= buf.length) {
    const header = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
    i += 3;
    const last = (header & 1) !== 0;
    const size = header >>> 3;
    i += size;
    if (last) break;
  }
  if (contentChecksum) i += 4;
  if (i > buf.length) {
    throw new RangeError('truncated zstd frame');
  }
  return i;
}

runAdapter(adapter);
