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

  const MAX_DEPTH = 4, MAX_ENTRIES = 100, MAX_STR = 200;

  function isNode(v) {
    return typeof Node !== 'undefined' && v instanceof Node;
  }

  function describeNode(el) {
    try {
      if (el.nodeType === 1) {
        let s = el.tagName ? el.tagName.toLowerCase() : 'element';
        if (el.id) s += '#' + el.id;
        const cls = el.classList;
        if (cls && cls.length) {
          for (let i = 0; i < Math.min(cls.length, 8); i++) s += '.' + cls[i];
          if (cls.length > 8) s += '…';
        }
        return '<' + s + '>';
      }
      if (el.nodeType === 3) return '#text "' + String(el.textContent || '').slice(0, 40) + '"';
      if (el.nodeType === 9) return '#document';
      if (el.nodeType === 11) return '#document-fragment';
      return '<' + (el.nodeName ? String(el.nodeName).toLowerCase() : 'node') + '>';
    } catch (e) {
      return '[node]';
    }
  }

  // Best-effort label for values JSON.stringify would collapse to `{}`.
  function describeSpecial(v, depth, seen) {
    try {
      if (isNode(v)) return describeNode(v);
      if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '');
      if (typeof Map !== 'undefined' && v instanceof Map) {
        const me = []; let c = 0;
        v.forEach((val, key) => { if (c++ < 50) me.push(inspect(key, depth + 1, seen) + ' => ' + inspect(val, depth + 1, seen)); });
        return 'Map(' + v.size + ')' + (me.length ? ' { ' + me.join(', ') + (v.size > 50 ? ', …' : '') + ' }' : ' {}');
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        const se = []; let c2 = 0;
        v.forEach((val) => { if (c2++ < 50) se.push(inspect(val, depth + 1, seen)); });
        return 'Set(' + v.size + ')' + (se.length ? ' { ' + se.join(', ') + (v.size > 50 ? ', …' : '') + ' }' : ' {}');
      }
      if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { <pending> }';
      if (typeof URL !== 'undefined' && v instanceof URL) return 'URL ' + v.href;
      if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) return 'URLSearchParams { ' + v.toString() + ' }';
      if (typeof window !== 'undefined' && v === window) return '[window]';
      if (typeof DataView !== 'undefined' && v instanceof DataView) return 'DataView(' + v.byteLength + ')';
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
        return ((v.constructor && v.constructor.name) || 'TypedArray') + '(' + v.length + ') [' + Array.prototype.slice.call(v, 0, 20).join(', ') + (v.length > 20 ? ', …' : '') + ']';
      }
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return 'ArrayBuffer(' + v.byteLength + ')';
      if (typeof Blob !== 'undefined' && v instanceof Blob) return 'Blob { size: ' + v.size + ', type: ' + JSON.stringify(v.type) + ' }';
      if (typeof Event !== 'undefined' && v instanceof Event) return (v.type || 'event') + ' Event';
      const brand = Object.prototype.toString.call(v);
      const bm = /^\[object (NodeList|HTMLCollection|DOMTokenList|NamedNodeMap)\]$/.exec(brand);
      if (bm) {
        const len = v.length || 0, arr = [];
        for (let i = 0; i < Math.min(len, 20); i++) arr.push(inspect(v[i], depth + 1, seen));
        return bm[1] + '(' + len + ') [' + arr.join(', ') + (len > 20 ? ', …' : '') + ']';
      }
    } catch (e) {}
    return undefined;
  }

  // A compact, readable representation of any value (a small util.inspect).
  function inspect(v, depth = 0, seen = []) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const ty = typeof v;
    if (ty === 'string') {
      const q = JSON.stringify(v);
      return q.length > MAX_STR ? q.slice(0, MAX_STR) + '…"' : q;
    }
    if (ty === 'number' || ty === 'boolean') return String(v);
    if (ty === 'bigint') return String(v) + 'n';
    if (ty === 'symbol') { try { return v.toString(); } catch (e) { return 'Symbol()'; } }
    if (ty === 'function') {
      try { if (/^class[\s{]/.test(Function.prototype.toString.call(v))) return 'class ' + (v.name || '(anonymous)'); } catch (e) {}
      return 'ƒ ' + (v.name || 'anonymous') + '()';
    }
    const sp = describeSpecial(v, depth, seen);
    if (sp !== undefined) return sp;
    if (seen.indexOf(v) !== -1) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen = seen.concat([v]);
    try {
      if (Array.isArray(v)) {
        const items = [];
        for (let i = 0; i < Math.min(v.length, MAX_ENTRIES); i++) items.push(inspect(v[i], depth + 1, seen));
        if (v.length > MAX_ENTRIES) items.push('… ' + (v.length - MAX_ENTRIES) + ' more');
        return '[' + items.join(', ') + ']';
      }
      let ctor = '';
      try { ctor = (v.constructor && v.constructor.name) || ''; } catch (e) {}
      const keys = Object.keys(v);
      const pairs = [];
      for (let k = 0; k < Math.min(keys.length, MAX_ENTRIES); k++) pairs.push(keys[k] + ': ' + inspect(v[keys[k]], depth + 1, seen));
      if (keys.length > MAX_ENTRIES) pairs.push('… ' + (keys.length - MAX_ENTRIES) + ' more');
      const body = pairs.length ? '{ ' + pairs.join(', ') + ' }' : '{}';
      return ctor && ctor !== 'Object' ? ctor + ' ' + body : body;
    } catch (e) {
      try { return String(v); } catch (e2) { return '[unserializable]'; }
    }
  }

  function serialize(v) {
    return inspect(v, 0, []);
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
