import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  isErrorMessage,
  isLogMessage,
  isNetworkMessage,
  wsPortFor,
  type ErrorMessage,
  type LogMessage,
  type NetworkMessage,
} from '../shared/protocol';

export interface LensServerEvents {
  log: (message: LogMessage) => void;
  errorLog: (message: ErrorMessage) => void;
  network: (message: NetworkMessage) => void;
  /** Emitted when a fresh run connects (no clients -> first client). */
  newRun: () => void;
  error: (error: Error) => void;
  listening: (info: { tcpPort: number; wsPort: number }) => void;
}

/**
 * Receives log messages from runtime agents.
 * - TCP (newline-delimited JSON) for Node processes.
 * - WebSocket for browser-injected clients.
 *
 * Both feed a single `log` event. Decoupled from VS Code so it can also power
 * the standalone CLI viewer and be tested headlessly.
 *
 * When `allowFallback` is true (used by the editor extension), a busy preferred
 * port falls back to an OS-assigned free port instead of erroring — so multiple
 * editor windows can run side by side. The CLI viewer keeps `allowFallback`
 * false because the agent targets its fixed, predictable port.
 */
export class LensServer extends EventEmitter {
  private tcpServer: net.Server | null = null;
  private wss: WebSocketServer | null = null;
  private connections = 0;

  /** Track a connection; a transition from 0 -> 1 means a new run started. */
  private onConnectionOpen(): void {
    if (this.connections === 0) {
      this.emit('newRun');
    }
    this.connections += 1;
  }

  private onConnectionClose(): void {
    this.connections = Math.max(0, this.connections - 1);
  }

  constructor(
    private readonly preferredTcpPort: number,
    private readonly allowFallback = false,
  ) {
    super();
  }

  async start(): Promise<void> {
    try {
      const tcpPort = await this.startTcp(this.preferredTcpPort);
      const wsPort = await this.startWs(wsPortFor(this.preferredTcpPort));
      this.emit('listening', { tcpPort, wsPort });
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  private handlePayload(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (isLogMessage(parsed)) {
      this.emit('log', parsed);
    } else if (isErrorMessage(parsed)) {
      this.emit('errorLog', parsed);
    } else if (isNetworkMessage(parsed)) {
      this.emit('network', parsed);
    }
  }

  private startTcp(preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.onConnectionOpen();
        socket.on('close', () => this.onConnectionClose());
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            this.handlePayload(line);
          }
        });
        socket.on('error', () => {
          /* client disconnects are normal */
        });
      });
      this.tcpServer = server;

      // Prefer the configured port (shell integration & external terminals target
      // it). On a reload the previous host may not have released it yet, so retry
      // a few times before falling back to an ephemeral port.
      let retries = 0;
      const MAX_RETRIES = this.allowFallback ? 5 : 0;
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && this.allowFallback) {
          if (retries < MAX_RETRIES) {
            retries += 1;
            setTimeout(() => server.listen(preferred, '127.0.0.1'), 400);
          } else {
            server.listen(0, '127.0.0.1');
          }
          return;
        }
        reject(err);
      };
      server.on('error', onError);
      server.listen(preferred, '127.0.0.1', () => {
        server.removeListener('error', onError);
        server.on('error', (err) => this.emit('error', err));
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private startWs(preferred: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let retries = 0;
      const MAX_RETRIES = this.allowFallback ? 5 : 0;
      const tryListen = (port: number): void => {
        const wss = new WebSocketServer({ port, host: '127.0.0.1' });
        wss.on('connection', (ws: WebSocket) => {
          this.onConnectionOpen();
          ws.on('close', () => this.onConnectionClose());
          ws.on('message', (data) => this.handlePayload(data.toString()));
          ws.on('error', () => {
            /* ignore */
          });
        });
        wss.once('listening', () => {
          this.wss = wss;
          wss.on('error', (err) => this.emit('error', err));
          resolve((wss.address() as AddressInfo).port);
        });
        wss.once('error', (err: NodeJS.ErrnoException) => {
          try {
            wss.close();
          } catch {
            /* ignore */
          }
          if (err.code === 'EADDRINUSE' && this.allowFallback) {
            if (retries < MAX_RETRIES) {
              retries += 1;
              setTimeout(() => tryListen(preferred), 400);
            } else {
              tryListen(0);
            }
            return;
          }
          reject(err);
        });
      };
      tryListen(preferred);
    });
  }

  stop(): void {
    this.tcpServer?.close();
    this.tcpServer = null;
    this.wss?.close();
    this.wss = null;
  }
}
