import * as net from 'node:net';

export interface Transport {
  send(payload: unknown): void;
  close(): void;
}

const MAX_QUEUE = 1000;
const MAX_ATTEMPTS = 10;
const RECONNECT_MS = 500;

/**
 * Fire-and-forget TCP transport for the runtime agent.
 *
 * Design goals:
 * - Never throw into the host application.
 * - Never keep the process alive: the socket and timers are `unref`'d, so a
 *   short-lived script still exits normally even if the editor isn't listening.
 * - Buffer messages until connected, then flush; drop silently if it never
 *   connects (capped queue).
 */
export function createTcpTransport(port: number, host = '127.0.0.1'): Transport {
  let socket: net.Socket | null = null;
  let connected = false;
  let connecting = false;
  let attempts = 0;
  let closed = false;
  const queue: string[] = [];

  function flush(): void {
    if (!socket || !connected) {
      return;
    }
    while (queue.length > 0) {
      socket.write(queue.shift() as string);
    }
  }

  function scheduleReconnect(): void {
    if (closed || attempts >= MAX_ATTEMPTS) {
      return;
    }
    const timer = setTimeout(connect, RECONNECT_MS);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function connect(): void {
    if (closed || connecting || connected) {
      return;
    }
    connecting = true;
    attempts += 1;
    const s = net.connect({ port, host });
    if (typeof s.unref === 'function') {
      s.unref();
    }
    s.on('connect', () => {
      connected = true;
      connecting = false;
      socket = s;
      flush();
    });
    s.on('error', () => {
      connecting = false;
      connected = false;
      socket = null;
      scheduleReconnect();
    });
    s.on('close', () => {
      connected = false;
      socket = null;
      if (!closed) {
        scheduleReconnect();
      }
    });
  }

  const transport: Transport = {
    send(payload: unknown): void {
      if (closed) {
        return;
      }
      try {
        const line = JSON.stringify(payload) + '\n';
        if (connected && socket) {
          socket.write(line);
        } else {
          if (queue.length < MAX_QUEUE) {
            queue.push(line);
          }
          connect();
        }
      } catch {
        // swallow: telemetry must never break the host app
      }
    },
    close(): void {
      closed = true;
      try {
        socket?.end();
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };

  // Connect eagerly so the socket is ready before the first message — important
  // for crashing processes, where there's no time to establish a connection
  // after an uncaught error fires.
  connect();

  return transport;
}
