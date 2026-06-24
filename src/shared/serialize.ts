import { inspect } from 'node:util';

export interface SerializeOptions {
  /** Object/array nesting depth. */
  depth?: number;
  /** Max characters per individual string before truncation. */
  maxStringLength?: number;
  /** Max array entries shown. */
  maxArrayLength?: number;
}

const DEFAULTS: Required<SerializeOptions> = {
  depth: 4,
  maxStringLength: 10_000,
  maxArrayLength: 100,
};

/**
 * Serialize a single console argument into a compact, single-line-friendly
 * display string. Built on top of `util.inspect`, so circular references,
 * getters, BigInt, Map/Set, errors, etc. are all handled safely and never throw.
 */
export function serializeArg(value: unknown, options: SerializeOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };
  try {
    return inspect(value, {
      depth: opts.depth,
      breakLength: Infinity,
      compact: true,
      maxArrayLength: opts.maxArrayLength,
      maxStringLength: opts.maxStringLength,
      colors: false,
      getters: false,
      sorted: false,
    });
  } catch (err) {
    // Absolute last-resort fallback: never let serialization crash the host app.
    try {
      return String(value);
    } catch {
      return `[unserializable: ${(err as Error)?.message ?? 'unknown'}]`;
    }
  }
}

export function serializeArgs(args: readonly unknown[], options: SerializeOptions = {}): string[] {
  return args.map((arg) => serializeArg(arg, options));
}

/** A compact, JSON-safe representation of a value for the panel's object tree. */
export interface TreeNode {
  /** Type label: 'string' | 'number' | 'object' | 'array' | class name … */
  t: string;
  /** Short single-line display for the row. */
  preview: string;
  /** Child entries for objects/arrays (omitted for leaves). */
  children?: Array<{ key: string; node: TreeNode }>;
  truncated?: boolean;
}

interface TreeOptions {
  maxDepth: number;
  maxChildren: number;
}

const TREE_DEFAULTS: TreeOptions = { maxDepth: 4, maxChildren: 100 };

/**
 * Build a bounded, JSON-safe tree from any value so the panel can render it as a
 * collapsible object inspector. Never throws; handles circular refs.
 */
export function buildTree(value: unknown, options: Partial<TreeOptions> = {}): TreeNode {
  const opts = { ...TREE_DEFAULTS, ...options };
  const seen = new WeakSet<object>();

  const walk = (val: unknown, depth: number): TreeNode => {
    if (val === null) return { t: 'null', preview: 'null' };
    const type = typeof val;
    if (type === 'string') return { t: 'string', preview: serializeArg(val, { maxStringLength: 200 }) };
    if (type === 'number' || type === 'boolean' || type === 'undefined' || type === 'bigint') {
      return { t: type, preview: String(val) + (type === 'bigint' ? 'n' : '') };
    }
    if (type === 'symbol') return { t: 'symbol', preview: String(val) };
    if (type === 'function') {
      const name = (val as { name?: string }).name;
      return { t: 'function', preview: `ƒ ${name || 'anonymous'}()` };
    }
    const obj = val as object;
    if (seen.has(obj)) return { t: 'circular', preview: '[Circular]' };
    seen.add(obj);

    try {
      if (Array.isArray(val)) {
        const node: TreeNode = { t: 'array', preview: `Array(${val.length})` };
        if (depth >= opts.maxDepth) {
          return node;
        }
        const children: TreeNode['children'] = [];
        const limit = Math.min(val.length, opts.maxChildren);
        for (let i = 0; i < limit; i++) {
          children.push({ key: String(i), node: walk(val[i], depth + 1) });
        }
        node.children = children;
        node.truncated = val.length > limit;
        return node;
      }
      if (val instanceof Map) {
        const node: TreeNode = { t: 'Map', preview: `Map(${val.size})` };
        if (depth < opts.maxDepth) {
          node.children = [...val.entries()]
            .slice(0, opts.maxChildren)
            .map(([k, v]) => ({ key: serializeArg(k, { maxStringLength: 60 }), node: walk(v, depth + 1) }));
        }
        return node;
      }
      if (val instanceof Set) {
        const node: TreeNode = { t: 'Set', preview: `Set(${val.size})` };
        if (depth < opts.maxDepth) {
          node.children = [...val.values()].slice(0, opts.maxChildren).map((v, i) => ({ key: String(i), node: walk(v, depth + 1) }));
        }
        return node;
      }
      const ctor = (obj.constructor && obj.constructor.name) || 'Object';
      const node: TreeNode = { t: ctor, preview: serializeArg(val, { depth: 0 }) };
      if (depth >= opts.maxDepth) {
        return node;
      }
      const keys = Object.keys(obj as Record<string, unknown>);
      const limit = Math.min(keys.length, opts.maxChildren);
      node.children = keys
        .slice(0, limit)
        .map((k) => ({ key: k, node: walk((obj as Record<string, unknown>)[k], depth + 1) }));
      node.truncated = keys.length > limit;
      return node;
    } catch {
      return { t: 'object', preview: serializeArg(val) };
    } finally {
      seen.delete(obj);
    }
  };

  try {
    return walk(value, 0);
  } catch {
    return { t: 'unknown', preview: serializeArg(value) };
  }
}

/**
 * Build a single-line preview from already-serialized argument strings.
 * Newlines are collapsed and the result is truncated to `maxLength`.
 */
export function buildPreview(parts: readonly string[], maxLength = 200): string {
  let preview = parts.join(' ').replace(/\s*\r?\n\s*/g, ' ⏎ ');
  if (preview.length > maxLength) {
    preview = preview.slice(0, Math.max(0, maxLength - 1)) + '…';
  }
  return preview;
}
