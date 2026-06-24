import * as path from 'node:path';
import type { ErrorMessage, LogLevel, LogMessage, NetworkMessage, StackFrame } from './protocol';

/** A single recorded execution of a log line. */
export interface LogRecord {
  timestamp: number;
  level: LogLevel;
  args: string[];
  preview: string;
}

export interface LineEntry {
  line: number;
  column: number;
  level: LogLevel;
  preview: string;
  /** Number of times this exact line has logged in the current session. */
  count: number;
  lastTimestamp: number;
  /** Recent executions (chronological, capped). */
  history: LogRecord[];
  /** True when produced by a logpoint (not console.* in the user's code). */
  logpoint?: boolean;
  /** The logpoint expression, if `logpoint`. */
  expression?: string;
}

export interface ErrorEntry {
  line: number;
  column: number;
  name: string;
  message: string;
  frames: StackFrame[];
  timestamp: number;
  count: number;
}

export interface NetworkEntry {
  line: number;
  column: number;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  requestBody?: string;
  responseBody?: string;
  error?: string;
  durationMs: number;
  timestamp: number;
  count: number;
}

export interface EditorEntries {
  logs: LineEntry[];
  errors: ErrorEntry[];
  network: NetworkEntry[];
}

const MAX_HISTORY = 50;

/** Normalize a file path into a stable lookup key. */
export function normalizeKey(file: string): string {
  // Browser sources may arrive as URLs; keep only the meaningful path part.
  let p = file;
  const schemeMatch = /^[a-z]+:\/\/[^/]*(\/.*)$/i.exec(p);
  if (schemeMatch) {
    p = schemeMatch[1];
  }
  return path.normalize(p).replace(/\\/g, '/');
}

/** Key used to store an incoming message. */
export function keyForMessage(message: LogMessage): string {
  return normalizeKey(message.file);
}

/**
 * True when a stored key belongs to the file currently open at `full`. Matches
 * the exact path (Node / server-side logs) and any path-suffix of it: browser
 * logs arrive either as a bare basename ("Hero.astro") or as a served-URL path
 * ("/src/sections/Hero.astro"), and both are trailing segments of the real file
 * path. An absolute path to a *different* file is not a suffix, so files that
 * merely share a basename don't cross-match.
 */
export function editorMatchesKey(key: string, full: string): boolean {
  if (key === full) {
    return true;
  }
  const tail = key.replace(/^\/+/, '');
  return tail.length > 0 && (full === tail || full.endsWith('/' + tail));
}

/**
 * Candidate keys for an open editor, most specific first. Lets logs match an
 * editor by full path, and (for browser logs that only carry a URL) by basename.
 */
export function keysForEditorPath(fsPath: string): string[] {
  const full = normalizeKey(fsPath);
  const base = path.basename(full);
  return base && base !== full ? [full, base] : [full];
}

interface FileBucket {
  logs: Map<number, LineEntry>;
  errors: Map<number, ErrorEntry>;
  network: Map<number, NetworkEntry>;
}

/**
 * A single text edit, described in editor-agnostic terms (0-based line numbers)
 * so the pure store can react to document changes without importing VS Code.
 */
export interface LineEdit {
  /** 0-based first line of the replaced range. */
  startLine: number;
  /** 0-based last line of the replaced range. */
  endLine: number;
  /** True when the range ends at column 0 of `endLine` (that line is untouched). */
  endAtLineStart: boolean;
  /** Net change in line count for the document (lines added − lines removed). */
  delta: number;
}

/**
 * In-memory store of inline log/error entries, keyed by file then line.
 * Pure data structure with no editor dependencies, so it is fully unit-testable.
 */
export class DecorationStore {
  private byFile = new Map<string, FileBucket>();

  private bucket(key: string): FileBucket {
    let b = this.byFile.get(key);
    if (!b) {
      b = { logs: new Map(), errors: new Map(), network: new Map() };
      this.byFile.set(key, b);
    }
    return b;
  }

  /**
   * Record a log message. Returns the storage key (file) so callers can refresh
   * only the affected editors. Clearing is driven by the server detecting a new
   * run (see LensServer `newRun`), not by per-message session ids — a dev server
   * spawns several processes and their events must not clear each other.
   */
  add(message: LogMessage): string {
    const key = keyForMessage(message);
    const logs = this.bucket(key).logs;

    const existing = logs.get(message.line);
    const record: LogRecord = {
      timestamp: message.timestamp,
      level: message.level,
      args: message.args,
      preview: message.preview,
    };
    const history = existing ? existing.history : [];
    history.push(record);
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }

