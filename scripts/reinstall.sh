#!/usr/bin/env bash
#
# Re-package and reinstall the Console Lens VS Code extension.
# Run it whenever you want to test the latest local changes:
#
#   ./scripts/reinstall.sh        (or: npm run reinstall)
#
# Steps: compile -> bundle (esbuild) -> package (.vsix) -> install into VS Code.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "▶ Compiling (tsc)…"
npx tsc -p ./

echo "▶ Bundling extension (esbuild)…"
npx -y esbuild@0.21.5 src/extension/index.ts \
  --bundle --platform=node --target=node18 \
  --external:vscode --format=cjs \
  --outfile=out/extension/index.js

echo "▶ Bundling broker (esbuild)…"
npx -y esbuild@0.21.5 src/broker/broker.ts \
  --bundle --platform=node --target=node18 \
  --format=cjs \
  --outfile=out/broker/broker.js

echo "▶ Packaging (.vsix)…"
npx -y @vscode/vsce@^3 package --no-dependencies

VSIX="$(ls -t console-lens-*.vsix | head -1)"
if [ -z "$VSIX" ]; then
  echo "✗ No .vsix produced" >&2
  exit 1
fi

if command -v code >/dev/null 2>&1; then
  echo "▶ Installing $VSIX into VS Code…"
  code --install-extension "$VSIX" --force
  echo "✅ Installed $VSIX"
  echo "   Reload VS Code:  Cmd+Shift+P → 'Developer: Reload Window'"
else
  echo "✅ Built $VSIX"
  echo "   'code' CLI not found. Install via VS Code: Cmd+Shift+P → 'Shell Command: Install code command in PATH'"
  echo "   Then run:  code --install-extension $VSIX --force"
fi
