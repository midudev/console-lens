import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSource } from '../shared/logpoints';
import { logpointsForFile } from './logpoint-store';

export interface LogpointMeta {
  f: string;
  l: number;
  e: string;
}

type Ship = (meta: LogpointMeta, value: unknown) => void;

/**
 * Install Node-side logpoint instrumentation: define the global sink and hook
 * module compilation (CJS via `_compile`, ESM via `registerHooks`) to inject the
 * logpoint calls. Always falls back to the original source if a transform fails.
 */
export function setupLogpoints(ship: Ship): void {
  (globalThis as Record<string, unknown>).__cl_lp__ = (meta: LogpointMeta, value: unknown) => {
    try {
      ship(meta, value);
    } catch {
      /* never break the host app */
    }
  };

  const moduleAny = Module as unknown as {
    prototype: { _compile?: (content: string, filename: string) => unknown; __clLp__?: boolean };
    registerHooks?: (hooks: unknown) => void;
  };

  // CommonJS
  const proto = moduleAny.prototype;
  if (proto && typeof proto._compile === 'function' && !proto.__clLp__) {
    proto.__clLp__ = true;
    const original = proto._compile;
    proto._compile = function (this: unknown, content: string, filename: string): unknown {
      let out = content;
      try {
        const lps = logpointsForFile(filename);
        if (lps.length > 0) {
          out = transformSource(content, lps);
        }
      } catch {
        out = content;
      }
      if (out !== content) {
        try {
          return original.call(this, out, filename);
        } catch {
          // Our transform broke compilation — never break the app.
          return original.call(this, content, filename);
        }
      }
      return original.call(this, content, filename);
    };
  }

  // ES modules (Node 22.15+/23.5+/24): synchronous in-process hooks.
  if (typeof moduleAny.registerHooks === 'function') {
    try {
      moduleAny.registerHooks({
        load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => { source?: unknown; format?: string }) {
          const result = nextLoad(url, context);
          try {
            if (result && result.source != null && url.startsWith('file:')) {
              const filename = fileURLToPath(url);
              const lps = logpointsForFile(filename);
              if (lps.length > 0) {
                const src =
                  typeof result.source === 'string' ? result.source : Buffer.from(result.source as Uint8Array).toString('utf8');
                result.source = transformSource(src, lps);
              }
            }
          } catch {
            /* keep original source */
          }
          return result;
        },
      });
    } catch {
      /* registerHooks unavailable/failed — CJS path still works */
    }
  }
}
