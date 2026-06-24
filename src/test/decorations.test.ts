import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecorationStore,
  keyForMessage,
  keysForEditorPath,
  normalizeKey,
} from '../shared/decorations';
import type { LogMessage } from '../shared/protocol';

function msg(overrides: Partial<LogMessage> = {}): LogMessage {
  return {
    v: 1,
    type: 'log',
    level: 'log',
    file: '/Users/x/app.js',
    line: 10,
    column: 3,
    args: ['1'],
    preview: 'value 1',
    timestamp: Date.now(),
    runtime: 'node',
    session: 's1',
    ...overrides,
  };
}

test('normalizeKey strips url schemes and normalizes', () => {
  assert.equal(normalizeKey('http://localhost:3000/src/app.js'), '/src/app.js');
  assert.equal(normalizeKey('/a/b/../c.js'), '/a/c.js');
});

test('keysForEditorPath returns full path and basename', () => {
  assert.deepEqual(keysForEditorPath('/Users/x/app.js'), ['/Users/x/app.js', 'app.js']);
});

test('stores entries keyed by file and line', () => {
  const store = new DecorationStore();
  store.add(msg());
  const entries = store.getByKey(keyForMessage(msg()));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].line, 10);
  assert.equal(entries[0].count, 1);
});

test('increments count and keeps latest preview on repeated line', () => {
  const store = new DecorationStore();
  store.add(msg({ preview: 'a' }));
  store.add(msg({ preview: 'b' }));
  const [entry] = store.getByKey('/Users/x/app.js');
  assert.equal(entry.count, 2);
  assert.equal(entry.preview, 'b');
});

test('different lines are tracked separately and sorted', () => {
  const store = new DecorationStore();
  store.add(msg({ line: 20 }));
  store.add(msg({ line: 5 }));
  const entries = store.getByKey('/Users/x/app.js');
  assert.deepEqual(entries.map((e) => e.line), [5, 20]);
});

test('events from different processes/sessions of one run coexist (no auto-clear)', () => {
  // A dev server spawns several processes; their events must NOT clear each other.
  // Clearing is driven by the server detecting a new run, not by session ids.
  const store = new DecorationStore();
  store.add(msg({ session: 's1', line: 10 }));
  store.add(msg({ session: 's2', line: 99 }));
  const entries = store.getByKey('/Users/x/app.js');
  assert.deepEqual(entries.map((e) => e.line), [10, 99]);
});

test('getForEditorPath resolves by full path then basename', () => {
  const store = new DecorationStore();
  // browser-style url message -> stored under /src/app.js
  store.add(msg({ file: 'http://localhost/app.js' }));
  const byBasename = store.getForEditorPath('/some/other/dir/app.js');
  assert.equal(byBasename.logs.length, 1);
});

test('merges browser (basename), network (url) and server (abs) buckets for one file', () => {
  // Reproduces an Astro component: a client <script> console.log arrives as a
  // bare basename, its fetch as a served URL, and frontmatter logs as the
  // absolute path. All three must show in the editor for that file.
  const store = new DecorationStore();
  const abs = '/Users/x/src/sections/Hero.astro';
  store.add(msg({ file: 'Hero.astro', line: 220, preview: 'hola' })); // browser <script>
  store.add(msg({ file: abs, line: 3, preview: 'frontmatter' })); // server-side
  store.addNetwork({
    v: 1,
    type: 'network',
    method: 'GET',
    url: 'http://localhost:4321/src/sections/Hero.astro',
    status: 200,
    ok: true,
    durationMs: 5,
    file: 'http://localhost:4321/src/sections/Hero.astro',
    line: 53,
    column: 1,
    timestamp: 1,
    runtime: 'browser',
    session: 's1',
  });
  const entries = store.getForEditorPath(abs);
  assert.deepEqual(entries.logs.map((l) => l.line), [3, 220]);
  assert.equal(entries.logs.find((l) => l.line === 220)?.preview, 'hola');
  assert.equal(entries.network.length, 1);
});

test('does not cross-match a different file sharing a basename', () => {
  // A Node log keyed to one absolute path must not leak into another file that
  // merely shares the basename.
  const store = new DecorationStore();
  store.add(msg({ file: '/Users/x/a/index.astro', line: 5, preview: 'A' }));
  const other = store.getForEditorPath('/Users/x/b/index.astro');
  assert.equal(other.logs.length, 0);
});

