import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInternalRequest } from '../shared/dev-requests';

test('flags Astro/Vite framework-internal requests', () => {
  const internal = [
    'http://localhost:4321/src/sections/Hero.astro?astro&type=script&index=0&lang.ts',
    'http://localhost:4321/src/sections/Hero.astro?astro&type=style&index=0&lang.css',
    'http://localhost:4321/@vite/client',
    'http://localhost:4321/@id/astro:scripts/page.js',
    'http://localhost:4321/@fs/Users/x/proj/node_modules/foo.js',
    'http://localhost:5173/node_modules/.vite/deps/react.js',
    'http://localhost:5173/src/main.ts?t=1700000000000',
    'http://localhost:3000/_next/static/webpack/123.hot-update.json',
  ];
  for (const u of internal) {
    assert.equal(isInternalRequest(u), true, u);
  }
});

test('keeps real app requests', () => {
  const app = [
    'https://midu.dev',
    'http://localhost:4321/api/users',
    'https://api.github.com/repos?url=https://example.com', // legit ?url param
    '/api/echo?id=42',
    'https://cdn.infolavelada.com/hero-bg/background-2048.avif',
  ];
  for (const u of app) {
    assert.equal(isInternalRequest(u), false, u);
  }
});

test('never throws on odd input', () => {
  assert.equal(isInternalRequest(undefined as unknown as string), false);
  assert.equal(isInternalRequest('' as string), false);
});
