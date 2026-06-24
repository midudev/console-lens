# Changelog

All notable changes to Console Lens are documented here.

## 0.1.21

- **Richer browser value formatting.** The browser client now renders complex
  values the way DevTools does instead of collapsing them to `{}`: DOM nodes show
  as `<tag#id.class…>`, and `Map`, `Set`, `Error`, `RegExp`, `Date`, typed
  arrays, `NodeList`/`HTMLCollection`, `Blob`/`File`, `URL`, class instances and
  more all get a readable representation (and stay expandable in the panel).
- **Less network noise.** Dev-server/framework-internal requests (Vite + Astro
  module/asset loading like `?astro&type=script`, `/@vite/…`, `/@id/…`,
  `node_modules/.vite/…`, HMR pings) are no longer captured as network logs —
  they aren't app requests. Applies to both the Node agent and browser client.
- **Responsive panel.** Reduced side padding, and on a narrow (side-bar) panel
  each row stacks vertically — a compact meta line with the message at full
  width — so content is never squeezed into a one-character column.
- **Configurable history limit.** New `consoleLens.maxEvents` setting (default
  5000) caps how many events are kept in the panel and events file; lower it if a
  high-frequency log loop makes the panel sluggish. (The log was already capped,
  not unbounded — now you control the cap.)

## 0.1.20

- **Inline values clear when you edit the line.** Editing or deleting a line now
  drops its (now stale) inline value instead of leaving it stuck to the wrong
  code, and inserting/removing lines shifts the remaining values to follow. The
  fresh values come back on the next run.

## 0.1.19

- **Shared broker (multi-window, multi-editor)**: the capture backend is now a
  single shared process instead of a per-window server. The first editor to
  start spawns the broker (which owns the fixed ports); every other window —
  even a different editor like Cursor — **detects and reuses it**, then receives
  a fanned-out copy of every event. Open as many windows as you like and logs
  show in all of them. This removes the old "focused window owns the port"
  rotation that left agents talking to a window you weren't looking at.
  - A window opening mid-session gets the backlog replayed (snapshot).
  - "Clear All" from one window clears every window.
  - The broker is the single writer of `events.json` (no concurrent-write
    races), and exits shortly after the last window closes.
  - The CLI viewer subscribes to the same broker, so it now coexists with open
    editors instead of fighting for the port.
- **Fix: client-side `<script>` logs now show inline.** Inline decorations for a
  file merge every source of events for it instead of showing only the first —
  so a browser `console.log` (which arrives as a bare basename) no longer gets
  hidden behind that same file's network or server-side entries. Common in Astro
  components, where one `.astro` file mixes frontmatter, a client `<script>` and
  fetches.

## 0.1.x

- **Inline logs** with execution history and timestamps in the hover.
- **Errors**: uncaught exceptions captured (Node + browser) and shown inline in
  red with a full, source-mapped stack in the hover.
- **Network**: `fetch` requests (Node + browser) shown inline with method, status,
  duration and request/response payloads; binary bodies are summarized, not dumped.
- **Panel**: status-bar viewer of all captured logs/errors/network, with live
  updates, type filters, a text filter, an event counter, an auto-scroll/pause
  toggle, a Clear button, and "Go to source" / "Ask AI" actions.
- **AI**: `Ask AI` action in hovers and panel, plus an **MCP server**
  (`runtime-logs`, `runtime-errors`, `runtime-logs-and-errors`,
  `runtime-logs-by-location`) auto-registered for VS Code Copilot and copyable for
  Cursor / Claude Code / Windsurf / Cline.
- **Zero-config**: auto-injects the browser client into Vite / Astro / Next.js dev
  servers; works in VS Code terminals and, via shell integration, in any terminal.
- **Source maps** resolved server-side (Astro frontmatter, Next.js server
  components, TS via tsx/ts-node).
- **Robustness**: shared session across a dev server's processes; clearing driven
  by new-run detection (not per-message), so sibling processes don't wipe each
  other's logs; preferred-port retry for reliable reconnects across reloads.
- **Cleanup**: `Console Lens: Clean up` removes the shell integration and cache.
