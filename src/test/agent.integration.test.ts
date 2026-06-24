import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type { LogMessage } from '../shared/protocol';

/**
 * End-to-end: spawn a real Node process with the agent preloaded, point it at a
 * throwaway TCP server, and assert it ships correctly-located, serialized logs.
 */
test('agent captures and ships node console logs with real source locations', async () => {
  const messages: LogMessage[] = [];

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

  const port: number = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const preload = path.resolve(__dirname, '../agent/preload.js');
  const fixture = path.resolve(__dirname, 'fixtures/logs.js');

  const exitCode: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, fixture], {
      env: { ...process.env, CONSOLE_LENS_PORT: String(port) },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });

  // Give any in-flight TCP writes a moment to land.
  await new Promise((r) => setTimeout(r, 150));
  server.close();

  assert.equal(exitCode, 0, 'child process should exit cleanly');

  const logs = messages.filter((m) => m.type === 'log' && /logs\.(ts|js)$/.test(m.file));
  assert.ok(logs.length >= 4, `expected >= 4 logs, got ${logs.length}`);

  const hello = logs.find((m) => m.preview.includes('hello world'));
  assert.ok(hello, 'should capture the hello log');
  assert.equal(hello!.runtime, 'node');
  assert.equal(hello!.level, 'log');
  assert.ok(path.isAbsolute(hello!.file), 'file should be an absolute path');
  // Source maps: the executed file is fixtures/logs.js, but the agent enables
  // source-map support, so the captured location maps back to the .ts source
  // (the `console.log('hello world', 123)` call sits on line 3 of logs.ts).
  assert.ok(hello!.file.endsWith('logs.ts'), `expected source-mapped logs.ts, got ${hello!.file}`);
  assert.equal(hello!.line, 3, `expected original source line 3, got ${hello!.line}`);

  assert.ok(logs.some((m) => m.level === 'warn'));
  assert.ok(logs.some((m) => m.level === 'error'));
  // circular reference handled without crashing the child
  assert.ok(logs.some((m) => m.preview.includes('circular')));
});
