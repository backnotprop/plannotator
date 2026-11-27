/**
 * Pinned artifacts and the Artifacts wall across linked machines (inbox-artifacts-merged.ts, the `?machines=1` reads
 * of inbox-artifact-pins.ts), on two real stores without a server: this Inbox's and a linked machine's, read through
 * the same door answer that machine's `GET artifacts` gives.
 *
 * What can regress: a linked machine's pins or artifacts missing from the merged reads, or carrying no machine (so a
 * press or a tile goes to the wrong store); the Wall's order across machines, or paging that skips or repeats a row
 * once each machine has its own offset; the counts the bar shows not adding up; an asleep machine's rows dropped
 * instead of shown as last read; a far row of a thread this Inbox holds taken; a hostile far answer read as it came;
 * the plain reads (no `machines=1`) taking far rows.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAttachment } from "@plannotator/core/inbox-types";
import type { InboxArtifactsPage } from "@plannotator/core/inbox-artifact-pins";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxArtifactPins, inboxArtifactsPage } from "./inbox-artifact-pins";
import { farWallPage, mergeArtifactPins, readFarArtifactPins, readFarWall, readWallCursor, type FarWall, type WallPeer } from "./inbox-artifacts-merged";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const MAC = `ibx_01K${"0".repeat(22)}M`;
const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });

function file(name: string, kind: InboxAttachment["kind"]): InboxAttachment {
  const at = new Date().toISOString();
  return { id: inboxId("att"), path: `/nowhere/${name}`, named_path: null, name, kind, sent_sha256: "0".repeat(64), size: 10, sent_at: at, sent_mtime: at };
}

/** A store whose messages come one minute apart from `start`, each with `per` pictures. */
function machineStore(label: string, start: string, messages: number, per = 1) {
  const dir = mkdtempSync(join(tmpdir(), `plannotator-wall-${label}-`));
  roots.push(dir);
  let t = Date.parse(start);
  const store = InboxStore.open(dir, { now: () => new Date((t += 60_000)) });
  const project = store.ensureProject({ name: label, root: `/work/${label}` });
  let thread: string | null = null;
  const files: InboxAttachment[] = [];
  for (let i = 0; i < messages; i += 1) {
    const attachments = Array.from({ length: per }, (_, j) => file(`${label}-${i}-${j}.png`, "image"));
    files.push(...attachments);
    const sent = store.sendMessage({ project_id: project.id, author: agent(`ses_${label}`), ...(thread ? { reply_to: thread } : { thread: label, subject: label }), body: `${label} ${i}`, attachments }).message;
    thread ??= sent.thread_id;
  }
  return { store, thread: thread!, files };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** This Inbox's routes, with one linked machine whose door answers from `far` (or, `away`, with nothing). */
function routes(own: InboxStore, far: InboxStore, state: { away: boolean } = { away: false }) {
  const peer: WallPeer = {
    id: MAC,
    get state() {
      return state.away ? "offline" : "online";
    },
    request: async (_route, search) => json(await inboxArtifactsPage(far, new URL(`http://mac/api/inbox/artifacts${search}`))),
  };
  return createInboxArtifactPins({
    store: own,
    serverSession: "s",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json,
    machines: { pinLists: () => [{ machine: MAC, pins: far.artifactPins() }], walls: async (searchOf) => [await readFarWall(peer, searchOf(MAC))] },
  });
}

const read = async (route: ReturnType<typeof routes>, path: string) => (await (await route.route(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`)))!.json()) as InboxArtifactsPage & { machines?: Record<string, { away: boolean }>; pins?: unknown };

describe("the merged pins", () => {
  test("this machine's first, then the linked machine's with its machine; the plain read stays this Inbox's own", async () => {
    const here = machineStore("here", "2026-11-20T09:00:00.000Z", 1);
    const there = machineStore("there", "2026-11-20T09:30:00.000Z", 2);
    here.store.setArtifactPinned(here.thread, here.files[0]!.id, true);
    there.store.setArtifactPinned(there.thread, there.files[1]!.id, true);
    const r = routes(here.store, there.store);
    const merged = (await read(r, "/api/inbox/artifact-pins?machines=1")).pins as { key: string; thread_id: string; machine?: string }[];
    expect(merged.map((pin) => [pin.key, pin.thread_id, pin.machine ?? null])).toEqual([
      [here.files[0]!.id, here.thread, null],
      [there.files[1]!.id, there.thread, MAC],
    ]);
    expect(((await read(r, "/api/inbox/artifact-pins")).pins as unknown[]).length).toBe(1);
  });

  test("a far pin of a thread this Inbox holds, or a key already listed, is never taken; a far list's junk is dropped", () => {
    const own = [{ key: "att_a", thread_id: "msg_01K000000000000000000000HA", pinned_at: "2026-11-20T09:00:00.000Z" }];
    const far = readFarArtifactPins([
      { key: "att_a", thread_id: "msg_01K000000000000000000000FA", pinned_at: "2026-11-20T09:01:00.000Z" },
      { key: "att_b", thread_id: "msg_01K000000000000000000000HA", pinned_at: "2026-11-20T09:02:00.000Z" },
      { key: "att_c", thread_id: "msg_01K000000000000000000000FA", pinned_at: "2026-11-20T09:03:00.000Z" },
      { key: "../../etc", thread_id: "msg_01K000000000000000000000FA", pinned_at: "x" },
      { key: "att_d", thread_id: "prj_nope", pinned_at: "x" },
      null,
      "att_e",
    ]);
    expect(far.map((pin) => pin.key)).toEqual(["att_a", "att_b", "att_c"]);
    const merged = mergeArtifactPins(own, [{ machine: MAC, pins: far }], (threadId) => threadId === "msg_01K000000000000000000000HA");
    expect(merged.map((pin) => [pin.key, pin.machine ?? null])).toEqual([
      ["att_a", null],
      ["att_c", MAC],
    ]);
    // An older Inbox's list carries none.
    expect(readFarArtifactPins(undefined)).toEqual([]);
  });
});

describe("the merged Wall", () => {
  test("both machines' artifacts newest first, each far one with its machine; paging by each machine's own offset neither skips nor repeats", async () => {
    // Interleaved in time: here at :01, :03, …; there at :02, :04, … with two pictures a message.
    const here = machineStore("here", "2026-11-20T09:00:00.000Z", 7);
    const there = machineStore("there", "2026-11-20T09:00:30.000Z", 6, 2);
    const r = routes(here.store, there.store);
    const one = await read(r, "/api/inbox/artifacts?machines=1&limit=200");
    expect(one.artifacts.length).toBe(7 + 12);
    expect(one.total).toBe(19);
    expect(one.next_cursor).toBeNull();
    expect(one.counts).toEqual({ all: 19, pinned: 0, types: { images: 19, videos: 0, pages: 0, documents: 0, other: 0 } });
    // Newest message first across both; inside a message, its own order.
    const ats = one.artifacts.map((row) => row.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(one.artifacts.filter((row) => row.machine === MAC).map((row) => row.key)).toEqual((await inboxArtifactsPage(there.store, new URL("http://x/a?limit=200"))).artifacts.map((row) => row.key));
    expect(one.artifacts.filter((row) => !row.machine).every((row) => row.thread_id === here.thread)).toBe(true);

    // Pages of 4, each from the cursor the last one gave, read the same rows in the same order.
    const paged: string[] = [];
    let cursor: string | null = "";
    for (let pages = 0; cursor !== null && pages < 20; pages += 1) {
      const page = await read(r, `/api/inbox/artifacts?machines=1&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      paged.push(...page.artifacts.map((row) => row.key));
      expect(page.total).toBe(19);
      cursor = page.next_cursor;
    }
    expect(paged).toEqual(one.artifacts.map((row) => row.key));

    // The plain read stays this Inbox's own, and a cursor that does not read as one is refused.
    expect((await read(r, "/api/inbox/artifacts?limit=200")).artifacts.every((row) => !row.machine)).toBe(true);
    expect(readWallCursor("4,ibx_nope:2")).toBeNull();
    expect(readWallCursor(`x,${MAC}:2`)).toBeNull();
  });

  test("Pinned: a pin on either machine is on the Pinned page and in its count", async () => {
    const here = machineStore("here", "2026-11-20T09:00:00.000Z", 2);
    const there = machineStore("there", "2026-11-20T09:00:30.000Z", 2);
    here.store.setArtifactPinned(here.thread, here.files[0]!.id, true);
    there.store.setArtifactPinned(there.thread, there.files[1]!.id, true);
    const r = routes(here.store, there.store);
    const pinned = await read(r, "/api/inbox/artifacts?machines=1&pinned=1");
    expect(pinned.artifacts.map((row) => [row.key, row.machine ?? null])).toEqual([
      [there.files[1]!.id, MAC],
      [here.files[0]!.id, null],
    ]);
    expect(pinned.artifacts.every((row) => row.pinned_at !== null)).toBe(true);
    const all = await read(r, "/api/inbox/artifacts?machines=1");
    expect(all.counts.all).toBe(4);
    expect(all.counts.pinned).toBe(2);
  });

  test("the linked machine asleep: its rows as last read, marked away; a machine never read adds nothing", async () => {
    const here = machineStore("here", "2026-11-20T09:00:00.000Z", 1);
    const there = machineStore("there", "2026-11-20T09:00:30.000Z", 2);
    const state = { away: true };
    const r = routes(here.store, there.store, state);
    const never = await read(r, "/api/inbox/artifacts?machines=1");
    expect(never.artifacts.length).toBe(1);
    expect(never.machines).toEqual({ [MAC]: { away: true } });
    state.away = false;
    const awake = await read(r, "/api/inbox/artifacts?machines=1");
    expect(awake.artifacts.length).toBe(3);
    state.away = true;
    const asleep = await read(r, "/api/inbox/artifacts?machines=1");
    expect(asleep.artifacts.map((row) => row.key)).toEqual(awake.artifacts.map((row) => row.key));
    expect(asleep.machines).toEqual({ [MAC]: { away: true } });
  });

  test("an older door (404) adds nothing and is not away; a far row of a thread this Inbox holds is passed over; a hostile answer is read by name", async () => {
    const older: WallPeer = { id: MAC, state: "online", request: async () => json({ code: "device_route_not_found" }, 404) };
    expect(await readFarWall(older, "?limit=60")).toEqual({ machine: MAC, page: null, away: false });

    const here = machineStore("here", "2026-11-20T09:00:00.000Z", 1);
    const hostile = farWallPage(MAC, {
      artifacts: [
        { key: "att_x", thread_id: here.thread, message_id: "msg_x", at: "2026-11-21T00:00:00.000Z" },
        { key: "att_y", thread_id: "msg_01K000000000000000000000FA", message_id: "msg_y", at: "2026-11-21T00:00:00.000Z", machine: "ibx_spoofed" },
        { key: "<script>", thread_id: "msg_01K000000000000000000000FA", message_id: "msg_z", at: "x" },
      ],
      next_cursor: 5,
      total: -3,
      counts: { all: "lots", pinned: 1.5, types: { images: 2, evil: 9 } },
    })!;
    expect(hostile.artifacts.map((row) => [row.key, row.machine])).toEqual([
      ["att_x", MAC],
      ["att_y", MAC],
    ]);
    expect(hostile.next_cursor).toBeNull();
    expect(hostile.total).toBe(2);
    expect(hostile.counts).toEqual({ all: 0, pinned: 0, types: { images: 2, videos: 0, pages: 0, documents: 0, other: 0 } });

    const far: FarWall = { machine: MAC, page: hostile, away: false };
    const r = createInboxArtifactPins({ store: here.store, serverSession: "s", readBody: async () => ({}), json, machines: { pinLists: () => [], walls: async () => [far] } });
    const merged = await read(r, "/api/inbox/artifacts?machines=1");
    expect(merged.artifacts.map((row) => row.key)).toEqual(["att_y", here.files[0]!.id]);
  });
});
