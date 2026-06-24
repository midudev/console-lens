import type { NetworkMessage } from '../shared/protocol';
import { captureCallSite } from '../shared/stack';
import { isInternalRequest } from '../shared/dev-requests';
import { resolveSourcePath } from './resolve-path';
import type { Transport } from './transport';

const MAX_BODY = 10_000;

function cap(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
}

function bodyToString(body: unknown): string | undefined {
  if (body == null) {
    return undefined;
  }
  if (typeof body === 'string') {
    return cap(body);
  }
  // URLSearchParams and similar stringify cleanly.
  try {
    if (typeof (body as { toString?: unknown }).toString === 'function') {
      const s = String(body);
      if (s && s !== '[object Object]') {
        return cap(s);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Wrap the global `fetch` to report each request (method, url, status, request
 * and response payloads) tagged with the call site. Fire-and-forget: the
 * response is returned to the app immediately; bodies are read from a clone in
 * the background so the app's own `.json()`/`.text()` still works.
 */
export function patchFetch(transport: Transport, session: string, cwd?: string): void {
  const g = globalThis as unknown as {
    fetch?: ((...a: unknown[]) => Promise<unknown>) & { __consoleLensWrapped__?: boolean };
  };
  const original = g.fetch;
  if (typeof original !== 'function' || original.__consoleLensWrapped__) {
    return;
  }

  const send = (msg: Omit<NetworkMessage, 'v' | 'type' | 'runtime' | 'session' | 'timestamp'>): void => {
    transport.send({
      v: 1,
      type: 'network',
      runtime: 'node',
      session,
      cwd,
      timestamp: Date.now(),
      ...msg,
    } satisfies NetworkMessage);
  };

  const wrapped = async function fetchWithLens(input: unknown, init?: unknown): Promise<unknown> {
    const initObj = (init ?? {}) as { method?: string; body?: unknown };
    const inputObj = input as { url?: string; method?: string };
    const url = typeof input === 'string' ? input : inputObj?.url ?? String(input);
    // Skip the dev server's own module/asset/HMR traffic — not app requests.
    if (isInternalRequest(url)) {
      return (original as (...a: unknown[]) => Promise<unknown>)(input, init);
    }
    const site = captureCallSite([__filename]);
    const start = Date.now();
    const method = (initObj.method || inputObj?.method || 'GET').toUpperCase();
    const requestBody = bodyToString(initObj.body);

    const base = {
      method,
      url,
      file: site ? resolveSourcePath(site.file) : '',
      line: site?.line ?? 0,
      column: site?.column ?? 0,
      requestBody,
    };

    try {
      const res = (await (original as (...a: unknown[]) => Promise<unknown>)(input, init)) as Response;
      const status = res.status;
      const ok = res.ok;
      if (!site) {
        return res;
      }
      const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      const textual = /json|text|xml|javascript|html|csv|urlencoded|graphql/i.test(contentType);
      if (!textual) {
        // Don't read binary bodies (images, fonts, …) — they'd be garbage.
        send({
          ...base,
          status,
          ok,
          responseBody: contentType ? `[${contentType.split(';')[0]}]` : undefined,
          durationMs: Date.now() - start,
        });
        return res;
      }
      // Read the textual body from a clone so we never consume the app's response.
      try {
        res
          .clone()
          .text()
          .then((txt) => send({ ...base, status, ok, responseBody: cap(txt), durationMs: Date.now() - start }))
          .catch(() => send({ ...base, status, ok, durationMs: Date.now() - start }));
      } catch {
        send({ ...base, status, ok, durationMs: Date.now() - start });
      }
      return res;
    } catch (err) {
      if (site) {
        send({
          ...base,
          status: 0,
          ok: false,
          error: (err as Error)?.message ?? String(err),
          durationMs: Date.now() - start,
        });
      }
      throw err;
    }
  } as ((...a: unknown[]) => Promise<unknown>) & { __consoleLensWrapped__?: boolean };

  wrapped.__consoleLensWrapped__ = true;
  g.fetch = wrapped;
}
