/**
 * Console Lens runtime agent.
 *
 * Loaded via `node --require <this file>`. It patches the `console` methods so
 * each call still logs normally AND ships a structured message (with the real
 * source location) to the editor. Zero third-party dependencies.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_TCP_PORT, LOG_LEVELS, PORT_ENV, WS_PORT_ENV, type LogLevel, type LogMessage } from '../shared/protocol';
import { buildPreview, buildTree, serializeArgs } from '../shared/serialize';
import { captureCallSite, enableSourceMaps } from '../shared/stack';
import { resolveSourcePath } from './resolve-path';
import { createTcpTransport } from './transport';
import { setupHttpInjection } from './http-inject';
import { reportError } from './errors';
import { patchFetch } from './network';
import { setupLogpoints } from './logpoint-runtime';

type Patchable = Record<string, (...args: unknown[]) => void>;
type Capture = (level: LogLevel, args: unknown[], opts?: { table?: boolean }) => void;

const GLOBAL_FLAG = '__consoleLensAttached__';

/** Patch console.table/dir/trace/assert/count/time/group so they're captured too. */
function patchExtraConsoleMethods(
  target: Patchable,
  originals: Patchable,
  capture: Capture,
  suppress: { on: boolean },
): void {
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  // Run the native method (its internal console.log calls are suppressed so we
  // don't double-capture), then run our own capturer exactly once.
  const wrap = (name: string, capturer: (args: unknown[]) => void): void => {
    const orig =
      typeof target[name] === 'function' ? (target[name].bind(console) as (...a: unknown[]) => void) : () => {};
    originals[name] = orig;
    target[name] = function patchedExtra(...args: unknown[]): void {
      suppress.on = true;
      try {
        orig(...args);
      } catch {
        /* ignore */
      }
      suppress.on = false;
      try {
        capturer(args);
      } catch {
        /* ignore */
      }
    };
  };
  const label = (args: unknown[]): string => (typeof args[0] === 'string' ? args[0] : 'default');

  wrap('table', (args) => capture('log', args, { table: true }));
  wrap('dir', (args) => capture('log', args));
  wrap('trace', (args) => capture('debug', args.length ? args : ['console.trace']));
  wrap('assert', (args) => {
    if (!args[0]) {
      capture('error', ['Assertion failed:', ...args.slice(1)]);
    }
  });
  wrap('count', (args) => {
    const key = label(args);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    capture('debug', [`${key}: ${n}`]);
  });
  wrap('countReset', (args) => counts.set(label(args), 0));
  wrap('time', (args) => timers.set(label(args), Date.now()));
  wrap('timeEnd', (args) => {
    const key = label(args);
    const start = timers.get(key);
    timers.delete(key);
    if (start !== undefined) {
      capture('debug', [`${key}: ${Date.now() - start}ms`]);
    }
  });
  wrap('timeLog', (args) => {
    const start = timers.get(label(args));
    if (start !== undefined) {
      capture('debug', [`${label(args)}: ${Date.now() - start}ms`, ...args.slice(1)]);
    }
  });
  for (const g of ['group', 'groupCollapsed']) {
    wrap(g, (args) => {
      if (args.length) {
        capture('log', ['▸', ...args]);
      }
    });
  }
}

