/**
 * Console Lens broker — a single, shared, long-lived process that decouples the
 * capture backend from any individual editor window.
 *
 * Why: previously every editor window ran its own server and fought over the
 * preferred port. The first window won it; the rest fell back to ephemeral
 * ports. An agent (which targets one fixed port) therefore reached only one
 * window — usually not the one you were looking at. Open two windows, or run
 * your app in a different editor, and logs vanished.
 *
 * How it works now:
 * - The broker owns the fixed ports: TCP `port` (Node agents), WS `port + 1`
 *   (browsers), and `port + 2` (the subscriber channel for editor windows).
 * - The FIRST editor to start wins the port and runs the broker; the rest
 *   detect it and connect as subscribers instead of starting their own server.
 * - Every event the broker receives is fanned out to ALL subscribers, so every
 *   window shows the logs regardless of which terminal/editor produced them.
 * - The broker is the single writer of `events.json` (for the MCP server),
 *   ending the concurrent-write races between windows.
 * - It exits shortly after the last subscriber disconnects, so closing every
 *   editor cleans up while a quick window reload survives.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LensServer } from '../extension/server';
import { EventLog } from '../extension/events';
import { wsPortFor } from '../shared/protocol';
import type { ErrorMessage, LogMessage, NetworkMessage } from '../shared/protocol';
import { subPortFor, type BrokerEnvelope, type SnapshotItem } from '../shared/broker-protocol';

export interface BrokerOptions {
  tcpPort: number;
  /** Where to persist the event log for the MCP server (optional). */
  eventsPath?: string;
  /** Exit this many ms after the last subscriber leaves (0 = never). Default 10s. */
  idleExitMs?: number;
  /** Called when the broker decides to exit while idle (defaults to process.exit). */
  onExit?: () => void;
  log?: (m: string) => void;
}

/** Cap on replayed history sent to a freshly-connected window. */
const MAX_RAW = 5000;

export class Broker {
  readonly tcpPort: number;
  readonly wsPort: number;
  readonly subPort: number;

