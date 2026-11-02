/**
 * The daily ping on a real Inbox, in a temp data dir, against a loopback
 * receiver: a start checks it (and sends when the notice was shown on an
 * earlier day); Settings → About's switch writes config.json `telemetry`;
 * the one-time notice is claimed once, only by a page on this computer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEMETRY_CI_VARS } from "@plannotator/shared/config";
import { startInboxServer, type InboxServer } from "./inbox";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_TELEMETRY_URL", "DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const servers: InboxServer[] = [];
let receiver: ReturnType<typeof Bun.serve>;
let bodies: string[];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ["DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS]) delete process.env[key];
  bodies = [];
  receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return new Response(null, { status: 204 });
    },
  });
  process.env.PLANNOTATOR_TELEMETRY_URL = `http://127.0.0.1:${receiver.port}`;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  receiver.stop(true);
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function world(ping?: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-daily-ping-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  // The Inbox reads config.json through the env, even when handed dataDir.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  if (ping) writeFileSync(join(dataDir, "ping.json"), JSON.stringify(ping));
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, version: "0.30.0" });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: Record<string, unknown> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const telemetry = async () => ((await (await fetch(`${base}/api/inbox/settings`)).json()) as { telemetry: { on: boolean; config: boolean; env: string | null; notice_due: boolean } }).telemetry;
  return { dataDir, post, telemetry };
}

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
}

describe("the Inbox and the daily ping", () => {
  test("a start checks it: one ping once the notice was shown on an earlier day", async () => {
    const { dataDir } = await world({ firstWeek: "2026-01-05", noticeDay: yesterday() });
    await until(() => bodies.length > 0 && JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).lastDay !== undefined);
    expect(bodies).toEqual(['{"version":"0.30.0","age":4}']);
    expect(JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).lastDay).toBe(today());
  });

  test("the notice: due until a page claims it, and only the first claim shows it; no ping that day", async () => {
    const { dataDir, post, telemetry } = await world();
    expect(await telemetry()).toEqual({ on: true, config: true, env: null, notice_due: true });
    expect((await post("/api/inbox/ping-notice", { serverSession: "another" })).status).toBe(409);
    const answers = await Promise.all([post("/api/inbox/ping-notice"), post("/api/inbox/ping-notice")]);
    const shows = await Promise.all(answers.map(async (a) => ((await a.json()) as { show: boolean }).show));
    expect(shows.filter(Boolean)).toHaveLength(1);
    expect((await telemetry()).notice_due).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")).noticeDay).toBe(today());
    await Bun.sleep(200);
    expect(bodies).toEqual([]);
  });

  test("Settings → About's switch writes config.json telemetry; the environment's off locks it", async () => {
    const { dataDir, post, telemetry } = await world();
    expect((await post("/api/inbox/settings", { telemetry: "no" })).status).toBe(422);
    const saved = (await (await post("/api/inbox/settings", { telemetry: false })).json()) as { telemetry: { on: boolean; notice_due: boolean } };
    expect(saved.telemetry).toMatchObject({ on: false, notice_due: false });
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).telemetry).toBe(false);
    expect(((await (await post("/api/inbox/ping-notice")).json()) as { show: boolean }).show).toBe(false);
    await post("/api/inbox/settings", { telemetry: true });
    process.env.DO_NOT_TRACK = "1";
    expect(await telemetry()).toEqual({ on: false, config: true, env: "DO_NOT_TRACK", notice_due: false });
  });
});
