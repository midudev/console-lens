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

  function serialize(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    try {
      return JSON.stringify(v, function () {
        return arguments[1];
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
      var site = callSite();
      var start = Date.now();
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
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
