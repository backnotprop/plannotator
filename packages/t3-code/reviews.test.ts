import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3Credentials } from "./auth";
import { T3Delivery } from "./delivery";
import { T3_FAILED_REVIEW_KEEP_MS, T3_OPEN_ABANDONED_MS, T3_REVIEW_KEEP_MS, T3Reviews } from "./reviews";
import { T3SessionBridge } from "./session-bridge";
import { T3Thread } from "./t3-client";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-t3-reviews-"));
  roots.push(root);
  const directory = join(root, "reviews");
  mkdirSync(directory);
  const thread = new T3Thread({ async call() { throw new Error("T3 is not reached in these tests"); } }, "thread-a");
  const credentials = new T3Credentials(root, new URL("http://127.0.0.1:3773/mcp"));
  const record = (id: string, fields: Record<string, unknown>) => {
    mkdirSync(join(directory, id), { recursive: true });
    writeFileSync(join(directory, id, "launch.json"), JSON.stringify({ id, kind: "annotate", subject: "notes.md", createdAt: Date.now(), token: "t".repeat(43), ...fields }));
  };
  const read = (id: string) => JSON.parse(readFileSync(join(directory, id, "launch.json"), "utf8")) as Record<string, unknown>;
  const open = () => new T3Reviews(directory, ["plannotator"], root, root, new T3SessionBridge(thread), new T3Delivery(thread, credentials), () => {});
  return { directory, record, read, open };
}

/** A pid that existed and is gone. */
function deadPid(): number {
  return Bun.spawnSync(["/bin/sh", "-c", "exit 0"]).pid;
}

async function tick(reviews: T3Reviews): Promise<void> {
  await (reviews as unknown as { tick(): Promise<void> }).tick();
}

describe("T3 review records", () => {
  test("a launch that never came up does not keep the worker alive, and the next worker does not inherit it", async () => {
    // What regresses: a worker killed while opening a review left a record
    // with no port; it was adopted by every later worker and idle() stayed false forever.
    const w = world();
    w.record("pn-aaaaa1", { pid: deadPid() });                                     // its CLI died too
    w.record("pn-aaaaa2", {});                                                     // killed before the CLI started
    w.record("pn-aaaaa3", { pid: process.pid, createdAt: Date.now() - T3_OPEN_ABANDONED_MS - 1000 }); // alive, never ready
    w.record("pn-aaaaa4", { pid: process.pid });                                   // still within its opening window
    w.record("pn-aaaaa5", { pid: deadPid(), port: 1, url: "http://127.0.0.1:1" }); // opened, server gone
    const reviews = w.open();
    await tick(reviews);
    for (const id of ["pn-aaaaa1", "pn-aaaaa2", "pn-aaaaa3", "pn-aaaaa5"]) {
      expect(w.read(id).failure).toBeString();
      expect(w.read(id).token).toBe("");
    }
    expect(w.read("pn-aaaaa4").failure).toBeUndefined();
    expect(reviews.idle()).toBe(false);
    reviews.dispose();
    const later = w.open();
    expect((later as unknown as { reviews: Map<string, unknown> }).reviews.size).toBe(1);
    later.dispose();
    rmSync(join(w.directory, "pn-aaaaa4"), { recursive: true });
    const clean = w.open();
    await tick(clean);
    expect(clean.idle()).toBe(true);
    clean.dispose();
  });

  test("settled reviews lose their bridge token at once and their folder after the keep window", () => {
    const w = world();
    const now = Date.now();
    w.record("pn-bbbbb1", { delivered: true, settledAt: now - T3_REVIEW_KEEP_MS - 1000 });
    w.record("pn-bbbbb2", { delivered: true, settledAt: now - 1000 });
    w.record("pn-bbbbb3", { failure: "refused", settledAt: now - T3_REVIEW_KEEP_MS - 1000 });
    w.record("pn-bbbbb4", { failure: "refused", settledAt: now - T3_FAILED_REVIEW_KEEP_MS - 1000 });
    w.record("pn-bbbbb5", { pid: process.pid });
    writeFileSync(join(w.directory, "pn-bbbbb2", "feedback.md"), "Feedback Claude reads\n");
    const reviews = w.open();
    expect(existsSync(join(w.directory, "pn-bbbbb1"))).toBe(false);
    expect(w.read("pn-bbbbb2").token).toBe("");
    expect(readFileSync(join(w.directory, "pn-bbbbb2", "feedback.md"), "utf8")).toBe("Feedback Claude reads\n");
    expect(w.read("pn-bbbbb3").token).toBe("");
    expect(existsSync(join(w.directory, "pn-bbbbb4"))).toBe(false);
    expect(w.read("pn-bbbbb5").token).toBe("t".repeat(43));
    reviews.prune(now + T3_REVIEW_KEEP_MS + 5000);
    expect(existsSync(join(w.directory, "pn-bbbbb2"))).toBe(false);
    expect(existsSync(join(w.directory, "pn-bbbbb5"))).toBe(true);
    reviews.dispose();
  });
});
