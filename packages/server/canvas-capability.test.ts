/**
 * The thread canvas on the Inbox's capability seam, in process (no Inbox started, the MCP server built and never
 * served), on a scratch data dir. What regresses if these fail:
 * - off, the canvas shows: an `/api/canvas` route answers, the settings name it, a window's stream gets its frames,
 *   or the agent's tool text or read_thread mention it;
 * - on, a route answers anything but the owner's window on this computer;
 * - a stale page's save overwrites the canvas instead of a 409, or a stale layout replaces the current one;
 * - a link the person (or a page) put on an element is kept, or an element list with no bound is taken;
 * - bytes that are not a picture are kept as one;
 * - a window is not told a canvas changed, or keeps being told after its stream stopped;
 * - read_thread does not point the agent at what the person did, or points when they did nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_INSTRUCTIONS_LINE, canvasChangedLine } from "@plannotator/core/canvas-skill";
import type { CanvasElement, CanvasParts } from "@plannotator/core/canvas-scene";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createCanvasCapability } from "./canvas-capability";
import {
  capabilitiesInstructions,
  capabilitiesThreadLines,
  capabilitiesWire,
  capabilitiesFrame,
  routeInboxCapabilities,
  streamInboxCapabilities,
  type InboxCapability,
  type InboxCapabilityGuard,
} from "./inbox-capability";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

let dataDir = "";
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "canvas-capability-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedEnv;
  rmSync(dataDir, { recursive: true, force: true });
});

const ID = "msg_01M7NQW4XEMG1FHP7SNPFAAE0Y";
const SESSION = "srv-session-1";
const owner: InboxCapabilityGuard = { local: true, crossSite: () => null, serverSession: SESSION };
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BOARD = '<div id="app" data-frame="phone">\n <div id="row-1"><p id="row-1-label">Push alerts</p></div>\n</div>\n';
const PARTS: CanvasParts = {
  app: { parent: null, kind: "frame" },
  "row-1": { parent: "app", kind: "box", words: "Push alerts" },
  "row-1-label": { parent: "row-1", kind: "text", words: "Push alerts" },
};
const el = (id: string, x: number, y: number, w: number, h: number, extra: Partial<CanvasElement> = {}): CanvasElement => ({ id, type: "rectangle", x, y, width: w, height: h, customData: { part: id }, ...extra });
const LAID_OUT: CanvasElement[] = [el("app", 0, 0, 390, 800), el("row-1", 10, 100, 370, 50), el("row-1-label", 20, 115, 100, 20, { type: "text", text: "Push alerts" })];

const switchTo = (on: boolean) => writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxCanvas: on }));

function world() {
  let changed = 0;
  const capability = createCanvasCapability({ dataDir, changed: () => changed++ });
  const list: InboxCapability[] = [capability];
  const route = async (method: string, path: string, body?: unknown, guard = owner) => {
    const req = new Request(`http://127.0.0.1:1${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    const res = await routeInboxCapabilities(list, req, new URL(req.url), guard);
    return { status: res?.status ?? null, body: res && res.headers.get("Content-Type")?.includes("json") ? ((await res.json()) as Record<string, unknown>) : null };
  };
  /** An agent version, laid out by "the window". */
  const drawn = async () => {
    const s = capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    const r = await route("POST", `/api/canvas/${ID}/layout`, { version: s.agentVersion, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    expect(r.status).toBe(200);
    return r.body!.rev as number;
  };
  return { capability, list, route, drawn, changed: () => changed };
}

describe("off", () => {
  test("every canvas route is the unknown-route 404 and the settings say nothing of it", async () => {
    const { list, route, capability } = world();
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    for (const on of [null, false]) {
      if (on !== null) switchTo(on);
      for (const [method, path] of [
        ["GET", "/api/canvas/pending"],
        ["GET", `/api/canvas/${ID}`],
        ["GET", `/api/canvas/${ID}/picture`],
        ["GET", `/api/canvas/${ID}/versions/1`],
        ["POST", `/api/canvas/${ID}/scene`],
        ["POST", `/api/canvas/${ID}/layout`],
      ] as const) {
        const r = await route(method, path, method === "POST" ? { base: 0, elements: [], files: {} } : undefined);
        expect([path, r.status, r.body]).toEqual([path, 404, { error: "Not found", code: "not_found" }]);
      }
      expect(capabilitiesWire(list)).toEqual({});
      expect(capabilitiesFrame(list, false)).toEqual({});
      expect(capabilitiesInstructions(list)).toEqual([]);
    }
    // The frame of the change that turned it off says so, once.
    expect(capabilitiesFrame(list, true)).toEqual({ canvas: { on: false } });
  });

  test("off, a window's stream gets no frame; on, it does, and stop ends it", async () => {
    const { list, capability } = world();
    const frames: string[] = [];
    const off = streamInboxCapabilities(list, (f) => frames.push(f), true);
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    await new Promise((r) => setTimeout(r, 500));
    expect(frames).toEqual([]);
    off.stop();

    switchTo(true);
    const remote = streamInboxCapabilities(list, (f) => frames.push(`remote:${f}`), false);
    const local = streamInboxCapabilities(list, (f) => frames.push(f), true);
    // The server tells the CLI a window can lay out.
    expect(existsSync(join(dataDir, "canvases", ".windows.json"))).toBe(true);
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    await new Promise((r) => setTimeout(r, 500));
    expect(frames).toEqual([`event: canvas\ndata: ${JSON.stringify({ ids: [ID] })}\n\n`]);

    local.stop();
    remote.stop();
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    await new Promise((r) => setTimeout(r, 500));
    expect(frames).toHaveLength(1);
  });

  test("turning it off through sync stops a running stream", async () => {
    const { list, capability } = world();
    switchTo(true);
    const frames: string[] = [];
    const streams = streamInboxCapabilities(list, (f) => frames.push(f), true);
    switchTo(false);
    streams.sync();
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    await new Promise((r) => setTimeout(r, 500));
    expect(frames).toEqual([]);
    streams.stop();
  });
});

describe("on", () => {
  test("the settings say it is on; routes answer only the owner's window on this computer", async () => {
    switchTo(true);
    const { list, route, drawn } = world();
    expect(capabilitiesWire(list)).toEqual({ canvas: { on: true } });
    expect(capabilitiesWire(list, false)).toEqual({});
    await drawn();
    const away = await route("GET", `/api/canvas/${ID}`, undefined, { ...owner, local: false });
    expect(away.status).toBe(404);
    const crossSite = await route("GET", `/api/canvas/${ID}`, undefined, { ...owner, crossSite: () => new Response("no", { status: 403 }) });
    expect(crossSite.status).toBe(403);
    const r = await route("GET", `/api/canvas/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, agent_version: 1, layout: { state: "done" }, marks: [] });
    expect(await route("GET", "/api/canvas/not-a-thread")).toMatchObject({ status: 404 });
  });

  test("a stale page's save is a 409 with the current rev; the current one saves and reads back", async () => {
    switchTo(true);
    const { route, drawn } = world();
    const rev = await drawn();
    const movedRow = LAID_OUT.map((e) => (e.id.startsWith("row-1") ? { ...e, y: e.y + 40 } : e));
    const stale = await route("POST", `/api/canvas/${ID}/scene`, { base: rev - 1, elements: movedRow, files: {} });
    expect(stale).toEqual({ status: 409, body: { error: expect.any(String), code: "stale_base", rev } });
    const ok = await route("POST", `/api/canvas/${ID}/scene`, { base: rev, elements: movedRow, files: {} });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ rev: rev + 1, marks: ['moved #row-1 ("Push alerts") by +0,+40'] });
  });

  test("a POST from another server session is refused", async () => {
    switchTo(true);
    const { route, drawn } = world();
    const rev = await drawn();
    const r = await route("POST", `/api/canvas/${ID}/scene`, { base: rev, elements: LAID_OUT, files: {}, serverSession: "an-old-server" });
    expect(r.status).toBe(409);
    expect(r.body?.code).not.toBe("stale_base");
  });

  test("a layout for a version not waiting is a 409; pending lists the waiting one", async () => {
    switchTo(true);
    const { route, capability } = world();
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    capability.store.agentWrite(ID, { board: BOARD, pins: {} });
    expect((await route("GET", "/api/canvas/pending")).body).toEqual({ pending: [{ id: ID, version: 2 }] });
    const old = await route("POST", `/api/canvas/${ID}/layout`, { version: 1, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS });
    expect(old.status).toBe(409);
    expect(old.body?.code).toBe("stale_layout");
    const now = await route("POST", `/api/canvas/${ID}/layout`, { version: 2, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS });
    expect(now.status).toBe(200);
    expect((await route("GET", "/api/canvas/pending")).body).toEqual({ pending: [{ id: ID, version: 2, picture: true }] });
  });

  test("links are dropped, a malformed or unbounded element list is refused", async () => {
    switchTo(true);
    const { route, drawn, capability } = world();
    const rev = await drawn();
    const linked = [...LAID_OUT, { id: "mine", type: "rectangle", x: 0, y: 0, width: 10, height: 10, link: "https://example.com/phish" }];
    expect((await route("POST", `/api/canvas/${ID}/scene`, { base: rev, elements: linked, files: {} })).status).toBe(200);
    expect(capability.store.get(ID).scene!.elements.every((e) => e.link === null)).toBe(true);

    const base = capability.store.get(ID).rev;
    for (const elements of [[{ id: "x", type: "rectangle", x: "0", y: 0, width: 1, height: 1 }], [{ type: "rectangle", x: 0, y: 0, width: 1, height: 1 }], "nope", Array.from({ length: 20_001 }, (_, i) => ({ id: `e${i}`, type: "rectangle", x: 0, y: 0, width: 1, height: 1 }))]) {
      const r = await route("POST", `/api/canvas/${ID}/scene`, { base, elements, files: {} });
      expect(r.status).toBe(400);
    }
    const badFile = await route("POST", `/api/canvas/${ID}/scene`, { base, elements: LAID_OUT, files: { f: { name: "../canvas.json", mimeType: "image/png" } } });
    expect(badFile.status).toBe(400);
    expect(capability.store.get(ID).rev).toBe(base);
  });

  test("only picture bytes are kept: a picture POST and a pasted upload that are not one are refused", async () => {
    switchTo(true);
    const { route, drawn, capability } = world();
    const rev = await drawn();
    const notPng = `data:image/png;base64,${Buffer.from("<svg onload=alert(1)>").toString("base64")}`;
    expect((await route("POST", `/api/canvas/${ID}/picture`, { rev, dataURL: notPng })).body).toEqual({ saved: false });
    expect((await route("POST", `/api/canvas/${ID}/picture`, { rev, dataURL: "data:image/svg+xml;base64,PHN2Zy8+" })).status).toBe(400);
    expect(capability.store.picturePath(ID)).toBeNull();
    expect((await route("POST", `/api/canvas/${ID}/picture`, { rev, version: 1, dataURL: PNG_URL })).body).toEqual({ saved: true });
    expect(capability.store.picturePath(ID, 1)).not.toBeNull();

    const image = (id: string, fileId: string) => ({ id, type: "image", x: 500, y: 0, width: 40, height: 40, fileId });
    const files = { a: { name: "a.png", mimeType: "image/png" }, b: { name: "b.png", mimeType: "image/png" } };
    const saved = await route("POST", `/api/canvas/${ID}/scene`, { base: capability.store.get(ID).rev, elements: [...LAID_OUT, image("ia", "a"), image("ib", "b")], files, uploads: { a: { dataURL: PNG_URL }, b: { dataURL: notPng } } });
    expect(saved.status).toBe(200);
    expect(capability.store.filePath(ID, "a.png")).not.toBeNull();
    expect(capability.store.filePath(ID, "b.png")).toBeNull();
  });
});

describe("the agent's side", () => {
  type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<{ content: { text: string }[] }> };
  function mcp(list: InboxCapability[]) {
    const store = InboxStore.open(dataDir);
    const project = store.ensureProject({ name: "app", root: join(dataDir, "app") });
    const context = {
      store,
      baseUrl: () => "http://localhost:1/",
      resolveProject: async () => project,
      capabilityInstructions: () => capabilitiesInstructions(list),
      capabilityThreadLines: (threadId: string) => capabilitiesThreadLines(list, threadId),
    } as unknown as InboxMcpContext;
    const server = createInboxMcpServer(context);
    const tools = (server as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
    const instructions = (server as unknown as { server: { _instructions?: string } }).server._instructions ?? "";
    return { store, project, tools, instructions };
  }

  test("the tool's instructions carry the canvas line only while on", () => {
    const { list } = world();
    expect(mcp(list).instructions).not.toContain(CANVAS_INSTRUCTIONS_LINE);
    expect(mcp(list).instructions).not.toMatch(/canvas/i);
    switchTo(true);
    expect(mcp(list).instructions).toContain(CANVAS_INSTRUCTIONS_LINE);
  });

  test("read_thread points at `canvas read` only while the person changed the canvas since the agent's version", async () => {
    switchTo(true);
    const { list, capability, route } = world();
    const m = mcp(list);
    const sent = m.store.sendMessage({ project_id: m.project.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: null }, body: "Drew it.", thread: "Settings" });
    const thread = sent.message.id;
    const read = async () => (await m.tools.read_thread!.handler({ thread_id: thread, agent_session: "ses_a", agent_host: "claude-code" }, {})).content.map((c) => c.text).join("\n");
    const line = canvasChangedLine(thread);

    expect(await read()).not.toContain(line);
    const s = capability.store.agentWrite(thread, { board: BOARD, pins: {} });
    capability.store.layoutDone(thread, { version: s.agentVersion, elements: LAID_OUT, files: {}, warnings: [], parts: PARTS, changed: 0 });
    expect(capabilitiesThreadLines(list, thread)).toEqual([]);
    expect(await read()).not.toContain(line);

    const moved = LAID_OUT.map((e) => (e.id.startsWith("row-1") ? { ...e, x: e.x + 30 } : e));
    expect((await route("POST", `/api/canvas/${thread}/scene`, { base: capability.store.get(thread).rev, elements: moved, files: {} })).status).toBe(200);
    expect(await read()).toContain(line);

    switchTo(false);
    expect(capabilitiesThreadLines(list, thread)).toEqual([]);
    expect(await read()).not.toContain(line);
  });
});
