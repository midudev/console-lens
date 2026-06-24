/**
 * Wire protocol shared between the runtime agent and the editor extension.
 * Messages are newline-delimited JSON over TCP (Node) or WebSocket (browser).
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export type Runtime = 'node' | 'browser';

export interface LogMessage {
  /** Protocol version. */
  v: 1;
  type: 'log';
  level: LogLevel;
  /** Absolute file path (node) or source URL/path (browser). */
  file: string;
  /** 1-based line number of the call site. */
  line: number;
  /** 1-based column number of the call site. */
  column: number;
  /** Each console argument, pre-serialized to a display string. */
  args: string[];
  /** Structured tree per argument for the panel's object inspector (optional). */
  tree?: unknown[];
  /** Single-line preview built from `args`. */
  preview: string;
  timestamp: number;
  runtime: Runtime;
  /** Per-process/session id, used to group and clear runs. */
  session: string;
  /** Project root the producing process ran in (its cwd), so the editor can
   * show only the current project's logs by default. */
  cwd?: string;
  /** True when this came from a logpoint (no console.* in the user's code). */
  logpoint?: boolean;
  /** The logpoint expression, if `logpoint`. */
  expression?: string;
  /** True when produced by `console.table` — the panel renders it as a grid. */
  table?: boolean;
}

/** A single resolved stack frame of a captured error. */
export interface StackFrame {
  /** Function name, if any (e.g. "applyTax"). */
  function?: string;
  /** Absolute file path / source URL. */
  file: string;
  line: number;
  column: number;
}

export interface ErrorMessage {
  v: 1;
  type: 'error';
  /** Error class name (e.g. "TypeError"). */
  name: string;
  message: string;
  /** Source-mapped, user-land-first stack frames. */
  frames: StackFrame[];
  /** What surfaced it: "uncaughtException" | "unhandledRejection". */
  origin: string;
  timestamp: number;
  runtime: Runtime;
  session: string;
  /** Project root the producing process ran in (its cwd). */
  cwd?: string;
}

export interface NetworkMessage {
  v: 1;
  type: 'network';
  method: string;
  url: string;
  /** HTTP status, or 0 if the request failed before a response. */
  status: number;
  ok: boolean;
  requestBody?: string;
  responseBody?: string;
  /** Error message if the request threw (network failure). */
  error?: string;
  durationMs: number;
  /** Call site of the fetch(). */
  file: string;
  line: number;
  column: number;
  timestamp: number;
  runtime: Runtime;
  session: string;
  /** Project root the producing process ran in (its cwd). */
  cwd?: string;
}

export type AnyMessage = LogMessage | ErrorMessage | NetworkMessage;

export const PROTOCOL_VERSION = 1 as const;

/** Default TCP port for the Node agent. */
export const DEFAULT_TCP_PORT = 9111;

/** Browser WebSocket server listens on TCP port + 1. */
export const wsPortFor = (tcpPort: number): number => tcpPort + 1;

/** Env var used to tell the agent which TCP port to connect to. */
export const PORT_ENV = 'CONSOLE_LENS_PORT';

/** Env var for the browser WebSocket port (may differ from TCP port + 1 when
 * ports fall back to ephemeral values, e.g. multiple editor windows open). */
export const WS_PORT_ENV = 'CONSOLE_LENS_WS_PORT';

export const LOG_LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

/** Minimal structural validation for an incoming message. */
export function isLogMessage(value: unknown): value is LogMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const m = value as Record<string, unknown>;
  return (
    m.type === 'log' &&
    typeof m.file === 'string' &&
    typeof m.line === 'number' &&
    typeof m.preview === 'string' &&
    typeof m.level === 'string' &&
    LOG_LEVELS.includes(m.level as LogLevel)
  );
}

export function isErrorMessage(value: unknown): value is ErrorMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const m = value as Record<string, unknown>;
  return (
    m.type === 'error' &&
    typeof m.message === 'string' &&
    typeof m.name === 'string' &&
    Array.isArray(m.frames)
  );
}

export function isNetworkMessage(value: unknown): value is NetworkMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const m = value as Record<string, unknown>;
  return (
    m.type === 'network' &&
    typeof m.url === 'string' &&
    typeof m.method === 'string' &&
    typeof m.status === 'number' &&
    typeof m.line === 'number'
  );
}
