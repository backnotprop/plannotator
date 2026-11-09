/**
 * The live All files stream, in both runtimes: a page that goes away while
 * the server is still reading what git ignores (before anything is attached)
 * must leave nothing behind, and closeAll must stop every heartbeat.
 *
 * Regression guarded: each aborted stream left a subscriber, a 30 s heartbeat
 * and a watcher forever (measured 20 of 20 on both runtimes).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReviewRepoWatch as createBunWatch } from "./review-repo-watch";
import { createReviewRepoWatch as createPiWatch } from "../../apps/pi-extension/server/review-repo-watch";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-repo-watch-"));
  dirs.push(dir);
  return dir;
}
const slowIgnored = () => new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 30));
const options = (extra: Record<string, unknown> = {}) => ({
  mode: "watch" as const,
  signature: async () => "same",
  ignored: slowIgnored,
  onChange: () => {},
  ...extra,
});

class FakeResponse extends EventEmitter {
  destroyed = false;
  writeHead() {}
  write() {
    return true;
  }
}

describe("review repo watch (Bun)", () => {
  test("streams aborted during the ignore read attach nothing (20 of 20)", async () => {
    const watch = createBunWatch();
    const dir = root();
    const pending: Promise<Response>[] = [];
    for (let i = 0; i < 20; i += 1) {
      const controller = new AbortController();
      pending.push(watch.stream(dir, options({ signal: controller.signal })));
      controller.abort();
    }
    await Promise.all(pending);
    expect(watch.stats()).toEqual({ lives: 0, subscribers: 0, heartbeats: 0 });
    watch.closeAll();
  });

  test("an attached stream is released on abort; closeAll stops every heartbeat", async () => {
    const watch = createBunWatch();
    const dir = root();
    const controller = new AbortController();
    const response = await watch.stream(dir, options({ mode: "poll", pollMs: 60_000, signal: controller.signal }));
    expect(response.status).toBe(200);
    await watch.stream(dir, options({ mode: "poll", pollMs: 60_000 }));
    expect(watch.stats()).toEqual({ lives: 1, subscribers: 2, heartbeats: 2 });
    controller.abort();
    expect(watch.stats()).toEqual({ lives: 1, subscribers: 1, heartbeats: 1 });
    watch.closeAll();
    expect(watch.stats()).toEqual({ lives: 0, subscribers: 0, heartbeats: 0 });
  });
});

describe("review repo watch (Pi)", () => {
  test("responses closed during the ignore read attach nothing (20 of 20)", async () => {
    const watch = createPiWatch();
    const dir = root();
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = new FakeResponse();
      pending.push(watch.stream(res as never, dir, options()));
      res.destroyed = true;
      res.emit("close");
    }
    await Promise.all(pending);
    expect(watch.stats()).toEqual({ lives: 0, subscribers: 0, heartbeats: 0 });
    watch.closeAll();
  });

  test("an attached stream is released on close; closeAll stops every heartbeat", async () => {
    const watch = createPiWatch();
    const dir = root();
    const first = new FakeResponse();
    await watch.stream(first as never, dir, options({ mode: "poll", pollMs: 60_000 }));
    await watch.stream(new FakeResponse() as never, dir, options({ mode: "poll", pollMs: 60_000 }));
    expect(watch.stats()).toEqual({ lives: 1, subscribers: 2, heartbeats: 2 });
    first.emit("close");
    expect(watch.stats()).toEqual({ lives: 1, subscribers: 1, heartbeats: 1 });
    watch.closeAll();
    expect(watch.stats()).toEqual({ lives: 0, subscribers: 0, heartbeats: 0 });
  });
});