  private readonly server: LensServer;
  private subServer: net.Server | null = null;
  private readonly subscribers = new Set<net.Socket>();
  private raw: SnapshotItem[] = [];
  private readonly eventLog = new EventLog();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: BrokerOptions) {
    this.tcpPort = opts.tcpPort;
    this.wsPort = wsPortFor(opts.tcpPort);
    this.subPort = subPortFor(opts.tcpPort);
    this.server = new LensServer(opts.tcpPort, false);
    if (opts.eventsPath) {
      this.eventLog.onEvent(() => this.scheduleWrite());
      this.eventLog.onClear(() => this.writeEvents('[]'));
    }
  }

  private log(m: string): void {
    this.opts.log?.(m);
  }

  /** Bind the agent/browser ports and the subscriber channel. Rejects (so the
   * caller can step aside) if another broker already owns the port. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.on('log', (m: LogMessage) => this.ingest({ type: 'log', m }));
      this.server.on('errorLog', (m: ErrorMessage) => this.ingest({ type: 'error', m }));
      this.server.on('network', (m: NetworkMessage) => this.ingest({ type: 'network', m }));
      this.server.on('newRun', () => this.onNewRun());
      this.server.on('listening', () => this.startSubServer().then(resolve, reject));
      this.server.start();
    });
  }

  private ingest(item: SnapshotItem): void {
    this.raw.push(item);
    if (this.raw.length > MAX_RAW) {
      this.raw.splice(0, this.raw.length - MAX_RAW);
    }
    if (item.type === 'log') {
      this.eventLog.addLog(item.m);
    } else if (item.type === 'error') {
      this.eventLog.addError(item.m);
    } else {
      this.eventLog.addNetwork(item.m);
    }
    this.broadcast({ t: item.type, m: item.m } as BrokerEnvelope);
  }

  /** A fresh run connected (0 → 1 agent connections): drop stale events. */
  private onNewRun(): void {
    this.raw = [];
    this.eventLog.clear();
    this.broadcast({ t: 'newRun' });
    this.log('new run detected — cleared previous events');
  }

  /** A window asked to clear: wipe history and tell every window. */
  private clearAll(): void {
    this.raw = [];
    this.eventLog.clear();
    this.broadcast({ t: 'clear' });
  }

  private startSubServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((socket) => this.onSubscriber(socket));
      srv.once('error', reject);
      srv.listen(this.subPort, '127.0.0.1', () => {
        srv.removeListener('error', reject);
        srv.on('error', (e) => this.log(`subscriber server error: ${(e as Error).message}`));
        this.subServer = srv;
        this.log(`broker listening — tcp ${this.tcpPort} · ws ${this.wsPort} · sub ${this.subPort}`);
        this.scheduleIdleExit(); // exit if no window ever connects
        resolve();
      });
    });
  }

  private onSubscriber(socket: net.Socket): void {
    socket.setEncoding('utf8');
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    // Add + snapshot synchronously so no live message can interleave (and thus
    // be either missed or duplicated).
    this.subscribers.add(socket);
    this.write(socket, { t: 'hello', tcpPort: this.tcpPort, wsPort: this.wsPort, pid: process.pid });
    this.write(socket, { t: 'snapshot', items: this.raw });
    this.log(`window subscribed (${this.subscribers.size} watching)`);

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.onSubscriberMessage(line);
      }
    });
    const drop = (): void => {
      this.subscribers.delete(socket);
      this.log(`window unsubscribed (${this.subscribers.size} watching)`);
      if (this.subscribers.size === 0) {
        this.scheduleIdleExit();
      }
    };
    socket.on('close', drop);
    socket.on('error', () => {
      /* a window going away is normal */
    });
  }

  private onSubscriberMessage(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const env = JSON.parse(trimmed);
      if (env && env.t === 'clear') {
        this.clearAll();
      }
    } catch {
      /* ignore */
    }
  }

  private broadcast(env: BrokerEnvelope): void {
    for (const socket of this.subscribers) {
      this.write(socket, env);
    }
  }

  private write(socket: net.Socket, env: BrokerEnvelope): void {
    try {
      socket.write(JSON.stringify(env) + '\n');
    } catch {
      /* ignore */
    }
  }

  private scheduleIdleExit(): void {
    const ms = this.opts.idleExitMs ?? 10_000;
    if (ms <= 0) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.subscribers.size === 0) {
        this.log('no windows watching — exiting');
        this.stop();
        (this.opts.onExit ?? (() => process.exit(0)))();
      }
    }, ms);
    this.idleTimer.unref?.();
  }

  private scheduleWrite(): void {
    if (this.writeTimer || !this.opts.eventsPath) {
      return;
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.writeEvents(JSON.stringify(this.eventLog.getAll()));
    }, 300);
    this.writeTimer.unref?.();
  }

  private writeEvents(content: string): void {
    const file = this.opts.eventsPath;
    if (!file) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    } catch {
      /* ignore */
    }
  }

  stop(): void {
    this.server.stop();
    this.subServer?.close();
    this.subServer = null;
    for (const socket of this.subscribers) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.subscribers.clear();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
  }
}

function parseArgs(argv: string[]): { port: number; events?: string } {
  let port = 9111;
  let events: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      port = Number(argv[++i]) || port;
    } else if (argv[i] === '--events') {
      events = argv[++i];
    }
  }
  return { port, events };
}

// Run as a standalone process (spawned detached by the extension / CLI viewer).
if (require.main === module) {
  const { port, events } = parseArgs(process.argv.slice(2));
  const broker = new Broker({ tcpPort: port, eventsPath: events });
  // Losing the race for the port simply means another broker already runs — the
  // window that spawned us will connect to it instead.
  broker.start().catch(() => process.exit(0));
  const bye = (): void => {
    broker.stop();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
