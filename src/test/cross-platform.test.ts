import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProjectPath, isInProjectRoots } from '../shared/project';
import { parseStackLine, normalizeFileUrl } from '../shared/stack';
import { normalizeKey, keysForEditorPath } from '../shared/decorations';

// These tests feed platform-specific *inputs* (Windows-style `C:\…` paths, POSIX
// `/home/…` paths, browser URLs) to the pure path helpers so the macOS/Linux CI
// machine still verifies the Windows behaviour the author can't test locally.

test('project filter: matches an exact workspace root (Windows & POSIX)', () => {
  assert.equal(isInProjectRoots('C:\\Users\\me\\velada', ['C:\\Users\\me\\velada']), true);
  assert.equal(isInProjectRoots('/home/me/velada', ['/home/me/velada']), true);
});

test('project filter: rejects a different project', () => {
  assert.equal(isInProjectRoots('C:\\Users\\me\\console-lens', ['C:\\Users\\me\\velada']), false);
  assert.equal(isInProjectRoots('/home/me/console-lens', ['/home/me/velada']), false);
});

test('project filter: is case-insensitive (Windows/macOS) and slash-insensitive', () => {
  // Windows fsPath casing/slashes vs the dev server's cwd can differ.
  assert.equal(isInProjectRoots('c:/users/me/VELADA', ['C:\\Users\\me\\velada']), true);
  assert.equal(isInProjectRoots('C:\\Users\\me\\velada\\', ['C:/Users/me/velada']), true);
});

test('project filter: matches a monorepo sub-package (cwd inside root)', () => {
  assert.equal(isInProjectRoots('C:\\dev\\mono\\packages\\web', ['C:\\dev\\mono']), true);
  assert.equal(isInProjectRoots('/dev/mono/packages/web', ['/dev/mono']), true);
});

test('project filter: matches when a root is inside the cwd', () => {
  assert.equal(isInProjectRoots('/dev/mono', ['/dev/mono/packages/web']), true);
});

test('project filter: does not partially match a sibling with a shared prefix', () => {
  // "/home/me/velada-2" must NOT match root "/home/me/velada".
  assert.equal(isInProjectRoots('/home/me/velada-2', ['/home/me/velada']), false);
  assert.equal(isInProjectRoots('C:\\Users\\me\\velada-2', ['C:\\Users\\me\\velada']), false);
});

test('project filter: undefined cwd and empty roots never match', () => {
  assert.equal(isInProjectRoots(undefined, ['/home/me/velada']), false);
  assert.equal(isInProjectRoots('/home/me/velada', []), false);
  assert.equal(isInProjectRoots('/home/me/velada', ['']), false);
});

test('normalizeProjectPath: folds slashes, trailing slash and case', () => {
  assert.equal(normalizeProjectPath('C:\\Users\\Me\\App\\'), 'c:/users/me/app');
  assert.equal(normalizeProjectPath('/home/Me/App/'), '/home/me/app');
  assert.equal(normalizeProjectPath(''), '');
});

test('normalizeFileUrl: strips the leading slash before a Windows drive letter', () => {
  // Node ESM frames on Windows look like file:///C:/x/app.mjs (pathname /C:/x/app.mjs).
  assert.equal(normalizeFileUrl('file:///C:/Users/me/app.mjs'), 'C:/Users/me/app.mjs');
  assert.equal(normalizeFileUrl('file:///D:/proj/src/index.ts'), 'D:/proj/src/index.ts');
  // POSIX file URLs keep their leading slash.
  assert.equal(normalizeFileUrl('file:///home/me/app.js'), '/home/me/app.js');
  // Query/hash suffixes (Vite/webpack) are dropped, drive handling intact.
  assert.equal(normalizeFileUrl('file:///C:/x/app.mjs?v=123'), 'C:/x/app.mjs');
});

test('parseStackLine: parses Windows backslash paths', () => {
  assert.deepEqual(parseStackLine('    at applyTax (C:\\Users\\me\\app\\tax.js:12:34)'), {
    file: 'C:\\Users\\me\\app\\tax.js',
    line: 12,
    column: 34,
  });
});

test('parseStackLine: parses a Windows ESM file:// frame (drive slash stripped)', () => {
  assert.deepEqual(parseStackLine('    at file:///C:/Users/me/app/index.mjs:5:9'), {
    file: 'C:/Users/me/app/index.mjs',
    line: 5,
    column: 9,
  });
});

test('normalizeKey: folds Windows separators and strips URL host', () => {
  assert.equal(normalizeKey('C:\\Users\\me\\app\\index.astro'), 'C:/Users/me/app/index.astro');
  assert.equal(normalizeKey('http://localhost:4321/src/pages/index.astro'), '/src/pages/index.astro');
});

test('keysForEditorPath: yields full path and basename for a Windows path', () => {
  assert.deepEqual(keysForEditorPath('C:\\Users\\me\\app\\index.astro'), [
    'C:/Users/me/app/index.astro',
    'index.astro',
  ]);
});
