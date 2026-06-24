import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  shellBlock,
  shellBlockRegex,
  removeShellBlock,
  SHELL_MARKER_START,
  SHELL_MARKER_END,
} from '../shared/shell-integration';

// The shell block must GUARD the NODE_OPTIONS export on the agent file existing,
// so a stale block (e.g. after the cache is deleted on uninstall) can never make
// `node` crash with "Cannot find module …/preload.js".
test('shellBlock (posix) guards NODE_OPTIONS on the preload existing', () => {
  const block = shellBlock('zsh');
  assert.match(block, /\[ -f "\$HOME\/\.console-lens\/out\/agent\/preload\.js" \] && export NODE_OPTIONS=/);
  assert.ok(block.startsWith(SHELL_MARKER_START));
  assert.ok(block.trimEnd().endsWith(SHELL_MARKER_END));
});

test('shellBlock (fish) guards NODE_OPTIONS with `test -f … ; and`', () => {
  const block = shellBlock('fish');
  assert.match(block, /test -f "\$HOME\/\.console-lens\/out\/agent\/preload\.js"; and set -gx NODE_OPTIONS/);
});

test('shellBlockRegex matches the whole fenced block including surrounding newlines', () => {
  const file = `before\n\n${shellBlock('zsh')}\n\nafter\n`;
  const match = file.match(shellBlockRegex());
  assert.ok(match);
  assert.ok(match![0].includes(SHELL_MARKER_START));
  assert.ok(match![0].includes(SHELL_MARKER_END));
});

test('removeShellBlock strips the block, preserves user content, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-shell-'));
  const rc = path.join(dir, '.zshrc');
  try {
    fs.writeFileSync(rc, `# user prompt\nexport FOO=1\n\n${shellBlock('zsh')}\n\n# trailing line\n`);

    assert.equal(removeShellBlock(rc), 'removed');
    const after = fs.readFileSync(rc, 'utf8');
    assert.doesNotMatch(after, /Console Lens/);
    assert.match(after, /export FOO=1/);
    assert.match(after, /# trailing line/);

    // Running again is a no-op once the block is gone.
    assert.equal(removeShellBlock(rc), 'absent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeShellBlock returns "absent" for a missing file', () => {
  assert.equal(removeShellBlock(path.join(os.tmpdir(), 'cl-does-not-exist-xyz', '.zshrc')), 'absent');
});
