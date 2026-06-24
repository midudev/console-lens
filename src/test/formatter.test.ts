import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVEL_COLORS, LEVEL_ICONS, inlineText } from '../shared/formatter';
import { LOG_LEVELS } from '../shared/protocol';

test('inlineText prefixes the level icon', () => {
  assert.equal(inlineText('log', 'hello', 1), '› hello');
  assert.equal(inlineText('error', 'boom', 1), '✖ boom');
});

test('inlineText shows a counter only when count > 1', () => {
  assert.equal(inlineText('log', 'x', 1), '› x');
  assert.equal(inlineText('log', 'x', 5), '› x ×5');
});

test('every log level has an icon and a color', () => {
  for (const level of LOG_LEVELS) {
    assert.ok(LEVEL_ICONS[level], `missing icon for ${level}`);
    assert.match(LEVEL_COLORS[level], /^#[0-9a-f]{6}$/i, `bad color for ${level}`);
  }
});
