/**
 * AstrBot adapter for Chronicle / hstry.
 *
 * Reads AstrBot's data_v4.db without ever opening it for writes. The
 * conversations table is the authoritative LLM history. When a platform
 * session has no structured conversation, platform_message_history is used
 * as a lossless-enough fallback so raw QQ/WeChat/WebChat activity is not
 * silently dropped. WebChat side threads are imported as small, searchable
 * conversations of their own.
 */

import { existsSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import type {
  Adapter,
  AdapterInfo,
  Conversation,
  Message,
  MessageRole,
  ParseOptions,
  ParseStreamResult,
  ToolCall,
} from '../types/index.ts';
import { runAdapter, textOnlyParts } from '../types/index.ts';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

let openDb: ((path: string) => SqliteDb) | null = null;

try {
  if (typeof Bun !== 'undefined') {
    // @ts-ignore - bun:sqlite is Bun-only
    const { Database: BunDatabase } = await import('bun:sqlite');
    openDb = (path: string) => new BunDatabase(path, { readonly: true }) as unknown as SqliteDb;
  } else {
    const mod = await import('better-sqlite3');
    const BetterSqlite = mod.default;
    openDb = (path: string) => BetterSqlite(path, { readonly: true }) as unknown as SqliteDb;
  }
} catch {
  // SQLite is optional at adapter load time. detect/parse become no-ops when
  // the selected JavaScript runtime cannot load a SQLite implementation.
}

declare const Bun: unknown;

const DEFAULT_PATHS = [
  '/vol1/@appdata/astrbot/data',
  join(homedir(), 'astrbot', 'data'),
  join(homedir(), '.astrbot', 'data'),
  '/app/data',
  './data',
];

const STRUCTURED_TABLE = 'conversations';
const PLATFORM_HISTORY_TABLE = 'platform_message_history';
const WEBCHAT_THREADS_TABLE = 'webchat_threads';

type Row = Record<string, unknown>;

const adapter: Adapter = {
  info(): AdapterInfo {
    return {
      name: 'astrbot',
      displayName: 'AstrBot',
      version: '1.0.0',
      defaultPaths: DEFAULT_PATHS,
    };
  },

  async detect(path: string): Promise<number | null> {
    if (!openDb) return null;

    const dbPath = resolveDbPath(path);
    if (!dbPath) return null;

    let db: SqliteDb | undefined;
    try {
      db = openDb(dbPath);
      const tables = tableNames(db);
      const hasConversations = tables.has(STRUCTURED_TABLE);
      const hasPlatformHistory = tables.has(PLATFORM_HISTORY_TABLE);
      const hasWebChatThreads = tables.has(WEBCHAT_THREADS_TABLE);

      if (hasConversations && hasPlatformHistory) return 0.98;
      if (hasConversations && hasWebChatThreads) return 0.95;
      if (hasConversations) return 0.9;
      if (hasPlatformHistory) return 0.85;
      if (hasWebChatThreads) return 0.75;
    } catch {
      return null;
    } finally {
      db?.close();
    }

    return null;
  },

  async parse(path: string, opts?: ParseOptions): Promise<Conversation[]> {
    if (!openDb) return [];

    const dbPath = resolveDbPath(path);
    if (!dbPath) return [];

    let db: SqliteDb | undefined;
    try {
      db = openDb(dbPath);
      const tables = tableNames(db);
      const conversations: Conversation[] = [];
      const structuredSessionKeys = new Set<string>();

      if (tables.has(STRUCTURED_TABLE)) {
        for (const row of tableRows(db, STRUCTURED_TABLE)) {
          const conversation = buildStructuredConversation(row, opts);
          if (!conversation) continue;
          conversations.push(conversation);
          structuredSessionKeys.add(
            sessionKey(
              metadataString(conversation.metadata, 'platformId'),
              metadataString(conversation.metadata, 'userId'),
            ),
          );
        }
      }

      if (tables.has(PLATFORM_HISTORY_TABLE)) {
        conversations.push(
          ...buildPlatformHistoryConversations(
            tableRows(db, PLATFORM_HISTORY_TABLE),
            structuredSessionKeys,
            opts,
          ),
        );
      }

      if (tables.has(WEBCHAT_THREADS_TABLE)) {
        for (const row of tableRows(db, WEBCHAT_THREADS_TABLE)) {
          const thread = buildWebChatThread(row, opts);
          if (thread) conversations.push(thread);
        }
      }

      conversations.sort(compareConversations);
      return opts?.limit && opts.limit > 0
        ? conversations.slice(0, opts.limit)
        : conversations;
    } catch (err) {
      console.error('Error reading AstrBot database:', err);
      return [];
    } finally {
      db?.close();
    }
  },

  supportsIncremental: true,

  async parseSince(path: string, since: number): Promise<Conversation[]> {
    return adapter.parse(path, { since });
  },

  async parseStream(path: string, opts?: ParseOptions): Promise<ParseStreamResult> {
    const all = await adapter.parse(path, opts);
    const batchSize = Math.max(1, Math.floor(opts?.batchSize ?? 200));
    const offset = cursorOffset(opts?.cursor);
    const conversations = all.slice(offset, offset + batchSize);
    const nextOffset = offset + conversations.length;
    const done = nextOffset >= all.length;

    return {
      conversations,
      cursor: done ? undefined : { offset: nextOffset },
      done,
    };
  },
};

function resolveDbPath(path: string): string | null {
  if (!path) return null;

  if (existsSync(path) && !isDirectory(path)) {
    if (basename(path).toLowerCase().endsWith('.db')) return path;
  }

  const candidates = [
    join(path, 'data_v4.db'),
    join(path, 'data', 'data_v4.db'),
    join(path, 'astrbot', 'data', 'data_v4.db'),
    join(path, 'data', 'astrbot.db'),
  ];

  return candidates.find(candidate => existsSync(candidate) && !isDirectory(candidate)) ?? null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function tableNames(db: SqliteDb): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Row[];
  return new Set(
    rows
      .map(row => stringValue(row.name))
      .filter((name): name is string => Boolean(name)),
  );
}

function tableRows(db: SqliteDb, table: string): Row[] {
  return db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Row[];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function buildStructuredConversation(row: Row, opts?: ParseOptions): Conversation | null {
  const conversationId = firstString(row, ['conversation_id', 'conversationId', 'cid', 'id']);
  if (!conversationId) return null;

  const platformId = firstString(row, ['platform_id', 'platformId', 'platform']) ?? 'unknown';
  const userId = firstString(row, ['user_id', 'userId', 'session_id', 'sessionId']) ?? 'unknown';
  const rowCreatedAt = timestampMs(firstValue(row, ['created_at', 'createdAt']));
  const rowUpdatedAt = timestampMs(firstValue(row, ['updated_at', 'updatedAt']), rowCreatedAt);
  const parsedContent = parseJsonValue(firstValue(row, ['content', 'history', 'messages']));
  const items = structuredMessageItems(parsedContent);
  const messages = items
    .map((item, index) => buildStructuredMessage(item, index, undefined, opts))
    .filter((message): message is Message => Boolean(message));

  if (messages.length === 0) return null;

  const messageTimes = messages
    .map(message => message.createdAt)
    .filter((value): value is number => Number.isInteger(value) && value > 0);
  const createdAt = rowCreatedAt || Math.min(...messageTimes, 0);
  const updatedAt = rowUpdatedAt || Math.max(...messageTimes, createdAt);
  if (isBeforeSince(createdAt, updatedAt, opts?.since)) return null;

  const personaId = firstString(row, ['persona_id', 'personaId']);
  const tokenUsage = numberValue(firstValue(row, ['token_usage', 'tokenUsage']));
  const metadata: Record<string, unknown> = {
    source: 'astrbot',
    sourceTable: STRUCTURED_TABLE,
    conversationId,
    platformId,
    platform: platformLabel(platformId),
    userId,
    personaId,
    tokenUsage,
  };

  return {
    externalId: conversationId,
    title: firstString(row, ['title']) ?? undefined,
    createdAt,
    updatedAt: updatedAt || undefined,
    model: firstString(row, ['model', 'model_id', 'modelId']) ?? undefined,
    messages,
    metadata,
    messageCount: messages.length,
  };
}

function buildStructuredMessage(
  value: unknown,
  index: number,
  fallbackCreatedAt: number | undefined,
  opts?: ParseOptions,
): Message | null {
  const record = asRecord(value);
  const sourceRole = record
    ? stringValue(record.role) ?? stringValue(record.type) ?? stringValue(record.sender_role)
    : undefined;
  const role = mapRole(
    sourceRole,
  );
  const rawContent = record
    ? firstValue(record, ['content', 'message', 'text', 'output'])
    : value;
  const content = contentToText(rawContent);
  const toolCalls = opts?.includeTools === false ? [] : extractToolCalls(record?.tool_calls ?? record?.toolCalls);

  if (!content && toolCalls.length === 0) return null;

  const createdAt = timestampMs(
    record ? firstValue(record, ['created_at', 'createdAt', 'timestamp', 'time']) : undefined,
    fallbackCreatedAt ?? 0,
  );
  const model = record
    ? firstString(record, ['model', 'model_id', 'modelId']) ?? undefined
    : undefined;

  return {
    role,
    content,
    parts: textOnlyParts(content),
    createdAt: createdAt > 0 ? createdAt : undefined,
    model,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    metadata: {
      source: 'astrbot',
      sourceMessageIndex: index,
      sourceRole,
    },
  };
}

function buildPlatformHistoryConversations(
  rows: Row[],
  structuredSessionKeys: Set<string>,
  opts?: ParseOptions,
): Conversation[] {
  const groups = new Map<string, HistoryEntry[]>();

  for (const row of rows) {
    const platformId = firstString(row, ['platform_id', 'platformId', 'platform']) ?? 'unknown';
    const userId = firstString(row, ['user_id', 'userId', 'session_id', 'sessionId']) ?? 'unknown';
    const key = sessionKey(platformId, userId);
    if (structuredSessionKeys.has(key)) continue;

    const message = buildPlatformHistoryMessage(row);
    if (!message) continue;

    const entry = {
      row,
      platformId,
      userId,
      message,
      rowId: numberValue(firstValue(row, ['id', 'inner_id'])) ?? 0,
    };
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const conversations: Conversation[] = [];
  for (const entries of groups.values()) {
    entries.sort(compareHistoryEntries);
    const first = entries[0];
    const last = entries[entries.length - 1];
    const messageTimes = entries
      .map(entry => entry.message.createdAt)
      .filter((value): value is number => Number.isInteger(value) && value > 0);
    const createdAt = Math.min(...messageTimes, 0);
    const updatedAt = Math.max(...messageTimes, createdAt);
    if (isBeforeSince(createdAt, updatedAt, opts?.since)) continue;

    conversations.push({
      externalId: `platform-session:${first.platformId}:${first.userId}`,
      title: first.userId,
      createdAt,
      updatedAt: updatedAt || undefined,
      messages: entries.map(entry => entry.message),
      messageCount: entries.length,
      metadata: {
        source: 'astrbot',
        sourceTable: PLATFORM_HISTORY_TABLE,
        platformId: first.platformId,
        platform: platformLabel(first.platformId),
        userId: first.userId,
        firstHistoryId: first.rowId || undefined,
        lastHistoryId: last.rowId || undefined,
        historyRowCount: entries.length,
      },
    });
  }

  return conversations;
}

function buildPlatformHistoryMessage(row: Row): Message | null {
  const raw = parseJsonValue(firstValue(row, ['content', 'message', 'data']));
  const record = asRecord(raw);
  const role = mapRole(
    stringValue(record?.role) ?? stringValue(record?.type) ?? firstString(row, ['role', 'message_role']),
  );
  const body = record
    ? firstValue(record, ['message', 'content', 'text', 'output'])
    : raw;
  const content = contentToText(body);
  if (!content) return null;

  const historyId = firstString(row, ['id', 'inner_id']);
  const senderId = firstString(row, ['sender_id', 'senderId']);
  const senderName = firstString(row, ['sender_name', 'senderName']);
  const createdAt = timestampMs(firstValue(row, ['created_at', 'createdAt', 'timestamp']));

  return {
    role,
    content,
    parts: textOnlyParts(content),
    createdAt: createdAt > 0 ? createdAt : undefined,
    metadata: {
      source: 'astrbot',
      sourceTable: PLATFORM_HISTORY_TABLE,
      historyId,
      senderId,
      senderName,
      llmCheckpointId: firstString(row, ['llm_checkpoint_id', 'llmCheckpointId']),
    },
  };
}

function buildWebChatThread(row: Row, opts?: ParseOptions): Conversation | null {
  const threadId = firstString(row, ['thread_id', 'threadId', 'id']);
  if (!threadId) return null;

  const rowCreatedAt = timestampMs(firstValue(row, ['created_at', 'createdAt']));
  const rowUpdatedAt = timestampMs(firstValue(row, ['updated_at', 'updatedAt']), rowCreatedAt);
  const candidate = firstValue(row, ['messages', 'history', 'content']);
  const parsedCandidate = parseJsonValue(candidate);
  const items = structuredMessageItems(parsedCandidate);
  const messages = items
    .map((item, index) => buildStructuredMessage(item, index, undefined, opts))
    .filter((message): message is Message => Boolean(message));

  if (messages.length === 0) {
    const selectedText = firstString(row, ['selected_text', 'selectedText']);
    if (selectedText) {
      messages.push({
        role: 'user',
        content: selectedText,
        parts: textOnlyParts(selectedText),
        createdAt: rowCreatedAt > 0 ? rowCreatedAt : undefined,
        metadata: {
          source: 'astrbot',
          sourceTable: WEBCHAT_THREADS_TABLE,
          selectedText: true,
        },
      });
    }
  }

  if (messages.length === 0) return null;

  const messageTimes = messages
    .map(message => message.createdAt)
    .filter((value): value is number => Number.isInteger(value) && value > 0);
  const createdAt = rowCreatedAt || Math.min(...messageTimes, 0);
  const updatedAt = rowUpdatedAt || Math.max(...messageTimes, createdAt);
  if (isBeforeSince(createdAt, updatedAt, opts?.since)) return null;

  const parentSessionId = firstString(row, ['parent_session_id', 'parentSessionId']);
  return {
    externalId: `webchat-thread:${threadId}`,
    title: 'WebChat thread',
    createdAt,
    updatedAt: updatedAt || undefined,
    messages,
    messageCount: messages.length,
    metadata: {
      source: 'astrbot',
      sourceTable: WEBCHAT_THREADS_TABLE,
      platformId: 'webchat',
      platform: 'webui',
      userId: parentSessionId,
      threadId,
      creator: firstString(row, ['creator']),
      parentSessionId,
      parentMessageId: firstString(row, ['parent_message_id', 'parentMessageId']),
      baseCheckpointId: firstString(row, ['base_checkpoint_id', 'baseCheckpointId']),
    },
  };
}

interface HistoryEntry {
  row: Row;
  platformId: string;
  userId: string;
  message: Message;
  rowId: number;
}

function structuredMessageItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    return [{ role: 'assistant', content: value }];
  }

  const record = asRecord(value);
  if (!record) return [];

  const directMessages = firstValue(record, ['messages']);
  if (Array.isArray(directMessages)) return directMessages;

  const history = asRecord(record.history);
  if (Array.isArray(history?.messages)) return history.messages;
  if (history?.messages && typeof history.messages === 'object') {
    return Object.values(history.messages as Record<string, unknown>);
  }

  if (Array.isArray(record.content)) return record.content;
  if ('role' in record || 'type' in record || 'message' in record || 'text' in record) {
    return [record];
  }
  return [];
}

function extractToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap(item => {
    const record = asRecord(item);
    if (!record) return [];
    const functionValue = asRecord(record.function);
    const toolName = stringValue(functionValue?.name) ?? stringValue(record.name);
    if (!toolName) return [];
    const inputValue = functionValue?.arguments ?? record.input;
    return [{
      toolName,
      input: parseJsonValue(inputValue),
      output: stringValue(record.output),
      status: mapToolStatus(stringValue(record.status)),
    }];
  });
}

