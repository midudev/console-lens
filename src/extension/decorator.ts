import * as vscode from 'vscode';
import { DecorationStore, type ErrorEntry, type LineEdit, type LineEntry, type NetworkEntry } from '../shared/decorations';
import { LEVEL_COLORS, inlineText } from '../shared/formatter';
import type { ErrorMessage, LogLevel, LogMessage, NetworkMessage, StackFrame } from '../shared/protocol';

const ERROR_COLOR = '#e05561';
const NET_OK_COLOR = '#4a9eff';
const NET_ERR_COLOR = '#e05561';
const LOGPOINT_COLOR = '#4ade80';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Bridges the pure `DecorationStore` to VS Code editor decorations, including
 * detailed hovers (execution history with timestamps, error stacks) and a
 * "send to AI" action.
 */
export class Decorator {
  private readonly store = new DecorationStore();
  private readonly logTypes = new Map<LogLevel, vscode.TextEditorDecorationType>();
  private readonly errorType: vscode.TextEditorDecorationType;
  private readonly netOkType: vscode.TextEditorDecorationType;
  private readonly netErrType: vscode.TextEditorDecorationType;
  private readonly logpointType: vscode.TextEditorDecorationType;
  private enabled = true;
  private maxInlineLength: number;

  constructor(maxInlineLength: number) {
    this.maxInlineLength = maxInlineLength;
    for (const [level, color] of Object.entries(LEVEL_COLORS)) {
      this.logTypes.set(
        level as LogLevel,
        vscode.window.createTextEditorDecorationType({
          after: { margin: '0 0 0 2em', color, fontStyle: 'italic' },
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      );
    }
    this.errorType = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 2em', color: ERROR_COLOR, fontStyle: 'italic' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.netOkType = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 2em', color: NET_OK_COLOR, fontStyle: 'italic' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.netErrType = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 2em', color: NET_ERR_COLOR, fontStyle: 'italic' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.logpointType = vscode.window.createTextEditorDecorationType({
      after: { margin: '0 0 0 2em', color: LOGPOINT_COLOR, fontStyle: 'italic', fontWeight: 'bold' },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearEditors();
    } else {
      this.renderAll();
    }
  }

  setMaxInlineLength(value: number): void {
    this.maxInlineLength = value;
    this.renderAll();
  }

  onMessage(message: LogMessage): void {
    this.store.add(message);
    if (this.enabled) {
      this.renderMatching();
    }
  }

  onError(message: ErrorMessage): void {
    this.store.addError(message);
    if (this.enabled) {
      this.renderMatching();
    }
  }

  onNetwork(message: NetworkMessage): void {
    this.store.addNetwork(message);
    if (this.enabled) {
      this.renderMatching();
    }
  }

  clear(): void {
    this.store.clear();
    this.clearEditors();
  }

  /**
   * React to edits in a document: drop the (now stale) inline values on edited
   * lines and shift the rest. Returns true if anything changed.
   */
  applyEdit(fsPath: string, edits: LineEdit[]): boolean {
    return this.store.applyEdit(fsPath, edits);
  }

  private renderMatching(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderEditor(editor);
    }
  }

  renderEditor(editor: vscode.TextEditor): void {
    if (!this.enabled) {
      return;
    }
    const { logs, errors, network } = this.store.getForEditorPath(editor.document.uri.fsPath);
    this.applyLogs(editor, logs);
    this.applyErrors(editor, errors);
    this.applyNetwork(editor, network);
  }

