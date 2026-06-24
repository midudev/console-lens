import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogpointDef } from '../shared/logpoints';

interface StoredLogpoint extends LogpointDef {
  enabled?: boolean;
}

let cache: { mtimeMs: number; list: LogpointDef[] } | null = null;

/** Read enabled logpoints from the file the extension maintains (mtime-cached). */
function loadAll(): LogpointDef[] {
  const file = process.env.CONSOLE_LENS_LOGPOINTS;
  if (!file) {
    return [];
  }
  try {
    const stat = fs.statSync(file);
    if (cache && cache.mtimeMs === stat.mtimeMs) {
      return cache.list;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredLogpoint[];
    const list = (Array.isArray(data) ? data : [])
      .filter((lp) => lp && lp.enabled !== false && lp.expression && lp.file && lp.line)
      .map((lp) => ({ file: lp.file, line: lp.line, expression: lp.expression }));
    cache = { mtimeMs: stat.mtimeMs, list };
    return list;
  } catch {
    return [];
  }
}

const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');

/** Logpoints for a file: prefer an exact path match, fall back to basename. */
export function logpointsForFile(filename: string): LogpointDef[] {
  const all = loadAll();
  if (all.length === 0) {
    return [];
  }
  const target = norm(filename);
  const exact = all.filter((lp) => norm(lp.file) === target);
  if (exact.length > 0) {
    return exact;
  }
  const base = path.basename(target);
  return all.filter((lp) => path.basename(norm(lp.file)) === base);
}

export function hasLogpoints(): boolean {
  return loadAll().length > 0;
}
