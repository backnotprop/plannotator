/**
 * The launch switch's routes on the Pi plan, review and annotate servers (`handleLaunchSwitchRequest`, handlers.ts),
 * the Bun servers' mirror (packages/server/launch-switch-route.test.ts), on one temp data folder. What regresses: Pi's
 * route missing or answering another shape than Bun's, or Pi's stamp not counting for the Bun surfaces (the dialog
 * shown twice on one computer).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as bun from "../../../packages/shared/launch-switch.ts";
import { LAUNCH_SWITCH_FILE, configLaunchShownStore, createLaunchSwitch, setLaunchSwitchServiceForTests } from "../generated/launch-switch.ts";
import { handleLaunchSwitchRequest } from "./handlers.ts";

const START = Date.parse("2026-12-02T08:00:00Z");
const DOC = {
  v: 1,
  campaign: "product-hunt-2026",
  on: true,
  url: "https://www.producthunt.com/products/plannotator?launch=plannotator",
  startsAt: "2026-12-02T08:00:00Z",
  endsAt: "2026-12-03T08:00:00Z",
};
const offline = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

const original = process.env.PLANNOTATOR_DATA_DIR;
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-launch-switch-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
  writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(START).toISOString(), doc: DOC }));
  setLaunchSwitchServiceForTests(
    createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/launch.json", shown: configLaunchShownStore, fetch: offline, now: () => START + 1000 }),
  );
});
afterEach(() => {
  setLaunchSwitchServiceForTests(null);
  if (original === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = original;
});

function exchange(path: string, body: unknown = {}, method = "POST") {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method, url: path, headers: {} }) as unknown as IncomingMessage;
  const sent: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      sent.status = status;
      return res;
    },
    end(chunk: string) {
      sent.body = chunk;
    },
  } as unknown as ServerResponse;
  return { req, res, sent, url: new URL(`http://localhost:1234${path}`) };
}

const call = async (path: string, body?: unknown, method?: string) => {
  const x = exchange(path, body, method);
  expect(await handleLaunchSwitchRequest(x.req, x.res, x.url)).toBe(true);
  return { status: x.sent.status, body: JSON.parse(x.sent.body ?? "null") };
};

describe("handleLaunchSwitchRequest (Pi)", () => {
  const bunSide = () =>
    bun.createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/launch.json", shown: bun.configLaunchShownStore, fetch: offline, now: () => START + 2000 });

  test("claim answers what the Bun servers answer, from the same kept copy", async () => {
    const pi = await call("/api/launch-switch/claim");
    expect(pi).toEqual({ status: 200, body: { show: true, campaign: "product-hunt-2026", url: DOC.url } });
    expect(bun.launchSwitchRoute(bunSide(), "POST", "/api/launch-switch/claim", {})).toEqual(pi);
  });

  test("shown on Pi: the Bun surfaces (and Pi again) say no; the answer is kept", async () => {
    expect((await call("/api/launch-switch/shown", { campaign: "product-hunt-2026" })).body).toEqual({ show: true });
    expect(bunSide().claim()).toEqual({ show: false });
    expect((await call("/api/launch-switch/claim")).body).toEqual({ show: false });
    expect((await call("/api/launch-switch/answer", { answer: "dismissed" })).body).toEqual({ ok: true });
    expect(bun.configLaunchShownStore.read("product-hunt-2026")?.answer).toBe("dismissed");
  });

  test("only its own paths; POST only", async () => {
    const other = exchange("/api/image");
    expect(await handleLaunchSwitchRequest(other.req, other.res, other.url)).toBe(false);
    expect((await call("/api/launch-switch/claim", undefined, "GET")).status).toBe(405);
    expect((await call("/api/launch-switch/answer", { answer: "maybe" })).status).toBe(400);
  });
});
