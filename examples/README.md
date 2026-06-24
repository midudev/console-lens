# Console Lens — framework examples

Working examples proving Console Lens captures `console.*` from **Vite**, **Astro**
and **Next.js**, on both the **server** (Node) and in the **browser** — with
**zero configuration**: no imports, no `<script>` tags, no copied files.

| Example | Server logs (Node agent) | Browser logs (auto-injected) |
| --- | --- | --- |
| [`vite/`](./vite) | ✅ captured | ✅ mapped to `src/main.js` |
| [`astro/`](./astro) | ✅ captured (frontmatter) | ✅ mapped to `index.astro` |
| [`nextjs/`](./nextjs) | ✅ captured (server component) | ✅ mapped to `Counter.tsx` |

Notice that **none** of the example source files import Console Lens. Everything is
wired up automatically by the agent when you run with `npm run dev:lens`.

## How it works

Each `dev:lens` script just runs the framework's normal dev command with the agent
preloaded:

```
NODE_OPTIONS="--require ../../out/agent/preload.js" CONSOLE_LENS_PORT=9111 <framework> dev
```

The agent then, **automatically**:

1. **Server logs** — patches `console.*` in Node, so any log from Vite config/SSR,
   Astro frontmatter, or Next.js server components & route handlers is captured.
2. **Browser logs** — wraps the dev server's HTTP layer to:
   - serve the browser client at a virtual route, and
   - inject a `<script>` for it into every HTML response.

   So browser `console.*` streams to the editor with **no manual import**.
3. Prints a single **` console lens ` connected · http://localhost:PORT** line once
   the dev server starts, confirming the wiring.

Errors (uncaught exceptions) and `fetch` network requests are captured too — no extra
setup.

## Run an example

From the **repo root**, build Console Lens once:

```bash
npm install && npm run compile
```

Start a log sink — either the CLI viewer (`npm run viewer`) or the VS Code
extension (press F5) for inline values. Then:

```bash
cd examples/vite      # or examples/astro, examples/nextjs
npm install
npm run dev:lens      # look for the " console lens  connected" line
```

Open the dev server URL and interact with the page. Server and browser logs appear
in the viewer / inline in your editor, tagged with their source location and runtime.

## Note on source locations

Both browser and server logs map to your **original source files**, thanks to
source-map resolution:

- **Browser** — e.g. `Counter.tsx:27`, `index.astro:9`, `main.js:12`.
- **Server** — Astro frontmatter → `index.astro:5`, Next.js server component →
  `app/page.tsx:7` (resolved from the `webpack://` virtual path to the real file).

See the root README "Source maps" section for details.
