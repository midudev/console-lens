import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Logpoint {
  id: string;
  /** Absolute editor file path. */
  file: string;
  /** 1-based line. */
  line: number;
  expression: string;
  enabled: boolean;
}

const norm = (p: string) => path.normalize(p).replace(/\\/g, '/');

/**
 * Stores logpoints (in workspace memento + a JSON file the agent reads), and
 * notifies listeners on change so CodeLens/gutter can refresh.
 */
export class LogpointStore {
  private points: Logpoint[];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly filePath: string, private readonly memento: vscode.Memento) {
    this.points = memento.get<Logpoint[]>('logpoints', []);
    this.persist();
  }

  all(): Logpoint[] {
    return this.points;
  }

  forFile(fsPath: string): Logpoint[] {
    const n = norm(fsPath);
    return this.points.filter((p) => norm(p.file) === n);
  }

  findAt(fsPath: string, line: number): Logpoint | undefined {
    const n = norm(fsPath);
    return this.points.find((p) => norm(p.file) === n && p.line === line);
  }

  get(id: string): Logpoint | undefined {
    return this.points.find((p) => p.id === id);
  }

  add(file: string, line: number, expression: string): void {
    this.points.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, file, line, expression, enabled: true });
    this.changed();
  }

  update(id: string, expression: string): void {
    const lp = this.get(id);
    if (lp) {
      lp.expression = expression;
      this.changed();
    }
  }

  remove(id: string): void {
    this.points = this.points.filter((p) => p.id !== id);
    this.changed();
  }

  toggleEnabled(id: string): void {
    const lp = this.get(id);
    if (lp) {
      lp.enabled = !lp.enabled;
      this.changed();
    }
  }

  private changed(): void {
    void this.memento.update('logpoints', this.points);
    this.persist();
    this.emitter.fire();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.points));
    } catch {
      /* ignore */
    }
  }
}

/** CodeLens above each logpoint line: shows the expression + edit/toggle/remove. */
export class LogpointCodeLensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  constructor(private readonly store: LogpointStore) {
    this.onDidChangeCodeLenses = store.onDidChange;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const lp of this.store.forFile(document.uri.fsPath)) {
      if (lp.line < 1 || lp.line > document.lineCount) {
        continue;
      }
      const range = new vscode.Range(lp.line - 1, 0, lp.line - 1, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(eye) logpoint: ${lp.enabled ? '' : '(off) '}${lp.expression}`,
          command: 'console-lens.editLogpoint',
          arguments: [lp.id],
        }),
        new vscode.CodeLens(range, {
          title: lp.enabled ? '$(circle-slash) disable' : '$(play) enable',
          command: 'console-lens.toggleLogpointEnabled',
          arguments: [lp.id],
        }),
        new vscode.CodeLens(range, {
          title: '$(trash) remove',
          command: 'console-lens.removeLogpoint',
          arguments: [lp.id],
        }),
      );
    }
    return lenses;
  }
}
