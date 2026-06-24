#!/usr/bin/env node
/**
 * Console Lens MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 *
 * Exposes the runtime logs/errors/network captured by Console Lens to any MCP
 * client (Copilot, Cursor, Claude Code, Windsurf, Cline). It reads the events
 * file the editor extension keeps up to date — no shared process needed.
 *
 * Self-contained: only Node built-ins, so it can be copied to a stable path and
 * launched directly by an MCP client.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Ev {
  id: number;
  kind: 'log' | 'error' | 'network';
  level: string;
  timestamp: number;
  file: string;
  line: number;
  preview: string;
  detail: string;
}

const EVENTS_PATH =
  process.env.CONSOLE_LENS_EVENTS || path.join(os.homedir(), '.console-lens', 'events.json');

function loadEvents(): Ev[] {
  try {
    const data = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
    return Array.isArray(data) ? (data as Ev[]) : [];
  } catch {
    return [];
  }
}

function fmt(e: Ev): string {
  const time = new Date(e.timestamp).toISOString();
  const tag = e.kind === 'error' ? 'ERROR' : e.kind === 'network' ? 'NETWORK' : `LOG (${e.level})`;
  return `[${time}] ${tag} — ${e.file || '?'}:${e.line}\n${e.detail}`;
}

const TOOLS = [
  {
    name: 'runtime-logs',
    description: 'Get recent console logs from the running app captured by Console Lens.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max events (default 200)' } } },
  },
  {
    name: 'runtime-errors',
    description: 'Get runtime errors (uncaught exceptions, with stack traces) from the running app.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'runtime-logs-and-errors',
    description: 'Get both runtime logs and errors from the running app, in order.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'runtime-logs-by-location',
    description: 'Get logs/errors/network captured for a given source file (and optional line).',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' } },
      required: ['file'],
    },
  },
];

function callTool(name: string, args: Record<string, unknown>): string {
  let events = loadEvents();
  const limit = typeof args.limit === 'number' ? args.limit : 200;

  if (name === 'runtime-logs') {
    events = events.filter((e) => e.kind === 'log');
  } else if (name === 'runtime-errors') {
    events = events.filter((e) => e.kind === 'error');
  } else if (name === 'runtime-logs-and-errors') {
    events = events.filter((e) => e.kind !== 'network');
  } else if (name === 'runtime-logs-by-location') {
    const file = String(args.file ?? '');
    const base = file.split(/[\\/]/).pop();
    events = events.filter(
      (e) => e.file === file || (base ? e.file.split(/[\\/]/).pop() === base : false),
    );
    if (typeof args.line === 'number') {
      events = events.filter((e) => e.line === args.line);
    }
  } else {
    return `Unknown tool: ${name}`;
  }

  const slice = events.slice(-limit);
  if (slice.length === 0) {
    return 'No matching runtime events captured yet. Make sure the app is running under Console Lens.';
  }
  return slice.map(fmt).join('\n\n');
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): void {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params?.protocolVersion as string) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'console-lens', version: '0.1.0' },
    });
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    try {
      reply(id, { content: [{ type: 'text', text: callTool(name, args) }] });
    } catch (err) {
      reply(id, { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true });
    }
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method && method.startsWith('notifications/')) {
    /* notifications get no response */
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed line */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
