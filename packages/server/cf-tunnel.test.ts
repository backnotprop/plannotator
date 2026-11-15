import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CF_TUNNEL_BACKOFF, createCfTunnel, tunnelTokenPath, type CfTunnelState } from "./cf-tunnel";

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCloudflared(script: string) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-cf-tunnel-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const path = join(bin, "cloudflared");
  writeFileSync(path, `#!/bin/sh\necho "$$ $TUNNEL_TOKEN $*" >> "${root}/runs"\n${script}\n`);
  chmodSync(path, 0o755);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "cloudflare-access"), { recursive: true });
  writeFileSync(tunnelTokenPath(dataDir), "fake-run-token\n", { mode: 0o600 });
  return { path, dataDir, runs: () => (existsSync(join(root, "runs")) ? readFileSync(join(root, "runs"), "utf8").trim().split("\n") : []) };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("cloudflared as the Inbox's child", () => {
  test("runs with the token in its environment, never its arguments, and counts its connections", async () => {
    const fake = fakeCloudflared(
      'echo "INF Registered tunnel connection connIndex=0 location=x" >&2\necho "INF Registered tunnel connection connIndex=1 location=y" >&2\nexec sleep 30',
    );
    let last: CfTunnelState | null = null;
    const tunnel = createCfTunnel({ dataDir: fake.dataDir, binary: fake.path, log: () => {}, onChange: () => (last = tunnel.state()) });
    stops.push(tunnel.stop);
    tunnel.start();
    await until(() => last?.connections === 2);
    expect(tunnel.state()).toMatchObject({ state: "connected", connections: 2, restarts: 0 });
    const [run] = fake.runs();
    expect(run).toMatch(/fake-run-token tunnel --no-autoupdate --metrics 127\.0\.0\.1:\d+ run$/);
    expect(run!.split(" ").slice(2).join(" ")).not.toContain("fake-run-token");
    const pid = tunnel.state().pid!;
    tunnel.stop();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(tunnel.state().state).toBe("stopped");
  });

  test("connected by cloudflared's own /ready even when its log says nothing", async () => {
    const server = `const port = Number(process.argv[1].split(":")[1]); Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ status: 200, readyConnections: 3 }) }); setInterval(() => {}, 1e6);`;
    const fake = fakeCloudflared(`exec "${process.execPath}" -e '${server}' "$4"`);
    let last: CfTunnelState | null = null;
    const tunnel = createCfTunnel({ dataDir: fake.dataDir, binary: fake.path, log: () => {}, onChange: () => (last = tunnel.state()) });
    stops.push(tunnel.stop);
    tunnel.start();
    await until(() => last?.connections === 3, 9_000);
    expect(tunnel.state().state).toBe("connected");
  }, 15_000);

  test("a child that exits is started again after a growing wait, and stop ends the retries", async () => {
    const fake = fakeCloudflared('echo "ERR failed to dial edge" >&2\nexit 1');
    const waits: number[] = [];
    let pending: (() => void) | null = null;
    const tunnel = createCfTunnel({
      dataDir: fake.dataDir,
      binary: fake.path,
      log: () => {},
      onChange: () => {},
      timers: { set: (fn, ms) => (waits.push(ms), (pending = fn)), clear: () => (pending = null) },
    });
    stops.push(tunnel.stop);
    tunnel.start();
    await until(() => waits.length === 1);
    expect(tunnel.state()).toMatchObject({ state: "retrying", restarts: 1 });
    expect(tunnel.state().error).toContain("failed to dial edge");
    pending!();
    await until(() => waits.length === 2);
    expect(waits).toEqual([CF_TUNNEL_BACKOFF.firstMs, CF_TUNNEL_BACKOFF.firstMs * 2]);
    tunnel.stop();
    expect(pending).toBeNull();
    expect(fake.runs()).toHaveLength(2);
  });

  test("no binary or no token: it says so and starts nothing", () => {
    const fake = fakeCloudflared("exit 0");
    const missing = createCfTunnel({ dataDir: fake.dataDir, binary: null, log: () => {}, onChange: () => {} });
    missing.start();
    expect(missing.state()).toMatchObject({ state: "missing", error: "cloudflared is not installed." });
    rmSync(tunnelTokenPath(fake.dataDir));
    const noToken = createCfTunnel({ dataDir: fake.dataDir, binary: fake.path, log: () => {}, onChange: () => {} });
    noToken.start();
    expect(noToken.state().state).toBe("missing");
    expect(fake.runs()).toEqual([]);
  });
});
