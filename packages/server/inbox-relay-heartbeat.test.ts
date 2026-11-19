import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { InboxDevices } from "@plannotator/shared/inbox/devices";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxRelay, heartbeatLook } from "./inbox-relay";

const PHONE = "dev_01M4H6G73M9H3Z32T859E72DPY";

async function waitFor(check: () => boolean, problem: string, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(problem);
    await Bun.sleep(10);
  }
}

test("the Inbox reconnects when the relay's replies disappear without a close frame", async () => {
  let connections = 0;
  let pings = 0;
  let blackHole = false;
  let dropped = 0;
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        connections++;
        ws.send(JSON.stringify({ type: "hello", devices: [{ device_id: PHONE, carriage: false, cursor: 0 }] }));
      },
      message() {},
      ping() { pings++; },
    },
  });
  const sockets = new Set<Socket>();
  let tunnels = 0;
  // Behave like a path that loses inbound traffic without sending FIN or a WebSocket close.
  const proxy = createServer((client) => {
    const first = tunnels++ === 0;
    const upstream = createConnection(relay.port, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        (socket === client ? upstream : client).destroy();
      });
    }
    client.on("data", (chunk) => upstream.write(chunk));
    upstream.on("data", (chunk) => {
      if (first && blackHole) dropped++;
      else client.write(chunk);
    });
  });
  proxy.listen(0, "127.0.0.1");
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-relay-heartbeat-"));
  let client: ReturnType<typeof createInboxRelay> | undefined;
  try {
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const store = InboxStore.open(dataDir);
    const devices = InboxDevices.open(dataDir);
    devices.add({ id: PHONE, name: "Phone", platform: "ios", token: "tok_test", secret: "secret", at: new Date().toISOString() });
    writeFileSync(join(dataDir, "inbox", "relay.json"), JSON.stringify({
      v: 1, url: `http://127.0.0.1:${address.port}`, mailbox_id: "mbx_test", secret: "bearer",
    }));
    let hellos = 0;
    client = createInboxRelay({
      dataDir,
      store,
      devices,
      apply: async () => new Response(null, { status: 404 }),
      payload: () => ({}),
      log: (line) => { if (line === "hello 1") hellos++; },
      heartbeat: { intervalMs: 40, timeoutMs: 250 },
    });
    client.start();

    // A healthy idle socket stays up through several complete ping/pong cycles.
    await waitFor(() => hellos === 1 && pings >= 3, "the healthy connection never sent three pings");
    expect(connections).toBe(1);
    blackHole = true;

    await waitFor(() => hellos === 2, "the Inbox never replaced the unresponsive socket");
    expect(dropped).toBeGreaterThan(0);
    const before = pings;
    await waitFor(() => pings >= before + 3, "the replacement socket did not stay healthy");
    expect(connections).toBe(2);
  } finally {
    client?.stop();
    for (const socket of sockets) socket.destroy();
    proxy.close();
    relay.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** Bun reports its send queue in `bufferedAmount` from 1.4; before, it is always 0. */
const REPORTS_QUEUE = Bun.semver.satisfies(Bun.version, ">=1.4.0");

interface LargeResultRun {
  connections: number;
  pings: number;
  applies: number;
  /** When the Inbox applied the command first, and when the relay heard it was applied. */
  firstApplyAt: number;
  appliedAt: number;
  lines: string[];
}

/**
 * A loopback relay that hands the Inbox one command until it is reported
 * applied (as the mailbox does), its result `bodyBytes` long, behind a proxy
 * whose Inbox-to-relay direction carries `uplink(n, run)` bytes per 100 ms
 * tick on the n-th connection (Infinity: unslowed; 0: stalled), with TCP
 * backpressure. Every timer, socket and server is closed before it returns.
 */
async function withLargeResult(
  options: { bodyBytes: number; heartbeat: { intervalMs: number; timeoutMs: number; uplinkBytesPerMs: number }; uplink: (tunnel: number, run: LargeResultRun) => number },
  check: (run: LargeResultRun) => Promise<void>,
) {
  const COMMAND = "cmd_large_result";
  const keys = await deriveRelayKeys("secret", PHONE);
  const command = JSON.stringify({
    type: "command",
    device_id: PHONE,
    id: COMMAND,
    ciphertext: await encryptWithKey(JSON.stringify({ v: 1, id: COMMAND, method: "GET", path: "/api/inbox/device/attachments/att_1/download" }), keys.upKey),
  });
  const run: LargeResultRun = { connections: 0, pings: 0, applies: 0, firstApplyAt: 0, appliedAt: 0, lines: [] };
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      maxPayloadLength: 32 * 1024 * 1024,
      open(ws) {
        run.connections++;
        ws.send(JSON.stringify({ type: "hello", devices: [{ device_id: PHONE, carriage: true, cursor: 0 }] }));
        if (!run.appliedAt) ws.send(command);
      },
      message(_ws, data) {
        const frame = JSON.parse(String(data)) as { type: string; id?: string };
        if (frame.type === "applied" && frame.id === COMMAND && !run.appliedAt) run.appliedAt = Date.now();
      },
      ping() { run.pings++; },
    },
  });
  const sockets = new Set<Socket>();
  const meters = new Set<ReturnType<typeof setInterval>>();
  let tunnels = 0;
  const proxy = createServer((client) => {
    const tunnel = tunnels++;
    const upstream = createConnection(relay.port, "127.0.0.1");
    // Bytes the uplink may still carry this tick; a large chunk leaves a debt the next ticks pay off.
    let budget = options.uplink(tunnel, run);
    const meter = setInterval(() => {
      const rate = options.uplink(tunnel, run);
      budget = Math.min(budget + rate, rate);
      if (budget > 0) client.resume();
    }, 100);
    meters.add(meter);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        sockets.delete(socket);
        clearInterval(meter);
        meters.delete(meter);
        (socket === client ? upstream : client).destroy();
      });
    }
    client.on("data", (chunk) => {
      upstream.write(chunk);
      const rate = options.uplink(tunnel, run);
      if (rate === Infinity) return;
      budget = Math.min(budget, rate) - chunk.length;
      if (budget <= 0) client.pause();
    });
    upstream.on("data", (chunk) => client.write(chunk));
  });
  proxy.listen(0, "127.0.0.1");
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-relay-heartbeat-"));
  let client: ReturnType<typeof createInboxRelay> | undefined;
  try {
    await once(proxy, "listening");
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const store = InboxStore.open(dataDir);
    const devices = InboxDevices.open(dataDir);
    devices.add({ id: PHONE, name: "Phone", platform: "ios", token: "tok_test", secret: "secret", at: new Date().toISOString() });
    writeFileSync(join(dataDir, "inbox", "relay.json"), JSON.stringify({
      v: 1, url: `http://127.0.0.1:${address.port}`, mailbox_id: "mbx_test", secret: "bearer",
    }));
    // A phone's download: sealed twice in base64, its result frame is about 16/9 of the body.
    const download = Buffer.alloc(options.bodyBytes, 7);
    client = createInboxRelay({
      dataDir,
      store,
      devices,
      apply: async () => {
        run.applies++;
        run.firstApplyAt ||= Date.now();
        return new Response(download, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      },
      payload: () => ({}),
      log: (line) => { run.lines.push(line); },
      heartbeat: options.heartbeat,
    });
    client.start();
    await check(run);
  } finally {
    client?.stop();
    for (const meter of meters) clearInterval(meter);
    for (const socket of sockets) socket.destroy();
    proxy.close();
    relay.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const TIMED_OUT = "socket heartbeat timed out";

test("a large result that takes many heartbeats to upload is not cut off and its command is not sent again", async () => {
  const heartbeat = { intervalMs: 40, timeoutMs: 1_000, uplinkBytesPerMs: 512 };
  // About 8 MiB at about 1 MiB/s; the slowest uplink allowed for is half that.
  await withLargeResult({ bodyBytes: Math.floor(4.5 * 1024 * 1024), heartbeat, uplink: () => 100 * 1024 }, async (run) => {
    await waitFor(() => run.appliedAt > 0, "the command was never reported applied", 30_000);
    // The throttle held the upload past four pong deadlines.
    expect(run.appliedAt - run.firstApplyAt).toBeGreaterThan(4 * heartbeat.timeoutMs);
    expect(run.applies).toBe(1);
    expect(run.connections).toBe(1);
    expect(run.lines).not.toContain(TIMED_OUT);
    // The heartbeat carries on once the upload is through.
    const before = run.pings;
    await waitFor(() => run.pings >= before + 3, "the socket stopped answering pings after the upload");
    expect(run.connections).toBe(1);
  });
}, 60_000);

test("a look for the pong: a moving queue keeps the socket, a stuck one or an overdue pong drops it", () => {
  const heartbeat = { intervalMs: 30_000, timeoutMs: 10_000, uplinkBytesPerMs: 32, queueStepBytes: 2 * 1024 * 1024 };
  const stuckMs = (2 * 1024 * 1024) / 32; // about 65 s at the slowest uplink allowed for
  const due = 600_000; // a large frame's allowance, from the ping at 0
  // Bun's queue shrank since the last look: look again, past the allowance too.
  expect(heartbeatLook({ now: 10_000, left: 900_000, queued: 1_000_000, movedAt: 0, due }, heartbeat)).toEqual({ drop: false, ms: 10_000, movedAt: 10_000 });
  expect(heartbeatLook({ now: 700_000, left: 900_000, queued: 1_000_000, movedAt: 690_000, due }, heartbeat)).toEqual({ drop: false, ms: 10_000, movedAt: 700_000 });
  // Bytes wait and have not moved for less than a step takes: look again; for longer: dropped, long before the allowance.
  expect(heartbeatLook({ now: 60_000, left: 900_000, queued: 900_000, movedAt: 0, due }, heartbeat)).toEqual({ drop: false, ms: 10_000, movedAt: 0 });
  expect(heartbeatLook({ now: stuckMs, left: 900_000, queued: 900_000, movedAt: 0, due }, heartbeat)).toEqual({ drop: true });
  // A frame sent since the last look counts in `queued`, so it does not read as a queue that failed to shrink.
  expect(heartbeatLook({ now: 10_000, left: 5_000_000, queued: 5_100_000, movedAt: 0, due }, heartbeat).drop).toBe(false);
  // The queue just emptied: one more look for bytes still in the kernel.
  expect(heartbeatLook({ now: 700_000, left: 0, queued: 50_000, movedAt: 690_000, due }, heartbeat)).toEqual({ drop: false, ms: 10_000, movedAt: 700_000 });
  // An empty queue (or a Bun that does not report it): the allowance decides.
  expect(heartbeatLook({ now: 590_000, left: 0, queued: 0, movedAt: 0, due }, heartbeat)).toEqual({ drop: false, ms: 10_000, movedAt: 0 });
  expect(heartbeatLook({ now: 595_000, left: 0, queued: 0, movedAt: 0, due }, heartbeat)).toEqual({ drop: false, ms: 5_000, movedAt: 0 });
  expect(heartbeatLook({ now: due, left: 0, queued: 0, movedAt: 0, due }, heartbeat)).toEqual({ drop: true });
  // A quiet socket after a sleep: the pong is 10 s late, dropped at the first look.
  expect(heartbeatLook({ now: 10_000, left: 0, queued: 0, movedAt: 0, due: 10_000 }, heartbeat)).toEqual({ drop: true });
});

test.skipIf(!REPORTS_QUEUE)("a path that stops taking bytes mid-upload is replaced at once, not when the allowance runs out", async () => {
  // The first socket's uplink stalls once the relay has it; the allowance (16 bytes/ms) would wait about nine minutes.
  const heartbeat = { intervalMs: 40, timeoutMs: 500, uplinkBytesPerMs: 16, queueStepBytes: 64 * 1024 };
  await withLargeResult({
    bodyBytes: Math.floor(4.5 * 1024 * 1024),
    heartbeat,
    uplink: (tunnel, run) => (tunnel === 0 && run.connections >= 1 ? 0 : Infinity),
  }, async (run) => {
    await waitFor(() => run.lines.includes(TIMED_OUT), "the stalled socket was never dropped", 10_000);
    const droppedAfter = Date.now() - run.firstApplyAt;
    expect(droppedAfter).toBeLessThan(intervalBound(heartbeat));
    // The replacement socket carries the command the relay still holds.
    await waitFor(() => run.appliedAt > 0, "the command was never applied on the replacement socket", 10_000);
    expect(run.connections).toBe(2);
    expect(run.applies).toBe(2);
  });
}, 60_000);

/** A stuck queue is caught once it has not moved for as long as a step takes, within a look or two. */
function intervalBound(heartbeat: { intervalMs: number; timeoutMs: number; uplinkBytesPerMs: number; queueStepBytes: number }): number {
  return heartbeat.intervalMs + heartbeat.queueStepBytes / heartbeat.uplinkBytesPerMs + 3 * heartbeat.timeoutMs;
}
