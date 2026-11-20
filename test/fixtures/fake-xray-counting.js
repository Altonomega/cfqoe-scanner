#!/usr/bin/env node
// Test double for the real Xray binary that records every `run`
// invocation, so a test can pin how many sessions a pipeline stage
// starts (Probe P-4: one session per tunnel candidate across rounds,
// restarted only after a failed round). Each invocation appends one
// line — the candidate IP taken from the generated config — to the
// file named by FAKE_XRAY_COUNT_FILE. With FAKE_XRAY_COUNT_FAIL=1 it
// then exits non-zero like fake-xray-dead, so every start attempt
// fails after being counted. Without a count file configured it
// behaves exactly like fake-xray.js. No network access either way:
// the listener only ever talks to the local process manager.
import fs from 'node:fs';
import net from 'node:net';

const args = process.argv.slice(2);

if (args[0] === 'version') {
  console.log('Xray 0.0.0-fake-counting (test fixture)');
  process.exit(0);
}

const configIndex = args.indexOf('-c');
if (configIndex === -1 || !args[configIndex + 1]) {
  console.error('missing -c config');
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(args[configIndex + 1], 'utf8'));

const countFile = process.env.FAKE_XRAY_COUNT_FILE;
if (countFile) {
  const candidateIp =
    config.outbounds?.[0]?.settings?.vnext?.[0]?.address ?? 'unknown';
  // Synchronous on purpose: the line must be durable before the port
  // opens and the manager declares the session started.
  fs.appendFileSync(countFile, `${candidateIp}\n`);
}

if (process.env.FAKE_XRAY_COUNT_FAIL) {
  console.error('fake xray (counting): simulated startup failure');
  process.exit(1);
}

const inbound = config.inbounds[0];

const server = net.createServer((socket) => {
  socket.on('data', () => socket.write(Buffer.from([0x05, 0x00])));
  socket.on('error', () => {});
});

server.listen(inbound.port, inbound.listen, () => {
  console.log(`fake xray (counting) listening on ${inbound.listen}:${inbound.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
