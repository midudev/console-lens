// `vscode:uninstall` lifecycle hook.
//
// VS Code runs this as plain `node ./out/uninstall.js` (NO vscode API) on the
// first restart after the extension is uninstalled — see
// https://code.visualstudio.com/api/references/extension-manifest. It undoes the
// system-wide footprint the extension writes on activation, so a plain
// Marketplace "Uninstall" is as clean as the install was automatic:
//   • removes the `# >>> Console Lens >>>` block from the user's shell profile
//   • deletes the stable agent cache (~/.console-lens)
//
// Caveat (microsoft/vscode#72375): historically this hook also fired after an
// *update*, not just a real uninstall. At that point the freshly-installed
// version's directory is already on disk next to this (old) one, so we detect a
// sibling install and skip teardown. Belt-and-suspenders: even if the guard is
// wrong, the next activation re-creates both, and the guarded shell block
// (see shellBlock()) can never break `node` on its own.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { STABLE_DIR, detectShellRc, removeShellBlock } from './shared/shell-integration';

const EXTENSION_ID = 'midudev.console-lens';

/** The extension folder this script ships in (…/midudev.console-lens-X.Y.Z).
 * `__dirname` is …/<that folder>/out. */
const OWN_EXTENSION_DIR = path.resolve(__dirname, '..');

/** True if a *different* copy of the extension is still installed — which means
 * this hook fired for an update, not a real uninstall, so we must leave the
 * shared footprint in place for the surviving version. */
function anotherVersionInstalled(): boolean {
  const home = os.homedir();
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.vscode-server', 'extensions'),
    path.join(home, '.vscode-oss', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.cursor-server', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ];
  if (process.env.VSCODE_EXTENSIONS) {
    roots.push(process.env.VSCODE_EXTENSIONS);
  }
  const prefix = `${EXTENSION_ID}-`;
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue; // dir doesn't exist on this machine
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().startsWith(prefix)) {
        continue;
      }
      // Ignore our own folder — it may still be on disk while this runs.
      if (path.resolve(root, entry) !== OWN_EXTENSION_DIR) {
        return true;
      }
    }
  }
  return false;
}

function main(): void {
  try {
    if (anotherVersionInstalled()) {
      return; // update, not uninstall — keep the shared footprint
    }
    removeShellBlock(detectShellRc().file);
    fs.rmSync(STABLE_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort: an uninstall hook must never throw or hang.
  }
}

main();
