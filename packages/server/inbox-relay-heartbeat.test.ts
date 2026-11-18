import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { InboxDevices } from "@plannotator/shared/inbox/devices";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxRelay } from "./inbox-relay";

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

test("a large result that takes many heartbeats to upload is not cut off and its command is not sent again", async () => {
  const COMMAND = "cmd_large_result";
  const keys = await deriveRelayKeys("secret", PHONE);
  const command = JSON.stringify({
    type: "command",
    device_id: PHONE,
    id: COMMAND,
    ciphertext: await encryptWithKey(JSON.stringify({ v: 1, id: COMMAND, method: "GET", path: "/api/inbox/device/attachments/att_1/download" }), keys.upKey),
  });
  let connections = 0;
  let pings = 0;
  let resultBytes = 0;
  let applied = false;
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      maxPayloadLength: 32 * 1024 * 1024,
      open(ws) {
        connections++;
        ws.send(JSON.stringify({ type: "hello", devices: [{ device_id: PHONE, carriage: true, cursor: 0 }] }));
        // Like the mailbox: a command not yet reported applied is handed over again on each new socket.
        if (!applied) ws.send(command);
      },
      message(_ws, data) {
        const frame = JSON.parse(String(data)) as { type: string; id?: string };
        if (frame.type === "item") resultBytes = String(data).length;
        if (frame.type === "applied" && frame.id === COMMAND) applied = true;
      },
      ping() { pings++; },
    },
  });
  // A slow uplink: the Inbox's bytes reach the relay at about 2 MiB/s, with TCP backpressure; the way down is not slowed.
  const UPLINK_BYTES_PER_TICK = 200 * 1024;
  const sockets = new Set<Socket>();
  const meters = new Set<ReturnType<typeof setInterval>>();
  const proxy = createServer((client) => {
    const upstream = createConnection(relay.port, "127.0.0.1");
    let budget = UPLINK_BYTES_PER_TICK;
    const meter = setInterval(() => {
      budget = UPLINK_BYTES_PER_TICK;
      client.resume();
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
      budget -= chunk.length;
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
    // A phone's download: its result frame is about 4 MiB, some 2 s on this uplink, eight pong deadlines.
    const download = Buffer.alloc(Math.floor(2.25 * 1024 * 1024), 7);
    let applies = 0;
    const lines: string[] = [];
    client = createInboxRelay({
      dataDir,
      store,
      devices,
      apply: async () => {
        applies++;
        return new Response(download, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
      },
      payload: () => ({}),
      log: (line) => { lines.push(line); },
      // The real timings scaled down; the slowest uplink allowed for is half this one's speed.
      heartbeat: { intervalMs: 40, timeoutMs: 250, uplinkBytesPerMs: 1024 },
    });
    client.start();

    await waitFor(() => applied, "the command was never reported applied", 15_000);
    expect(resultBytes).toBeGreaterThan(3.5 * 1024 * 1024);
    expect(applies).toBe(1);
    expect(connections).toBe(1);
    expect(lines).not.toContain("socket heartbeat timed out");

    // The heartbeat carries on once the upload is through.
    const before = pings;
    await waitFor(() => pings >= before + 3, "the socket stopped answering pings after the upload");
    expect(connections).toBe(1);
  } finally {
    client?.stop();
    for (const meter of meters) clearInterval(meter);
    for (const socket of sockets) socket.destroy();
    proxy.close();
    relay.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
