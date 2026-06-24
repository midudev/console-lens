export interface CallSite {
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
}

/** Enable Node's built-in source-map support so stack traces report original
 * positions (e.g. a Vite-SSR-transformed `.astro`/`.tsx` module maps back to the
 * author's source line). Safe to call repeatedly; no-op on very old Node. */
export function enableSourceMaps(): void {
  try {
    (process as { setSourceMapsEnabled?: (v: boolean) => void }).setSourceMapsEnabled?.(true);
  } catch {
    /* older Node without the API */
  }
}

function isInternal(file: string | null | undefined): boolean {
  if (!file) {
    return true;
  }
  return file.startsWith('node:') || file.startsWith('internal/') || file.includes('node:internal');
}

/** Parse a single V8 stack-trace line into a call site, if it has a location. */
export function parseStackLine(line: string): CallSite | null {
  // Forms:
  //   "    at fnName (/path/file.js:12:34)"
  //   "    at /path/file.js:12:34"
  //   "    at async fn (file:///path:12:34)"
  //   "    at eval (/path/index.astro:5:9)"   (source-map translated)
  let match = /\(([^()]+):(\d+):(\d+)\)\s*$/.exec(line);
  if (!match) {
    match = /at\s+(.+?):(\d+):(\d+)\s*$/.exec(line);
  }
  if (!match) {
    return null;
  }
  return {
    file: normalizeFileUrl(match[1]),
    line: parseInt(match[2], 10),
    column: parseInt(match[3], 10),
  };
}

/**
 * Capture the first user-land call site above the caller of this function.
 *
 * Reads the default (source-map translated, when enabled) `error.stack` string
 * rather than overriding `Error.prepareStackTrace` — overriding it would bypass
 * Node's source-map translation and also drop the location of `eval`/vm frames
 * used by dev servers (Vite SSR, etc.). `ignoreFiles` lets the agent skip its
 * own frames so the reported site is the user's `console.log` line.
 */
export function captureCallSite(ignoreFiles: readonly string[] = []): CallSite | null {
  // Drop this function's own frame via V8's `captureStackTrace`, which excludes
  // it by reference. String-matching our own filename instead is fragile once
  // source maps are enabled (Node ≥ 23 default): the frame is translated to the
  // original `.ts` path, no longer matching the running `.js` `__filename`.
  const captureStackTrace = (Error as ErrorWithCapture).captureStackTrace;
  let stack: string | undefined;
  let ownFrameStripped = false;
  if (typeof captureStackTrace === 'function') {
    const holder: { stack?: string } = {};
    captureStackTrace(holder, captureCallSite);
    stack = holder.stack;
    ownFrameStripped = true;
  } else {
    stack = new Error().stack;
  }
  if (!stack) {
    return null;
  }
  const lines = stack.split('\n');
  // lines[0] is "Error"; lines[1] is the caller (own frame already stripped) —
  // or, on the fallback path, this function's own frame (skipped via SELF).
  for (let i = 1; i < lines.length; i++) {
    if (!ownFrameStripped && lines[i].includes(SELF)) {
      continue; // skip captureCallSite's own frame(s)
    }
    const site = parseStackLine(lines[i]);
    if (!site || isInternal(site.file)) {
      continue;
    }
    if (ignoreFiles.some((ignored) => site.file === ignored)) {
      continue;
    }
    return site;
  }
  return null;
}

interface ErrorWithCapture {
  captureStackTrace?: (target: object, ctor?: (...args: never[]) => unknown) => void;
}

const SELF = __filename;

export interface ParsedFrame extends CallSite {
  function?: string;
}

/**
 * Parse all user-land frames from an error stack (source-map translated when
 * enabled). Skips Node internals; keeps function names for display.
 */
export function parseFrames(stack: string, ignoreFiles: readonly string[] = []): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const raw of stack.split('\n')) {
    const site = parseStackLine(raw);
    if (!site || isInternal(site.file)) {
      continue;
    }
    if (ignoreFiles.some((f) => site.file === f) || site.file.includes('/.console-lens/')) {
      continue;
    }
    const fnMatch = /^\s*at\s+(?:async\s+)?(.+?)\s+\(/.exec(raw);
    frames.push({ ...site, function: fnMatch ? fnMatch[1] : undefined });
  }
  return frames;
}

/**
 * Strip a leading `file://` and any `?query`/`#hash` suffix (bundlers such as
 * webpack/Vite append them, e.g. `page.tsx?7603`) so paths match what the editor
 * uses.
 */
export function normalizeFileUrl(file: string): string {
  let result = file;
  if (result.startsWith('file://')) {
    try {
      result = decodeURIComponent(new URL(result).pathname);
      // On Windows an ESM frame is `file:///C:/x/app.mjs`, whose URL pathname is
      // `/C:/x/app.mjs` — strip the leading slash before the drive letter so the
      // editor gets a real path (`C:/x/app.mjs`).
      if (/^\/[A-Za-z]:/.test(result)) {
        result = result.slice(1);
      }
    } catch {
      /* keep as-is */
    }
  }
  const queryIndex = result.search(/[?#]/);
  if (queryIndex >= 0) {
    result = result.slice(0, queryIndex);
  }
  return result;
}
