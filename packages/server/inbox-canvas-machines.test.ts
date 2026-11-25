/**
 * A thread's canvas across linked computers (mark `canvas`), on two real Inboxes linked both ways. The canvas lives
 * with its thread: a window on the other computer reads and saves it through the forward and the door, a save held
 * in the outbox while that computer is away lands once when it is back, the canvas's frames reach the other computer's
 * windows, and a drawing job there is answered from a window here. Starts two Inboxes: CI runs it.
 *
 * What this catches: a far save landing here instead of there, or a partial save dropping what it did not name; a
 * far read or a picture's file not reaching the thread's computer; an agent's change there not reaching the windows
 * here (or arriving without its machine, so the window reads the wrong Inbox); a drawing job there that no window
 * here can answer; a save while that computer is away lost instead of held and applied once; either direction
 * working without the other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** A `tailscale` stand-in that keeps a serve config (as inbox-artifact-pins-machines.test.ts does). */
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

function thread(store: InboxStore, label: string): string {
  const project = store.ensureProject({ name: label, root: `/work/${label}` });
  return store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: `ses_${label}`, name: "Claude Code" }, thread: label, subject: label, body: "Sketch the flow" }).message.thread_id;
}

/** One box as Excalidraw draws it: what a window's save names. */
function box(id: string, x: number, version = 1): Json {
  return { id, type: "rectangle", x, y: 0, width: 120, height: 60, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version, versionNonce: version, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
}
const scene = (elements: Json[]) => ({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });

describe("a thread's canvas across linked computers", () => {
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
  const start = (dataDir: string, ahead = 0) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: scriptedTailscale(), storeNow: () => new Date(Date.now() + ahead) });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  const post = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, ...body }) });
  };
  let keys = 0;
  /** A window's save of another computer's thread: through the forward, keyed, only what changed. */
  const saveThere = (port: number, machine: string, threadId: string, elements: Json[], have: number) =>
    post(port, `/api/inbox/m/${machine}/threads/${threadId}/canvas`, { idempotency_key: `window-canvas-${++keys}`, scene: scene(elements), have, partial: true, window: "cw_testwindow" });
  /** An agent on that computer, through its `plannotator inbox canvas` route. */
  const agent = (port: number, body: Json) =>
    fetch(`${at(port)}/api/inbox/canvas/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, by: { host: "claude-code", session: "ses_canvas_agent", name: "Claude Code" } }) });
  /** Every frame a window of this Inbox hears (`machines=1`: its linked computers' too), as they come. */
  const listen = (port: number) => {
    const frames: { event: string; data: Json }[] = [];
    const stop = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${at(port)}/api/inbox/events?machines=1`, { signal: stop.signal });
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!event || !data) continue;
            try {
              frames.push({ event, data: JSON.parse(data) as Json });
            } catch {
              // Not JSON: not a frame this test reads.
            }
          }
        }
      } catch {
        // Stopped.
      }
    })();
    return { frames, stop: () => stop.abort() };
  };
  const storedOn = async (port: number, threadId: string) => ((await get(port, `/api/inbox/threads/${threadId}/canvas`)).scene.elements as Json[]).map((e) => [e.id, e.x]);

  test("each computer's window draws on the other's thread: reads, saves, files, live changes and drawing jobs both ways; a save while it is away is held and lands once", async () => {
    const dataA = scratch("plannotator-canvas-linked-a-");
    const dataB = scratch("plannotator-canvas-linked-b-");
    const a = await start(dataA);
    let b = await start(dataB, 60_000);
    const hearA = listen(a.port);
    let hearB = listen(b.port);
    try {
      for (const port of [a.port, b.port]) expect((await post(port, "/api/inbox/settings", { canvas: { on: true } })).status).toBe(200);
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const aId = (JSON.parse(readFileSync(join(dataB, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const onA = thread(a.store, "harbor");
      const onB = thread(b.store, "ledger");
      // Each says it has the canvas, so each window offers its pen on the other's threads.
      await waitFor("B's canvas mark on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.marks?.includes("canvas") === true, 20_000);
      await waitFor("A's canvas mark on B", async () => ((await get(b.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === aId)?.marks?.includes("canvas") === true, 20_000);

      // A's window saves on B's thread: it lands on B only, and A reads it back through the forward.
      const saved = await saveThere(a.port, bId, onB, [box("box_one", 0), box("box_two", 300)], 0);
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as Json).rev).toBe(1);
      expect(await storedOn(b.port, onB)).toEqual([["box_one", 0], ["box_two", 300]]);
      expect((await get(a.port, `/api/inbox/m/${bId}/threads/${onB}/canvas`)).rev).toBe(1);
      // A partial save names one thing; the other stays where it was.
      expect((await saveThere(a.port, bId, onB, [box("box_two", 340, 2)], 1)).status).toBe(200);
      expect(await storedOn(b.port, onB)).toEqual([["box_one", 0], ["box_two", 340]]);
      // A picture's file goes ahead of its save, and is read back through the forward.
      const file = { id: "file_harbor_1", mimeType: "image/png", dataURL: "data:image/png;base64,iVBORw0KGgo=", created: 1 };
      const sent = await fetch(`${at(a.port)}/api/inbox/m/${bId}/threads/${onB}/canvas/files?idempotency_key=files-1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: { [file.id]: file } }) });
      expect(sent.status).toBe(200);
      expect((await get(a.port, `/api/inbox/m/${bId}/threads/${onB}/canvas/files/${file.id}`)).file).toEqual(file);
      expect(await get(a.port, `/api/inbox/threads/${onB}/canvas`)).toMatchObject({ code: "thread_not_found" });

      // B's agent changes B's canvas: A's windows hear it, said to be B's.
      expect((await agent(b.port, { thread_id: onB, base: 2, do: [{ add: "note", text: "From the agent on B" }] })).status).toBe(200);
      await waitFor("B's canvas frame on A", () => hearA.frames.some((f) => f.event === "canvas" && f.data.machine === bId && f.data.thread_id === onB && f.data.rev === 3), 15_000);

      // B's agent asks for a picture: a window on A draws it and answers through the forward.
      const asked = agent(b.port, { thread_id: onB, picture: true });
      await waitFor("B's drawing job on A", () => hearA.frames.some((f) => f.event === "canvas-job" && f.data.machine === bId && f.data.thread_id === onB), 7_000);
      const job = hearA.frames.find((f) => f.event === "canvas-job" && f.data.machine === bId)!.data;
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
      const answered = await fetch(`${at(a.port)}/api/inbox/m/${bId}/canvas/jobs/${job.id}?x=0&y=0&w=400&h=200&scale=1&idempotency_key=job-1`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
      expect(answered.status).toBe(200);
      const pictured = (await (await asked).json()) as Json;
      expect(pictured.text).toMatch(/^Picture of the whole canvas: .+\.png/);
      expect(readFileSync(pictured.picture as string)).toEqual(Buffer.from(png));

      // And the other way: B's window saves on A's thread, and B's windows hear A's agent.
      expect((await saveThere(b.port, aId, onA, [box("box_a", 10)], 0)).status).toBe(200);
      expect(await storedOn(a.port, onA)).toEqual([["box_a", 10]]);
      expect((await agent(a.port, { thread_id: onA, base: 1, do: [{ add: "box", text: "From the agent on A" }] })).status).toBe(200);
      await waitFor("A's canvas frame on B", () => hearB.frames.some((f) => f.event === "canvas" && f.data.machine === aId && f.data.thread_id === onA && f.data.rev === 2), 15_000);

      // B away: A's save is held (202), nothing lost; it lands once when B is back, and B's frame then reaches A.
      hearB.stop();
      b.stop();
      await waitFor("B offline on A", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "offline", 30_000);
      const held = await saveThere(a.port, bId, onB, [box("box_three", 600)], 3);
      expect(held.status).toBe(202);
      b = await start(dataB, 60_000);
      hearB = listen(b.port);
      await waitFor("the held save on B", async () => (await storedOn(b.port, onB)).some(([id]) => id === "box_three"), 45_000);
      const after = (await get(b.port, `/api/inbox/threads/${onB}/canvas`)) as Json;
      expect((after.scene.elements as Json[]).filter((e) => e.id === "box_three").length).toBe(1);
      expect((after.scene.elements as Json[]).map((e) => e.id).slice(0, 2)).toEqual(["box_one", "box_two"]);
    } finally {
      hearA.stop();
      hearB.stop();
      a.stop();
      b.stop();
    }
  }, 180_000);
});
