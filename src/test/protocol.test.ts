import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TCP_PORT, isLogMessage, wsPortFor } from '../shared/protocol';

test('wsPortFor is tcp port + 1', () => {
  assert.equal(wsPortFor(DEFAULT_TCP_PORT), DEFAULT_TCP_PORT + 1);
});

test('isLogMessage accepts a valid message', () => {
  assert.equal(
    isLogMessage({
      type: 'log',
      level: 'log',
      file: '/a.js',
      line: 1,
      preview: 'x',
    }),
    true,
  );
});

test('isLogMessage rejects invalid payloads', () => {
  assert.equal(isLogMessage(null), false);
  assert.equal(isLogMessage({}), false);
  assert.equal(isLogMessage({ type: 'log', level: 'nope', file: '/a', line: 1, preview: 'x' }), false);
  assert.equal(isLogMessage({ type: 'other', level: 'log', file: '/a', line: 1, preview: 'x' }), false);
  assert.equal(isLogMessage('string'), false);
});
