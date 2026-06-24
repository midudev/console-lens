// Console Lens browser client. Injected into served HTML pages.
// Patches console.* and streams structured logs to the editor over WebSocket.
(function () {
  if (window.__consoleLensAttached__) return;
  window.__consoleLensAttached__ = true;

  var PORT = (window.__CONSOLE_LENS_WS_PORT__ || 9112);
  var URL = 'ws://localhost:' + PORT;
  var session = String(Date.now()) + Math.random().toString(16).slice(2);
  // Project root of the dev server that served this page (injected by the agent),
  // so the editor can show only the current project's logs by default.
  var PROJECT = window.__CONSOLE_LENS_PROJECT__ || undefined;
  var socket = null;
  var queue = [];
  var MAX_QUEUE = 500;

  function connect() {
    try {
      socket = new WebSocket(URL);
      socket.addEventListener('open', function () {
        while (queue.length) socket.send(queue.shift());
      });
      socket.addEventListener('close', function () {
        socket = null;
        setTimeout(connect, 1000);
      });
      socket.addEventListener('error', function () {});
    } catch (e) {}
  }
  connect();

  function send(obj) {
    if (PROJECT && obj && obj.cwd === undefined) obj.cwd = PROJECT;
    var line = JSON.stringify(obj);
    if (socket && socket.readyState === 1) socket.send(line);
    else if (queue.length < MAX_QUEUE) queue.push(line);
  }

  function isNode(v) {
    return typeof Node !== 'undefined' && v instanceof Node;
  }

  // A DOM node has no enumerable own properties, so JSON.stringify renders it as
  // an empty `{}`. Describe it like the browser console does instead: a CSS-ish
  // selector (tag#id.class…) so `console.log(el)` is actually readable.
  function describeNode(el) {
    try {
      if (el.nodeType === 1) {
        var s = el.tagName ? el.tagName.toLowerCase() : 'element';
        if (el.id) s += '#' + el.id;
        var cls = el.classList;
        if (cls && cls.length) {
          for (var i = 0; i < Math.min(cls.length, 8); i++) s += '.' + cls[i];
          if (cls.length > 8) s += '…';
        }
        return '<' + s + '>';
      }
      if (el.nodeType === 3) return '#text "' + String(el.textContent || '').slice(0, 40) + '"';
      if (el.nodeType === 8) return '<!-- comment -->';
      if (el.nodeType === 9) return '#document';
      if (el.nodeType === 11) return '#document-fragment';
      return '<' + (el.nodeName ? String(el.nodeName).toLowerCase() : 'node') + '>';
    } catch (e) {
      return '[node]';
    }
  }

  // Dev-server / framework internals (Vite + Astro module and asset loading,
  // HMR). These aren't app requests, so they must not show up as network logs.
  function isInternalRequest(url) {
    try {
      var u = String(url);
      return (
        /[?&](astro|vue|svelte)&type=/.test(u) || // SFC sub-modules (?astro&type=script…)
        /[?&]astro(&|=|$)/.test(u) ||
        /\/@(vite|id|fs|react-refresh)\//.test(u) ||
        /\/@vite\/client\b/.test(u) ||
        /\/node_modules\/\.vite\//.test(u) ||
        /[?&]html-proxy\b/.test(u) ||
        /[?&]t=\d{10,}/.test(u) || // Vite HMR cache-busting timestamp
        /hot-update\.(json|js|mjs)\b/.test(u) // webpack / Next HMR
      );
    } catch (e) {
      return false;
    }
  }

  var MAX_DEPTH = 4, MAX_ENTRIES = 100, MAX_STR = 200;

  // Best-effort label for values JSON.stringify would collapse to `{}`: DOM
  // nodes & collections, Map, Set, Error, RegExp, Date, typed arrays, Blob/File,
  // Promise, URL… Returns undefined for plain objects/arrays (caller recurses).
  function describeSpecial(v, depth, seen) {
    try {
      if (isNode(v)) return describeNode(v);
      if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Error) return (v.name || 'Error') + ': ' + (v.message || '');
      if (typeof Map !== 'undefined' && v instanceof Map) {
        var me = [], c = 0;
        v.forEach(function (val, key) {
          if (c++ < 50) me.push(inspect(key, depth + 1, seen) + ' => ' + inspect(val, depth + 1, seen));
        });
        return 'Map(' + v.size + ')' + (me.length ? ' { ' + me.join(', ') + (v.size > 50 ? ', …' : '') + ' }' : ' {}');
      }
      if (typeof Set !== 'undefined' && v instanceof Set) {
        var se = [], c2 = 0;
        v.forEach(function (val) { if (c2++ < 50) se.push(inspect(val, depth + 1, seen)); });
        return 'Set(' + v.size + ')' + (se.length ? ' { ' + se.join(', ') + (v.size > 50 ? ', …' : '') + ' }' : ' {}');
      }
      if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise { <pending> }';
      if (typeof WeakMap !== 'undefined' && v instanceof WeakMap) return 'WeakMap {}';
      if (typeof WeakSet !== 'undefined' && v instanceof WeakSet) return 'WeakSet {}';
      if (typeof URL !== 'undefined' && v instanceof URL) return 'URL ' + v.href;
      if (typeof URLSearchParams !== 'undefined' && v instanceof URLSearchParams) return 'URLSearchParams { ' + v.toString() + ' }';
      if (typeof window !== 'undefined' && v === window) return '[window]';
      if (typeof DataView !== 'undefined' && v instanceof DataView) return 'DataView(' + v.byteLength + ')';
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
        var ta = Array.prototype.slice.call(v, 0, 20).join(', ');
        return ((v.constructor && v.constructor.name) || 'TypedArray') + '(' + v.length + ') [' + ta + (v.length > 20 ? ', …' : '') + ']';
      }
      if (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer) return 'ArrayBuffer(' + v.byteLength + ')';
      if (typeof File !== 'undefined' && v instanceof File) return 'File ' + JSON.stringify(v.name) + ' { size: ' + v.size + ', type: ' + JSON.stringify(v.type) + ' }';
      if (typeof Blob !== 'undefined' && v instanceof Blob) return 'Blob { size: ' + v.size + ', type: ' + JSON.stringify(v.type) + ' }';
      if (typeof Event !== 'undefined' && v instanceof Event) return (v.type || 'event') + ' Event';
      if (typeof FormData !== 'undefined' && v instanceof FormData) return 'FormData {}';
      var brand = Object.prototype.toString.call(v);
      var bm = /^\[object (NodeList|HTMLCollection|DOMTokenList|NamedNodeMap)\]$/.exec(brand);
      if (bm) {
        var len = v.length || 0, arr = [];
        for (var i = 0; i < Math.min(len, 20); i++) arr.push(inspect(v[i], depth + 1, seen));
        return bm[1] + '(' + len + ') [' + arr.join(', ') + (len > 20 ? ', …' : '') + ']';
      }
    } catch (e) {}
    return undefined;
  }

  // A compact, readable representation of any value — a small util.inspect for
  // the browser — so complex objects never collapse to `{}` in the editor.
  function inspect(v, depth, seen) {
    depth = depth || 0; seen = seen || [];
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    var ty = typeof v;
    if (ty === 'string') {
      var q = JSON.stringify(v);
      return q.length > MAX_STR ? q.slice(0, MAX_STR) + '…"' : q;
    }
    if (ty === 'number' || ty === 'boolean') return String(v);
    if (ty === 'bigint') return String(v) + 'n';
    if (ty === 'symbol') { try { return v.toString(); } catch (e) { return 'Symbol()'; } }
    if (ty === 'function') {
      try { if (/^class[\s{]/.test(Function.prototype.toString.call(v))) return 'class ' + (v.name || '(anonymous)'); } catch (e) {}
      return 'ƒ ' + (v.name || 'anonymous') + '()';
    }
    var sp = describeSpecial(v, depth, seen);
    if (sp !== undefined) return sp;
    if (seen.indexOf(v) !== -1) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array]' : '[Object]';
    seen = seen.concat([v]);
    try {
      if (Array.isArray(v)) {
        var items = [];
        for (var i = 0; i < Math.min(v.length, MAX_ENTRIES); i++) items.push(inspect(v[i], depth + 1, seen));
        if (v.length > MAX_ENTRIES) items.push('… ' + (v.length - MAX_ENTRIES) + ' more');
        return '[' + items.join(', ') + ']';
      }
      var ctor = '';
      try { ctor = (v.constructor && v.constructor.name) || ''; } catch (e) {}
      var keys = Object.keys(v);
      var pairs = [];
      for (var k = 0; k < Math.min(keys.length, MAX_ENTRIES); k++) {
        pairs.push(keys[k] + ': ' + inspect(v[keys[k]], depth + 1, seen));
      }
      if (keys.length > MAX_ENTRIES) pairs.push('… ' + (keys.length - MAX_ENTRIES) + ' more');
      var body = pairs.length ? '{ ' + pairs.join(', ') + ' }' : '{}';
      return ctor && ctor !== 'Object' ? ctor + ' ' + body : body;
    } catch (e) {
      try { return String(v); } catch (e2) { return '[unserializable]'; }
    }
  }

  function serialize(v) {
    return inspect(v, 0, []);
  }

  function callSite() {
    var err = new Error();
    var lines = (err.stack || '').split('\n');
    for (var i = 1; i < lines.length; i++) {
      var lineStr = lines[i];
      if (lineStr.indexOf('console-lens') !== -1) continue;
      var m = /(https?:\/\/.+?|\/.+?):(\d+):(\d+)/.exec(lineStr);
      if (m) return { url: m[1], file: m[1].split('?')[0], line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
    }
    return { url: '', file: location.pathname, line: 0, column: 0 };
  }

  // --- Source-map resolution -------------------------------------------------
  // Dev servers (Vite, Astro, webpack…) serve transformed modules: an Astro
  // `<script>` or a `.ts` file becomes a separate JS module, so the browser's
  // stack reports the line WITHIN that generated module (often `:1`), not the
  // original source line. Each served module ships a source map, so we fetch it
  // once per URL and map the generated position back to the real file:line.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var smCache = {}; // url -> Promise<map|null>

  function decodeVLQ(seg) {
    var result = [], shift = 0, value = 0;
    for (var i = 0; i < seg.length; i++) {
      var c = B64.indexOf(seg.charAt(i));
      if (c === -1) break;
      value += (c & 31) << shift;
      if (c & 32) { shift += 5; }
      else { var neg = value & 1; value = value >> 1; result.push(neg ? -value : value); value = 0; shift = 0; }
    }
    return result;
  }

  function decodeMappings(str) {
    var rows = str.split(';'), out = new Array(rows.length);
    var srcIdx = 0, origLine = 0, origCol = 0;
    for (var li = 0; li < rows.length; li++) {
      var segs = [], genCol = 0;
      if (rows[li]) {
        var parts = rows[li].split(',');
        for (var si = 0; si < parts.length; si++) {
          var f = decodeVLQ(parts[si]);
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
    var root = raw.sourceRoot || '';
    var sources = (raw.sources || []).map(function (s) {
      try { return new URL(root + s, baseUrl).href; } catch (e) { return s; }
    });
    return { sources: sources, rows: decodeMappings(raw.mappings || '') };
  }

  function loadMap(url) {
    if (smCache[url]) return smCache[url];
    var p = fetch(url).then(function (r) { return r.text(); }).then(function (text) {
      var mm = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/.exec(text);
      if (!mm) return null;
      var su = mm[1];
      if (su.indexOf('data:') === 0) {
        var b = su.indexOf('base64,');
        var json = b !== -1 ? atob(su.slice(b + 7)) : decodeURIComponent(su.slice(su.indexOf(',') + 1));
        return parseMap(JSON.parse(json), url);
      }
      var mapUrl = new URL(su, url).href;
      return fetch(mapUrl).then(function (r) { return r.json(); }).then(function (j) { return parseMap(j, url); });
    }).catch(function () { return null; });
    smCache[url] = p;
    return p;
  }

  function mapPosition(map, line, column) {
    var segs = map.rows[line - 1];
    if (!segs || !segs.length) return null;
    var col0 = column - 1, best = null;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i].length < 4) continue;
      if (segs[i][0] <= col0) best = segs[i]; else if (best) break;
    }
    if (!best) for (var j = 0; j < segs.length; j++) { if (segs[j].length >= 4) { best = segs[j]; break; } }
    if (!best) return null;
    return { file: map.sources[best[1]] || null, line: best[2] + 1, column: best[3] + 1 };
  }

  // Resolve a raw stack site to its original source location (async). Falls back
  // to the raw site when no usable source map is available.
  function resolveSite(site) {
    if (!site || !site.url) return Promise.resolve(site);
    return loadMap(site.url).then(function (map) {
      if (map) {
        var pos = mapPosition(map, site.line, site.column);
        if (pos && pos.file) return { file: pos.file, line: pos.line, column: pos.column };
      }
      return { file: site.file, line: site.line, column: site.column };
    }).catch(function () { return { file: site.file, line: site.line, column: site.column }; });
  }

  function buildTree(value, depth, seen) {
    depth = depth || 0; seen = seen || [];
    if (value === null) return { t: 'null', preview: 'null' };
    var ty = typeof value;
    if (ty === 'string') return { t: 'string', preview: JSON.stringify(value).slice(0, 200) };
    if (ty === 'number' || ty === 'boolean' || ty === 'undefined' || ty === 'bigint') return { t: ty, preview: String(value) };
    if (ty === 'symbol') return { t: 'symbol', preview: String(value) };
    if (ty === 'function') return { t: 'function', preview: 'ƒ ' + (value.name || 'anonymous') + '()' };
    // Special objects: render them meaningfully and, where useful, expandable —
    // instead of the empty `{}` JSON.stringify would produce.
    if (isNode(value)) {
      var nn = { t: 'node', preview: describeNode(value) };
      if (value.nodeType === 1 && depth < 4) {
        nn.children = [];
        if (value.id) nn.children.push({ key: 'id', node: { t: 'string', preview: JSON.stringify(value.id) } });
        var cls = value.getAttribute && value.getAttribute('class');
        if (cls) nn.children.push({ key: 'class', node: { t: 'string', preview: JSON.stringify(cls) } });
        var txt = (value.textContent || '').trim();
        if (txt) nn.children.push({ key: 'textContent', node: { t: 'string', preview: JSON.stringify(txt.slice(0, 80)) } });
      }
      return nn;
    }
    if (typeof Map !== 'undefined' && value instanceof Map) {
      var mn = { t: 'Map', preview: 'Map(' + value.size + ')' };
      if (depth < 4) {
        mn.children = []; var mseen = seen.concat([value]); var mc = 0;
        value.forEach(function (val, key) {
          if (mc++ < 100) mn.children.push({ key: typeof key === 'object' && key !== null ? inspect(key, 0, []) : String(key), node: buildTree(val, depth + 1, mseen) });
        });
        mn.truncated = value.size > 100;
      }
      return mn;
    }
    if (typeof Set !== 'undefined' && value instanceof Set) {
      var setN = { t: 'Set', preview: 'Set(' + value.size + ')' };
      if (depth < 4) {
        setN.children = []; var sseen = seen.concat([value]); var si = 0;
        value.forEach(function (val) { if (si < 100) setN.children.push({ key: String(si++), node: buildTree(val, depth + 1, sseen) }); });
        setN.truncated = value.size > 100;
      }
      return setN;
    }
    if (value instanceof Error) {
      return { t: 'Error', preview: (value.name || 'Error') + ': ' + (value.message || ''), children: [
        { key: 'name', node: { t: 'string', preview: JSON.stringify(value.name || 'Error') } },
        { key: 'message', node: { t: 'string', preview: JSON.stringify(value.message || '') } },
        { key: 'stack', node: { t: 'string', preview: JSON.stringify(String(value.stack || '').slice(0, 800)) } },
      ] };
    }
    var special = describeSpecial(value, depth, seen);
    if (special !== undefined) return { t: (value.constructor && value.constructor.name) || 'object', preview: special };
    if (seen.indexOf(value) !== -1) return { t: 'circular', preview: '[Circular]' };
    seen = seen.concat([value]);
    try {
      if (Array.isArray(value)) {
        var n = { t: 'array', preview: 'Array(' + value.length + ')' };
        if (depth < 4) { n.children = []; for (var i = 0; i < Math.min(value.length, 100); i++) n.children.push({ key: String(i), node: buildTree(value[i], depth + 1, seen) }); n.truncated = value.length > 100; }
        return n;
      }
      var ctor = (value.constructor && value.constructor.name) || 'Object';
      var n2 = { t: ctor, preview: serialize(value).slice(0, 120) };
      if (depth < 4) { var keys = Object.keys(value); n2.children = []; for (var j = 0; j < Math.min(keys.length, 100); j++) n2.children.push({ key: keys[j], node: buildTree(value[keys[j]], depth + 1, seen) }); n2.truncated = keys.length > 100; }
      return n2;
    } catch (e) { return { t: 'object', preview: String(value) }; }
  }

  // Logpoint sink: invoked by instrumentation injected into served modules.
  window.__cl_lp__ = function (meta, value) {
    try {
      var parts = [serialize(value)];
      send({
        v: 1, type: 'log', level: 'log',
        file: meta.f, line: meta.l, column: 0,
        args: parts, tree: [buildTree(value)],
        preview: parts.join(' ').slice(0, 200),
        timestamp: Date.now(), runtime: 'browser', session: session,
        logpoint: true, expression: meta.e,
      });
    } catch (e) {}
  };

  var LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  LEVELS.forEach(function (level) {
    var native = console[level] ? console[level].bind(console) : console.log.bind(console);
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      native.apply(console, args);
      try {
        var site = callSite();
        var parts = args.map(serialize);
        var preview = parts.join(' ').replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 200);
        var trees = args.map(function (a) { return buildTree(a); });
        var ts = Date.now();
        resolveSite(site).then(function (loc) {
          send({
            v: 1,
            type: 'log',
            level: level,
            file: loc.file,
            line: loc.line,
            column: loc.column,
            args: parts,
            tree: trees,
            preview: preview,
            timestamp: ts,
            runtime: 'browser',
            session: session,
          });
        });
      } catch (e) {}
    };
  });

  // console.table → captured as a log flagged `table` so the panel renders a grid.
  if (typeof console.table === 'function' && !console.table.__consoleLensWrapped__) {
    var nativeTable = console.table.bind(console);
    var patchedTable = function () {
      var args = Array.prototype.slice.call(arguments);
      nativeTable.apply(console, args);
      try {
        var site = callSite();
        var parts = args.map(serialize);
        var preview = parts.join(' ').replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 200);
        var trees = args.map(function (a) { return buildTree(a); });
        var ts = Date.now();
        resolveSite(site).then(function (loc) {
          send({
            v: 1, type: 'log', level: 'log',
            file: loc.file, line: loc.line, column: loc.column,
            args: parts, tree: trees, preview: preview,
            timestamp: ts, runtime: 'browser', session: session, table: true,
          });
        });
      } catch (e) {}
    };
    patchedTable.__consoleLensWrapped__ = true;
    console.table = patchedTable;
  }

  // Capture fetch() calls (method, status, request/response payloads).
  if (typeof window.fetch === 'function' && !window.fetch.__consoleLensWrapped__) {
    var nativeFetch = window.fetch.bind(window);
    var capN = function (s) {
      return typeof s === 'string' && s.length > 10000 ? s.slice(0, 10000) + '…' : s;
    };
    var reqBodyOf = function (init) {
      try {
        if (init && typeof init.body === 'string') return capN(init.body);
        if (init && init.body && typeof init.body.toString === 'function') {
          var s = String(init.body);
          if (s && s !== '[object Object]') return capN(s);
        }
      } catch (e) {}
      return undefined;
    };
    var wrapped = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      // Skip the dev server's own module/asset/HMR traffic — not app requests.
      if (isInternalRequest(url)) return nativeFetch(input, init);
      var site = callSite();
      var start = Date.now();
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var requestBody = reqBodyOf(init);
      var emit = function (status, ok, responseBody, error) {
        send({
          v: 1,
          type: 'network',
          method: method,
          url: url,
          status: status,
          ok: ok,
          requestBody: requestBody,
          responseBody: responseBody,
          error: error,
          durationMs: Date.now() - start,
          file: site.file,
          line: site.line,
          column: site.column,
          timestamp: Date.now(),
          runtime: 'browser',
          session: session,
        });
      };
      return nativeFetch(input, init).then(
        function (res) {
          try {
            var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (!/json|text|xml|javascript|html|csv|urlencoded|graphql/i.test(ct)) {
              emit(res.status, res.ok, ct ? '[' + ct.split(';')[0] + ']' : undefined);
              return res;
            }
            res
              .clone()
              .text()
              .then(function (txt) {
                emit(res.status, res.ok, capN(txt));
              })
              .catch(function () {
                emit(res.status, res.ok);
              });
          } catch (e) {
            emit(res.status, res.ok);
          }
          return res;
        },
        function (err) {
          emit(0, false, undefined, (err && err.message) || String(err));
          throw err;
        },
      );
    };
    wrapped.__consoleLensWrapped__ = true;
    window.fetch = wrapped;
  }

  function emitNet(method, url, status, ok, requestBody, responseBody, error, durationMs, site) {
    if (isInternalRequest(url)) return;
    send({
      v: 1, type: 'network', method: method, url: url, status: status, ok: ok,
      requestBody: requestBody, responseBody: responseBody, error: error, durationMs: durationMs,
      file: site.file, line: site.line, column: site.column,
      timestamp: Date.now(), runtime: 'browser', session: session,
    });
  }

  // Capture XMLHttpRequest (axios and others use it) by patching the prototype
  // — preserves the constructor, instanceof and static constants.
  if (typeof window.XMLHttpRequest === 'function' && window.XMLHttpRequest.prototype && !window.XMLHttpRequest.prototype.__consoleLensWrapped__) {
    var xproto = window.XMLHttpRequest.prototype;
    xproto.__consoleLensWrapped__ = true;
    var origOpen = xproto.open;
    var origSend = xproto.send;
    xproto.open = function (method, url) {
      try { this.__cl = { method: (method || 'GET').toUpperCase(), url: url, site: callSite() }; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    xproto.send = function (body) {
      var info = this.__cl;
      if (info) {
        info.start = Date.now();
        try { if (typeof body === 'string') info.body = body.slice(0, 10000); } catch (e) {}
        var xhr = this;
        this.addEventListener('loadend', function () {
          try {
            var ct = (xhr.getResponseHeader && xhr.getResponseHeader('content-type')) || '';
            var textual = /json|text|xml|javascript|html|csv|urlencoded|graphql/i.test(ct);
            var resp;
            try { resp = textual ? String(xhr.responseText || '').slice(0, 10000) : (ct ? '[' + ct.split(';')[0] + ']' : undefined); } catch (e) { resp = undefined; }
            emitNet(info.method, info.url, xhr.status, xhr.status >= 200 && xhr.status < 400, info.body, resp, xhr.status === 0 ? 'request failed' : undefined, Date.now() - info.start, info.site);
          } catch (e) {}
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  // Capture WebSocket connection lifecycle (not Console Lens's own socket).
  if (typeof window.WebSocket === 'function' && !window.WebSocket.__consoleLensWrapped__) {
    var NativeWS = window.WebSocket;
    var WrappedWS = function (url, protocols) {
      var ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
      var u = String(url);
      var self = u.indexOf('localhost:' + PORT) !== -1 || u.indexOf('127.0.0.1:' + PORT) !== -1;
      if (!self) {
        var site = callSite();
        var start = Date.now();
        try {
          ws.addEventListener('open', function () { emitNet('WS', u, 101, true, undefined, 'connected', undefined, Date.now() - start, site); });
          ws.addEventListener('error', function () { emitNet('WS', u, 0, false, undefined, undefined, 'connection error', Date.now() - start, site); });
        } catch (e) {}
      }
      return ws;
    };
    WrappedWS.__consoleLensWrapped__ = true;
    WrappedWS.prototype = NativeWS.prototype;
    WrappedWS.CONNECTING = NativeWS.CONNECTING; WrappedWS.OPEN = NativeWS.OPEN; WrappedWS.CLOSING = NativeWS.CLOSING; WrappedWS.CLOSED = NativeWS.CLOSED;
    window.WebSocket = WrappedWS;
  }

  // Capture uncaught errors and unhandled promise rejections.
  function parseErrFrames(stack) {
    var out = [];
    var lines = (stack || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (ln.indexOf('console-lens') !== -1) continue;
      var m = /(https?:\/\/.+?|\/.+?):(\d+):(\d+)/.exec(ln);
      if (!m) continue;
      var fn = /at\s+(.+?)\s+\(/.exec(ln);
      out.push({ function: fn ? fn[1] : undefined, url: m[1], file: m[1].split('?')[0], line: parseInt(m[2], 10), column: parseInt(m[3], 10) });
    }
    return out;
  }
  function sendError(err, origin) {
    try {
      var e = err && err.stack ? err : new Error((err && err.message) || String(err));
      var raw = parseErrFrames(e.stack);
      var ts = Date.now();
      Promise.all(raw.map(function (f) {
        return resolveSite(f).then(function (loc) { return { function: f.function, file: loc.file, line: loc.line, column: loc.column }; });
      })).then(function (frames) {
        send({
          v: 1, type: 'error',
          name: e.name || 'Error',
          message: e.message || String(err),
          frames: frames,
          origin: origin,
          timestamp: ts, runtime: 'browser', session: session,
        });
      });
    } catch (x) {}
  }
  window.addEventListener('error', function (ev) { sendError(ev.error || ev.message, 'window.onerror'); });
  window.addEventListener('unhandledrejection', function (ev) { sendError(ev.reason, 'unhandledrejection'); });
})();
