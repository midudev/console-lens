<img width="4052" height="2372" alt="CleanShot 2026-06-24 at 18 05 34@2x" src="https://github.com/user-attachments/assets/b96dda6e-429d-4896-aaca-34ee0c3c8cb0" />

# 🔎 Console Lens

> ⚠️ **Beta.** Console Lens is under active development — expect rough edges and
> breaking changes between versions. Bug reports and feedback are very welcome.

**Free, source-available inline runtime insight for VS Code.**
See your `console.log` values, **errors**, and **network requests** right next to the
code that produced them, in real time — no breakpoints, no switching to a terminal.

```js
function add(a, b) {
  const result = a + b;
  console.log('add ->', result);   // › add -> 6  ×3   ← appears here, live
  return result;
}
```

## Features

- **Inline values** next to the exact source line, updated as your code runs, with
  an `×N` execution counter.
- **Execution history with timestamps** — hover a log to see every time it ran
  (`HH:MM:SS.mmm`) with the full value each time.
- **Errors & uncaught exceptions** shown inline in red, with a hover listing the full
  stack (`fn @ file:line` + source line). Crash behaviour is preserved.
- **Network requests** — `fetch` calls show `method · status · url` inline (Node and
  browser), with request/response payloads in the hover.
- **Logs & errors panel** — click the status bar to open a viewer of everything
  captured: collapsible **object inspector**, type filters, text filter, event
  counter, auto-scroll/pause, Clear, and "Go to source / Ask AI" actions.
- **Pause/resume & export** — pause capture at any time (status bar / command) so a
  noisy run can't bury what you care about, and **export the captured logs to a file**
  for sharing or attaching to a bug report.
- **More console methods** — `table`, `dir`, `assert`, `count`, `time`/`timeEnd`,
  `trace`, `group` are captured too. High-frequency logs are rate-limited per
  call site so a tight loop can't flood the editor.
- **Logpoints** — log any expression on a line **without editing your code**.
  `Cmd/Ctrl+Alt+L` (or right-click → "Add logpoint"), type an expression, and its
  value shows inline (green 👁) and in the panel. Manage them via CodeLens + gutter.
- **AI integration** — an `Ask AI` action in every hover sends the log/error to your
  editor's chat, plus an **MCP server** so Copilot/Cursor/Claude/Windsurf/Cline can
  read runtime logs & errors directly.
- **Works in any terminal** — zero-config in VS Code terminals, and an automatic
  shell integration for iTerm/Warp/Terminal.app and the rest.
- **Node + browser, zero-config** — start any **Vite / Astro / Next.js** dev server
  under the agent and the browser client is auto-injected into served HTML.
- **Source-map resolved** — server-side logs in compiled templates map back to your
  original `.astro` / `.tsx` / `.ts` source.
- **Safe & non-intrusive** — serialization built on `util.inspect` (circular refs,
  `BigInt`, `Map`/`Set`, errors…); the agent is fire-and-forget and never hangs or
  crashes your app. Zero runtime dependencies in the agent. Fully tested.

## Architecture

A single shared **broker** process owns the fixed ports and fans every event out
to all editor windows, so any number of windows (and editors) watch the same
runtime at once. The first window to start spawns the broker; the rest detect it
and subscribe instead of starting their own server.

```
 your app (node)            broker (shared, 1 process)            your editors
┌──────────────────┐  TCP   ┌────────────────────┐  fan-out  ┌─────────────────┐
│ agent (preload)  │ ─────► │ LensServer (agents) │ ────────► │ window A  ┐     │
│ • patches console│  JSON  │ + browser WS        │ ────────► │ window B  ┤ inline
│ • captures errors│        │ EventLog            │ ────────► │ Cursor …  ┘ + panel
│ • wraps fetch    │        │   └── events.json ──────► MCP server ──► AI       │
│ • injects browser│  WS    └────────────────────┘           └─────────────────┘
│   client (HTML)  │ ◄──── browser (Vite / Astro / Next.js page)
└──────────────────┘        subscribers connect on port + 2
```

- `src/shared` — pure, dependency-free core (protocol, serialization, stack capture,
  source-path resolution, decoration store, broker envelope protocol). Unit-tested.
- `src/agent` — the `--require` runtime agent: console patching, error capture,
  `fetch` wrapping, browser auto-injection. Zero dependencies.
