import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { DEFAULT_TCP_PORT, PORT_ENV, WS_PORT_ENV, wsPortFor } from '../shared/protocol';
import { Decorator } from './decorator';
import { connectToBroker } from '../broker/client';
import { EventLog } from './events';
import { LensPanel } from './panel';
import { LogpointStore, LogpointCodeLensProvider } from './logpoints';

/** Stable, version-independent location for the agent so external terminals can
 * reference a path that survives extension updates. */
const STABLE_DIR = path.join(os.homedir(), '.console-lens');
const STABLE_PRELOAD = path.join(STABLE_DIR, 'out', 'agent', 'preload.js');
/** Single, global event log written by the broker and read by the MCP server. */
const GLOBAL_EVENTS = path.join(STABLE_DIR, 'events.json');
const SHELL_MARKER_START = '# >>> Console Lens >>>';
const SHELL_MARKER_END = '# <<< Console Lens <<<';

/** Copy the agent + injector into STABLE_DIR, preserving the relative layout the
 * agent expects (`../shared`, `../../injector`). */
function syncStableAgent(context: vscode.ExtensionContext, log: (m: string) => void): void {
  try {
    fs.mkdirSync(path.join(STABLE_DIR, 'out'), { recursive: true });
    fs.cpSync(context.asAbsolutePath('out/agent'), path.join(STABLE_DIR, 'out', 'agent'), { recursive: true });
    fs.cpSync(context.asAbsolutePath('out/shared'), path.join(STABLE_DIR, 'out', 'shared'), { recursive: true });
    fs.cpSync(context.asAbsolutePath('out/mcp'), path.join(STABLE_DIR, 'out', 'mcp'), { recursive: true });
    fs.cpSync(context.asAbsolutePath('injector'), path.join(STABLE_DIR, 'injector'), { recursive: true });
    log(`synced stable agent to ${STABLE_PRELOAD}`);
  } catch (err) {
    log(`failed to sync stable agent: ${(err as Error).message}`);
  }
}

/**
 * Map a captured source location to a real file on disk so the editor can open
 * it. Node logs already carry absolute paths; browser logs carry a URL or a
 * server-root path (e.g. `http://localhost:4321/src/pages/index.astro` or
 * `/src/pages/index.astro`). We strip the scheme/host and query, then look for
 * the longest trailing path segment that exists under a workspace folder, with a
 * basename search as a last resort.
 */
async function resolveWorkspaceFile(file: string): Promise<string | undefined> {
  if (!file) {
    return undefined;
  }
  // An absolute path that already exists on disk: use it as-is.
  if (path.isAbsolute(file) && !/^[a-z]+:\/\//i.test(file) && fs.existsSync(file)) {
    return file;
  }
  // Strip scheme + host (http://localhost:4321/…) and any query/hash.
  let p = file.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  if (!p) {
    return undefined;
  }
  const segments = p.split('/').filter((s) => s && s !== '.');
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const base = folder.uri.fsPath;
    // Try the longest trailing sub-path first, so `/src/pages/index.astro`
    // resolves precisely even when the file shares its name with others.
    for (let i = 0; i < segments.length; i++) {
      const candidate = path.resolve(base, segments.slice(i).join('/'));
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  // Last resort: search the workspace by basename.
  const basename = segments[segments.length - 1];
  if (basename) {
    const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 1);
    if (found.length) {
      return found[0].fsPath;
    }
  }
  return undefined;
}

