/**
 * The launch switch's routes on the Bun plan, review and annotate servers (`handleLaunchSwitch`, shared-handlers.ts)
 * and the Inbox's action (`launchSwitchAction`, as inbox.ts's `/api/inbox/launch-switch` calls it), on one temp data
 * folder with the real machine-state record; the decisions are packages/shared/launch-switch.test.ts. What regresses:
 * the dialog showing on a second surface of the same computer, a route waiting on a slow or failed site, or the route
 * answering paths that are not its own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import {
  LAUNCH_SWITCH_FILE,
  LAUNCH_SWITCH_REFRESH_MS,
  configLaunchShownStore,
  createLaunchSwitch,
  launchSwitchAction,
  setLaunchSwitchServiceForTests,
} from "@plannotator/shared/launch-switch";
import { handleLaunchSwitch } from "./shared-handlers";

const START = Date.parse("2026-12-02T08:00:00Z");
const DOC = {
  v: 1,
  campaign: "product-hunt-2026",
  on: true,
  url: "https://www.producthunt.com/posts/plannotator?utm_source=plannotator",
  startsAt: "2026-12-02T08:00:00Z",
  endsAt: "2026-12-03T08:00:00Z",
  line: "a key this version does not know: never passed on",
};

const original = process.env.PLANNOTATOR_DATA_DIR;
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "launch-switch-route-"));
  process.env.PLANNOTATOR_DATA_DIR = dir;
  // The kept copy, last asked long ago: every claim starts a background refresh.
  writeFileSync(join(dir, LAUNCH_SWITCH_FILE), JSON.stringify({ checkedAt: new Date(START - 2 * LAUNCH_SWITCH_REFRESH_MS).toISOString(), doc: DOC }));
});
afterEach(() => {
  setLaunchSwitchServiceForTests(null);
  if (original === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = original;
});

/** A site that never answers (or fails at once), counted. */
function site(mode: "hang" | "fail") {
  let calls = 0;
  const fn = ((_url: string, init?: RequestInit) => {
    calls++;
    if (mode === "fail") return Promise.reject(new Error("offline"));
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const surface = (fetcher: typeof fetch, now = START + 1000) =>
  createLaunchSwitch({ dataDir: () => dir, endpoint: () => "http://127.0.0.1:9/launch.json", shown: configLaunchShownStore, fetch: fetcher, now: () => now, timeoutMs: 1500 });

const post = (path: string, body: unknown = {}) => new Request(`http://localhost:1234${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const call = async (path: string, body?: unknown) => {
  const res = await handleLaunchSwitch(post(path, body), new URL(`http://localhost:1234${path}`));
  return { status: res!.status, body: await res!.json() };
};

describe("handleLaunchSwitch", () => {
  test("claim answers from the kept copy at once while the site hangs", async () => {
    const hanging = site("hang");
    setLaunchSwitchServiceForTests(surface(hanging.fn));
    const before = performance.now();
    const claim = await call("/api/launch-switch/claim");
    expect(performance.now() - before).toBeLessThan(500);
    expect(claim).toEqual({ status: 200, body: { show: true, campaign: "product-hunt-2026", url: DOC.url } });
    await new Promise((r) => setTimeout(r, 10));
    expect(hanging.calls()).toBe(1);
  });

  test("a failed site changes nothing: the kept copy still answers", async () => {
    const failing = site("fail");
    setLaunchSwitchServiceForTests(surface(failing.fn));
    await call("/api/launch-switch/claim");
    await new Promise((r) => setTimeout(r, 20));
    expect((await call("/api/launch-switch/claim")).body).toMatchObject({ show: true });
  });

  test("once per computer: shown on a done screen, the Inbox's claim says no (and the other way round)", async () => {
    const quiet = site("fail").fn;
    setLaunchSwitchServiceForTests(surface(quiet));
    const inbox = surface(quiet, START + 2000);
    expect(launchSwitchAction(inbox, "claim", {}).body).toMatchObject({ show: true });
    expect((await call("/api/launch-switch/shown", { campaign: "product-hunt-2026" })).body).toEqual({ show: true });
    expect(loadConfig().launch?.["product-hunt-2026"]?.shownAt).toBeString();
    expect(launchSwitchAction(inbox, "claim", {}).body).toEqual({ show: false });
    expect(launchSwitchAction(inbox, "shown", {}).body).toEqual({ show: false });
    expect((await call("/api/launch-switch/claim")).body).toEqual({ show: false });
    expect((await call("/api/launch-switch/answer", { answer: "opened" })).body).toEqual({ ok: true });
    expect(loadConfig().launch?.["product-hunt-2026"]?.answer).toBe("opened");
  });

  test("the Inbox first: a done screen then says no", async () => {
    const quiet = site("fail").fn;
    setLaunchSwitchServiceForTests(surface(quiet));
    const inbox = surface(quiet);
    expect(launchSwitchAction(inbox, "shown", {}).body).toEqual({ show: true });
    expect(launchSwitchAction(inbox, "answer", { answer: "dismissed" }).body).toEqual({ ok: true });
    expect((await call("/api/launch-switch/claim")).body).toEqual({ show: false });
    expect((await call("/api/launch-switch/shown")).body).toEqual({ show: false });
  });

  test("only its own paths; POST only; answers opened or dismissed", async () => {
    setLaunchSwitchServiceForTests(surface(site("fail").fn));
    expect(await handleLaunchSwitch(post("/api/image"), new URL("http://localhost:1234/api/image"))).toBeNull();
    expect(await handleLaunchSwitch(post("/api/launch-switch/other"), new URL("http://localhost:1234/api/launch-switch/other"))).toBeNull();
    const get = await handleLaunchSwitch(new Request("http://localhost:1234/api/launch-switch/claim"), new URL("http://localhost:1234/api/launch-switch/claim"));
    expect(get!.status).toBe(405);
    expect((await call("/api/launch-switch/answer", { answer: "maybe" })).status).toBe(400);
  });
});
