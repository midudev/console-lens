import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventLog } from '../extension/events';
import type { LogMessage } from '../shared/protocol';

function log(i: number): LogMessage {
  return {
    v: 1,
    type: 'log',
    level: 'log',
    file: '/app.js',
    line: i,
    column: 1,
    args: [String(i)],
    preview: 'p' + i,
    timestamp: i,
    runtime: 'node',
    session: 's',
  };
}

test('keeps every event under the cap', () => {
  const lg = new EventLog(10);
  for (let i = 1; i <= 8; i++) lg.addLog(log(i));
  assert.equal(lg.getAll().length, 8);
});

test('rolls the oldest events off once the cap is exceeded', () => {
  const lg = new EventLog(5);
  for (let i = 1; i <= 12; i++) lg.addLog(log(i));
  const all = lg.getAll();
  assert.equal(all.length, 5);
  // The most recent 5 survive (previews p8..p12).
  assert.deepEqual(all.map((e) => e.preview), ['p8', 'p9', 'p10', 'p11', 'p12']);
});

test('falls back to the default cap for non-positive values', () => {
  const lg = new EventLog(0);
  for (let i = 1; i <= 6000; i++) lg.addLog(log(i));
  assert.equal(lg.getAll().length, 5000); // DEFAULT_MAX_EVENTS
});
