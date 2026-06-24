import type { LogLevel } from './protocol';

export const LEVEL_ICONS: Record<LogLevel, string> = {
  log: '›',
  info: 'ℹ',
  warn: '⚠',
  error: '✖',
  debug: '◆',
};

/** Editor decoration colors per level (theme-friendly grays/accents). */
export const LEVEL_COLORS: Record<LogLevel, string> = {
  log: '#7a8290',
  info: '#4a9eff',
  warn: '#d7a847',
  error: '#e05561',
  debug: '#9a7fd1',
};

/**
 * Build the inline text shown after a line of code.
 * Adds a repetition counter (`×N`) when the same line logged multiple times.
 */
export function inlineText(level: LogLevel, preview: string, count: number): string {
  const icon = LEVEL_ICONS[level] ?? '›';
  const counter = count > 1 ? ` ×${count}` : '';
  return `${icon} ${preview}${counter}`;
}
