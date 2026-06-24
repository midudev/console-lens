import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSourcePath } from '../agent/resolve-path';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-resolve-'));
fs.mkdirSync(path.join(base, 'app'), { recursive: true });
fs.writeFileSync(path.join(base, 'app', 'page.tsx'), 'x');
fs.mkdirSync(path.join(base, 'src'), { recursive: true });
fs.writeFileSync(path.join(base, 'src', 'main.ts'), 'x');

test('resolves a webpack:// url to a real file under baseDir', () => {
  const out = resolveSourcePath('webpack://my-app/app/page.tsx', base);
  assert.equal(out, path.join(base, 'app', 'page.tsx'));
});

test('resolves webpack-internal with namespace groups and dot segments', () => {
  const out = resolveSourcePath('webpack-internal:///(rsc)/./app/page.tsx', base);
  assert.equal(out, path.join(base, 'app', 'page.tsx'));
});

test('resolves a plain relative path', () => {
  const out = resolveSourcePath('./src/main.ts', base);
  assert.equal(out, path.join(base, 'src', 'main.ts'));
});

test('returns absolute paths unchanged', () => {
  const abs = path.join(base, 'app', 'page.tsx');
  assert.equal(resolveSourcePath(abs, base), abs);
});

test('returns the original string when nothing matches on disk', () => {
  const input = 'webpack://x/does/not/exist.tsx';
  assert.equal(resolveSourcePath(input, base), input);
});
