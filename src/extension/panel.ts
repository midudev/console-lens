import * as vscode from 'vscode';
import type { EventLog, PanelEvent } from './events';
import { isInProjectRoots } from '../shared/project';

/**
 * Webview panel that lists every captured log/error/network event with a details
 * pane, opened from the status bar. Streams new events live.
 */
export class LensPanel {
  private static current: LensPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, eventLog: EventLog): void {
    const column = vscode.ViewColumn.Beside;
    if (LensPanel.current) {
      LensPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel('consoleLens', 'Console Lens', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    LensPanel.current = new LensPanel(panel, eventLog);
  }

  private unsubscribe: Array<() => void> = [];

  private constructor(panel: vscode.WebviewPanel, private readonly eventLog: EventLog) {
    this.panel = panel;
    this.panel.webview.html = this.html();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; [k: string]: unknown }) => {
        if (msg.type === 'ready') {
          this.sync();
        } else if (msg.type === 'open' && typeof msg.file === 'string') {
          vscode.commands.executeCommand('console-lens.openLocation', msg.file, msg.line, msg.column);
        } else if (msg.type === 'ai' && typeof msg.prompt === 'string') {
          vscode.commands.executeCommand('console-lens.sendToAI', msg.prompt);
        } else if (msg.type === 'clear') {
          vscode.commands.executeCommand('console-lens.clear');
        } else if (msg.type === 'toggleCapture') {
          vscode.commands.executeCommand('console-lens.toggleCapture');
        } else if (msg.type === 'copy' && typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Console Lens: copied to clipboard', 2000);
        } else if (msg.type === 'save' && typeof msg.text === 'string') {
          void this.saveText(msg.text as string);
        }
      },
      null,
      this.disposables,
    );

    // Live updates (unsubscribed on dispose so a closed panel can't break the chain).
    this.unsubscribe.push(this.eventLog.onEvent((e) => this.post({ type: 'event', event: e })));
    this.unsubscribe.push(this.eventLog.onClear(() => this.post({ type: 'reset' })));

    // Re-sync when the panel becomes visible again (catches anything missed).
    this.panel.onDidChangeViewState(
      () => {
        if (this.panel.visible) {
          this.sync();
        }
      },
      null,
      this.disposables,
    );
  }

  private async saveText(text: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { Text: ['log', 'txt'], JSON: ['json'] },
      saveLabel: 'Export Console Lens logs',
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
      vscode.window.showInformationMessage('Console Lens: logs exported.');
    }
  }

  /** Send a full snapshot to the webview. */
  private sync(): void {
    this.post({ type: 'reset' });
    for (const e of this.eventLog.getAll()) {
      this.post({ type: 'event', event: e });
    }
  }

  private post(message: { type: string; event?: PanelEvent }): void {
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    LensPanel.current = undefined;
    for (const off of this.unsubscribe) {
      off();
    }
    this.unsubscribe = [];
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2);
    // Workspace roots let the panel show only the current project's logs by
    // default (each log carries the cwd of the process that produced it).
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const rootsJson = JSON.stringify(roots);
    const hasRoots = roots.length > 0;
    return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; overflow: hidden; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); }
  #app { display: flex; height: 100vh; min-height: 0; }
  #left { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }

  .toolbar { display: flex; gap: 2px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar input { flex: 1; min-width: 0; height: 26px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 0 8px; border-radius: 5px; outline: none; }
  .toolbar input:focus { border-color: var(--vscode-focusBorder); }
  .tb-sep { width: 1px; height: 16px; background: var(--vscode-panel-border); margin: 0 4px; flex: none; }

  .iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; flex: none; transition: background .12s, color .12s; }
  .iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.18)); }
  .iconbtn:active { background: var(--vscode-toolbar-activeBackground, rgba(127,127,127,.28)); }
  .iconbtn svg { width: 16px; height: 16px; display: block; }
  .iconbtn.recbtn { color: var(--vscode-descriptionForeground); }
  .iconbtn.recbtn.on { color: #e5534b; }
  .iconbtn.recbtn.on .rec-dot { animation: rec-pulse 1.6s ease-in-out infinite; }
  @keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .iconbtn.autobtn { color: var(--vscode-descriptionForeground); }
  .iconbtn.autobtn.on { color: var(--vscode-charts-blue, #4a9eff); background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.14)); }
  .iconbtn.clearbtn:hover { color: var(--vscode-errorForeground); }

  .chips { display: flex; gap: 4px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  .chip { font-size: 11px; line-height: 18px; padding: 1px 9px; border-radius: 10px; cursor: pointer; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); user-select: none; transition: background .12s, color .12s; }
  .chip:hover { color: var(--vscode-foreground); border-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); }
  .chip.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .chip.active:hover { color: var(--vscode-button-foreground); }
  .chip-sep { width: 1px; align-self: stretch; margin: 2px 4px; background: var(--vscode-panel-border); }
  .count { margin-left: auto; font-size: 11px; color: var(--vscode-descriptionForeground); align-self: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }

  #list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
  /* DevTools-style rows: the log content is rendered inline and expandable in
     place — no separate detail pane, no click needed to read a log. A thin
     separator, a level-colored left rail, and a level-tinted background for
     warnings/errors (all from theme tokens). */
  .row { position: relative; display: flex; align-items: flex-start; gap: 7px; padding: 3px 10px 3px 7px; border-left: 3px solid transparent; border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); min-width: 0; }
  .row.error { background: var(--vscode-inputValidation-errorBackground, rgba(255,77,77,.08)); border-left-color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  .row.warn  { background: var(--vscode-inputValidation-warningBackground, rgba(220,170,40,.08)); border-left-color: var(--vscode-editorWarning-foreground, #d7a847); }
  .row.info  { border-left-color: var(--vscode-editorInfo-foreground, #4a9eff); }
  .row.network { border-left-color: var(--vscode-charts-blue, #4a9eff); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .lvlicon { flex: none; width: 15px; height: 15px; margin-top: 2px; display: inline-flex; align-items: center; justify-content: center; }
  .lvlicon svg { width: 15px; height: 15px; display: block; }
  .lvlicon.error { color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  .lvlicon.warn { color: var(--vscode-editorWarning-foreground, #d7a847); }
  .lvlicon.info { color: var(--vscode-editorInfo-foreground, #4a9eff); }
  .ts { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; font-size: 11px; flex: none; margin-top: 3px; }
  .badge { font-size: 9px; font-weight: 600; padding: 0 4px; border-radius: 3px; flex: none; text-transform: uppercase; letter-spacing: .04em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: .85; margin-top: 2px; }
  .badge.network { background: var(--vscode-charts-blue, #2b6cb0); color: #fff; }
  .content { flex: 1; min-width: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.5; word-break: break-word; }
  .content .text { white-space: pre-wrap; }
  .content.error { color: var(--vscode-editorError-foreground, var(--vscode-errorForeground)); }
  .content.warn { color: var(--vscode-editorWarning-foreground, #d7a847); }
  .loc { flex: none; align-self: flex-start; margin-top: 3px; max-width: 40%; color: var(--vscode-descriptionForeground); font-size: 11px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
  .loc:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  /* Always in flow so they reserve their space (the padding to the right of the
     file:line) — they only become visible on hover, never covering the name. */
  .row-actions { flex: none; align-self: flex-start; margin-top: 1px; display: flex; gap: 2px; visibility: hidden; }
  .row:hover .row-actions { visibility: visible; }
  .row-actions .iconbtn { width: 22px; height: 22px; }
  .row-actions .iconbtn svg { width: 14px; height: 14px; }
  .empty { padding: 16px; color: var(--vscode-descriptionForeground); }

  /* Inline expandable detail (error stack, network bodies). */
  .xdetails { margin-top: 2px; }
  .xdetails > summary { cursor: pointer; list-style: none; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .xdetails > summary::-webkit-details-marker { display: none; }
  .xdetails > summary::before { content: '▸ '; }
  .xdetails[open] > summary::before { content: '▾ '; }
  .xbody { margin: 4px 0 2px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1)); border-radius: 4px; }
  .frame { cursor: pointer; }
  .frame:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }

  /* console.table grid */
  .ltable { border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: normal; margin-top: 3px; }
  .ltable th, .ltable td { border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); padding: 3px 9px; text-align: left; vertical-align: top; }
  .ltable th { background: var(--vscode-keybindingTable-headerBackground, var(--vscode-editorWidget-background)); font-weight: 600; }
  .ltable th.idx, .ltable td.idx { color: var(--vscode-descriptionForeground); }
  .ltable tbody tr:nth-child(even) td { background: var(--vscode-list-hoverBackground, transparent); }
  .ltable td .v-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .ltable td .v-number, .ltable td .v-boolean { color: var(--vscode-debugTokenExpression-number, #b5cea8); }

  /* Inline object inspector (DevTools-style, collapsed previews expand in place). */
  .tree, .tree details { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: normal; }
  .tree details { padding-left: 14px; }
  .tree > details, .tree > .leaf { padding-left: 0; }
  .tree summary { cursor: pointer; list-style: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree summary::-webkit-details-marker { display: none; }
  .tree summary::before { content: '▸'; display: inline-block; width: 12px; color: var(--vscode-descriptionForeground); }
  .tree details[open] > summary::before { content: '▾'; }
  .tree .leaf { padding-left: 12px; }
  .tree .key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
  .tree .v-string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .tree .v-number, .tree .v-boolean, .tree .v-bigint { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .tree .v-null, .tree .v-undefined { color: var(--vscode-descriptionForeground); }
  .tree .ty { color: var(--vscode-descriptionForeground); }
  .tree .more { padding-left: 26px; color: var(--vscode-descriptionForeground); font-style: italic; }
  .argsep { margin: 8px 0 4px; color: var(--vscode-descriptionForeground); font-size: 11px; }
</style>
</head>
<body>
<div id="app">
  <div id="left">
    <div class="toolbar">
      <input id="filter" placeholder="Filter…" />
      <button id="pause" class="iconbtn recbtn on" title="Pause capture" aria-label="Pause capture"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle class="rec-dot" cx="12" cy="12" r="6" /></svg></button>
      <button id="autoscroll" class="iconbtn autobtn on" title="Auto-scroll: on" aria-label="Toggle auto-scroll"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11" /><path d="M7 11l5 5l5 -5" /><path d="M5 20h14" /></svg></button>
      <span class="tb-sep"></span>
      <button id="copy" class="iconbtn" title="Copy all events to clipboard" aria-label="Copy all events"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" /><path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2" /></svg></button>
      <button id="save" class="iconbtn" title="Export all events to a file" aria-label="Export events"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" /><path d="M7 11l5 5l5 -5" /><path d="M12 4v12" /></svg></button>
      <button id="clear" class="iconbtn clearbtn" title="Clear all captured events" aria-label="Clear all events"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" /><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" /></svg></button>
    </div>
    <div class="chips">
      <span class="chip active" data-kind="all">All</span>
      <span class="chip" data-kind="log">Logs</span>
      <span class="chip" data-kind="error">Errors</span>
      <span class="chip" data-kind="network">Network</span>
      <span class="chip-sep"></span>
      <span class="chip active" data-runtime="all">Both</span>
      <span class="chip" data-runtime="node">Server</span>
      <span class="chip" data-runtime="browser">Client</span>
      ${hasRoots ? '<span class="chip-sep"></span><span class="chip active" id="projChip" title="Showing this project only — click to include all open projects">This project</span>' : ''}
      <span id="count" class="count">0</span>
    </div>
    <div id="list"><div class="empty">Waiting for logs… run your app.</div></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById('list');
  const filterEl = document.getElementById('filter');
  const countEl = document.getElementById('count');
  const autoBtn = document.getElementById('autoscroll');
  let events = [];
  let kind = 'all';
  let runtime = 'all';
  let autoScroll = true;
  let projectOnly = ${hasRoots ? 'true' : 'false'};
  // True once any event has arrived carrying a project (cwd). While at least one
  // log is attributed to a project, untagged logs are treated as "other project"
  // and hidden under "This project"; if NOTHING is tagged (a fully legacy/manual
  // setup) we don't filter by project so the panel is never mysteriously empty.
  let anyCwd = false;

  // Per-project filtering: each event carries the cwd of the process that
  // produced it; by default we only show logs from the current workspace. The
  // matcher is embedded verbatim from src/shared/project.ts so it is covered by
  // cross-platform unit tests (Windows/Linux path handling).
  ${isInProjectRoots.toString()}
  const ROOTS = ${rootsJson};
  function inProject(e){
    if (!projectOnly || !ROOTS.length) return true;
    if (!e.cwd) return !anyCwd; // untagged: only show when no project info exists at all
    return isInProjectRoots(e.cwd, ROOTS);
  }

  // Tabler filled icons, sized to 15px via the .lvlicon class.
  const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c5.523 0 10 4.477 10 10s-4.477 10 -10 10s-10 -4.477 -10 -10s4.477 -10 10 -10m3.6 5.2a1 1 0 0 0 -1.4 .2l-2.2 2.933l-2.2 -2.933a1 1 0 1 0 -1.6 1.2l2.55 3.4l-2.55 3.4a1 1 0 1 0 1.6 1.2l2.2 -2.933l2.2 2.933a1 1 0 0 0 1.6 -1.2l-2.55 -3.4l2.55 -3.4a1 1 0 0 0 -.2 -1.4" /></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.67c.955 0 1.845 .467 2.39 1.247l.105 .16l8.114 13.548a2.914 2.914 0 0 1 -2.307 4.363l-.195 .008h-16.225a2.914 2.914 0 0 1 -2.582 -4.2l.099 -.185l8.11 -13.538a2.914 2.914 0 0 1 2.491 -1.403zm.01 13.33l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007zm-.01 -7a1 1 0 0 0 -.993 .883l-.007 .117v4l.007 .117a1 1 0 0 0 1.986 0l.007 -.117v-4l-.007 -.117a1 1 0 0 0 -.993 -.883z" /></svg>';
  const ICON_INFO = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l.642 .005l.616 .017l.299 .013l.579 .034l.553 .046c4.687 .455 6.65 2.333 7.166 6.906l.03 .29l.046 .553l.041 .727l.006 .15l.017 .617l.005 .642l-.005 .642l-.017 .616l-.013 .299l-.034 .579l-.046 .553c-.455 4.687 -2.333 6.65 -6.906 7.166l-.29 .03l-.553 .046l-.727 .041l-.15 .006l-.617 .017l-.642 .005l-.642 -.005l-.616 -.017l-.299 -.013l-.579 -.034l-.553 -.046c-4.687 -.455 -6.65 -2.333 -7.166 -6.906l-.03 -.29l-.046 -.553l-.041 -.727l-.006 -.15l-.017 -.617l-.004 -.318v-.648l.004 -.318l.017 -.616l.013 -.299l.034 -.579l.046 -.553c.455 -4.687 2.333 -6.65 6.906 -7.166l.29 -.03l.553 -.046l.727 -.041l.15 -.006l.617 -.017c.21 -.003 .424 -.005 .642 -.005zm0 9h-1l-.117 .007a1 1 0 0 0 0 1.986l.117 .007v3l.007 .117a1 1 0 0 0 .876 .876l.117 .007h1l.117 -.007a1 1 0 0 0 .876 -.876l.007 -.117l-.007 -.117a1 1 0 0 0 -.764 -.857l-.112 -.02l-.117 -.006v-3l-.007 -.117a1 1 0 0 0 -.876 -.876l-.117 -.007zm.01 -3l-.127 .007a1 1 0 0 0 0 1.986l.117 .007l.127 -.007a1 1 0 0 0 0 -1.986l-.117 -.007z" /></svg>';
  const ICON_AI = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.1l4.1 1.9l-4.1 1.9l-1.9 4.1l-1.9 -4.1l-4.1 -1.9l4.1 -1.9z" /><path d="M19 14l.9 2.1l2.1 .9l-2.1 .9l-.9 2.1l-.9 -2.1l-2.1 -.9l2.1 -.9z" /></svg>';
  const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" /><path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2" /></svg>';

  function fmtTime(ts){ const d=new Date(ts),p=(n,l=2)=>String(n).padStart(l,'0'); return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+p(d.getMilliseconds(),3); }
  function base(f){ return (f||'').split(/[\\/]/).pop() || ''; }
  function badgeText(e){ return e.kind==='network' ? 'NET' : e.level; }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function valClass(t){ return 'v-' + (t||'').replace(/[^a-z]/gi,'').toLowerCase(); }
  function hasChildren(n){ return n && n.children && n.children.length; }

  // The level/severity of an event, collapsing kind+level into one of the
  // DevTools-style severities used for the left rail, tint and icon.
  function levelOf(e){ return e.kind==='error' ? 'error' : e.kind==='network' ? 'network' : e.level; }

  // Leading slot: a colored severity icon for error/warn/info, else a small badge.
  function makeLeading(e){
    const lvl = levelOf(e);
    const icon = lvl==='error' ? ICON_ERROR : lvl==='warn' ? ICON_WARN : lvl==='info' ? ICON_INFO : null;
    const el = document.createElement('span');
    if (icon) { el.className = 'lvlicon ' + lvl; el.innerHTML = icon; }
    else { el.className = 'badge ' + lvl; el.textContent = badgeText(e); }
    return el;
  }

  function makeTreeNode(key, node, depth){
    var hasChildren = node.children && node.children.length;
    var keyHtml = key !== null ? '<span class="key">' + esc(key) + '</span>: ' : '';
    if (hasChildren) {
      var det = document.createElement('details');
      det.open = false; // DevTools-style: collapsed, preview visible inline
      var sum = document.createElement('summary');
      sum.innerHTML = keyHtml + '<span class="ty">' + esc(node.preview) + '</span>';
      det.appendChild(sum);
      for (var i = 0; i < node.children.length; i++) det.appendChild(makeTreeNode(node.children[i].key, node.children[i].node, depth + 1));
      if (node.truncated) { var m = document.createElement('div'); m.className = 'more'; m.textContent = '… more items'; det.appendChild(m); }
      return det;
    }
    var leaf = document.createElement('div'); leaf.className = 'leaf';
    leaf.innerHTML = keyHtml + '<span class="' + valClass(node.t) + '">' + esc(node.preview) + '</span>';
    return leaf;
  }

  function renderTrees(trees){
    var wrap = document.createElement('div'); wrap.className = 'tree';
    for (var i = 0; i < trees.length; i++) {
      if (trees.length > 1) { var sep = document.createElement('div'); sep.className = 'argsep'; sep.textContent = 'arg ' + i; wrap.appendChild(sep); }
      wrap.appendChild(makeTreeNode(null, trees[i], 0));
    }
    return wrap;
  }

  // --- console.table -------------------------------------------------------
  // Build a column model from an object-inspector node (array/object whose
  // entries become rows; their properties become columns, DevTools-style).
  function buildTableModel(node){
    if (!node || !node.children || !node.children.length) return null;
    var rows = node.children, cols = [], seen = {}, hasValues = false;
    for (var i = 0; i < rows.length; i++) {
      var rn = rows[i].node;
      if (rn && rn.children && rn.children.length) {
        for (var c = 0; c < rn.children.length; c++) { var k = rn.children[c].key; if (!seen[k]) { seen[k] = 1; cols.push(k); } }
      } else { hasValues = true; }
    }
    return { rows: rows, cols: cols, hasValues: hasValues };
  }

  function cellHtml(n){ return n ? '<span class="' + valClass(n.t) + '">' + esc(n.preview) + '</span>' : ''; }

  function renderTable(model){
    var t = document.createElement('table'); t.className = 'ltable';
    var thead = document.createElement('thead'), htr = document.createElement('tr');
    function addTh(text, cls){ var x = document.createElement('th'); if (cls) x.className = cls; x.textContent = text; htr.appendChild(x); }
    addTh('(index)', 'idx');
    for (var c = 0; c < model.cols.length; c++) addTh(model.cols[c]);
    if (model.hasValues) addTh('Value');
    thead.appendChild(htr); t.appendChild(thead);
    var tb = document.createElement('tbody');
    for (var i = 0; i < model.rows.length; i++) {
      var row = model.rows[i], rn = row.node, tr = document.createElement('tr');
      var idx = document.createElement('td'); idx.className = 'idx'; idx.textContent = row.key; tr.appendChild(idx);
      var byKey = {};
      if (rn && rn.children) for (var k = 0; k < rn.children.length; k++) byKey[rn.children[k].key] = rn.children[k].node;
      for (var cc = 0; cc < model.cols.length; cc++) { var td = document.createElement('td'); td.innerHTML = cellHtml(byKey[model.cols[cc]]); tr.appendChild(td); }
      if (model.hasValues) { var vtd = document.createElement('td'); if (!(rn && rn.children && rn.children.length)) vtd.innerHTML = cellHtml(rn); tr.appendChild(vtd); }
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    return t;
  }

  // Fallback when no inspector tree is available (lite browser client): rebuild
  // a shallow node from the serialized value so the grid can still render.
  function toNode(v, depth){
    var t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
    var preview = typeof v === 'string' ? JSON.stringify(v) : v === null ? 'null'
      : typeof v === 'object' ? (Array.isArray(v) ? 'Array(' + v.length + ')' : '{…}') : String(v);
    var node = { t: t, preview: preview };
    if (v && typeof v === 'object' && depth > 0) {
      var keys = Array.isArray(v) ? v.map(function(_, i){ return String(i); }) : Object.keys(v);
      node.children = keys.slice(0, 200).map(function(k){ return { key: k, node: toNode(v[k], depth - 1) }; });
    }
    return node;
  }

  function tableNodeFor(e){
    if (e.tree && e.tree.length) return e.tree[0];
    try { return toNode(JSON.parse(e.detail), 2); } catch (x) { return null; }
  }

  function updateCount(shownLen) {
    countEl.textContent = shownLen === events.length ? events.length + ' events' : shownLen + ' / ' + events.length;
  }

  function matches(e){
    const q = filterEl.value.toLowerCase();
    return (kind === 'all' || e.kind === kind) &&
      (runtime === 'all' || e.runtime === runtime) &&
      inProject(e) &&
      (!q || e.preview.toLowerCase().includes(q) || (e.file||'').toLowerCase().includes(q));
  }

  function askAI(e){
    const fence = String.fromCharCode(96,96,96);
    const intro = e.kind==='error'?'My app threw an error:':e.kind==='network'?'A network request from my app:':'A console.'+e.level+' from my app:';
    vscode.postMessage({ type:'ai', prompt: intro+'\\n'+fence+'\\n'+(e.detail||e.preview)+'\\n'+fence+'\\nHelp me understand or fix it.' });
  }

  // A collapsible "▸ summary / body" section used for error stacks & network bodies.
  function xdetails(summaryText, build){
    const det = document.createElement('details'); det.className = 'xdetails';
    const sum = document.createElement('summary'); sum.textContent = summaryText; det.appendChild(sum);
    sum.onclick = (ev) => ev.stopPropagation();
    const body = document.createElement('div'); body.className = 'xbody'; build(body); det.appendChild(body);
    return det;
  }

  function renderError(e){
    const wrap = document.createElement('div'); wrap.className = 'content error';
    const head = document.createElement('div'); head.className = 'text'; head.textContent = e.preview; wrap.appendChild(head);
    if (e.frames && e.frames.length) {
      wrap.appendChild(xdetails('Stack (' + e.frames.length + ')', (body) => {
        for (const f of e.frames) {
          const line = document.createElement('div'); line.className = 'frame';
          line.textContent = 'at ' + (f.function || '<anonymous>') + ' (' + base(f.file) + ':' + f.line + ')';
          if (f.file) line.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type:'open', file:f.file, line:f.line, column:f.column }); };
          body.appendChild(line);
        }
      }));
    } else if (e.detail && e.detail.indexOf('\\n') !== -1) {
      wrap.appendChild(xdetails('Stack', (body) => { body.textContent = e.detail; }));
    }
    return wrap;
  }

  function renderNetwork(e){
    const wrap = document.createElement('div'); wrap.className = 'content';
    const head = document.createElement('div'); head.className = 'text'; head.textContent = e.preview; wrap.appendChild(head);
    if (e.detail && e.detail.indexOf('\\n') !== -1) {
      wrap.appendChild(xdetails('Details', (body) => { body.textContent = e.detail; }));
    }
    return wrap;
  }

  function renderLog(e){
    const wrap = document.createElement('div'); wrap.className = 'content ' + levelOf(e);
    if (e.table) {
      const model = buildTableModel(tableNodeFor(e));
      if (model) { wrap.appendChild(renderTable(model)); return wrap; }
    }
    const trees = e.tree;
    if (trees && trees.length) {
      // A single object/array arg: render it as an inline, expandable inspector.
      if (trees.length === 1 && hasChildren(trees[0])) {
        const tw = document.createElement('div'); tw.className = 'tree';
        tw.appendChild(makeTreeNode(null, trees[0], 0));
        wrap.appendChild(tw); return wrap;
      }
      // Mixed/multiple args including objects: show the preview, expand for structure.
      if (trees.some(hasChildren)) {
        const det = document.createElement('details'); det.className = 'xdetails';
        const sum = document.createElement('summary'); sum.className = 'text'; sum.textContent = e.preview;
        sum.onclick = (ev) => ev.stopPropagation();
        det.appendChild(sum); det.appendChild(renderTrees(trees));
        wrap.appendChild(det); return wrap;
      }
    }
    const span = document.createElement('div'); span.className = 'text'; span.textContent = e.preview;
    wrap.appendChild(span);
    return wrap;
  }

  function renderContent(e){
    if (e.kind === 'error') return renderError(e);
    if (e.kind === 'network') return renderNetwork(e);
    return renderLog(e);
  }

  function makeRow(e){
    const lvl = levelOf(e);
    const row = document.createElement('div'); row.className = 'row ' + lvl;
    row.appendChild(makeLeading(e));
    const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = fmtTime(e.timestamp); row.appendChild(ts);
    row.appendChild(renderContent(e));
    if (e.file || e.line) {
      const loc = document.createElement('span'); loc.className = 'loc';
      loc.textContent = (e.file ? base(e.file) : '') + ':' + e.line;
      loc.title = 'Open ' + (e.file||'') + ':' + e.line;
      if (e.file) loc.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type:'open', file:e.file, line:e.line, column:e.column }); };
      row.appendChild(loc);
    }
    const actions = document.createElement('div'); actions.className = 'row-actions';
    const ai = document.createElement('button'); ai.className = 'iconbtn'; ai.title = 'Ask AI'; ai.setAttribute('aria-label','Ask AI'); ai.innerHTML = ICON_AI;
    ai.onclick = (ev) => { ev.stopPropagation(); askAI(e); };
    const cp = document.createElement('button'); cp.className = 'iconbtn'; cp.title = 'Copy'; cp.setAttribute('aria-label','Copy'); cp.innerHTML = ICON_COPY;
    cp.onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type:'copy', text: e.detail || e.preview }); };
    actions.appendChild(ai); actions.appendChild(cp); row.appendChild(actions);
    return row;
  }

  function render() {
    const shown = events.filter(matches);
    updateCount(shown.length);
    if (!shown.length) { listEl.innerHTML = '<div class="empty">' + (events.length ? 'No matching entries.' : 'Waiting for logs… run your app.') + '</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const e of shown) frag.appendChild(makeRow(e));
    listEl.textContent = '';
    listEl.appendChild(frag);
  }

  // Live append: add a single row without rebuilding the list, so already
  // expanded objects/stacks stay open as new logs stream in.
  function appendEvent(e){
    const empty = listEl.querySelector('.empty');
    if (empty) listEl.textContent = '';
    if (matches(e)) listEl.appendChild(makeRow(e));
    updateCount(events.filter(matches).length);
  }

  function scrollToBottom(){ listEl.scrollTop = listEl.scrollHeight; }

  function buildExportText(){
    return events.map(function(e){
      return '[' + fmtTime(e.timestamp) + '] ' + e.kind.toUpperCase() + ' ' + base(e.file) + ':' + e.line + '\\n' + (e.detail||'');
    }).join('\\n\\n');
  }

  filterEl.oninput = render;
  document.getElementById('clear').onclick = () => vscode.postMessage({ type:'clear' });
  document.getElementById('copy').onclick = () => vscode.postMessage({ type:'copy', text: buildExportText() });
  document.getElementById('save').onclick = () => vscode.postMessage({ type:'save', text: buildExportText() });
  const pauseBtn = document.getElementById('pause');
  let recording = true;
  pauseBtn.onclick = () => {
    recording = !recording;
    pauseBtn.classList.toggle('on', recording);
    pauseBtn.title = recording ? 'Pause capture' : 'Resume capture';
    vscode.postMessage({ type:'toggleCapture' });
  };
  autoBtn.onclick = () => {
    autoScroll = !autoScroll;
    autoBtn.classList.toggle('on', autoScroll);
    autoBtn.title = autoScroll ? 'Auto-scroll: on' : 'Auto-scroll: off';
    if (autoScroll) scrollToBottom();
  };
  document.querySelectorAll('.chip[data-kind]').forEach(chip => {
    chip.onclick = () => {
      kind = chip.getAttribute('data-kind');
      document.querySelectorAll('.chip[data-kind]').forEach(c => c.classList.toggle('active', c === chip));
      render();
      if (autoScroll) scrollToBottom();
    };
  });
  document.querySelectorAll('.chip[data-runtime]').forEach(chip => {
    chip.onclick = () => {
      runtime = chip.getAttribute('data-runtime');
      document.querySelectorAll('.chip[data-runtime]').forEach(c => c.classList.toggle('active', c === chip));
      render();
      if (autoScroll) scrollToBottom();
    };
  });
  const projChip = document.getElementById('projChip');
  if (projChip) projChip.onclick = () => {
    projectOnly = !projectOnly;
    projChip.classList.toggle('active', projectOnly);
    projChip.textContent = projectOnly ? 'This project' : 'All projects';
    projChip.title = projectOnly
      ? 'Showing this project only — click to include all open projects'
      : 'Showing all open projects — click to show only this project';
    render();
    if (autoScroll) scrollToBottom();
  };

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'reset') { events = []; anyCwd = false; render(); }
    else if (m.type === 'event') {
      events.push(m.event);
      // The first project-tagged log makes the filter strict — re-render so any
      // untagged logs already on screen (e.g. from a stale dev server) drop out.
      if (m.event.cwd && !anyCwd) { anyCwd = true; render(); }
      else appendEvent(m.event);
      if (autoScroll) scrollToBottom();
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
