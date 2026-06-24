import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { Broker } from '../broker/broker';
import { BrokerClient } from '../broker/client';
import type { LogMessage as Log } from '../shared/protocol';

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

function sampleLog(preview: string): Log {
  return {
    v: 1,
    type: 'log',
    level: 'log',
    file: '/app.js',
    line: 7,
    column: 1,
    args: [preview],
    preview,
    timestamp: Date.now(),
    runtime: 'node',
    session: 's1',
  };
}

/** Connect a fake agent to the broker's TCP port and send newline-JSON. */
function connectAgent(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
    s.on('error', reject);
  });
}

function makeClient(tcpPort: number): BrokerClient {
  // Broker is already up in every test, so spawnBroker should never run.
  const client = new BrokerClient({ tcpPort, spawnBroker: () => assert.fail('should not spawn') });
  client.start();
  return client;
}

test('fans out a log to every subscribed window', async () => {
  const port = await freePort();
  const broker = new Broker({ tcpPort: port, idleExitMs: 0 });
  await broker.start();

  const a = makeClient(port);
  const b = makeClient(port);
  await Promise.all([once(a, 'connected'), once(b, 'connected')]);

  const gotA = once(a, 'log');
  const gotB = once(b, 'log');
  const agent = await connectAgent(port);
  agent.write(JSON.stringify(sampleLog('hello')) + '\n');

  const [[msgA], [msgB]] = await Promise.all([gotA, gotB]);
  assert.equal((msgA as Log).preview, 'hello');
  assert.equal((msgB as Log).preview, 'hello');

  agent.end();
  a.close();
  b.close();
  broker.stop();
});

test('replays history to a window that connects late (snapshot)', async () => {
  const port = await freePort();
  const broker = new Broker({ tcpPort: port, idleExitMs: 0 });
  await broker.start();

  const early = makeClient(port);
  await once(early, 'connected');
  const agent = await connectAgent(port);
  agent.write(JSON.stringify(sampleLog('backlog')) + '\n');
  await once(early, 'log'); // ensure the broker processed it

  const late = makeClient(port);
  const [msg] = await once(late, 'log'); // delivered via snapshot
  assert.equal((msg as Log).preview, 'backlog');

  agent.end();
  early.close();
  late.close();
  broker.stop();
});

test('a Clear from one window clears every window', async () => {
  const port = await freePort();
  const broker = new Broker({ tcpPort: port, idleExitMs: 0 });
  await broker.start();

  const a = makeClient(port);
  const b = makeClient(port);
  await Promise.all([once(a, 'connected'), once(b, 'connected')]);

  const agent = await connectAgent(port);
  agent.write(JSON.stringify(sampleLog('x')) + '\n');
  await Promise.all([once(a, 'log'), once(b, 'log')]);

  const clearedA = once(a, 'clear');
  const clearedB = once(b, 'clear');
  a.requestClear();
  await Promise.all([clearedA, clearedB]);

  // A window connecting now gets an empty snapshot (no replayed logs).
  const late = makeClient(port);
  const snap = once(late, 'snapshot');
  let replayed = 0;
  late.on('log', () => (replayed += 1));
  await snap;
  assert.equal(replayed, 0);

  agent.end();
  a.close();
  b.close();
  late.close();
  broker.stop();
});

test('a fresh agent run triggers newRun for subscribers', async () => {
  const port = await freePort();
  const broker = new Broker({ tcpPort: port, idleExitMs: 0 });
  await broker.start();

  const a = makeClient(port);
  await once(a, 'connected');

  const newRun = once(a, 'newRun');
  const agent = await connectAgent(port); // 0 -> 1 agent connections
  await newRun;

  agent.end();
  a.close();
  broker.stop();
});

test('a second broker on the same port steps aside', async () => {
  const port = await freePort();
  const first = new Broker({ tcpPort: port, idleExitMs: 0 });
  await first.start();

  const second = new Broker({ tcpPort: port, idleExitMs: 0 });
  await assert.rejects(() => second.start(), /EADDRINUSE/);

  first.stop();
});

test('writes events.json for the MCP server', async () => {
  const port = await freePort();
  const eventsPath = path.join(os.tmpdir(), `cl-events-${process.pid}-${port}.json`);
  try {
    fs.rmSync(eventsPath, { force: true });
  } catch {
    /* ignore */
  }
  const broker = new Broker({ tcpPort: port, idleExitMs: 0, eventsPath });
  await broker.start();

  const a = makeClient(port);
  await once(a, 'connected');
  const agent = await connectAgent(port);
  agent.write(JSON.stringify(sampleLog('persist-me')) + '\n');

  // Persistence is debounced ~300ms.
  await new Promise((r) => setTimeout(r, 500));
  const saved = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
  assert.equal(Array.isArray(saved), true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].preview, 'persist-me');

  agent.end();
  a.close();
  broker.stop();
  fs.rmSync(eventsPath, { force: true });
});
