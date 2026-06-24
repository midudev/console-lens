import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

interface Sink {
  port: number;
  messages: Array<Record<string, unknown>>;
  close: () => void;
}

function startSink(): Promise<Sink> {
  const messages: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) {
          messages.push(JSON.parse(line));
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, messages, close: () => server.close() }),
    );
  });
}

const preload = path.resolve(__dirname, '../agent/preload.js');

test('captures uncaught errors with source-mapped stack frames', async () => {
  const sink = await startSink();
  const fixture = path.resolve(__dirname, 'fixtures/throws.js');

  const exitCode: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, fixture], {
      env: { ...process.env, CONSOLE_LENS_PORT: String(sink.port) },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
  await new Promise((r) => setTimeout(r, 200));
  sink.close();

  assert.notEqual(exitCode, 0, 'fixture should crash (uncaught exception)');
  const err = sink.messages.find((m) => m.type === 'error');
  assert.ok(err, 'should capture an error message');
  assert.equal(err!.name, 'Error');
  assert.match(err!.message as string, /boom from fixture/);
  const frames = err!.frames as Array<{ function?: string; file: string; line: number }>;
  assert.ok(Array.isArray(frames) && frames.length > 0, 'error should carry stack frames');
  assert.match(frames[0].file, /throws\.(ts|js)$/);
  assert.equal(frames[0].function, 'applyTax');
});

test('captures fetch network requests (method, status, body)', async () => {
  const sink = await startSink();
  const httpServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"hi":true}');
  });
  const url: string = await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/api`),
    );
  });
  const fixture = path.resolve(__dirname, 'fixtures/netfetch.js');

  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, fixture], {
      env: { ...process.env, CONSOLE_LENS_PORT: String(sink.port), CL_TEST_URL: url },
      stdio: 'ignore',
    });
    child.on('exit', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 200));
  sink.close();
  httpServer.close();

  const netMsg = sink.messages.find((m) => m.type === 'network');
  assert.ok(netMsg, 'should capture a network request');
  assert.equal(netMsg!.method, 'GET');
  assert.equal(netMsg!.status, 200);
  assert.match((netMsg!.responseBody as string) ?? '', /hi/);
});

test('logpoint logs an expression without editing the source (Node)', async () => {
  const sink = await startSink();
  const fixture = path.resolve(__dirname, 'fixtures/lp-fixture.js');
  // In the compiled .js, `return total;` is on line 4 (a "use strict" prologue is
  // added). Logpoint there with expression `total` must ship 42.
  const lpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-lp-')), 'logpoints.json');
  fs.writeFileSync(lpFile, JSON.stringify([{ file: fixture, line: 4, expression: 'total', enabled: true }]));

  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, fixture], {
      env: { ...process.env, CONSOLE_LENS_PORT: String(sink.port), CONSOLE_LENS_LOGPOINTS: lpFile },
      stdio: 'ignore',
    });
    child.on('exit', () => resolve());
  });
  await new Promise((r) => setTimeout(r, 200));
  sink.close();

  const lp = sink.messages.find((m) => m.type === 'log' && m.logpoint);
  assert.ok(lp, 'should capture a logpoint');
  assert.equal(lp!.line, 4);
  assert.equal(lp!.expression, 'total');
  assert.equal((lp!.args as string[])[0], '42');
});
