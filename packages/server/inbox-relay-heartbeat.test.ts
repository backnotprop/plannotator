import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxDevices } from "@plannotator/shared/inbox/devices";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxRelay } from "./inbox-relay";

const PHONE = "dev_01M4H6G73M9H3Z32T859E72DPY";

async function waitFor(check: () => boolean, problem: string) {
  const deadline = Date.now() + 3_000;
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