- `src/broker` — the shared broker process (`LensServer` + subscriber fan-out,
  single writer of `events.json`) and the client editors/viewer use to attach.
- `src/extension` — the VS Code extension: broker client, decorations + hovers,
  panel, event log, MCP registration, terminal/shell integration.
- `src/mcp` — standalone stdio MCP server exposing captured runtime data to AI.
- `src/cli` — a headless viewer that subscribes to the broker and prints logs.
- `injector/` — the browser client injected into served HTML.

## Quick start (no VS Code needed)

```bash
npm install
npm run compile

npm run viewer                                   # Terminal 1 — log sink
node --require ./out/agent/preload.js app.js      # Terminal 2 — your app
```

Each log/error/request is echoed in Terminal 1 with its `file:line`.

## Use it inside VS Code

Install the packaged extension (`npm run reinstall`, see below) or press **F5** to
launch an Extension Development Host. Then just run your app **in the integrated
terminal** — the agent is injected automatically; nothing to configure. The
`👁 Console Lens` status-bar item opens the panel.

### Any terminal (iTerm, Warp, Terminal.app, …)

Shell integration is **on by default** (`consoleLens.shellIntegration`): the
extension copies the agent to a stable path (`~/.console-lens/`) and adds
`NODE_OPTIONS` exports to your shell profile inside `# >>> Console Lens >>>` fences,
so every Node process you start anywhere streams to the editor. Turn it off with the
setting (it self-removes) or via **Console Lens: Disable for all terminals**.

> Global `NODE_OPTIONS` means the agent loads into every Node process. It's
> fire-and-forget: when the editor isn't listening, logs are dropped and nothing
> hangs. For a one-off instead, use **Console Lens: Copy NODE_OPTIONS**.

## Errors

Uncaught exceptions (and unhandled rejections that crash) are captured via
`uncaughtExceptionMonitor` — **crash behaviour is unchanged**. The error shows inline
in red at every user frame, and the hover lists the full stack (`fn @ file:line`)
with the source line, plus an `Ask AI` action.

## Network requests

The agent wraps `fetch` in Node and the browser without consuming your response (it
reads a clone). Each request shows inline at its call site:

```
const res = await fetch('/api/echo', { method: 'POST', … });   ⇆ 200 POST /api/echo
```

Blue for `2xx/3xx`, red for `4xx/5xx`/failures. The hover shows method, URL, status,
duration, and the **request and response payloads**.

## Logpoints (log without editing code)

Put the cursor on a line and press **`Cmd+Alt+L`** (macOS) / **`Ctrl+Alt+L`** to
toggle a logpoint there, or right-click → **Console Lens: Add logpoint**. Type an
expression (defaults to the selected text / word under the cursor) and Console Lens
evaluates it at that line and shows the value inline — **your source file is never
modified**.

- A green 👁 gutter marker + CodeLens (edit / disable / remove) manage each logpoint.
- The agent instruments code safely (the expression is validated and only injected
  on statement boundaries; on any doubt it falls back, never breaking your app).
- Works for **Node-executed** code (scripts, servers; CJS + ESM) and **browser**
  code served by the dev server (the served module is instrumented on the fly).
- Apply: reload the page (browser) or re-run (Node) after adding a logpoint.

> Scope: framework **SSR templates** that the framework compiles itself (Astro
> frontmatter, Next.js server components) aren't instrumented by the agent — those
> would need a build plugin. Browser/client code and plain Node code are covered.

## Logs & errors panel

Click **👁 Console Lens** in the status bar (or run **Console Lens: Open panel**) to
open a viewer of everything captured: a chronological, color-coded, filterable list
on the left and a details pane on the right with **Go to** and **Ask AI** buttons.

## AI integration (MCP)

Console Lens ships an **MCP server** so your AI agent can read runtime data:

| Tool | Description |
| --- | --- |
| `runtime-logs` | Recent console logs |
| `runtime-errors` | Runtime errors with stack traces |
| `runtime-logs-and-errors` | Both, in order |
| `runtime-logs-by-location` | Logs/errors/network for a file (and optional line) |

- **VS Code (Copilot)**: registered automatically (VS Code 1.101+). It appears in the
  chat tools picker as *Console Lens*.
- **Cursor / Claude Code / Windsurf / Cline**: run **Console Lens: Copy MCP config**
  and paste it into the client's MCP settings.

