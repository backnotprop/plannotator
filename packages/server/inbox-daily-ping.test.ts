/**
 * The daily ping on a real Inbox, in a temp data dir, against a loopback
 * receiver: a start sends the Inbox's ping (tool "inbox") with no notice and
 * no wait; NO_ANON_PING and the do-not-track convention stop it.
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

async function world(ping?: Record<string, unknown>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-daily-ping-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  if (ping) writeFileSync(join(dataDir, "ping.json"), JSON.stringify(ping));
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, version: "0.30.0" });
  servers.push(server);
  return { dataDir };
}

const today = () => new Date().toISOString().slice(0, 10);
const pingFile = (dataDir: string) => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")) as { day?: string; sent?: string[] };
  } catch {
    return {};
  }
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
}

describe("the Inbox and the daily ping", () => {
  test("a start sends the Inbox's ping at once; a plan ping earlier today makes it not the day's first", async () => {
    const { dataDir } = await world({ firstWeek: "2026-01-05", day: today(), sent: ["plan"] });
    await until(() => pingFile(dataDir).sent?.includes("inbox") === true);
    expect(bodies).toEqual(['{"version":"0.30.0","age_week":4,"tool":"inbox","first":0,"favicon":"none"}']);
    expect(pingFile(dataDir)).toMatchObject({ day: today(), sent: ["inbox", "plan"] });
  });

  for (const [name, value] of [
    ["NO_ANON_PING", "1"],
    ["DO_NOT_TRACK", "1"],
  ] as const) {
    test(`${name}=${value} sends nothing and writes nothing`, async () => {
      process.env[name] = value;
      const { dataDir } = await world();
      await Bun.sleep(300);
      expect(bodies).toEqual([]);
      expect(pingFile(dataDir)).toEqual({});
    });
  }
});
