/**
 * Zcode / ZAI adapter for hstry
 *
 * Canonical root: ~/.zcode
 * Authority: ~/.zcode/cli/db/db.sqlite (session / message / part).
 * Ignore streaming `transcript.jsonl` under `cli/agents` and `cli/log`.
 */

import { existsSync, statSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import type {
  Adapter,
  AdapterInfo,
  CanonPart,
  Conversation,
  Message,
  MessageRole,
  ParseOptions,
  ToolCall,
  ToolStatus,
} from '../types/index.ts';
import {
  runAdapter,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
  isUnderCanonicalRoot,
} from '../types/index.ts';
import { findFirstRealUserMessage, formatFrumTitle } from '../types/first-message.ts';

const DEFAULT_ZCODE_PATH = join(homedir(), '.zcode');

let openDb: ((path: string) => SqliteDb) | null = null;

interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}

try {
  if (typeof Bun !== 'undefined') {
    // @ts-ignore - bun:sqlite is Bun-only
    const { Database: BunDb } = await import('bun:sqlite');
    openDb = (path: string) => new BunDb(path, { readonly: true }) as unknown as SqliteDb;
  } else {
    const mod = await import('better-sqlite3');
    const BetterSqlite = mod.default;
    openDb = (path: string) => BetterSqlite(path, { readonly: true }) as unknown as SqliteDb;
  }
} catch {
  // SQLite not available — detect/parse will no-op.
}

declare const Bun: unknown;

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
  task_type: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  data: string;
}