function attach(): void {
  const g = globalThis as Record<string, unknown>;
  if (g[GLOBAL_FLAG]) {
    return;
  }
  g[GLOBAL_FLAG] = true;

  // Translate stack traces through source maps so server-side logs in compiled
  // templates (Astro frontmatter, Next.js server components, TS via tsx) map to
  // the author's original source line.
  enableSourceMaps();

  const port = Number(process.env[PORT_ENV]) || DEFAULT_TCP_PORT;
  const wsPort = Number(process.env[WS_PORT_ENV]) || port + 1;

  // Share ONE session across the whole process tree (pnpm -> node -> framework,
  // workers, etc.) so events from sibling processes of the same dev run don't
  // clear each other. The first process generates it; children inherit it via
  // the environment. A fresh `dev` run starts with no env -> a new session.
  let session = process.env.CONSOLE_LENS_SESSION;
  if (!session) {
    session = randomUUID();
    try {
      process.env.CONSOLE_LENS_SESSION = session;
    } catch {
      /* ignore */
    }
  }

  const transport = createTcpTransport(port);

  // The project the producing process runs in, so the editor can show only the
  // current project's logs by default (multiple dev servers can share one port).
  const projectCwd = process.cwd();

  const target = console as unknown as Patchable;
  const originals: Patchable = {};

  // Per-call-site rate limiting so a log in a tight loop/render can't flood the
  // wire or the panel. Up to MAX_PER_WINDOW messages per site per second.
  const MAX_PER_WINDOW = 50;
  const WINDOW_MS = 1000;
  const buckets = new Map<string, { start: number; count: number }>();
  const throttled = (key: string): boolean => {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now - b.start > WINDOW_MS) {
      buckets.set(key, { start: now, count: 1 });
      return false;
    }
    b.count += 1;
    return b.count > MAX_PER_WINDOW;
  };

  // Reentrancy guard: console.table/count/assert internally call console.log,
  // which we patched — without this they'd be captured twice.
  const suppress = { on: false };

  /** Capture a console call: serialize, locate, build a tree, ship. */
  const capture = (level: LogLevel, args: unknown[], opts?: { table?: boolean }): void => {
    if (suppress.on) {
      return;
    }
    try {
      const site = captureCallSite([__filename]);
      if (!site) {
        return;
      }
      const file = resolveSourcePath(site.file);
      if (throttled(`${file}:${site.line}`)) {
        return;
      }
      const parts = serializeArgs(args);
      const message: LogMessage = {
        v: 1,
        type: 'log',
        level,
        file,
        line: site.line,
        column: site.column,
        args: parts,
        tree: args.map((a) => buildTree(a)),
        preview: buildPreview(parts),
        timestamp: Date.now(),
        runtime: 'node',
        session,
        cwd: projectCwd,
        ...(opts?.table ? { table: true } : {}),
      };
      transport.send(message);
    } catch {
      /* never break the host app */
    }
  };

  for (const level of LOG_LEVELS) {
    const native = typeof target[level] === 'function' ? target[level].bind(console) : target.log.bind(console);
    originals[level] = native;
    target[level] = function patched(...args: unknown[]): void {
      native(...args); // preserve normal logging first
      capture(level, args);
    };
  }

  // Additional console methods (table, dir, assert, count, time, trace, group).
  patchExtraConsoleMethods(target, originals, capture, suppress);

  // Restore originals on exit so other exit handlers see a clean console.
  process.once('exit', () => {
    for (const level of LOG_LEVELS) {
      target[level] = originals[level];
    }
  });

  // Auto-inject the browser client into any HTML served by a dev server
  // (Vite / Astro / Next.js) started under this agent. Zero config.
  try {
    setupHttpInjection(port, wsPort, (message) => originals.log(message));
  } catch {
    /* never break the host app */
  }

  // Capture uncaught errors WITHOUT changing crash behaviour:
  // `uncaughtExceptionMonitor` observes the error and lets Node crash as usual.
  // It also covers unhandled promise rejections, which Node turns into an
  // uncaught exception by default — so we don't add a (behaviour-changing)
  // `unhandledRejection` listener.
  try {
    process.on('uncaughtExceptionMonitor', (err) => reportError(transport, session, err, 'uncaughtException', projectCwd));
  } catch {
    /* never break the host app */
  }

  // Capture fetch() calls (method, status, payloads) at their call site.
  try {
    patchFetch(transport, session, projectCwd);
  } catch {
    /* never break the host app */
  }

  // Logpoints: log expressions at a line without editing the user's code.
  try {
    setupLogpoints((meta, value) => {
      if (throttled(`${meta.f}:${meta.l}`)) {
        return;
      }
      const parts = serializeArgs([value]);
      transport.send({
        v: 1,
        type: 'log',
        level: 'log',
        file: meta.f,
        line: meta.l,
        column: 0,
        args: parts,
        tree: [buildTree(value)],
        preview: buildPreview(parts),
        timestamp: Date.now(),
        runtime: 'node',
        session,
        cwd: projectCwd,
        logpoint: true,
        expression: meta.e,
      });
    });
  } catch {
    /* never break the host app */
  }
}

attach();
