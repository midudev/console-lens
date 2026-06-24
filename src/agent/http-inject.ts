/**
 * Zero-config browser auto-injection.
 *
 * Wraps `http(s).createServer` so any dev server started under the agent
 * (Vite, Astro — which uses Vite — and Next.js) automatically:
 *   1. serves the Console Lens browser client at a virtual route, and
 *   2. injects a <script> tag pointing at it into every HTML response,
 * so browser `console.*` calls stream to the editor with **no manual import**.
 *
 * It also prints one confirmation line when a dev server starts listening.
 *
 * The client is served from its own URL (containing "console-lens") so the
 * browser-side stack parser can skip its frames and report the user's real line.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transformSource } from '../shared/logpoints';
import { logpointsForFile } from './logpoint-store';

const CLIENT_ROUTE = '/__console-lens__/client.js';

function jsLogpointTransform(body: string, urlPath: string): string {
  try {
    const lps = logpointsForFile(urlPath);
    if (lps.length === 0) {
      return body;
    }
    return transformSource(body, lps);
  } catch {
    return body;
  }
}

function loadClient(): string | null {
  // out/agent/http-inject.js -> repo/extension root -> injector/browser-client.js
  const candidates = [
    path.resolve(__dirname, '../../injector/browser-client.js'),
    path.resolve(__dirname, '../../../injector/browser-client.js'),
  ];
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Insert the snippet before </head>, else before </body>, else append. */
export function injectIntoHtml(html: string, snippet: string): string {
  let pos = html.indexOf('</head>');
  if (pos < 0) {
    pos = html.indexOf('</body>');
  }
  if (pos < 0) {
    return html + snippet;
  }
  return html.slice(0, pos) + snippet + html.slice(pos);
}

function toBuffer(chunk: unknown, encoding?: unknown): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.alloc(0);
}

/**
 * Buffer an HTML response and inject the client snippet exactly once.
 *
 * Streaming SSR (Astro, Next.js) writes the document as many `Uint8Array`
 * chunks, and can split the `</head>` tag across chunk boundaries — making
 * per-chunk matching unreliable. Since this is a dev-only tool, buffering the
 * full HTML and injecting once is simple and bulletproof. Non-HTML responses
 * are passed straight through untouched (decided on the first write/end).
 */
function installResponseTransformer(req: http.IncomingMessage, res: http.ServerResponse, snippet: string): void {
  const tagged = res as unknown as { __clInjected__?: boolean };
  if (tagged.__clInjected__) {
    return;
  }
  tagged.__clInjected__ = true;

  const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  const urlPath = (req.url ?? '').split('?')[0].split('#')[0];

  let mode: 'html' | 'js' | 'passthrough' | null = null;
  const chunks: Buffer[] = [];

  const decideMode = (): 'html' | 'js' | 'passthrough' => {
    const ct = res.getHeader('content-type');
    if (res.getHeader('content-encoding') || typeof ct !== 'string') {
      return 'passthrough'; // never touch compressed/unknown bodies
    }
    if (ct.includes('text/html')) {
      return 'html';
    }
    // Transform served JS modules only when there are logpoints for that file.
    if (/javascript|typescript/.test(ct) && logpointsForFile(urlPath).length > 0) {
      return 'js';
    }
    return 'passthrough';
  };

  const decide = (): void => {
    if (mode === null) {
      mode = decideMode();
    }
  };

  const splitArgs = (encoding?: unknown, cb?: unknown): { encoding?: unknown; cb?: () => void } => {
    if (typeof encoding === 'function') {
      return { cb: encoding as () => void };
    }
    return { encoding, cb: typeof cb === 'function' ? (cb as () => void) : undefined };
  };

  (res as { write: typeof res.write }).write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    try {
      decide();
      if (mode !== 'passthrough') {
        if (chunk != null) {
          chunks.push(toBuffer(chunk, encoding));
        }
        const { cb: callback } = splitArgs(encoding, cb);
        callback?.();
        return true;
      }
    } catch {
      /* fall through to original write */
    }
    return origWrite(chunk, encoding, cb);
  } as typeof res.write;

  (res as { end: typeof res.end }).end = function (chunk?: unknown, encoding?: unknown, cb?: unknown): http.ServerResponse {
    try {
      decide();
      if (mode !== 'passthrough') {
        const { encoding: enc, cb: callback } = splitArgs(encoding, cb);
        if (chunk != null && typeof chunk !== 'function') {
          chunks.push(toBuffer(chunk, enc));
        }
        let body = Buffer.concat(chunks).toString('utf8');
        body = mode === 'html' ? injectIntoHtml(body, snippet) : jsLogpointTransform(body, urlPath);
        if (!res.headersSent && res.getHeader('content-length')) {
          res.removeHeader('content-length'); // length changed -> use chunked
        }
        return origEnd(body, callback);
      }
    } catch {
      /* fall through to original end */
    }
    return origEnd(chunk, encoding, cb);
  } as typeof res.end;
}

