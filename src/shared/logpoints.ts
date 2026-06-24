/**
 * Shared logpoint instrumentation engine (runtime-agnostic).
 *
 * A logpoint logs an expression at a line WITHOUT editing the user's source.
 * We inject, at the start of the target line, a call to `globalThis.__cl_lp__`
 * that evaluates the expression (with full lexical scope, since it's spliced
 * inline) and ships the value. The injection is prepended on the SAME physical
 * line so line numbers are preserved (source maps, stacks, other logpoints).
 *
 * Safety: the expression is validated as parseable, and we only inject on lines
 * that look like statement boundaries — never breaking the user's app.
 */

export interface LogpointDef {
  /** Editor file path (for display/matching). */
  file: string;
  /** 1-based line. */
  line: number;
  expression: string;
}

/** Is the expression syntactically valid on its own? */
export function isValidExpression(expression: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${expression});`);
    return true;
  } catch {
    return false;
  }
}

const LEADING_CONTINUATION = /^[).\]},:?]|^(\|\||&&|\?\?|=>)/;
const TRAILING_CONTINUATION = /([=([{,?:]|=>|\|\||&&|\?\?|\+|-|\*|\/|\.|\bawait|\breturn|\bcase|`)\s*$/;

/** Heuristic: is line `idx` (0-based) a safe place to prepend a statement? */
export function isSafeInjectionLine(lines: string[], idx: number): boolean {
  const current = (lines[idx] ?? '').trim();
  if (!current || current.startsWith('//') || current.startsWith('*') || current.startsWith('/*')) {
    return false;
  }
  if (LEADING_CONTINUATION.test(current)) {
    return false;
  }
  // Look at the previous non-empty, non-comment line for an open continuation.
  for (let i = idx - 1; i >= 0; i--) {
    const prev = (lines[i] ?? '').trim();
    if (!prev || prev.startsWith('//')) {
      continue;
    }
    if (TRAILING_CONTINUATION.test(prev)) {
      return false;
    }
    break;
  }
  return true;
}

function snippet(lp: LogpointDef): string {
  const meta = JSON.stringify({ f: lp.file, l: lp.line, e: lp.expression });
  // `globalThis.__cl_lp__` is defined by whichever runtime is active (Node/browser).
  return `globalThis.__cl_lp__&&globalThis.__cl_lp__(${meta},(()=>{try{return (${lp.expression})}catch(__cle){return __cle}})());`;
}

/**
 * Inject instrumentation for `logpoints` into `source`. `lineFor` optionally maps
 * an editor line to the line within `source` (used in the browser where served
 * code differs from the source); defaults to identity.
 */
export function transformSource(
  source: string,
  logpoints: LogpointDef[],
  lineFor: (editorLine: number) => number | null = (l) => l,
): string {
  const valid = logpoints.filter((lp) => isValidExpression(lp.expression));
  if (valid.length === 0) {
    return source;
  }
  const lines = source.split('\n');
  const byLine = new Map<number, LogpointDef[]>();
  for (const lp of valid) {
    const target = lineFor(lp.line);
    if (target == null) {
      continue;
    }
    const arr = byLine.get(target);
    if (arr) {
      arr.push(lp);
    } else {
      byLine.set(target, [lp]);
    }
  }
  for (const [line, lps] of byLine) {
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) {
      continue;
    }
    if (!isSafeInjectionLine(lines, idx)) {
      continue;
    }
    lines[idx] = lps.map(snippet).join('') + lines[idx];
  }
  return lines.join('\n');
}
