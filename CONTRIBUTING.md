# Contributing to Console Lens

Thanks for your interest in improving Console Lens! Bug reports, ideas and pull
requests are all welcome — it's still **beta**, so there's plenty to do.

## License of contributions

By submitting a contribution, you agree that your contribution will be licensed
under the same license as the project: **AGPLv3 with Commons Clause** (see
[`LICENSE`](./LICENSE)).

## Getting started

```bash
npm install
npm run compile     # type-check + emit to out/
npm test            # unit + TCP server + end-to-end agent/broker tests
```

To try your changes inside VS Code, press **F5** to launch an Extension
Development Host, or run `npm run reinstall` to package and (re)install the
extension, then reload the window.

For a quick, editor-free loop:

```bash
npm run viewer                                    # Terminal 1 — log sink
node --require ./out/agent/preload.js app.js      # Terminal 2 — your app
```

## Project layout

- `src/shared` — pure, dependency-free core (protocol, serialization, decoration
  store, broker envelope protocol). Fully unit-tested.
- `src/agent` — the `--require` runtime agent (console patching, error/`fetch`
  capture, browser injection). Zero dependencies.
- `src/broker` — the shared broker process and the client editors/viewer use.
- `src/extension` — the VS Code extension.
- `src/mcp` — the standalone MCP server.
- `src/cli` — the headless viewer.

## Pull requests

- Keep changes focused and match the surrounding code style.
- Add or update tests for behaviour changes (`npm test` must pass).
- Update `README.md` / `CHANGELOG.md` when you change user-facing behaviour.