test('keeps an execution history with timestamps', () => {
  const store = new DecorationStore();
  store.add(msg({ preview: 'a', timestamp: 1 }));
  store.add(msg({ preview: 'b', timestamp: 2 }));
  const [entry] = store.getByKey('/Users/x/app.js');
  assert.equal(entry.history.length, 2);
  assert.deepEqual(
    entry.history.map((r) => r.preview),
    ['a', 'b'],
  );
  assert.equal(entry.history[1].timestamp, 2);
});

test('stores errors at every frame location', () => {
  const store = new DecorationStore();
  const keys = store.addError({
    v: 1,
    type: 'error',
    name: 'TypeError',
    message: 'boom',
    frames: [
      { function: 'applyTax', file: '/Users/x/utils.ts', line: 4, column: 11 },
      { function: undefined, file: '/Users/x/main.ts', line: 10, column: 23 },
    ],
    origin: 'uncaughtException',
    timestamp: 1,
    runtime: 'node',
    session: 's1',
  });
  assert.deepEqual(keys.sort(), ['/Users/x/main.ts', '/Users/x/utils.ts']);
  const utils = store.getForEditorPath('/Users/x/utils.ts');
  assert.equal(utils.errors.length, 1);
  assert.equal(utils.errors[0].message, 'boom');
  assert.equal(utils.errors[0].frames.length, 2);
});

test('stores network requests at the call site', () => {
  const store = new DecorationStore();
  store.addNetwork({
    v: 1,
    type: 'network',
    method: 'POST',
    url: 'http://localhost/api/echo',
    status: 200,
    ok: true,
    requestBody: '{"a":1}',
    responseBody: '{"ok":true}',
    durationMs: 12,
    file: '/Users/x/main.ts',
    line: 7,
    column: 20,
    timestamp: 1,
    runtime: 'node',
    session: 's1',
  });
  const { network } = store.getForEditorPath('/Users/x/main.ts');
  assert.equal(network.length, 1);
  assert.equal(network[0].method, 'POST');
  assert.equal(network[0].status, 200);
  assert.equal(network[0].responseBody, '{"ok":true}');
});

test('editing a line drops its stale inline value', () => {
  const store = new DecorationStore();
  store.add(msg({ line: 5 }));
  // In-place edit on line 5 (0-based 4), no line-count change.
  const changed = store.applyEdit('/Users/x/app.js', [
    { startLine: 4, endLine: 4, endAtLineStart: false, delta: 0 },
  ]);
  assert.equal(changed, true);
  assert.equal(store.getByKey('/Users/x/app.js').length, 0);
});

test('inserting lines above shifts decorations down', () => {
  const store = new DecorationStore();
  store.add(msg({ line: 5, preview: 'v' }));
  // Press Enter on line 2 (0-based 1): +1 line.
  store.applyEdit('/Users/x/app.js', [
    { startLine: 1, endLine: 1, endAtLineStart: false, delta: 1 },
  ]);
  const [entry] = store.getByKey('/Users/x/app.js');
  assert.equal(entry.line, 6);
});

test('deleting a line removes it and pulls the rest up', () => {
  const store = new DecorationStore();
  store.add(msg({ line: 3, preview: 'gone' }));
  store.add(msg({ line: 5, preview: 'keep' }));
  // Delete line 3 (range [2,0]-[3,0], removes one line).
  store.applyEdit('/Users/x/app.js', [
    { startLine: 2, endLine: 3, endAtLineStart: true, delta: -1 },
  ]);
  const entries = store.getByKey('/Users/x/app.js');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].preview, 'keep');
  assert.equal(entries[0].line, 4); // 5 shifted up by 1
});

test('applyEdit affects browser (basename) buckets of the edited file', () => {
  const store = new DecorationStore();
  // Browser <script> log stored under a bare basename.
  store.add(msg({ file: 'app.js', line: 10, preview: 'browser' }));
  const changed = store.applyEdit('/Users/x/app.js', [
    { startLine: 9, endLine: 9, endAtLineStart: false, delta: 0 },
  ]);
  assert.equal(changed, true);
  assert.equal(store.getForEditorPath('/Users/x/app.js').logs.length, 0);
});

test('clear empties the store', () => {
  const store = new DecorationStore();
  store.add(msg());
  store.clear();
  assert.equal(store.getByKey('/Users/x/app.js').length, 0);
});
