/**
 * PLANNOTATOR_LIVE_PORT on the Node live proxy the Pi extension ships
 * (#2145). The twin of packages/server/live-proxy-port.test.ts for the Bun
 * transport.
 *
 * Like live-proxy-node.test.ts, the proxy runs in a REAL `node` child
 * (live-proxy-node.child.ts): that is its runtime under Pi. A failed start
 * makes the child print { error } and end by itself, which it can only do
 * when the failed start left no listener open.
 *
 * Busy ports are real listeners this file starts and closes; free ports come
 * from the OS.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accepts,
  closeServer,
  deniedLowPort,
  nonLoopbackIPv4,
  occupyConsecutivePorts,
  partlyBusyRange,
  reserveFreePort,
} from "../../tests/helpers/live-port";

let childDir: string;
let entry: string;
let upstream: ReturnType<typeof Bun.serve>;
const children: Array<ReturnType<typeof Bun.spawn>> = [];

beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "live-proxy-node.child.ts")],
    target: "node",
    format: "esm",
  });
  if (!build.success) throw new Error(`child build failed: ${build.logs.map((l) => l.message).join("; ")}`);
  childDir = mkdtempSync(join(tmpdir(), "live-proxy-node-port-test-"));
  entry = join(childDir, "child.mjs");
  writeFileSync(entry, await build.outputs[0]!.text());
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<html><head></head><body>app</body></html>", {
      headers: { "Content-Type": "text/html" },
    }),
  });
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

afterAll(() => {
  upstream.stop(true);
  rmSync(childDir, { recursive: true, force: true });
});

type Outcome =
  | { kind: "listening"; port: number; stderr: () => Promise<string> }
  | { kind: "failed"; name: string; message: string; exitCode: number | null; stderr: string };

/** Start the proxy in node with PLANNOTATOR_LIVE_PORT set to `livePort`. */
async function startInNode(livePort: string | undefined): Promise<Outcome> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    LIVE_PROXY_TARGET: `http://127.0.0.1:${upstream.port}`,
    LIVE_PROXY_EDITOR_ORIGINS: "http://localhost:4100",
    LIVE_PROXY_BRIDGE: "/* bridge */",
  };
  delete env.PLANNOTATOR_LIVE_PORT;
  if (livePort !== undefined) env.PLANNOTATOR_LIVE_PORT = livePort;
  const child = Bun.spawn(["node", entry], { env, stdout: "pipe", stderr: "pipe" });
  children.push(child);

  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let banner = "";
  const timer = setTimeout(() => reader.cancel().catch(() => {}), 10_000);
  try {
    while (!banner.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) break;
      banner += new TextDecoder().decode(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const parsed = JSON.parse(banner.split("\n")[0] || "{}") as {
    port?: number;
    error?: { name: string; message: string };
  };
  if (parsed.error) {
    // The child must end by itself: a listener left open would keep it alive.
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    return {
      kind: "failed",
      ...parsed.error,
      exitCode,
      stderr: await new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    };
  }
  if (typeof parsed.port !== "number") throw new Error(`child printed no port: ${banner}`);
  return {
    kind: "listening",
    port: parsed.port,
    stderr: async () => {
      child.kill();
      return new Response(child.stderr as ReadableStream<Uint8Array>).text();
    },
  };
}

async function expectServesApp(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("app");
}

describe("Node live proxy: PLANNOTATOR_LIVE_PORT", () => {
  test("unset keeps a random loopback port", async () => {
    const outcome = await startInNode(undefined);
    if (outcome.kind !== "listening") throw new Error(outcome.message);
    expect(outcome.port).toBeGreaterThan(0);
    await expectServesApp(outcome.port);
  });

  test("a fixed free port is used, on 127.0.0.1 only", async () => {
    const port = await reserveFreePort();
    const outcome = await startInNode(String(port));
    if (outcome.kind !== "listening") throw new Error(outcome.message);
    expect(outcome.port).toBe(port);
    await expectServesApp(port);
    const lan = nonLoopbackIPv4();
    if (lan) expect(await accepts(lan, port)).toBe(false);
  });

  test("a range whose first port is busy falls through to the next", async () => {
    const range = await partlyBusyRange(3, 1);
    try {
      const outcome = await startInNode(`${range.start}-${range.end}`);
      if (outcome.kind !== "listening") throw new Error(outcome.message);
      expect(outcome.port).toBe(range.start + 1);
      await expectServesApp(outcome.port);
    } finally {
      await range.release();
    }
  });

  test("every port busy raises LiveProxyPortInUseError and leaves nothing open", async () => {
    const { start, servers } = await occupyConsecutivePorts(2);
    try {
      const outcome = await startInNode(`${start}-${start + 1}`);
      expect(outcome.kind).toBe("failed");
      if (outcome.kind !== "failed") return;
      expect(outcome.name).toBe("LiveProxyPortInUseError");
      expect(outcome.message).toContain(`every port in PLANNOTATOR_LIVE_PORT ${start}-${start + 1} is already in use`);
      expect(outcome.exitCode).toBe(3);
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  });

  test("an invalid value warns and falls back to a random port", async () => {
    const outcome = await startInNode("19440-");
    if (outcome.kind !== "listening") throw new Error(outcome.message);
    expect(outcome.port).toBeGreaterThan(0);
    await expectServesApp(outcome.port);
    expect(await outcome.stderr()).toContain('[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "19440-", using default');
  });

  test("a port this user may not bind is one clear line, and a range moves past it", async () => {
    const denied = await deniedLowPort();
    if (denied === null) {
      console.log("skip: no denied low port here (root, or low ports are open)");
      return;
    }
    const fixed = await startInNode(String(denied));
    expect(fixed.kind).toBe("failed");
    if (fixed.kind !== "failed") return;
    expect(fixed.name).toBe("LiveProxyPortError");
    expect(fixed.message).toBe(
      `Plannotator: live app proxy port ${denied} (PLANNOTATOR_LIVE_PORT) could not be used (EACCES: permission denied). Ports below 1024 usually need root. Set PLANNOTATOR_LIVE_PORT to a different port or range.`,
    );
    expect(fixed.exitCode).toBe(3);

    const range = await startInNode(`${denied}-1060`);
    if (range.kind !== "listening") throw new Error(range.message);
    expect(range.port).toBeGreaterThanOrEqual(1024);
    expect(range.port).toBeLessThanOrEqual(1060);
    await expectServesApp(range.port);
  });
});
