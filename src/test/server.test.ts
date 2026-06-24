import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { LensServer } from '../extension/server';
import type { LogMessage } from '../shared/protocol';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sample(): LogMessage {
  return {
    v: 1,
    type: 'log',
    level: 'log',
    file: '/a.js',
    line: 1,
    column: 1,
    args: ['1'],
    preview: 'hi',
    timestamp: Date.now(),
    runtime: 'node',
    session: 's',
  };
}

test('LensServer receives newline-delimited JSON over TCP, including split frames', async () => {
  const port = await freePort();
  const server = new LensServer(port);
  const received: LogMessage[] = [];
  server.on('log', (m) => received.push(m));

  await new Promise<void>((resolve) => {
    server.on('listening', () => resolve());
    server.start();
  });

  await new Promise<void>((resolve, reject) => {
    const client = net.connect({ port, host: '127.0.0.1' }, () => {
      const payload = JSON.stringify(sample());
      // Two messages, with the boundary split across writes.
      client.write(payload + '\n' + payload.slice(0, 5));
      setTimeout(() => {
        client.write(payload.slice(5) + '\n');
        client.end();
      }, 50);
    });
    client.on('close', () => resolve());
    client.on('error', reject);
  });

  await waitUntil(() => received.length === 2);
  server.stop();

  assert.equal(received.length, 2);
  assert.equal(received[0].preview, 'hi');
});

test('falls back to free ports when the preferred ones are busy (multi-window)', async () => {
  const port = await freePort();
  const first = new LensServer(port, true);
  const second = new LensServer(port, true);

  const firstPorts = await new Promise<{ tcpPort: number; wsPort: number }>((resolve) => {
    first.on('listening', resolve);
    first.start();
  });
  const secondPorts = await new Promise<{ tcpPort: number; wsPort: number }>((resolve) => {
    second.on('listening', resolve);
    second.start();
  });

  // First instance keeps the preferred port; the second gets distinct free ones.
  assert.equal(firstPorts.tcpPort, port);
  assert.notEqual(secondPorts.tcpPort, firstPorts.tcpPort);
  assert.notEqual(secondPorts.wsPort, firstPorts.wsPort);

  first.stop();
  second.stop();
});

test('without fallback, a busy port surfaces an error (CLI viewer)', async () => {
  const port = await freePort();
  const holder = new LensServer(port, false);
  await new Promise<void>((resolve) => {
    holder.on('listening', () => resolve());
    holder.start();
  });

  const blocked = new LensServer(port, false);
  const err = await new Promise<Error>((resolve) => {
    blocked.on('error', resolve);
    blocked.start();
  });
  assert.match(err.message, /EADDRINUSE/);

  holder.stop();
  blocked.stop();
});

test('LensServer ignores malformed payloads', async () => {
  const port = await freePort();
  const server = new LensServer(port);
  const received: LogMessage[] = [];
  server.on('log', (m) => received.push(m));
  await new Promise<void>((resolve) => {
    server.on('listening', () => resolve());
    server.start();
  });

  await new Promise<void>((resolve) => {
    const client = net.connect({ port, host: '127.0.0.1' }, () => {
      client.write('not json\n');
      client.write('{"type":"other"}\n');
      client.write('\n');
      client.end();
    });
    client.on('close', () => resolve());
  });

  await new Promise((r) => setTimeout(r, 50));
  server.stop();
  assert.equal(received.length, 0);
});
