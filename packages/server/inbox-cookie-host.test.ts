/**
 * The Inbox's Settings → General "Open Plannotator at plannotator.localhost"
 * (#2184): GET /api/inbox/settings carries `cookie_host`, POST `{ cookie_host }`
 * writes or removes config.json `urlHost: "plannotator.localhost"`, never
 * replaces another `urlHost`, and is locked while PLANNOTATOR_URL_HOST is set.
 * (Through the tailnet it is refused: inbox-tailscale.test.ts.)
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { startInboxServer, type InboxServer } from "./inbox";

let dataDir: string;
const servers: InboxServer[] = [];
const saved: Record<string, string | undefined> = {};
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_URL_HOST"] as const;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-cookie-host-")));
  // config.json is read from the data dir env.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  delete process.env.PLANNOTATOR_URL_HOST;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function start(): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, htmlContent: "<!doctype html><title>Inbox</title>" });
  servers.push(server);
  return server;
}

const settings = async (server: InboxServer) =>
  (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`)).json()) as Record<string, unknown>;
const post = (server: InboxServer, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}/api/inbox/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("on writes urlHost, off removes it, other config is kept; a non-boolean is refused", async () => {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ displayName: "tater" }));
  const server = await start();
  expect((await settings(server)).cookie_host).toEqual({ on: false, env: null, url_host: null });
  const on = await post(server, { cookie_host: true });
  expect(on.status).toBe(200);
  expect((await on.json()).cookie_host).toEqual({ on: true, env: null, url_host: null });
  expect(loadConfig()).toMatchObject({ displayName: "tater", urlHost: "plannotator.localhost" });
  // The running Inbox keeps the address it started with: the switch applies from the next start.
  expect(server.url).toBe(`http://localhost:${server.port}/`);
  expect((await post(server, { cookie_host: false })).status).toBe(200);
  expect(loadConfig().urlHost).toBeUndefined();
  expect(loadConfig().displayName).toBe("tater");
  expect((await post(server, { cookie_host: "on" })).status).toBe(422);
});

test("another urlHost is never replaced or removed: the switch is locked", async () => {
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ urlHost: "auto" }));
  const before = readFileSync(join(dataDir, "config.json"), "utf8");
  const server = await start();
  expect((await settings(server)).cookie_host).toEqual({ on: false, env: null, url_host: "auto" });
  for (const value of [true, false]) {
    const res = await post(server, { cookie_host: value });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("cookie_host_url_host_in_use");
  }
  expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe(before);
});

test("PLANNOTATOR_URL_HOST locks the switch", async () => {
  process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
  const server = await start();
  expect(server.url).toBe(`http://plannotator.localhost:${server.port}/`);
  expect((await settings(server)).cookie_host).toEqual({ on: true, env: "plannotator.localhost", url_host: null });
  const res = await post(server, { cookie_host: false });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe("cookie_host_env_decides");
});

test("a refused tailnet change in the same save writes no cookie switch", async () => {
  const before = process.env.PLANNOTATOR_INBOX_TAILSCALE;
  process.env.PLANNOTATOR_INBOX_TAILSCALE = "0";
  try {
    const server = await start();
    const res = await post(server, { tailscale: { on: true }, cookie_host: true });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("tailscale_env_decides");
    expect(loadConfig().urlHost).toBeUndefined();
  } finally {
    if (before === undefined) delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    else process.env.PLANNOTATOR_INBOX_TAILSCALE = before;
  }
});