const adapter: Adapter = {
  info(): AdapterInfo {
    return {
      name: 'zcode',
      displayName: 'Zcode / ZAI',
      version: '1.0.0',
      defaultPaths: [DEFAULT_ZCODE_PATH],
    };
  },

  async detect(path: string): Promise<number | null> {
    if (!isUnderCanonicalRoot(path, DEFAULT_ZCODE_PATH)) return null;
    const dbPath = resolveDbPath(path);
    if (!dbPath || !openDb) return null;
    try {
      const db = openDb(dbPath);
      try {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='session'",
        ).all() as Array<{ name: string }>;
        return row.length > 0 ? 0.95 : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  },

  async parse(path: string, opts?: ParseOptions): Promise<Conversation[]> {
    if (!openDb) return [];
    const dbPath = resolveDbPath(path);
    if (!dbPath) return [];

    const db = openDb(dbPath);
    try {
      let sessionQuery = `
        SELECT id, parent_id, directory, title, time_created, time_updated, task_type
        FROM session
      `;
      const params: unknown[] = [];
      if (opts?.since) {
        sessionQuery += ` WHERE time_created >= ? OR time_updated >= ?`;
        params.push(opts.since, opts.since);
      }
      sessionQuery += ` ORDER BY time_created DESC`;
      if (opts?.limit) {
        sessionQuery += ` LIMIT ?`;
        params.push(opts.limit);
      }

      const sessions = db.prepare(sessionQuery).all(...params) as SessionRow[];
      if (sessions.length === 0) return [];

      const sessionIds = sessions.map(s => s.id);
      const messagesBySession = new Map<string, MessageRow[]>();
      const partsByMessage = new Map<string, PartRow[]>();

      for (const chunk of chunks(sessionIds, 400)) {
        const ph = chunk.map(() => '?').join(',');
        const messageRows = db.prepare(
          `SELECT id, session_id, time_created, time_updated, data
           FROM message WHERE session_id IN (${ph})
           ORDER BY session_id, COALESCE(sequence, time_created), time_created`,
        ).all(...chunk) as MessageRow[];
        for (const row of messageRows) {
          let list = messagesBySession.get(row.session_id);
          if (!list) {
            list = [];
            messagesBySession.set(row.session_id, list);
          }
          list.push(row);
        }

        const messageIds = messageRows.map(r => r.id);
        for (const msgChunk of chunks(messageIds, 400)) {
          const mph = msgChunk.map(() => '?').join(',');
          const partRows = db.prepare(
            `SELECT id, message_id, data
             FROM part WHERE message_id IN (${mph})
             ORDER BY message_id, COALESCE(sequence, time_created), time_created`,
          ).all(...msgChunk) as PartRow[];
          for (const row of partRows) {
            let list = partsByMessage.get(row.message_id);
            if (!list) {
              list = [];
              partsByMessage.set(row.message_id, list);
            }
            list.push(row);
          }
        }
      }

      const conversations: Conversation[] = [];
      for (const session of sessions) {
        const conv = buildConversation(
          session,
          messagesBySession.get(session.id) ?? [],
          partsByMessage,
          opts,
        );
        if (conv) conversations.push(conv);
      }
      return conversations;
    } finally {
      db.close();
    }
  },
};

function resolveDbPath(path: string): string | null {
  if (existsSync(path) && !isDir(path) && basename(path) === 'db.sqlite') {
    return path;
  }
  const candidates = [
    join(path, 'cli', 'db', 'db.sqlite'),
    join(path, 'db', 'db.sqlite'),
    join(path, 'db.sqlite'),
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildConversation(
  session: SessionRow,
  messageRows: MessageRow[],
  partsByMessage: Map<string, PartRow[]>,
  opts?: ParseOptions,
): Conversation | null {
  const includeTools = opts?.includeTools !== false;
  const messages: Message[] = [];

  for (const row of messageRows) {
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = mapRole(typeof data.role === 'string' ? data.role : 'assistant');
    const createdAt = ms(nestedTime(data) ?? row.time_created);
    const { parts, content, toolCalls, model } = partsFromRows(
      partsByMessage.get(row.id) ?? [],
      includeTools,
      data,
    );
    if (!content && (!parts || parts.length === 0)) continue;

    messages.push({
      role,
      content,
      parts: parts.length > 0 ? parts : undefined,
      createdAt,
      model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      metadata: {
        id: row.id,
        agent: typeof data.agent === 'string' ? data.agent : undefined,
        provider: providerFromData(data),
      },
    });
  }

  if (messages.length === 0) return null;

  const createdAt = ms(session.time_created, messages[0]?.createdAt ?? 0);
  const updatedAt = ms(session.time_updated, createdAt);
  if (opts?.since && createdAt < opts.since && updatedAt < opts.since) return null;

  const frum = findFirstRealUserMessage(
    messages.map(m => ({ role: m.role, content: m.content })),
  );
  const storedTitle = session.title?.trim();
  const title = storedTitle && storedTitle !== session.id
    ? storedTitle
    : frum
      ? formatFrumTitle(frum)
      : storedTitle;

  const lastModel = [...messages].reverse().find(m => m.model)?.model;
  const lastProvider = [...messages].reverse().find(m => m.metadata?.provider)?.metadata?.provider;

  return {
    externalId: session.id,
    title,
    createdAt,
    updatedAt,
    model: typeof lastModel === 'string' ? lastModel : undefined,
    provider: typeof lastProvider === 'string' ? lastProvider : 'zcode',
    workspace: session.directory ?? undefined,
    messages,
    parentExternalId: session.parent_id ?? undefined,
    metadata: {
      taskType: session.task_type ?? undefined,
    },
  };
}

function partsFromRows(
  rows: PartRow[],
  includeTools: boolean,
  messageData: Record<string, unknown>,
): { parts: CanonPart[]; content: string; toolCalls: ToolCall[]; model?: string } {
  const parts: CanonPart[] = [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const model = modelFromData(messageData);

  for (const row of rows) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'step-start' || type === 'step-finish' || type === 'timeline') continue;

    if (type === 'text' && typeof data.text === 'string' && data.text) {
      texts.push(data.text);
      parts.push(textPart(data.text));
      continue;
    }
    if (type === 'reasoning' && typeof data.text === 'string' && data.text) {
      parts.push(thinkingPart(data.text));
      continue;
    }
    if (type === 'tool' && typeof data.tool === 'string') {
      const callId = typeof data.callID === 'string' ? data.callID : row.id;
      const state = (data.state && typeof data.state === 'object')
        ? data.state as Record<string, unknown>
        : {};
      const status = mapToolStatus(typeof state.status === 'string' ? state.status : undefined);
      const output = stringifyOutput(state.output ?? state.error);
      if (includeTools) {
        parts.push(toolCallPart(callId, data.tool, state.input));
        if (output !== undefined) {
          parts.push(toolResultPart(callId, output, {
            name: data.tool,
            isError: status === 'error',
          }));
        }
        toolCalls.push({
          toolName: data.tool,
          input: state.input,
          output,
          status,
        });
      }
    }
  }

  return { parts, content: texts.join('\n'), toolCalls, model };
}

function nestedTime(data: Record<string, unknown>): number | undefined {
  const time = data.time;
  if (time && typeof time === 'object' && 'created' in time) {
    const created = (time as { created?: unknown }).created;
    if (typeof created === 'number') return created;
  }
  return undefined;
}

function modelFromData(data: Record<string, unknown>): string | undefined {
  if (typeof data.modelID === 'string') return data.modelID;
  const model = data.model;
  if (model && typeof model === 'object' && 'modelID' in model) {
    const id = (model as { modelID?: unknown }).modelID;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function providerFromData(data: Record<string, unknown>): string | undefined {
  if (typeof data.providerID === 'string') return data.providerID;
  const model = data.model;
  if (model && typeof model === 'object' && 'providerID' in model) {
    const id = (model as { providerID?: unknown }).providerID;
    if (typeof id === 'string') return id;
  }
  return undefined;
}

function mapRole(role: string): MessageRole {
  switch (role.toLowerCase()) {
    case 'user':
    case 'human':
      return 'user';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'assistant';
  }
}

function mapToolStatus(status?: string): ToolStatus | undefined {
  switch (status) {
    case 'completed':
      return 'success';
    case 'error':
      return 'error';
    case 'pending':
    case 'running':
      return 'pending';
    default:
      return undefined;
  }
}

function stringifyOutput(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ms(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(fallback);
  return Math.floor(n);
}

runAdapter(adapter);