type EmitFn = (event: string, ...args: unknown[]) => boolean;

export function setupHttpInjection(
  tcpPort: number,
  wsPort: number,
  log: (message: string) => void,
): void {
  const clientJs = loadClient();
  // The dev server's project root, so browser logs can be attributed to it and
  // the editor can show only the current project's logs by default.
  const projectCwd = JSON.stringify(process.cwd());
  const snippet =
    `<script>window.__CONSOLE_LENS_WS_PORT__=${wsPort};window.__CONSOLE_LENS_PROJECT__=${projectCwd};</script>` +
    `<script src="${CLIENT_ROUTE}"></script>`;

  let announced = false;

  const serveClient = (res: http.ServerResponse): void => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(clientJs as string);
  };

  const announce = (server: http.Server): void => {
    if (announced) {
      return;
    }
    announced = true;
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : '?';
    const browser = clientJs ? 'browser logs on' : 'node only';
    // Single confirmation line: " console lens " on a green background, then a
    // plain message. No emojis.
    const badge = '\x1b[1;30;42m console lens \x1b[0m';
    log(`${badge} connected · http://localhost:${port} · ${browser}`);
  };

  /**
   * Patch `Server.prototype.emit` rather than `createServer`. Frameworks often
   * import `createServer` as a *named* ESM binding (`import { createServer }`),
   * which snapshots the function before our agent loads — so replacing the
   * module export has no effect. The Server prototype, however, is shared by
   * every server instance regardless of how it was created, making this the
   * reliable interception point for both `request` and `listening` events.
   */
  const patchPrototype = (proto: { emit: EmitFn } | undefined): void => {
    if (!proto) {
      return;
    }
    const tagged = proto as { emit: EmitFn; __consoleLensPatched__?: boolean };
    if (tagged.__consoleLensPatched__) {
      return;
    }
    tagged.__consoleLensPatched__ = true;

    const originalEmit = proto.emit;
    proto.emit = function (this: http.Server, event: string, ...args: unknown[]): boolean {
      if (event === 'request' && clientJs) {
        const req = args[0] as http.IncomingMessage;
        const res = args[1] as http.ServerResponse;
        try {
          if (req?.url && req.url.split('?')[0] === CLIENT_ROUTE) {
            serveClient(res);
            return true; // fully handled: don't dispatch to the app's listeners
          }
          // Force an uncompressed response so we can rewrite the HTML. Browsers
          // send `Accept-Encoding: gzip, br`, which makes dev servers (e.g.
          // Next.js) compress the body — into which we cannot inject. Dropping
          // this header (dev only) yields plain HTML.
          if (req?.headers) {
            delete req.headers['accept-encoding'];
          }
          installResponseTransformer(req, res, snippet);
        } catch {
          /* never break the host server */
        }
      } else if (event === 'listening') {
        try {
          announce(this);
        } catch {
          /* ignore */
        }
      }
      return originalEmit.apply(this, [event, ...args]);
    } as EmitFn;
  };

  patchPrototype((http.Server?.prototype as unknown) as { emit: EmitFn });
  patchPrototype((https.Server?.prototype as unknown) as { emit: EmitFn });
}
