/**
 * Cross-platform helpers for attributing a log to a project (used by the panel's
 * "This project" filter). Kept dependency-free so the exact source can be
 * embedded into the webview via `Function.prototype.toString`, which guarantees
 * the shipped code is the same code these unit tests exercise.
 */

/**
 * Normalize a filesystem path for comparison across OSes: forward slashes, no
 * trailing slash, lowercased. Windows and macOS are case-insensitive, and a
 * dev server's cwd vs the editor's workspace path may differ only in slash
 * direction or case, so we fold all of that away before comparing.
 */
export function normalizeProjectPath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * True when a log's project root (`cwd`) belongs to one of the workspace roots:
 * an exact match, the cwd nested inside a root, or a root nested inside the cwd
 * (e.g. running `npm run dev` from a monorepo sub-package).
 *
 * Self-contained (normalization inlined) so its `Function.prototype.toString`
 * can be embedded into the webview without depending on another symbol that a
 * bundler might rename or drop.
 */
export function isInProjectRoots(cwd: string | undefined, roots: readonly string[]): boolean {
  const norm = (p: string): string => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!cwd) {
    return false;
  }
  const c = norm(cwd);
  return roots.some((root) => {
    const r = norm(root);
    return r !== '' && (c === r || c.startsWith(r + '/') || r.startsWith(c + '/'));
  });
}
