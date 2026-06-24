import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureCallSite, normalizeFileUrl, parseStackLine } from '../shared/stack';

test('captures the caller file, line and column', () => {
  const site = captureCallSite(); // <- this line is the call site
  assert.ok(site, 'expected a call site');
  assert.match(site!.file, /stack\.test\.(js|ts)$/, `unexpected file: ${site!.file}`);
  assert.equal(typeof site!.line, 'number');
  assert.ok(site!.line > 0);
  assert.ok(site!.column > 0);
});

test('reports a location through a wrapper, skipping its own frames', () => {
  function wrapper(): ReturnType<typeof captureCallSite> {
    return captureCallSite();
  }
  const site = wrapper();
  assert.ok(site);
  assert.match(site!.file, /stack\.test\.(js|ts)$/);
});

test('parseStackLine handles the common V8 formats', () => {
  assert.deepEqual(parseStackLine('    at fn (/a/b.js:12:34)'), {
    file: '/a/b.js',
    line: 12,
    column: 34,
  });
  assert.deepEqual(parseStackLine('    at /a/b.js:5:6'), { file: '/a/b.js', line: 5, column: 6 });
  assert.deepEqual(parseStackLine('    at eval (/src/index.astro:5:9)'), {
    file: '/src/index.astro',
    line: 5,
    column: 9,
  });
  assert.deepEqual(parseStackLine('    at async f (file:///x/y.ts:1:2)'), {
    file: '/x/y.ts',
    line: 1,
    column: 2,
  });
  assert.equal(parseStackLine('    at Object.<anonymous>'), null);
});

test('normalizeFileUrl strips file:// scheme', () => {
  assert.equal(normalizeFileUrl('file:///Users/x/app.js'), '/Users/x/app.js');
  assert.equal(normalizeFileUrl('/Users/x/app.js'), '/Users/x/app.js');
});
