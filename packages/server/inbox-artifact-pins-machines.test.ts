/**
 * Pinned artifacts across linked machines, on two real Inboxes linked both ways (approval "inbox-artifact-stars";
 * the owner, 2026-11-24: "Whatever I can do on one computer, I should be able to do across computers"). A pin lives
 * on its thread's machine, as a star does: the window pins through the forward and the outbox, and that machine's
 * list carries it back. Starts two Inboxes: CI runs it.
 *
 * What this catches: a pin of a linked machine's artifact not landing in that machine's store, or landing here; the
 * merged pins or the merged Wall without the other machine's pins and artifacts, or without their machine (so a
 * press or a tile would go to the wrong store); a pin made on the other computer not reaching this one; unpin not
 * landing; the other machine asleep: its pins dropped instead of shown as last known, or a press lost instead of
 * held and applied when it is back; and either direction working without the other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** A `tailscale` stand-in that keeps a serve config (as inbox-archived-machines.test.ts does). */
function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`laptop.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://laptop.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
}

function file(name: string): InboxAttachment {
  const at = new Date().toISOString();
  return { id: inboxId("att"), path: `/nowhere/${name}`, named_path: null, name, kind: "image", sent_sha256: "0".repeat(64), size: 10, sent_at: at, sent_mtime: at };
}

/** A thread with two pictures in a store, as an agent there would send it. */
function threadWithPictures(store: InboxStore, label: string) {
  const project = store.ensureProject({ name: label, root: `/work/${label}` });
  const pictures = [file(`${label}-a.png`), file(`${label}-b.png`)];
  const message = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: `ses_${label}`, name: "Claude Code" }, thread: label, subject: label, body: "Pictures", attachments: pictures }).message;
  return { thread: message.thread_id, pictures };
}

describe("pinned artifacts across linked machines", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  // B's store clock runs a minute ahead, so its messages are always the newer ones (a fast runner sends both in one millisecond).
  const start = (dataDir: string, ahead = 0) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(), storeNow: () => new Date(Date.now() + ahead) });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  const post = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, ...body }) });
  };
  let keys = 0;
  /** A press in this Inbox's window on another machine's artifact: through the forward, keyed as the window keys it. */
  const pinThere = (port: number, machine: string, thread: string, key: string, pinned: boolean) => post(port, `/api/inbox/m/${machine}/artifact-pins`, { idempotency_key: `window-artifact-pin-${++keys}`, thread_id: thread, key, pinned });
  /** The merged pins: each key and the machine that keeps it (null: this one). */
  const mergedPins = async (port: number) => ((await get(port, "/api/inbox/artifact-pins?machines=1")).pins as Json[]).map((pin) => [pin.key, pin.machine ?? null]);
  const wall = async (port: number, query = "") => get(port, `/api/inbox/artifacts?machines=1${query}`);

  test("a pin on B's artifact from A lands on B and shows on both; B's own pin reaches A; A's reaches B; B asleep, its pins stay and a press is held until it is back", async () => {
    const dataA = scratch("plannotator-artifact-pins-linked-a-");
    const dataB = scratch("plannotator-artifact-pins-linked-b-");
    const a = await start(dataA);
    let b = await start(dataB, 60_000);
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const aId = (JSON.parse(readFileSync(join(dataB, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;

      const onA = threadWithPictures(a.store, "studio");
      const onB = threadWithPictures(b.store, "macbook");
      const [bFirst, bSecond] = onB.pictures.map((p) => p.id) as [string, string];

      // A's Wall holds both machines' artifacts, B's with its machine, newest first.
      await waitFor("B's artifacts on A's Wall", async () => ((await wall(a.port)).artifacts as Json[]).length === 4, 15_000);
      const all = await wall(a.port);
      expect((all.artifacts as Json[]).map((row) => [row.key, row.machine ?? null])).toEqual([
        [bFirst, bId],
        [bSecond, bId],
        [onA.pictures[0]!.id, null],
        [onA.pictures[1]!.id, null],
      ]);
      expect(all.counts.all).toBe(4);

      // Pin from A: B's store keeps it, A's does not; A's merged pins and Wall's Pinned show it at once, B's own read too.
      expect((await pinThere(a.port, bId, onB.thread, bFirst, true)).status).toBe(200);
      expect(b.store.artifactPins().map((pin) => pin.key)).toEqual([bFirst]);
      expect(a.store.artifactPins()).toEqual([]);
      expect(await mergedPins(a.port)).toEqual([[bFirst, bId]]);
      expect(((await wall(a.port, "&pinned=1")).artifacts as Json[]).map((row) => [row.key, row.machine])).toEqual([[bFirst, bId]]);
      expect(((await get(b.port, "/api/inbox/artifact-pins")).pins as Json[]).map((pin) => pin.key)).toEqual([bFirst]);

      // Pinned in B's own window: A hears it (B's `artifact-pins` event) without a press there.
      expect((await post(b.port, "/api/inbox/artifact-pins", { thread_id: onB.thread, key: bSecond, pinned: true })).status).toBe(200);
      await waitFor("B's own pin on A", async () => (await mergedPins(a.port)).length === 2, 15_000);
      expect(await mergedPins(a.port)).toEqual([
        [bFirst, bId],
        [bSecond, bId],
      ]);

      // And the other way: A's own pin shows on B, with A as its machine.
      expect((await post(a.port, "/api/inbox/artifact-pins", { thread_id: onA.thread, key: onA.pictures[0]!.id, pinned: true })).status).toBe(200);
      await waitFor("A's pin on B", async () => JSON.stringify(await mergedPins(b.port)).includes(aId), 15_000);
      expect(await mergedPins(b.port)).toEqual([
        [bFirst, null],
        [bSecond, null],
        [onA.pictures[0]!.id, aId],
      ]);

      // Unpin from A lands on B.
      expect((await pinThere(a.port, bId, onB.thread, bSecond, false)).status).toBe(200);
      expect(b.store.artifactPins().map((pin) => pin.key)).toEqual([bFirst]);
      expect(await mergedPins(a.port)).toEqual([
        [onA.pictures[0]!.id, null],
        [bFirst, bId],
      ]);

      // B asleep: A still shows B's pin and its Wall rows (as last known); a press is held (202), applied when B is back.
      b.stop();
      await waitFor("B offline on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "offline", 30_000);
      expect(await mergedPins(a.port)).toEqual([
        [onA.pictures[0]!.id, null],
        [bFirst, bId],
      ]);
      const asleep = await wall(a.port);
      expect((asleep.artifacts as Json[]).filter((row) => row.machine === bId).length).toBe(2);
      expect(asleep.machines).toEqual({ [bId]: { away: true } });
      expect((await pinThere(a.port, bId, onB.thread, bSecond, true)).status).toBe(202);
      b = await start(dataB, 60_000);
      await waitFor("the held pin on B", () => b.store.artifactPins().some((pin) => pin.key === bSecond), 45_000);
      await waitFor("the held pin on A", async () => (await mergedPins(a.port)).length === 3, 15_000);
    } finally {
      a.stop();
      b.stop();
    }
  }, 150_000);
});