function detectShellRc(): { file: string; shell: 'zsh' | 'bash' | 'fish' } {
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

const PORT_FILE = '$HOME/.console-lens/port';
const WSPORT_FILE = '$HOME/.console-lens/wsport';

/**
 * Shell block that does NOT hard-code the port. It keeps a port already injected
 * by the extension (integrated terminals get their own window's port), and only
 * falls back to the active window's port file (written by the focused window) for
 * external terminals — so logs reach the window you're actually looking at.
 */
function shellBlock(shell: 'zsh' | 'bash' | 'fish'): string {
  const preload = '$HOME/.console-lens/out/agent/preload.js';
  if (shell === 'fish') {
    return [
      SHELL_MARKER_START,
      `set -gx NODE_OPTIONS "$NODE_OPTIONS --require ${preload}"`,
      `if not set -q ${PORT_ENV}; set -gx ${PORT_ENV} (cat "${PORT_FILE}" 2>/dev/null; or echo 9111); end`,
      `if not set -q ${WS_PORT_ENV}; set -gx ${WS_PORT_ENV} (cat "${WSPORT_FILE}" 2>/dev/null; or echo 9112); end`,
      SHELL_MARKER_END,
    ].join('\n');
  }
  return [
    SHELL_MARKER_START,
    `export NODE_OPTIONS="$NODE_OPTIONS --require ${preload}"`,
    `export ${PORT_ENV}="\${${PORT_ENV}:-$(cat "${PORT_FILE}" 2>/dev/null || echo 9111)}"`,
    `export ${WS_PORT_ENV}="\${${WS_PORT_ENV}:-$(cat "${WSPORT_FILE}" 2>/dev/null || echo 9112)}"`,
    SHELL_MARKER_END,
  ].join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration('consoleLens');
  const preferredPort = config().get<number>('port', DEFAULT_TCP_PORT);

  const decorator = new Decorator(config().get<number>('maxInlineLength', 200));
  decorator.setEnabled(config().get<boolean>('enabled', true));
  context.subscriptions.push({ dispose: () => decorator.dispose() });

  const out = vscode.window.createOutputChannel('Console Lens');
  context.subscriptions.push(out);
  const log = (m: string) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`);
  log('Activating Console Lens…');

  // Keep a stable copy of the agent so external terminals (iTerm, Warp, …) can
  // reference a path that does not change across extension updates.
  syncStableAgent(context, log);

  // --- Shell integration (works in ANY terminal, system-wide) -------------
  // Driven by the `consoleLens.shellIntegration` setting (default on) and
  // reconciled automatically on activation — the user doesn't run anything.
  const writeShellIntegration = (): 'installed' | 'unchanged' | 'error' => {
    // POSIX shell profiles (~/.zshrc etc.) aren't sourced by PowerShell/cmd on
    // Windows, and the integrated-terminal env injection already covers it there.
    if (process.platform === 'win32') {
      return 'unchanged';
    }
    const { file, shell } = detectShellRc();
    const block = shellBlock(shell);
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const re = new RegExp(`\\n?${SHELL_MARKER_START}[\\s\\S]*?${SHELL_MARKER_END}\\n?`);
      const currentMatch = existing.match(re);
      if (currentMatch && currentMatch[0].trim() === block) {
        return 'unchanged'; // already up to date — don't rewrite on every launch
      }
      const cleaned = existing.replace(re, '\n');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${cleaned.replace(/\n*$/, '\n')}\n${block}\n`);
      log(`shell integration written to ${file} (${shell})`);
      return 'installed';
    } catch (err) {
      log(`shell integration failed for ${file}: ${(err as Error).message}`);
      return 'error';
    }
  };

  const removeShellIntegration = (): 'removed' | 'absent' | 'error' => {
    if (process.platform === 'win32') {
      return 'absent';
    }
    const { file } = detectShellRc();
    try {
      if (!fs.existsSync(file)) {
        return 'absent';
      }
      const existing = fs.readFileSync(file, 'utf8');
      const re = new RegExp(`\\n?${SHELL_MARKER_START}[\\s\\S]*?${SHELL_MARKER_END}\\n?`, 'g');
      if (!re.test(existing)) {
        return 'absent';
      }
      fs.writeFileSync(file, existing.replace(re, '\n'));
      log(`shell integration removed from ${file}`);
      return 'removed';
    } catch (err) {
      log(`shell integration removal failed for ${file}: ${(err as Error).message}`);
      return 'error';
    }
  };

  const reconcileShellIntegration = (): void => {
    if (config().get<boolean>('shellIntegration', true)) {
      const status = writeShellIntegration();
      if (status === 'installed') {
        const notified = context.globalState.get<boolean>('shellIntegrationNotified', false);
        if (!notified) {
          context.globalState.update('shellIntegrationNotified', true);
          vscode.window.showInformationMessage(
            'Console Lens now attaches to ALL terminals automatically. Open a new terminal to use it. (Disable via the "consoleLens.shellIntegration" setting.)',
          );
        }
      }
    } else {
      removeShellIntegration();
    }
  };
  reconcileShellIntegration();

  const loaderPath = context.asAbsolutePath('out/agent/preload.js');
  let activeTcpPort = preferredPort;
  let activeWsPort = wsPortFor(preferredPort);

  // Mechanism 1 (clean, invisible): inject the agent via the terminal
  // environment collection. Works for terminals opened after activation.
  // Per-workspace storage for events + logpoints (read by the agent/MCP).
  const clStorageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  try {
    fs.mkdirSync(clStorageDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const logpointsPath = path.join(clStorageDir, 'logpoints.json');
  const logpointStore = new LogpointStore(logpointsPath, context.workspaceState);

  const env = context.environmentVariableCollection;
  env.persistent = true;
  env.description = 'Console Lens — inline logging agent.';
  const applyEnv = (tcpPort: number, wsPort: number): void => {
    env.replace('NODE_OPTIONS', `--require "${loaderPath}"`);
    env.replace(PORT_ENV, String(tcpPort));
    env.replace(WS_PORT_ENV, String(wsPort));
    env.replace('CONSOLE_LENS_LOGPOINTS', logpointsPath);
    log(`env set: NODE_OPTIONS=--require "${loaderPath}" ${PORT_ENV}=${tcpPort} ${WS_PORT_ENV}=${wsPort}`);
  };
  applyEnv(activeTcpPort, activeWsPort);

  // Mechanism 2 (guaranteed): export the vars straight into terminals via the
  // terminal API. This covers terminals already open AND any case where the
  // environment collection isn't honoured by the user's setup. The export is
  // queued before the user can type, so the next command they run is attached.
  const autoAttach = config().get<boolean>('autoAttachTerminals', true);
  const exportLine = () =>
    `export NODE_OPTIONS="--require ${loaderPath}" ${PORT_ENV}=${activeTcpPort} ${WS_PORT_ENV}=${activeWsPort} CONSOLE_LENS_LOGPOINTS="${logpointsPath}"`;
  const attachTerminal = (terminal: vscode.Terminal, why: string): void => {
    if (!autoAttach || terminal.exitStatus !== undefined) {
      return;
    }
    terminal.sendText(exportLine());
    log(`auto-attached terminal (${why}): "${terminal.name}"`);
  };
  // New terminals.
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((terminal) => attachTerminal(terminal, 'opened')),
  );
  // Terminals already open at activation (attached once ports are known, below).
  const preexistingTerminals = [...vscode.window.terminals];

  const maxEvents = config().get<number>('maxEvents', 5000);
  const eventLog = new EventLog(maxEvents);

  // The broker is the single writer of the global events.json the MCP server
  // reads — one writer across every window, so no concurrent-write races. This
  // window's eventLog stays purely in-memory, feeding only the panel.
  const eventsPath = GLOBAL_EVENTS;
  const mcpServerPath = path.join(STABLE_DIR, 'out', 'mcp', 'server.js');

  // Register the MCP server with VS Code (1.101+) so Copilot can use it. Other
  // clients use the "Copy MCP config" command. Guarded for older VS Code.
  try {
    const lm = (vscode as unknown as { lm?: { registerMcpServerDefinitionProvider?: Function } }).lm;
    const McpStdio = (vscode as unknown as { McpStdioServerDefinition?: new (...a: unknown[]) => unknown })
      .McpStdioServerDefinition;
    if (lm?.registerMcpServerDefinitionProvider && McpStdio) {
      const emitter = new vscode.EventEmitter<void>();
      const provider = {
        onDidChangeMcpServerDefinitions: emitter.event,
        provideMcpServerDefinitions: () => [
          new McpStdio('Console Lens', 'node', [mcpServerPath], { CONSOLE_LENS_EVENTS: eventsPath }),
        ],
      };
      context.subscriptions.push(lm.registerMcpServerDefinitionProvider('console-lens', provider));
      log('registered MCP server provider for VS Code');
    }
  } catch (err) {
    log(`MCP registration skipped: ${(err as Error).message}`);
  }

  // Connect to the shared broker instead of running a per-window server. The
  // first window to start spawns the broker (which owns the fixed ports); every
  // other window detects it and attaches, so logs reach ALL windows at once.
  const brokerScript = context.asAbsolutePath('out/broker/broker.js');
  const spawnBroker = (): void => {
    try {
      const child = child_process.spawn(
        process.execPath,
        [brokerScript, '--port', String(preferredPort), '--events', eventsPath, '--max', String(maxEvents)],
        {
          detached: true,
          stdio: 'ignore',
          // VS Code's runtime is Electron; this makes process.execPath run as Node.
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
      );
      child.unref();
    } catch (err) {
      log(`failed to spawn broker: ${(err as Error).message}`);
    }
  };
  const client = connectToBroker({ tcpPort: preferredPort, spawnBroker, log });
  context.subscriptions.push(new vscode.Disposable(() => client.close()));

  // Capture state + live counters (shown in the status bar).
  let paused = false;
  let logCount = 0;
  let errorCount = 0;
  let netCount = 0;

  client.on('log', (message) => {
    if (paused) {
      return;
    }
    logCount += 1;
    decorator.onMessage(message);
    eventLog.addLog(message);
    refreshStatus();
  });
  client.on('errorLog', (message) => {
    if (paused) {
      return;
    }
    errorCount += 1;
    decorator.onError(message);
    eventLog.addError(message);
    refreshStatus();
  });
  client.on('network', (message) => {
    if (paused) {
      return;
    }
    netCount += 1;
    decorator.onNetwork(message);
    eventLog.addNetwork(message);
    refreshStatus();
  });
  // A fresh run, or a "Clear All" from any window — drop stale events here too.
  const clearLocal = (): void => {
    decorator.clear();
    eventLog.clear();
    logCount = errorCount = netCount = 0;
    refreshStatus();
  };
  client.on('newRun', () => {
    clearLocal();
    log('new run detected — cleared previous events');
  });
  client.on('clear', () => clearLocal());
  client.on('connected', ({ tcpPort, wsPort }: { tcpPort: number; wsPort: number }) => {
    activeTcpPort = tcpPort;
    activeWsPort = wsPort;
    log(`connected to broker — TCP ${tcpPort} / WS ${wsPort}`);
    refreshStatus();
  });
  client.on('unreachable', (port: number) => {
    vscode.window.showWarningMessage(
      `Console Lens: couldn't reach the broker on port ${port}. Another process may be using it — set "consoleLens.port" to a free port.`,
    );
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'console-lens.showPanel';
  context.subscriptions.push(statusBar);

  let enabled = config().get<boolean>('enabled', true);
  const refreshStatus = () => {
    const icon = paused ? '$(debug-pause)' : enabled ? '$(eye)' : '$(eye-closed)';
    const counts = paused
      ? ' (paused)'
      : `${logCount ? ` ${logCount}` : ''}${errorCount ? ` $(error)${errorCount}` : ''}${netCount ? ` $(arrow-swap)${netCount}` : ''}`;
    statusBar.text = `${icon} Console Lens${counts}`;
    statusBar.tooltip =
      `Console Lens — TCP ${activeTcpPort} / WS ${activeWsPort}\n` +
      `${logCount} logs · ${errorCount} errors · ${netCount} requests` +
      `${paused ? ' · capture PAUSED' : ''}\nClick to open the panel.`;
    statusBar.show();
  };

  // External terminals read the broker port from these files (the shell snippet
  // falls back to them). The broker owns one fixed port, so we write it once —
  // no more per-focus rotation that left already-open terminals pointing at a
  // stale port.
  const writePortFiles = (tcp: number, ws: number): void => {
    try {
      fs.mkdirSync(STABLE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STABLE_DIR, 'port'), String(tcp));
      fs.writeFileSync(path.join(STABLE_DIR, 'wsport'), String(ws));
    } catch {
      /* ignore */
    }
  };
  writePortFiles(activeTcpPort, activeWsPort);

  // Ports are fixed and known upfront, so wire up already-open terminals now —
  // there's no "listening" event to wait for.
  for (const terminal of preexistingTerminals) {
    attachTerminal(terminal, 'pre-existing');
  }

  refreshStatus();

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => decorator.renderAll()),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        decorator.renderEditor(editor);
      }
    }),
    // Editing a line makes its captured value stale: drop that inline decoration
    // (and shift the rest to follow inserted/removed lines) until the next run.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }
      const fsPath = e.document.uri.fsPath;
      const edits = e.contentChanges.map((c) => ({
        startLine: c.range.start.line,
        endLine: c.range.end.line,
        endAtLineStart: c.range.end.character === 0,
        delta: (c.text.match(/\n/g)?.length ?? 0) - (c.range.end.line - c.range.start.line),
      }));
      if (decorator.applyEdit(fsPath, edits)) {
        for (const ed of vscode.window.visibleTextEditors) {
          if (ed.document.uri.fsPath === fsPath) {
            decorator.renderEditor(ed);
          }
        }
      }
    }),
  );

  // --- Logpoints UI: CodeLens + gutter + commands ----------------------------
  const lpLanguages = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'astro', 'vue', 'svelte'].map(
    (language) => ({ language }),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(lpLanguages, new LogpointCodeLensProvider(logpointStore)),
  );
  const gutterType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.file(context.asAbsolutePath('assets/logpoint.svg')),
    gutterIconSize: 'contain',
    overviewRulerColor: '#4ade80',
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  context.subscriptions.push(gutterType);
  const renderGutter = (): void => {
    for (const ed of vscode.window.visibleTextEditors) {
      const decos = logpointStore
        .forFile(ed.document.uri.fsPath)
        .filter((lp) => lp.enabled && lp.line >= 1 && lp.line <= ed.document.lineCount)
        .map((lp) => ({ range: new vscode.Range(lp.line - 1, 0, lp.line - 1, 0) }));
      ed.setDecorations(gutterType, decos);
    }
  };
  context.subscriptions.push(
    logpointStore.onDidChange(renderGutter),
    vscode.window.onDidChangeVisibleTextEditors(renderGutter),
  );
  renderGutter();

  const addOrEditLogpoint = async (): Promise<void> => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }
    const line = ed.selection.active.line + 1;
    const existing = logpointStore.findAt(ed.document.uri.fsPath, line);
    const wordRange = ed.document.getWordRangeAtPosition(ed.selection.active);
    const dflt = !ed.selection.isEmpty
      ? ed.document.getText(ed.selection)
      : wordRange
        ? ed.document.getText(wordRange)
        : '';
    const expr = await vscode.window.showInputBox({
      prompt: `Console Lens logpoint — expression to log at line ${line} (no code edit)`,
      value: existing?.expression ?? dflt,
      placeHolder: 'e.g. user.id, response.status, count',
    });
    if (expr == null || !expr.trim()) {
      return;
    }
    if (existing) {
      logpointStore.update(existing.id, expr.trim());
    } else {
      logpointStore.add(ed.document.uri.fsPath, line, expr.trim());
    }
    vscode.window.setStatusBarMessage('Console Lens: logpoint set — reload the page / restart the run to apply.', 4000);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('console-lens.addLogpoint', addOrEditLogpoint),
    vscode.commands.registerCommand('console-lens.toggleLogpointHere', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return;
      }
      const existing = logpointStore.findAt(ed.document.uri.fsPath, ed.selection.active.line + 1);
      if (existing) {
        logpointStore.remove(existing.id);
      } else {
        await addOrEditLogpoint();
      }
    }),
    vscode.commands.registerCommand('console-lens.editLogpoint', async (id: string) => {
      const lp = logpointStore.get(id);
      if (!lp) {
        return;
      }
      const expr = await vscode.window.showInputBox({ prompt: 'Logpoint expression', value: lp.expression });
      if (expr != null && expr.trim()) {
        logpointStore.update(id, expr.trim());
      }
    }),
    vscode.commands.registerCommand('console-lens.removeLogpoint', (id: string) => logpointStore.remove(id)),
    vscode.commands.registerCommand('console-lens.toggleLogpointEnabled', (id: string) => logpointStore.toggleEnabled(id)),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('console-lens.toggle', () => {
      enabled = !enabled;
      decorator.setEnabled(enabled);
      refreshStatus();
      vscode.window.showInformationMessage(`Console Lens ${enabled ? 'enabled' : 'disabled'}.`);
    }),
    vscode.commands.registerCommand('console-lens.clear', () => {
      client.requestClear(); // clears every window via the broker
      vscode.window.showInformationMessage('Console Lens: inline logs cleared.');
    }),
    vscode.commands.registerCommand('console-lens.toggleCapture', () => {
      paused = !paused;
      refreshStatus();
      vscode.window.setStatusBarMessage(
        `Console Lens: capture ${paused ? 'paused' : 'resumed'}`,
        2000,
      );
      return paused;
    }),
    vscode.commands.registerCommand('console-lens.exportLogs', async () => {
      const events = eventLog.getAll();
      if (events.length === 0) {
        vscode.window.showInformationMessage('Console Lens: nothing to export yet.');
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        filters: { JSON: ['json'], Text: ['log', 'txt'] },
        saveLabel: 'Export Console Lens logs',
      });
      if (!uri) {
        return;
      }
      const isJson = uri.fsPath.endsWith('.json');
      const content = isJson
        ? JSON.stringify(events, null, 2)
        : events
            .map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.kind.toUpperCase()} ${e.file}:${e.line}\n${e.detail}`)
            .join('\n\n');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage(`Console Lens: exported ${events.length} events.`);
    }),
    vscode.commands.registerCommand('console-lens.showPanel', () => {
      LensPanel.show(context, eventLog);
    }),
    vscode.commands.registerCommand('console-lens.copyMcpConfig', async () => {
      const config = {
        mcpServers: {
          'console-lens': {
            command: 'node',
            args: [mcpServerPath],
            env: { CONSOLE_LENS_EVENTS: eventsPath },
          },
        },
      };
      await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
      vscode.window.showInformationMessage(
        'Console Lens: MCP config copied. Paste it into your AI client (Cursor / Claude Code / Windsurf / Cline) MCP settings.',
      );
    }),
    vscode.commands.registerCommand('console-lens.sendToAI', async (prompt: string) => {
      // Try the editor's AI chat (Copilot Chat / compatible). Fall back to clipboard.
      const candidates = [
        ['workbench.action.chat.open', { query: prompt }],
        ['workbench.panel.chat.view.copilot.focus', undefined],
        ['aichat.newchataction', prompt], // Cursor
      ] as const;
      for (const [cmd, arg] of candidates) {
        try {
          await vscode.commands.executeCommand(cmd, arg as never);
          return;
        } catch {
          /* try next */
        }
      }
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage('Console Lens: no AI chat found — context copied to clipboard.');
    }),
    vscode.commands.registerCommand(
      'console-lens.openLocation',
      async (file: string, line: number, column: number) => {
        const target = (await resolveWorkspaceFile(file)) ?? file;
        try {
          const doc = await vscode.workspace.openTextDocument(target);
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch {
          vscode.window.showWarningMessage(`Console Lens: could not open ${file}:${line}`);
        }
      },
    ),
    vscode.commands.registerCommand('console-lens.copyNodeOptions', async () => {
      const value = `NODE_OPTIONS="--require ${loaderPath}" ${PORT_ENV}=${activeTcpPort} ${WS_PORT_ENV}=${activeWsPort}`;
      await vscode.env.clipboard.writeText(value);
      vscode.window.showInformationMessage('Console Lens: NODE_OPTIONS copied. Prefix your run command with it.');
    }),
    vscode.commands.registerCommand('console-lens.injectActiveTerminal', () => {
      const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Console Lens');
      // Works for an ALREADY-open terminal (env-var injection only affects new ones).
      terminal.sendText(
        `export NODE_OPTIONS="--require ${loaderPath}" ${PORT_ENV}=${activeTcpPort} ${WS_PORT_ENV}=${activeWsPort}`,
      );
      terminal.show();
      vscode.window.showInformationMessage(
        'Console Lens: injected into the active terminal. Now run your dev server (e.g. npm run dev).',
      );
    }),
    vscode.commands.registerCommand('console-lens.installShellIntegration', async () => {
      if (process.platform === 'win32') {
        vscode.window.showInformationMessage(
          'Console Lens: shell integration is a POSIX-only feature. On Windows the agent already attaches to VS Code\'s integrated terminals automatically — no setup needed.',
        );
        return;
      }
      await config().update('shellIntegration', true, vscode.ConfigurationTarget.Global);
      const status = writeShellIntegration();
      const { file } = detectShellRc();
      if (status === 'error') {
        vscode.window.showErrorMessage(`Console Lens: could not edit ${path.basename(file)}.`);
      } else {
        vscode.window.showInformationMessage(
          `Console Lens enabled for ALL terminals via ${path.basename(file)}. Open a new terminal to apply.`,
        );
      }
    }),
    vscode.commands.registerCommand('console-lens.cleanup', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Console Lens: remove shell integration and delete ~/.console-lens? Run this before uninstalling.',
        { modal: true },
        'Clean up',
      );
      if (choice !== 'Clean up') {
        return;
      }
      await config().update('shellIntegration', false, vscode.ConfigurationTarget.Global);
      removeShellIntegration();
      try {
        fs.rmSync(STABLE_DIR, { recursive: true, force: true });
      } catch (err) {
        log(`cleanup: could not remove ${STABLE_DIR}: ${(err as Error).message}`);
      }
      vscode.window.showInformationMessage(
        'Console Lens: cleaned up shell integration and cache. You can now disable/uninstall the extension.',
      );
    }),
    vscode.commands.registerCommand('console-lens.uninstallShellIntegration', async () => {
      await config().update('shellIntegration', false, vscode.ConfigurationTarget.Global);
      const status = removeShellIntegration();
      const { file } = detectShellRc();
      vscode.window.showInformationMessage(
        status === 'removed'
          ? `Console Lens shell integration removed from ${path.basename(file)}. Restart your terminals.`
          : 'Console Lens: shell integration was not present.',
      );
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('consoleLens.maxInlineLength')) {
        decorator.setMaxInlineLength(config().get<number>('maxInlineLength', 200));
      }
      if (e.affectsConfiguration('consoleLens.enabled')) {
        enabled = config().get<boolean>('enabled', true);
        decorator.setEnabled(enabled);
        refreshStatus();
      }
      if (e.affectsConfiguration('consoleLens.shellIntegration')) {
        reconcileShellIntegration();
      }
    }),
  );
}

export function deactivate(): void {
  /* subscriptions handle cleanup */
}
