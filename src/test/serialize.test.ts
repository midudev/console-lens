import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview, buildTree, serializeArg, serializeArgs } from '../shared/serialize';

test('serializes primitives', () => {
  assert.equal(serializeArg(42), '42');
  assert.equal(serializeArg(true), 'true');
  assert.equal(serializeArg('hi'), "'hi'");
  assert.equal(serializeArg(null), 'null');
  assert.equal(serializeArg(undefined), 'undefined');
});

test('serializes objects and arrays compactly', () => {
  assert.equal(serializeArg({ a: 1, b: 2 }), '{ a: 1, b: 2 }');
  assert.equal(serializeArg([1, 2, 3]), '[ 1, 2, 3 ]');
});

test('handles circular references without throwing', () => {
  const obj: Record<string, unknown> = { name: 'x' };
  obj.self = obj;
  const out = serializeArg(obj);
  assert.match(out, /Circular/);
});

test('handles BigInt, Map, Set, Error', () => {
  assert.equal(serializeArg(10n), '10n');
  assert.match(serializeArg(new Map([['a', 1]])), /Map\(1\)/);
  assert.match(serializeArg(new Set([1, 2])), /Set\(2\)/);
  assert.match(serializeArg(new Error('boom')), /Error: boom/);
});

test('respects depth option', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  const shallow = serializeArg(deep, { depth: 1 });
  assert.match(shallow, /\[Object\]/);
});

test('truncates long strings via maxStringLength', () => {
  const long = 'x'.repeat(50);
  const out = serializeArg(long, { maxStringLength: 10 });
  assert.match(out, /more character/);
});

test('serializeArgs maps each argument', () => {
  assert.deepEqual(serializeArgs([1, 'a', true]), ['1', "'a'", 'true']);
});

test('buildTree builds a structured object tree', () => {
  const t = buildTree({ a: 1, b: { c: 'x' }, d: [1, 2] });
  assert.match(t.t, /Object/);
  assert.ok(t.children && t.children.length === 3);
  const b = t.children!.find((c) => c.key === 'b')!;
  assert.equal(b.node.t, 'Object');
  assert.equal(b.node.children![0].key, 'c');
  assert.equal(b.node.children![0].node.preview, "'x'");
  const d = t.children!.find((c) => c.key === 'd')!;
  assert.equal(d.node.t, 'array');
  assert.equal(d.node.preview, 'Array(2)');
});

test('buildTree handles circular refs and primitives', () => {
  const o: Record<string, unknown> = { n: 1 };
  o.self = o;
  const t = buildTree(o);
  const self = t.children!.find((c) => c.key === 'self')!;
  assert.equal(self.node.preview, '[Circular]');
  assert.equal(buildTree(42).preview, '42');
  assert.equal(buildTree('hi').t, 'string');
});

test('buildTree respects maxDepth', () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const t = buildTree(deep, { maxDepth: 2 });
  // at depth 2 the node has no children expanded
  const a = t.children!.find((c) => c.key === 'a')!.node;
  const b = a.children!.find((c) => c.key === 'b')!.node;
  assert.equal(b.children, undefined);
});

test('buildPreview joins, collapses newlines and truncates', () => {
  assert.equal(buildPreview(['a', 'b']), 'a b');
  assert.equal(buildPreview(['line1\nline2']), 'line1 ⏎ line2');
  const truncated = buildPreview(['y'.repeat(300)], 50);
  assert.equal(truncated.length, 50);
  assert.match(truncated, /…$/);
});