    logs.set(message.line, {
      line: message.line,
      column: message.column,
      level: message.level,
      preview: message.preview,
      count: existing ? existing.count + 1 : 1,
      lastTimestamp: message.timestamp,
      history,
      logpoint: message.logpoint,
      expression: message.expression,
    });
    return key;
  }

  /**
   * Record an error. The error decorates every user frame's location, so the
   * developer sees it whichever file they have open. Returns the affected keys.
   */
  addError(message: ErrorMessage): string[] {
    const keys: string[] = [];
    for (const frame of message.frames) {
      if (!frame.file || !frame.line) {
        continue;
      }
      const key = normalizeKey(frame.file);
      const errors = this.bucket(key).errors;
      const existing = errors.get(frame.line);
      errors.set(frame.line, {
        line: frame.line,
        column: frame.column,
        name: message.name,
        message: message.message,
        frames: message.frames,
        timestamp: message.timestamp,
        count: existing ? existing.count + 1 : 1,
      });
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
    return keys;
  }

  /** Record a network request at its call site. Returns the storage key. */
  addNetwork(message: NetworkMessage): string {
    const key = normalizeKey(message.file);
    const net = this.bucket(key).network;
    const existing = net.get(message.line);
    net.set(message.line, {
      line: message.line,
      column: message.column,
      method: message.method,
      url: message.url,
      status: message.status,
      ok: message.ok,
      requestBody: message.requestBody,
      responseBody: message.responseBody,
      error: message.error,
      durationMs: message.durationMs,
      timestamp: message.timestamp,
      count: existing ? existing.count + 1 : 1,
    });
    return key;
  }

  /** All log entries for a given storage key, sorted by line. */
  getByKey(key: string): LineEntry[] {
    const b = this.byFile.get(key);
    return b ? [...b.logs.values()].sort((a, c) => a.line - c.line) : [];
  }

  /**
   * Resolve entries for an editor by MERGING every bucket that belongs to the
   * file. One open file can own several at once: its absolute path (Node /
   * server-side logs), a basename and a served-URL path (browser logs). Returning
   * only the first match would hide, for instance, a client `<script>`'s
   * `console.log` behind that file's network or server-side entries.
   */
  getForEditorPath(fsPath: string): EditorEntries {
    const full = normalizeKey(fsPath);
    const logs = new Map<number, LineEntry>();
    const errors = new Map<number, ErrorEntry>();
    const network = new Map<number, NetworkEntry>();
    for (const [key, b] of this.byFile) {
      if (!editorMatchesKey(key, full)) {
        continue;
      }
      // On a per-line collision across buckets, keep the most recent entry.
      for (const e of b.logs.values()) {
        const prev = logs.get(e.line);
        if (!prev || e.lastTimestamp >= prev.lastTimestamp) {
          logs.set(e.line, e);
        }
      }
      for (const e of b.errors.values()) {
        const prev = errors.get(e.line);
        if (!prev || e.timestamp >= prev.timestamp) {
          errors.set(e.line, e);
        }
      }
      for (const e of b.network.values()) {
        const prev = network.get(e.line);
        if (!prev || e.timestamp >= prev.timestamp) {
          network.set(e.line, e);
        }
      }
    }
    const sortByLine = <T extends { line: number }>(m: Map<number, T>): T[] =>
      [...m.values()].sort((a, c) => a.line - c.line);
    return { logs: sortByLine(logs), errors: sortByLine(errors), network: sortByLine(network) };
  }

  keys(): string[] {
    return [...this.byFile.keys()];
  }

  /**
   * React to edits in a file: drop decorations on the edited lines (their
   * captured value is now stale) and shift the rest to follow inserted/removed
   * lines, so values stay anchored to the right code until the next run.
   * Applies to every bucket of the file (Node, browser, URL). Returns true if
   * anything changed, so the caller knows to re-render.
   */
  applyEdit(fsPath: string, edits: LineEdit[]): boolean {
    const full = normalizeKey(fsPath);
    let changed = false;
    for (const [key, bucket] of this.byFile) {
      if (!editorMatchesKey(key, full)) {
        continue;
      }
      for (const edit of edits) {
        changed = shiftLineMap(bucket.logs, edit) || changed;
        changed = shiftLineMap(bucket.errors, edit) || changed;
        changed = shiftLineMap(bucket.network, edit) || changed;
      }
    }
    return changed;
  }

  clear(): void {
    this.byFile.clear();
  }
}

/**
 * Apply one edit to a line-keyed map: entries on edited lines are dropped,
 * entries below shift by the line delta. Mutates the map in place; returns
 * whether it changed.
 */
function shiftLineMap<T extends { line: number }>(map: Map<number, T>, edit: LineEdit): boolean {
  if (map.size === 0) {
    return false;
  }
  const { startLine, endLine, endAtLineStart, delta } = edit;
  const next = new Map<number, T>();
  let changed = false;
  for (const [line, entry] of map) {
    const l0 = line - 1; // to 0-based
    if (l0 < startLine) {
      next.set(line, entry); // above the edit — untouched
    } else if (l0 > endLine) {
      entry.line = line + delta; // below the edit — shift to follow
      next.set(entry.line, entry);
      changed = changed || delta !== 0;
    } else if (l0 === endLine && endAtLineStart && endLine > startLine) {
      // The range ends at column 0 of this line, so its content is preserved —
      // it just moved (e.g. the line above it was deleted).
      entry.line = line + delta;
      next.set(entry.line, entry);
      changed = changed || delta !== 0;
    } else {
      changed = true; // an edited line — drop the now-stale decoration
    }
  }
  if (changed) {
    map.clear();
    for (const [line, entry] of next) {
      map.set(line, entry);
    }
  }
  return changed;
}