  renderAll(): void {
    if (!this.enabled) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.renderEditor(editor);
    }
  }

  private applyLogs(editor: vscode.TextEditor, entries: LineEntry[]): void {
    const byLevel = new Map<LogLevel, vscode.DecorationOptions[]>();
    for (const level of this.logTypes.keys()) {
      byLevel.set(level, []);
    }
    const logpointDecos: vscode.DecorationOptions[] = [];
    const lineCount = editor.document.lineCount;
    for (const entry of entries) {
      const lineIndex = entry.line - 1;
      if (lineIndex < 0 || lineIndex >= lineCount) {
        continue;
      }
      const range = editor.document.lineAt(lineIndex).range;
      if (entry.logpoint) {
        const counter = entry.count > 1 ? ` ×${entry.count}` : '';
        const label = this.truncate(`👁 ${entry.expression ?? ''} = ${entry.preview}${counter}`);
        logpointDecos.push({
          range,
          renderOptions: { after: { contentText: `  ${label}` } },
          hoverMessage: this.buildLogHover(entry),
        });
        continue;
      }
      const text = this.truncate(inlineText(entry.level, entry.preview, entry.count));
      byLevel.get(entry.level)?.push({
        range,
        renderOptions: { after: { contentText: `  ${text}` } },
        hoverMessage: this.buildLogHover(entry),
      });
    }
    for (const [level, type] of this.logTypes) {
      editor.setDecorations(type, byLevel.get(level) ?? []);
    }
    editor.setDecorations(this.logpointType, logpointDecos);
  }

  private applyErrors(editor: vscode.TextEditor, entries: ErrorEntry[]): void {
    const lineCount = editor.document.lineCount;
    const decorations: vscode.DecorationOptions[] = [];
    for (const entry of entries) {
      const lineIndex = entry.line - 1;
      if (lineIndex < 0 || lineIndex >= lineCount) {
        continue;
      }
      const label = this.truncate(`✖ ${entry.name}: ${entry.message}${entry.count > 1 ? ` ×${entry.count}` : ''}`);
      decorations.push({
        range: editor.document.lineAt(lineIndex).range,
        renderOptions: { after: { contentText: `  ${label}` } },
        hoverMessage: this.buildErrorHover(entry),
      });
    }
    editor.setDecorations(this.errorType, decorations);
  }

  private applyNetwork(editor: vscode.TextEditor, entries: NetworkEntry[]): void {
    const lineCount = editor.document.lineCount;
    const okDecos: vscode.DecorationOptions[] = [];
    const errDecos: vscode.DecorationOptions[] = [];
    for (const entry of entries) {
      const lineIndex = entry.line - 1;
      if (lineIndex < 0 || lineIndex >= lineCount) {
        continue;
      }
      const statusText = entry.status === 0 ? 'ERR' : String(entry.status);
      const label = this.truncate(
        `⇆ ${statusText} ${entry.method} ${entry.url}${entry.count > 1 ? ` ×${entry.count}` : ''}`,
      );
      const deco: vscode.DecorationOptions = {
        range: editor.document.lineAt(lineIndex).range,
        renderOptions: { after: { contentText: `  ${label}` } },
        hoverMessage: this.buildNetworkHover(entry),
      };
      (entry.ok ? okDecos : errDecos).push(deco);
    }
    editor.setDecorations(this.netOkType, okDecos);
    editor.setDecorations(this.netErrType, errDecos);
  }

  private buildNetworkHover(entry: NetworkEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    const statusText = entry.status === 0 ? 'failed' : String(entry.status);
    md.appendMarkdown(
      `**${entry.method}** ${entry.url}\n\nstatus: \`${statusText}\` · ${entry.durationMs}ms ${this.copilotLink(this.networkToPrompt(entry))}\n\n`,
    );
    if (entry.error) {
      md.appendMarkdown(`error: \`${entry.error}\`\n\n`);
    }
    if (entry.requestBody) {
      md.appendMarkdown(`**Request**\n`);
      md.appendCodeblock(entry.requestBody, 'json');
    }
    if (entry.responseBody) {
      md.appendMarkdown(`**Response**\n`);
      md.appendCodeblock(entry.responseBody, 'json');
    }
    return md;
  }

  private networkToPrompt(entry: NetworkEntry): string {
    return [
      `A ${entry.method} request to ${entry.url} returned ${entry.status} in ${entry.durationMs}ms.`,
      entry.requestBody ? `Request body:\n${entry.requestBody}` : '',
      entry.responseBody ? `Response body:\n${entry.responseBody}` : '',
      entry.error ? `Error: ${entry.error}` : '',
      'Help me understand or fix it.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildLogHover(entry: LineEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    const recent = [...entry.history].reverse().slice(0, 20);
    md.appendMarkdown(
      `**console.${entry.level}** · executed ${entry.count}× ${this.copilotLink(this.logToPrompt(entry))}\n\n`,
    );
    for (const rec of recent) {
      md.appendMarkdown(`\`${formatTime(rec.timestamp)}\`\n`);
      md.appendCodeblock(rec.args.join(' '), 'text');
    }
    if (entry.history.length > recent.length) {
      md.appendMarkdown(`\n_…and ${entry.history.length - recent.length} earlier_`);
    }
    return md;
  }

  private buildErrorHover(entry: ErrorEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(
      `$(error) **${entry.name}: ${entry.message}** ${this.copilotLink(this.errorToPrompt(entry))}\n\n`,
    );
    for (const frame of entry.frames) {
      const fn = frame.function ? `**${frame.function}** @ ` : '';
      const loc = `${frame.file}:${frame.line}:${frame.column}`;
      const link = `[${loc}](${this.openFileCommand(frame)})`;
      md.appendMarkdown(`- ${fn}${link}\n`);
      const src = this.readSourceLine(frame);
      if (src) {
        md.appendMarkdown(`\n  \`${src}\`\n`);
      }
    }
    return md;
  }

  /** A markdown command link rendered with the Copilot icon. */
  private copilotLink(prompt: string): string {
    const arg = encodeURIComponent(JSON.stringify([prompt]));
    return `[$(copilot) Ask AI](command:console-lens.sendToAI?${arg} "Send to your AI agent")`;
  }

  private openFileCommand(frame: StackFrame): string {
    const arg = encodeURIComponent(JSON.stringify([frame.file, frame.line, frame.column]));
    return `command:console-lens.openLocation?${arg}`;
  }

  private readSourceLine(frame: StackFrame): string | undefined {
    try {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === frame.file);
      if (doc && frame.line >= 1 && frame.line <= doc.lineCount) {
        return doc.lineAt(frame.line - 1).text.trim();
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  private logToPrompt(entry: LineEntry): string {
    return [
      `Here is a console.${entry.level} from my running app (executed ${entry.count}×):`,
      '```',
      entry.history[entry.history.length - 1]?.args.join(' ') ?? entry.preview,
      '```',
      'Help me understand or fix it.',
    ].join('\n');
  }

  private errorToPrompt(entry: ErrorEntry): string {
    const frames = entry.frames.map((f) => `  at ${f.function ?? '<anonymous>'} (${f.file}:${f.line}:${f.column})`);
    return [
      `My running app threw an error:`,
      '```',
      `${entry.name}: ${entry.message}`,
      ...frames,
      '```',
      'Find the root cause and fix it.',
    ].join('\n');
  }

  private truncate(text: string): string {
    if (text.length <= this.maxInlineLength) {
      return text;
    }
    return text.slice(0, Math.max(0, this.maxInlineLength - 1)) + '…';
  }

  private clearEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      for (const type of this.logTypes.values()) {
        editor.setDecorations(type, []);
      }
      editor.setDecorations(this.errorType, []);
      editor.setDecorations(this.netOkType, []);
      editor.setDecorations(this.netErrType, []);
      editor.setDecorations(this.logpointType, []);
    }
  }

  dispose(): void {
    for (const type of this.logTypes.values()) {
      type.dispose();
    }
    this.errorType.dispose();
    this.netOkType.dispose();
    this.netErrType.dispose();
    this.logpointType.dispose();
    this.logTypes.clear();
  }
}
