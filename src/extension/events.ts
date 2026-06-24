import type { ErrorMessage, LogLevel, LogMessage, NetworkMessage, StackFrame } from '../shared/protocol';

export interface PanelEvent {
  id: number;
  kind: 'log' | 'error' | 'network';
  level: LogLevel;
  timestamp: number;
  file: string;
  line: number;
  column: number;
  runtime: 'node' | 'browser';
  /** Project root (cwd) the producing process ran in, for per-project filtering. */
  cwd?: string;
  /** Single-line summary for the list. */
  preview: string;
  /** Full, possibly multi-line detail for the details pane. */
  detail: string;
  /** Error-only. */
  name?: string;
  frames?: StackFrame[];
  /** Log-only: structured tree per argument for the object inspector. */
  tree?: unknown[];
  /** Log-only: produced by `console.table`; rendered as a grid in the panel. */
  table?: boolean;
}

const MAX_EVENTS = 5000;

/**
 * Chronological log of everything captured (logs + errors + network), feeding the
 * panel. Cleared by the server on a new run (see LensServer `newRun`), not per
 * message session — a dev server's sibling processes must not clear each other.
 */
export class EventLog {
  private events: PanelEvent[] = [];
  private nextId = 1;
  private listeners: Array<(e: PanelEvent) => void> = [];
  private clearListeners: Array<() => void> = [];

  /** Subscribe to new events. Returns a disposer to unsubscribe. */
  onEvent(fn: (e: PanelEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Subscribe to clears. Returns a disposer to unsubscribe. */
  onClear(fn: () => void): () => void {
    this.clearListeners.push(fn);
    return () => {
      this.clearListeners = this.clearListeners.filter((l) => l !== fn);
    };
  }

  getAll(): PanelEvent[] {
    return this.events;
  }

  addLog(message: LogMessage): void {
    this.push({
      id: this.nextId++,
      kind: 'log',
      level: message.level,
      timestamp: message.timestamp,
      file: message.file,
      line: message.line,
      column: message.column,
      runtime: message.runtime,
      cwd: message.cwd,
      preview: message.preview,
      detail: message.args.join(' '),
      tree: message.tree,
      table: message.table,
    });
  }

  addError(message: ErrorMessage): void {
    const top = message.frames[0];
    const stack = message.frames
      .map((f) => `    at ${f.function ?? '<anonymous>'} (${f.file}:${f.line}:${f.column})`)
      .join('\n');
    this.push({
      id: this.nextId++,
      kind: 'error',
      level: 'error',
      timestamp: message.timestamp,
      file: top?.file ?? '',
      line: top?.line ?? 0,
      column: top?.column ?? 0,
      runtime: message.runtime,
      cwd: message.cwd,
      preview: `${message.name}: ${message.message}`,
      detail: `${message.name}: ${message.message}\n${stack}`,
      name: message.name,
      frames: message.frames,
    });
  }

  addNetwork(message: NetworkMessage): void {
    const statusText = message.status === 0 ? 'ERR' : String(message.status);
    const detailParts = [
      `${message.method} ${message.url}`,
      `status: ${statusText} (${message.durationMs}ms)`,
      message.error ? `error: ${message.error}` : '',
      message.requestBody ? `request:\n${message.requestBody}` : '',
      message.responseBody ? `response:\n${message.responseBody}` : '',
    ].filter(Boolean);
    this.push({
      id: this.nextId++,
      kind: 'network',
      level: message.ok ? 'info' : 'error',
      timestamp: message.timestamp,
      file: message.file,
      line: message.line,
      column: message.column,
      runtime: message.runtime,
      cwd: message.cwd,
      preview: `${statusText} ${message.method} ${message.url}`,
      detail: detailParts.join('\n'),
    });
  }

  clear(): void {
    this.events = [];
    for (const fn of this.clearListeners) {
      try {
        fn();
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }

  private push(event: PanelEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a broken listener must not stop the others */
      }
    }
  }
}
