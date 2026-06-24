// Console Lens browser injector.
// Loaded via `node --require injector/loader.js` in front of a dev server.
// It wraps http(s).createServer so HTML responses get the browser client
// script injected, streaming browser console.* calls to the editor.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const WS_PORT = (Number(process.env.CONSOLE_LENS_PORT) || 9111) + 1;

let CLIENT_SCRIPT = '';
try {
  CLIENT_SCRIPT = fs.readFileSync(path.join(__dirname, 'browser-client.js'), 'utf8');
} catch (e) {
  CLIENT_SCRIPT = '';
}

function buildSnippet() {
  return (
    '<script>window.__CONSOLE_LENS_WS_PORT__=' +
    WS_PORT +
    ';</script>\n<script>' +
    CLIENT_SCRIPT +
    '</script>'
  );
}

function isHtml(res) {
  const ct = res.getHeader('Content-Type');
  return typeof ct === 'string' && ct.includes('text/html');
}

function inject(html) {
  const snippet = buildSnippet();
  if (html.includes('</body>')) {
    return html.replace('</body>', snippet + '</body>');
  }
  return html + snippet;
}

function wrap(mod) {
  const original = mod.createServer;
  if (!original || original.__consoleLensWrapped__) {
    return;
  }
  function wrapped(...args) {
    const listener = args.find((a) => typeof a === 'function');
    const opts = args.find((a) => a && typeof a === 'object');
    const handler = (req, res) => {
      const originalEnd = res.end;
      res.end = function (chunk, encoding, callback) {
        try {
          if (chunk && isHtml(res)) {
            let html = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            html = inject(html);
            if (res.getHeader('Content-Length')) {
              res.setHeader('Content-Length', Buffer.byteLength(html));
            }
            return originalEnd.call(this, html, encoding, callback);
          }
        } catch (e) {
          /* fall through to original behaviour */
        }
        return originalEnd.call(this, chunk, encoding, callback);
      };
      if (listener) {
        listener(req, res);
      }
    };
    return opts && !listener
      ? original.call(this, opts, handler)
      : original.call(this, handler);
  }
  wrapped.__consoleLensWrapped__ = true;
  mod.createServer = wrapped;
}

wrap(http);
wrap(https);

console.log('🔎 Console Lens browser injector active (WS ' + WS_PORT + ')');