The extension keeps `~/.console-lens/events.json` up to date; the stdio server
(`~/.console-lens/out/mcp/server.js`) reads it — zero extra dependencies.

## Framework examples

Ready-to-run examples for **Vite**, **Astro** and **Next.js** live in
[`examples/`](./examples) — each captures server (Node) and browser logs, errors and
network with zero config. See [`examples/README.md`](./examples/README.md).

```bash
npm run viewer
cd examples/vite && npm install && npm run dev:lens
# → ✅ console lens connected · http://localhost:5173 · browser logs on
```

## Commands

| Command | Description |
| --- | --- |
| `Console Lens: Open panel (logs & errors)` | Open the viewer (also the status-bar action) |
| `Console Lens: Toggle On/Off` | Show/hide inline output |
| `Console Lens: Pause/Resume capture` | Stop/start collecting events without losing what's captured |
| `Console Lens: Clear All Inline Logs` | Clear decorations, panel and event log |
| `Console Lens: Export logs to a file` | Save the captured logs/errors/network to a file |
| `Console Lens: Add/Toggle logpoint on this line` | Add, edit or toggle a logpoint (`Cmd/Ctrl+Alt+L`) |
| `Console Lens: Copy MCP config…` | Copy the MCP server config for other AI clients |
| `Console Lens: Enable / Disable for all terminals` | Add/remove the shell integration |
| `Console Lens: Inject into active terminal` | Wire up an already-open terminal |
| `Console Lens: Copy NODE_OPTIONS…` | Copy the agent flag for a one-off command |
| `Console Lens: Clean up` | Remove the shell integration & cache before uninstalling |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `consoleLens.port` | `9111` | Preferred TCP port (browser WS uses `port + 1`) |
| `consoleLens.enabled` | `true` | Show inline output |
| `consoleLens.maxInlineLength` | `200` | Max characters shown inline |
| `consoleLens.shellIntegration` | `true` | Make it work in every terminal (edits your shell profile) |
| `consoleLens.autoAttachTerminals` | `true` | Also export into VS Code integrated terminals directly |

> **Multiple windows / editors:** all windows share one **broker** on
> `consoleLens.port` (the first to start spawns it; the rest detect and reuse it),
> so logs reach every open window — even across editors (e.g. VS Code + Cursor) —
> and there's no `EADDRINUSE`. Keep `consoleLens.port` the same across windows so
> they meet on the same broker; if that port is occupied by an unrelated process,
> set it to a free one.

## Build & packaging

```bash
npm run compile     # type-check + emit to out/
npm run bundle      # bundle the extension (esbuild) into out/extension/index.js
npm run package     # produce console-lens-<version>.vsix
npm run reinstall   # package AND (re)install into VS Code — use this to test changes
npm test            # unit + TCP server + end-to-end agent integration tests
```

After `npm run reinstall`, reload VS Code (`Cmd+Shift+P → Developer: Reload Window`).
To uninstall cleanly, run **Console Lens: Clean up** first (removes the shell
integration and `~/.console-lens/` cache), then
`code --uninstall-extension console-lens.console-lens`.

## Source maps & limitations

Server-side logs are **source-map resolved**: the agent enables Node's source-map
support, so logs in compiled/transpiled code map to your original source (Astro
frontmatter → `index.astro`, Next.js server components → `page.tsx`, TS via
`tsx`/`ts-node` → `.ts`). Virtual bundler paths (e.g. `webpack://app/page.tsx`) are
resolved to the real file on disk.

- Resolution relies on the runtime emitting source maps (Vite/Astro/Next dev do);
  code without source maps falls back to the executed location.
- Browser line mapping matches by file basename when the served URL isn't a real
  workspace path.
- Network capture covers `fetch`, `XMLHttpRequest` and `WebSocket` (lifecycle) in
  the browser, and `fetch` in Node. Node `http.request` isn't wrapped yet.

## License

This project is licensed under the GNU Affero General Public License v3.0
with the Commons Clause restriction.

You may view, use, modify and contribute to this project, but you may not
sell, offer as a paid SaaS, or commercially exploit a fork or derivative
whose value derives substantially from this software.

Any contribution submitted to this repository is licensed under the same
license terms. See [`LICENSE`](./LICENSE) for the full text and
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to contribute.
