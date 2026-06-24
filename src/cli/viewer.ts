#!/usr/bin/env node
/**
 * Headless Console Lens viewer.
 *
 * Subscribes to the shared broker (spawning it if needed) and prints every
 * received log to the terminal, including the resolved source location. This
 * lets you try the whole agent -> broker pipeline end-to-end without launching
 * VS Code — and it coexists with editor windows, since they all subscribe to
 * the same broker instead of fighting over the port:
 *
 *   Terminal 1:  npm run viewer
 *   Terminal 2:  node --require out/agent/preload.js demo/node-demo.js
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { DEFAULT_TCP_PORT, type LogLevel, type LogMessage } from '../shared/protocol';
import { LEVEL_ICONS } from '../shared/formatter';
import { connectToBroker } from '../broker/client';

const COLORS: Record<LogLevel, string> = {
  log: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[35m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function main(): void {
  const port = Number(process.env.CONSOLE_LENS_PORT) || DEFAULT_TCP_PORT;
  const brokerScript = path.join(__dirname, '..', 'broker', 'broker.js');
  const eventsPath = path.join(os.homedir(), '.console-lens', 'events.json');

  const spawnBroker = (): void => {
    const child = spawn(
      process.execPath,
      [brokerScript, '--port', String(port), '--events', eventsPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
  };

  const client = connectToBroker({ tcpPort: port, spawnBroker });

  client.on('connected', ({ tcpPort, wsPort }: { tcpPort: number; wsPort: number }) => {
    process.stdout.write(
      `${COLORS.info}🔎 Console Lens viewer${RESET} connected to broker — TCP ${tcpPort} (Node) / WS ${wsPort} (browser)\n` +
        `${DIM}Run your app with: NODE_OPTIONS="--require ${path.resolve('out/agent/preload.js')}" node yourfile.js${RESET}\n\n`,
    );
  });

  client.on('log', (message: LogMessage) => {
    const color = COLORS[message.level] ?? COLORS.log;
    const icon = LEVEL_ICONS[message.level] ?? '›';
    const loc = `${path.basename(message.file)}:${message.line}`;
    process.stdout.write(
      `${color}${icon} ${message.preview}${RESET} ${DIM}(${loc} · ${message.runtime})${RESET}\n`,
    );
  });

  client.on('unreachable', (busyPort: number) => {
    process.stderr.write(
      `\x1b[31mCould not reach the Console Lens broker on port ${busyPort}.${RESET}\n` +
        `Another process may be using it. Set CONSOLE_LENS_PORT to another value.\n`,
    );
  });

  process.on('SIGINT', () => {
    client.close();
    process.exit(0);
  });
}

main();
