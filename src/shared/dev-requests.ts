/**
 * Recognise dev-server / framework-internal requests (Vite + Astro module and
 * asset loading, HMR pings). These aren't app requests — capturing them as
 * "network" decorations just adds noise pinned to framework-generated URLs, so
 * both the Node agent and the browser client skip them.
 *
 * The browser client (`injector/browser-client.js`) keeps a standalone copy of
 * this logic since it can't import from the build; keep the two in sync.
 */
export function isInternalRequest(url: string): boolean {
  try {
    const u = String(url);
    return (
      /[?&](astro|vue|svelte)&type=/.test(u) || // SFC sub-modules (?astro&type=script…)
      /[?&]astro(&|=|$)/.test(u) ||
      /\/@(vite|id|fs|react-refresh)\//.test(u) ||
      /\/@vite\/client\b/.test(u) ||
      /\/node_modules\/\.vite\//.test(u) ||
      /[?&]html-proxy\b/.test(u) ||
      /[?&]t=\d{10,}/.test(u) || // Vite HMR cache-busting timestamp
      /hot-update\.(json|js|mjs)\b/.test(u) // webpack / Next HMR
    );
  } catch {
    return false;
  }
}
