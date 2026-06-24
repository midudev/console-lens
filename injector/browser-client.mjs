// Console Lens browser client (ES module form).
//
// Import this for its side effects in DEV to stream browser console.* calls to
// the editor over WebSocket. Safe to import in any bundler (Vite, Astro, Next):
//
//   if (import.meta.env?.DEV) import('console-lens/browser');
//
// The WebSocket port defaults to 9112 (Console Lens TCP port 9111 + 1) and can
// be overridden via window.__CONSOLE_LENS_WS_PORT__.
export function attachConsoleLens(options = {}) {
  if (typeof window === 'undefined') return; // no-op during SSR
  if (window.__consoleLensAttached__) return;
  window.__consoleLensAttached__ = true;

  const PORT = options.port || window.__CONSOLE_LENS_WS_PORT__ || 9112;
  const URL = 'ws://localhost:' + PORT;
  const session = String(Date.now()) + Math.random().toString(16).slice(2);
  // Project root of the dev server that served this page (injected by the agent).
  const PROJECT = options.project || window.__CONSOLE_LENS_PROJECT__ || undefined;
  let socket = null;
  const queue = [];
  const MAX_QUEUE = 500;

  function connect() {
    try {
      socket = new WebSocket(URL);
      socket.addEventListener('open', () => {
        while (queue.length) socket.send(queue.shift());
      });
      socket.addEventListener('close', () => {
        socket = null;
        setTimeout(connect, 1000);
      });
      socket.addEventListener('error', () => {});
    } catch (e) {}
  }
  connect();

  function send(obj) {
    if (PROJECT && obj && obj.cwd === undefined) obj.cwd = PROJECT;
    const line = JSON.stringify(obj);
    if (socket && socket.readyState === 1) socket.send(line);
    else if (queue.length < MAX_QUEUE) queue.push(line);
  }

  function serialize(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    const seen = new WeakSet();
    try {
      return JSON.stringify(v, (_k, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
        }
        if (typeof val === 'bigint') return val.toString() + 'n';
        if (typeof val === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
        return val;
      });
    } catch (e) {
      try {
        return String(v);
      } catch (e2) {
        return '[unserializable]';
      }
    }
  }

  function callSite() {
    const err = new Error();
    const lines = (err.stack || '').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const lineStr = lines[i];
      // Skip the client's own frames (callSite + the patched console method).
      if (lineStr.includes('console-lens')) continue;
      const m = /(https?:\/\/.+?|\/.+?):(\d+):(\d+)/.exec(lineStr);
      if (m) {
        return {
          url: m[1],
          file: m[1].split('?')[0],
          line: parseInt(m[2], 10),
          column: parseInt(m[3], 10),
        };
      }
    }
    return { url: '', file: location.pathname, line: 0, column: 0 };
  }

  // --- Source-map resolution -------------------------------------------------
  // Dev servers serve transformed modules (an Astro `<script>` or a `.ts` file
  // becomes its own JS module), so the browser stack reports the line within the
  // generated module (often `:1`), not the original source line. Each module
  // ships a source map; we fetch it once per URL and map the position back.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const smCache = new Map(); // url -> Promise<map|null>

  function decodeVLQ(seg) {
    const result = [];
    let shift = 0, value = 0;
    for (let i = 0; i < seg.length; i++) {
      const c = B64.indexOf(seg.charAt(i));
      if (c === -1) break;
      value += (c & 31) << shift;
      if (c & 32) shift += 5;
      else { const neg = value & 1; value >>= 1; result.push(neg ? -value : value); value = 0; shift = 0; }
    }
    return result;
  }

  function decodeMappings(str) {
    const rows = str.split(';');
    const out = new Array(rows.length);
    let srcIdx = 0, origLine = 0, origCol = 0;
    for (let li = 0; li < rows.length; li++) {
      const segs = [];
      let genCol = 0;
      if (rows[li]) {
        for (const part of rows[li].split(',')) {
          const f = decodeVLQ(part);
          genCol += f[0] || 0;
          if (f.length >= 4) { srcIdx += f[1]; origLine += f[2]; origCol += f[3]; segs.push([genCol, srcIdx, origLine, origCol]); }
          else segs.push([genCol]);
        }
      }
      out[li] = segs;
    }
    return out;
  }

  function parseMap(raw, baseUrl) {
    const root = raw.sourceRoot || '';
    const sources = (raw.sources || []).map((s) => {
      try { return new URL(root + s, baseUrl).href; } catch { return s; }
    });
    return { sources, rows: decodeMappings(raw.mappings || '') };
  }

  function loadMap(url) {
    if (smCache.has(url)) return smCache.get(url);
    const p = fetch(url).then((r) => r.text()).then((text) => {
      const mm = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/.exec(text);
      if (!mm) return null;
      const su = mm[1];
      if (su.indexOf('data:') === 0) {
        const b = su.indexOf('base64,');
        const json = b !== -1 ? atob(su.slice(b + 7)) : decodeURIComponent(su.slice(su.indexOf(',') + 1));
        return parseMap(JSON.parse(json), url);
      }
      const mapUrl = new URL(su, url).href;
      return fetch(mapUrl).then((r) => r.json()).then((j) => parseMap(j, url));
    }).catch(() => null);
    smCache.set(url, p);
    return p;
  }

  function mapPosition(map, line, column) {
    const segs = map.rows[line - 1];
    if (!segs || !segs.length) return null;
    const col0 = column - 1;
    let best = null;
    for (const seg of segs) {
      if (seg.length < 4) continue;
      if (seg[0] <= col0) best = seg; else if (best) break;
    }
    if (!best) for (const seg of segs) { if (seg.length >= 4) { best = seg; break; } }
    if (!best) return null;
    return { file: map.sources[best[1]] || null, line: best[2] + 1, column: best[3] + 1 };
  }

  function resolveSite(site) {
    if (!site || !site.url) return Promise.resolve(site);
    return loadMap(site.url).then((map) => {
      if (map) {
        const pos = mapPosition(map, site.line, site.column);
        if (pos && pos.file) return { file: pos.file, line: pos.line, column: pos.column };
      }
      return { file: site.file, line: site.line, column: site.column };
    }).catch(() => ({ file: site.file, line: site.line, column: site.column }));
  }

  const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of LEVELS) {
    const native = console[level] ? console[level].bind(console) : console.log.bind(console);
    console[level] = function (...args) {
      native(...args);
      try {
        const site = callSite();
        const parts = args.map(serialize);
        const preview = parts.join(' ').replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 200);
        const ts = Date.now();
        resolveSite(site).then((loc) => {
          send({
            v: 1,
            type: 'log',
            level,
            file: loc.file,
            line: loc.line,
            column: loc.column,
            args: parts,
            preview,
            timestamp: ts,
            runtime: 'browser',
            session,
          });
        });
      } catch (e) {}
    };
  }

  // console.table → captured as a log flagged `table` so the panel renders a grid.
  if (typeof console.table === 'function' && !console.table.__consoleLensWrapped__) {
    const nativeTable = console.table.bind(console);
    const patchedTable = function (...args) {
      nativeTable(...args);
      try {
        const site = callSite();
        const parts = args.map(serialize);
        const preview = parts.join(' ').replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 200);
        const ts = Date.now();
        resolveSite(site).then((loc) => {
          send({
            v: 1, type: 'log', level: 'log',
            file: loc.file, line: loc.line, column: loc.column,
            args: parts, preview, timestamp: ts, runtime: 'browser', session, table: true,
          });
        });
      } catch (e) {}
    };
    patchedTable.__consoleLensWrapped__ = true;
    console.table = patchedTable;
  }

  // Capture uncaught errors and unhandled promise rejections.
  function parseErrFrames(stack) {
    const out = [];
    for (const ln of (stack || '').split('\n')) {
      if (ln.includes('console-lens')) continue;
      const m = /(https?:\/\/.+?|\/.+?):(\d+):(\d+)/.exec(ln);
      if (!m) continue;
      const fn = /at\s+(.+?)\s+\(/.exec(ln);
      out.push({ function: fn ? fn[1] : undefined, url: m[1], file: m[1].split('?')[0], line: parseInt(m[2], 10), column: parseInt(m[3], 10) });
    }
    return out;
  }
  function sendError(err, origin) {
    try {
      const e = err && err.stack ? err : new Error((err && err.message) || String(err));
      const ts = Date.now();
      Promise.all(parseErrFrames(e.stack).map((f) =>
        resolveSite(f).then((loc) => ({ function: f.function, file: loc.file, line: loc.line, column: loc.column })),
      )).then((frames) => {
        send({ v: 1, type: 'error', name: e.name || 'Error', message: e.message || String(err), frames, origin, timestamp: ts, runtime: 'browser', session });
      });
    } catch (x) {}
  }
  window.addEventListener('error', (ev) => sendError(ev.error || ev.message, 'window.onerror'));
  window.addEventListener('unhandledrejection', (ev) => sendError(ev.reason, 'unhandledrejection'));
}

// Auto-attach on import for side-effect usage.
attachConsoleLens();

export default attachConsoleLens;
