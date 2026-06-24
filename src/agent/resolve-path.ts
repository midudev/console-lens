import * as fs from 'node:fs';
import * as path from 'node:path';

const cache = new Map<string, string>();

/**
 * Resolve a (possibly virtual) source path from a source map to a real file on
 * disk, so the editor can match it precisely instead of falling back to a
 * basename (important when many files share a name, e.g. Next.js `page.tsx`).
 *
 * Bundlers emit source paths like:
 *   webpack://app-name/app/page.tsx
 *   webpack-internal:///(rsc)/./app/page.tsx
 *   ./src/main.ts
 * We strip the scheme, namespace groups like `(rsc)`, and `.` segments, then
 * look for the longest trailing path that exists under `baseDir`.
 */
export function resolveSourcePath(file: string, baseDir: string = process.cwd()): string {
  if (!file || path.isAbsolute(file)) {
    return file;
  }
  const cached = cache.get(file);
  if (cached !== undefined) {
    return cached;
  }

  const stripped = file.replace(/^[a-z][a-z0-9.+-]*:\/+/i, '');
  const parts = stripped
    .split('/')
    .filter((p) => p && p !== '.' && !(p.startsWith('(') && p.endsWith(')')));

  let resolved = file;
  for (let i = 0; i < parts.length; i++) {
    const candidate = path.resolve(baseDir, parts.slice(i).join('/'));
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        resolved = candidate;
        break;
      }
    } catch {
      /* ignore and keep trying */
    }
  }

  cache.set(file, resolved);
  return resolved;
}
