/**
 * Client for the broker's subscriber channel, used by every editor window and
 * the CLI viewer.
 *
 * Connect logic ("detect and reuse"):
 * - Try to connect to the broker on `port + 2`.
 * - If a broker is already running (another window started it), we just attach
 *   and receive the shared event stream — no second server, no port fight.
 * - If nobody answers, spawn the broker (detached) and keep retrying until it
 *   comes up. Concurrent windows may each spawn one; only the first binds the
 *   port, the rest exit immediately, and everyone attaches to the survivor.
 *
 * The client re-emits the broker's events as `log` / `errorLog` / `network` /
 * `newRun` / `clear`, matching what the extension previously consumed straight
 * from `LensServer`, so the rest of the UI code is unchanged.
 */
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { subPortFor, isBrokerEnvelope, type BrokerEnvelope } from '../shared/broker-protocol';

export interface BrokerClientOptions {
  /** The agent TCP port; the subscriber channel is `tcpPort + 2`. */
  tcpPort: number;
  /** Spawn a broker process when none is reachable. */
  spawnBroker?: () => void;
  log?: (m: string) => void;
}

const RECONNECT_MS = 400;
/** Don't spawn a broker more than once per this window (avoids spawn storms). */
const SPAWN_DEBOUNCE_MS = 2_000;
/** After this many failed spawn attempts, surface that the port is unreachable. */
const UNREACHABLE_AFTER = 3;

export class BrokerClient extends EventEmitter {
  private readonly subPort: number;
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private buffer = '';
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSpawn = 0;
  private spawnCount = 0;
  private warnedUnreachable = false;

  constructor(private readonly opts: BrokerClientOptions) {
    super();
    this.subPort = subPortFor(opts.tcpPort);
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed || this.connected || this.socket) {
      return;
    }
    const socket = net.connect({ port: this.subPort, host: '127.0.0.1' });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.connected = true;
      this.spawnCount = 0;
      this.warnedUnreachable = false;
      this.opts.log?.('connected to broker');
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', () => {
      /* handled by the 'close' that follows */
    });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      this.buffer = '';
      if (this.closed) {
        return;
      }
      if (wasConnected) {
        this.emit('disconnected');
      } else {
        this.ensureBroker(); // nobody answered — bring one up
      }
      this.scheduleReconnect();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let env: unknown;
      try {
        env = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isBrokerEnvelope(env)) {
        this.dispatch(env);
      }
    }
  }

  private dispatch(env: BrokerEnvelope): void {
    switch (env.t) {
      case 'hello':
        this.emit('connected', { tcpPort: env.tcpPort, wsPort: env.wsPort });
        break;
      case 'log':
        this.emit('log', env.m);
        break;
      case 'error':
        this.emit('errorLog', env.m);
        break;
      case 'network':
        this.emit('network', env.m);
        break;
      case 'newRun':
        this.emit('newRun');
        break;
      case 'clear':
        this.emit('clear');
        break;
      case 'snapshot':
        for (const item of env.items) {
          if (item.type === 'log') {
            this.emit('log', item.m);
          } else if (item.type === 'error') {
            this.emit('errorLog', item.m);
          } else {
            this.emit('network', item.m);
          }
        }
        this.emit('snapshot');
        break;
    }
  }

  private ensureBroker(): void {
    const now = Date.now();
    if (now - this.lastSpawn < SPAWN_DEBOUNCE_MS) {
      return;
    }
    this.lastSpawn = now;
    this.spawnCount += 1;
    try {
      this.opts.spawnBroker?.();
      this.opts.log?.('spawned broker');
    } catch (err) {
      this.opts.log?.(`failed to spawn broker: ${(err as Error).message}`);
    }
    if (this.spawnCount >= UNREACHABLE_AFTER && !this.warnedUnreachable) {
      this.warnedUnreachable = true;
      this.emit('unreachable', this.subPort - 2);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer) {
      return;
    }
    // NOT unref'd on purpose: the consumers (CLI viewer, extension host) are
    // long-lived and want to keep retrying. The standalone viewer would exit
    // mid-reconnect if this timer didn't hold the event loop open. (The agent's
    // own transport keeps its unref'd retry — different concern.)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, RECONNECT_MS);
  }

  /** Ask the broker to clear every window. Falls back to a local clear offline. */
  requestClear(): void {
    if (this.socket && this.connected) {
      try {
        this.socket.write(JSON.stringify({ t: 'clear' }) + '\n');
        return;
      } catch {
        /* fall through to local */
      }
    }
    this.emit('clear');
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export function connectToBroker(opts: BrokerClientOptions): BrokerClient {
  const client = new BrokerClient(opts);
  client.start();
  return client;
}
