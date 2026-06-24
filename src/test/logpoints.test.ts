import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeInjectionLine, isValidExpression, transformSource } from '../shared/logpoints';

test('isValidExpression accepts valid, rejects invalid', () => {
  assert.equal(isValidExpression('user.id'), true);
  assert.equal(isValidExpression('a + b'), true);
  assert.equal(isValidExpression('1 +'), false);
  assert.equal(isValidExpression('const x = 1'), false);
});

test('transformSource injects an instrumentation call on the target line', () => {
  const src = ['function f() {', '  const x = 1;', '  return x;', '}'].join('\n');
  const out = transformSource(src, [{ file: '/a.js', line: 3, expression: 'x' }]);
  const lines = out.split('\n');
  assert.equal(lines.length, 4, 'line count preserved');
  assert.match(lines[2], /__cl_lp__/);
  assert.match(lines[2], /return \(x\)/);
  assert.ok(lines[2].endsWith('  return x;'), 'original code kept after injection');
});

test('transformSource skips invalid expressions (never breaks the file)', () => {
  const src = 'const a = 1;\nconst b = 2;';
  const out = transformSource(src, [{ file: '/a.js', line: 2, expression: 'b +' }]);
  assert.equal(out, src);
});

test('isSafeInjectionLine rejects continuation lines', () => {
  const lines = ['foo(', '  bar', ')'];
  assert.equal(isSafeInjectionLine(lines, 1), false); // prev line ends with "("
  assert.equal(isSafeInjectionLine(['const x = 1;', 'doThing();'], 1), true);
  assert.equal(isSafeInjectionLine(['a', '  .b()'], 1), false); // leading "."
});

test('transformSource does not inject on unsafe lines', () => {
  const src = ['fetch(', '  url', ')'].join('\n');
  const out = transformSource(src, [{ file: '/a.js', line: 2, expression: 'url' }]);
  assert.equal(out, src);
});
