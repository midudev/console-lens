import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectIntoHtml } from '../agent/http-inject';

const SNIPPET = '<script src="/__console-lens__/client.js"></script>';

test('injects before </head> when present', () => {
  const html = '<html><head><title>x</title></head><body>hi</body></html>';
  const out = injectIntoHtml(html, SNIPPET);
  assert.ok(out.includes(SNIPPET + '</head>'));
  assert.ok(out.indexOf(SNIPPET) < out.indexOf('<body>'));
});

test('falls back to </body> when no </head>', () => {
  const html = '<body>hi</body>';
  const out = injectIntoHtml(html, SNIPPET);
  assert.ok(out.includes(SNIPPET + '</body>'));
});

test('appends when neither head nor body present', () => {
  const html = '<div>fragment</div>';
  const out = injectIntoHtml(html, SNIPPET);
  assert.ok(out.endsWith(SNIPPET));
});

test('injects exactly once', () => {
  const html = '<head></head><head></head>';
  const out = injectIntoHtml(html, SNIPPET);
  assert.equal(out.split(SNIPPET).length - 1, 1);
});
