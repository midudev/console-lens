// Pure-Node helpers for the system-wide shell integration.
//
// This module imports NOTHING from `vscode`, on purpose: it is shared between
// the extension host (`src/extension/index.ts`) and the `vscode:uninstall`
// lifecycle script (`src/uninstall.ts`), which runs as plain `node` with no
// access to the VS Code API. Keep it free of vscode/editor imports.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PORT_ENV, WS_PORT_ENV } from './protocol';

/** Stable, version-independent location for the agent so external terminals can
 * reference a path that survives extension updates. */
export const STABLE_DIR = path.join(os.homedir(), '.console-lens');
export const STABLE_PRELOAD = path.join(STABLE_DIR, 'out', 'agent', 'preload.js');
/** Single, global event log written by the broker and read by the MCP server. */
export const GLOBAL_EVENTS = path.join(STABLE_DIR, 'events.json');

export const SHELL_MARKER_START = '# >>> Console Lens >>>';
export const SHELL_MARKER_END = '# <<< Console Lens <<<';

const PORT_FILE = '$HOME/.console-lens/port';
const WSPORT_FILE = '$HOME/.console-lens/wsport';
/** Path the shell block requires; guarded so a stale block can never break node. */
const PRELOAD_PATH = '$HOME/.console-lens/out/agent/preload.js';

export type ShellKind = 'zsh' | 'bash' | 'fish';

export function detectShellRc(): { file: string; shell: ShellKind } {
  const home = os.homedir();
  const shell = process.env.SHELL ?? '';
  if (shell.includes('fish')) {
    return { file: path.join(home, '.config', 'fish', 'config.fish'), shell: 'fish' };
  }
  if (shell.includes('bash')) {
    const bashrc = path.join(home, '.bashrc');
    return { file: fs.existsSync(bashrc) ? bashrc : path.join(home, '.bash_profile'), shell: 'bash' };
  }
  return { file: path.join(home, '.zshrc'), shell: 'zsh' };
}

/**
 * Shell block that does NOT hard-code the port. It keeps a port already injected
 * by the extension (integrated terminals get their own window's port), and only
 * falls back to the active window's port file (written by the focused window) for
 * external terminals — so logs reach the window you're actually looking at.
 *
 * The `NODE_OPTIONS` export is GUARDED on the agent file still existing. If the
 * cache (`~/.console-lens`) is ever removed — e.g. on uninstall, or by hand —
 * the block becomes inert instead of leaving a dangling `--require` that makes
 * every `node` invocation crash with "Cannot find module …/preload.js".
 */
export function shellBlock(shell: ShellKind): string {
  if (shell === 'fish') {
    return [
      SHELL_MARKER_START,
      `test -f "${PRELOAD_PATH}"; and set -gx NODE_OPTIONS "$NODE_OPTIONS --require ${PRELOAD_PATH}"`,
      `if not set -q ${PORT_ENV}; set -gx ${PORT_ENV} (cat "${PORT_FILE}" 2>/dev/null; or echo 9111); end`,
      `if not set -q ${WS_PORT_ENV}; set -gx ${WS_PORT_ENV} (cat "${WSPORT_FILE}" 2>/dev/null; or echo 9112); end`,
      SHELL_MARKER_END,
    ].join('\n');
  }
  return [
    SHELL_MARKER_START,
    `[ -f "${PRELOAD_PATH}" ] && export NODE_OPTIONS="$NODE_OPTIONS --require ${PRELOAD_PATH}"`,
    `export ${PORT_ENV}="\${${PORT_ENV}:-$(cat "${PORT_FILE}" 2>/dev/null || echo 9111)}"`,
    `export ${WS_PORT_ENV}="\${${WS_PORT_ENV}:-$(cat "${WSPORT_FILE}" 2>/dev/null || echo 9112)}"`,
    SHELL_MARKER_END,
  ].join('\n');
}

/** Matches the whole `# >>> Console Lens >>> … # <<< Console Lens <<<` block,
 * including a leading/trailing newline so removal leaves no blank gaps. */
export function shellBlockRegex(global = false): RegExp {
  return new RegExp(`\\n?${SHELL_MARKER_START}[\\s\\S]*?${SHELL_MARKER_END}\\n?`, global ? 'g' : '');
}

/** Strip the Console Lens block from a shell rc file. Pure fs, never throws. */
export function removeShellBlock(file: string): 'removed' | 'absent' | 'error' {
  try {
    if (!fs.existsSync(file)) {
      return 'absent';
    }
    const existing = fs.readFileSync(file, 'utf8');
    if (!shellBlockRegex(true).test(existing)) {
      return 'absent';
    }
    fs.writeFileSync(file, existing.replace(shellBlockRegex(true), '\n'));
    return 'removed';
  } catch {
    return 'error';
  }
}