function mapToolStatus(value: string | undefined): ToolCall['status'] | undefined {
  switch (value?.toLowerCase()) {
    case 'pending':
    case 'running':
      return 'pending';
    case 'success':
    case 'completed':
      return 'success';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

function mapRole(value: string | undefined): MessageRole {
  switch (value?.toLowerCase()) {
    case 'user':
    case 'human':
      return 'user';
    case 'system':
    case '_checkpoint':
    case 'checkpoint':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    case 'assistant':
    case 'ai':
    case 'bot':
      return 'assistant';
    default:
      return 'assistant';
  }
}

function contentToText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map(item => contentToText(item))
      .filter(Boolean)
      .join('\n');
  }

  const record = asRecord(value);
  if (!record) return String(value);
  for (const key of ['text', 'content', 'message', 'output', 'value']) {
    if (!(key in record)) continue;
    const text = contentToText(record[key]);
    if (text) return text;
  }

  const type = stringValue(record.type);
  if (type) return `[${type}]`;
  try {
    return JSON.stringify(record);
  } catch {
    return '';
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function timestampMs(value: unknown, fallback = 0): number {
  if (value == null || value === '') return Math.floor(fallback);
  if (typeof value === 'number') return numericTimestamp(value, fallback);
  if (typeof value === 'bigint') return numericTimestamp(Number(value), fallback);

  if (typeof value === 'object') {
    const record = asRecord(value);
    if (record) {
      const seconds = numberValue(record.seconds);
      if (seconds !== undefined) return numericTimestamp(seconds, fallback);
    }
  }

  const text = String(value).trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return numericTimestamp(Number(text), fallback);
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const dateText = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00Z`
    : hasTimezone
      ? text
      : `${text.replace(' ', 'T')}Z`;
  const parsed = Date.parse(dateText);
  return Number.isFinite(parsed) ? Math.floor(parsed) : Math.floor(fallback);
}

function numericTimestamp(value: number, fallback = 0): number {
  if (!Number.isFinite(value) || value <= 0) return Math.floor(fallback);
  return Math.floor(Math.abs(value) < 100_000_000_000 ? value * 1000 : value);
}

function isBeforeSince(createdAt: number, updatedAt: number, since: number | undefined): boolean {
  return since !== undefined && createdAt < since && updatedAt < since;
}

function compareConversations(left: Conversation, right: Conversation): number {
  return (right.updatedAt ?? right.createdAt) - (left.updatedAt ?? left.createdAt)
    || String(left.externalId ?? '').localeCompare(String(right.externalId ?? ''));
}

function compareHistoryEntries(left: HistoryEntry, right: HistoryEntry): number {
  return (left.message.createdAt ?? 0) - (right.message.createdAt ?? 0)
    || left.rowId - right.rowId;
}

function cursorOffset(cursor: unknown): number {
  if (typeof cursor === 'number' && Number.isInteger(cursor) && cursor >= 0) return cursor;
  const record = asRecord(cursor);
  const offset = numberValue(record?.offset);
  return offset !== undefined && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function sessionKey(platformId: string | undefined, userId: string | undefined): string {
  return `${platformId ?? ''}\u0000${userId ?? ''}`;
}

function platformLabel(platformId: string): string {
  const normalized = platformId.toLowerCase();
  if (normalized.includes('wechat') || normalized.includes('weixin') || normalized.includes('gewechat')) {
    return 'wechat';
  }
  if (normalized.includes('qq') || normalized.includes('aiocqhttp')) return 'qq';
  if (normalized === 'webchat' || normalized === 'webui') return 'webui';
  return platformId;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  return stringValue(metadata?.[key]);
}

function firstValue(row: Row, names: string[]): unknown {
  for (const name of names) {
    if (name in row) return row[name];
    const matchingKey = Object.keys(row).find(key => key.toLowerCase() === name.toLowerCase());
    if (matchingKey) return row[matchingKey];
  }
  return undefined;
}

function firstString(row: Row, names: string[]): string | undefined {
  return stringValue(firstValue(row, names));
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asRecord(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Row
    : undefined;
}

runAdapter(adapter);
