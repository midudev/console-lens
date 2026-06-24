import type { ErrorMessage, StackFrame } from '../shared/protocol';
import { parseFrames } from '../shared/stack';
import { resolveSourcePath } from './resolve-path';
import type { Transport } from './transport';

/**
 * Build and ship an ErrorMessage from a thrown value. Source-mapped stack frames
 * are resolved to real on-disk paths so the editor can match them exactly.
 */
export function reportError(
  transport: Transport,
  session: string,
  err: unknown,
  origin: string,
  cwd?: string,
): void {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    const frames: StackFrame[] = parseFrames(error.stack ?? '').map((f) => ({
      function: f.function,
      file: resolveSourcePath(f.file),
      line: f.line,
      column: f.column,
    }));

    const message: ErrorMessage = {
      v: 1,
      type: 'error',
      name: error.name || 'Error',
      message: error.message || String(err),
      frames,
      origin,
      timestamp: Date.now(),
      runtime: 'node',
      session,
      cwd,
    };
    transport.send(message);
  } catch {
    /* never break the host app */
  }
}
