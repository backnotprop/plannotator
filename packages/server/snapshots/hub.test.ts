import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSnapshotsHub, MAX_HUD_TOKENS, type SnapshotsHub } from "./hub";

const PORT = 47_301;
const TOKEN = "h".repeat(64);
const roots: string[] = [];
const hubs: SnapshotsHub[] = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A PNG header (signature + IHDR) with the given size: all the hub reads. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-snapshots-hub-"));
  roots.push(root);
  const dataDir = join(root, "data");
  const hub = createSnapshotsHub({ dataDir, version: "test", token: TOKEN, serverSession: "srv-1", getPort: () => PORT });
  hubs.push(hub);
  const call = async (method: string, path: string, body?: unknown, token = TOKEN) => {
    const response = await hub.handle(
      new Request(`http://127.0.0.1:${PORT}${path}`, {
        method,
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    const text = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, json };
  };
  const file = (name: string, bytes: Uint8Array | string) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  };
  const sayHello = async (host: string, sessionId: string) => {
    const answer = await call("POST", "/api/connections/hello", { host, sessionId, processId: "p", cwd: "/w", project: "w", title: "", lastHumanInputAt: 0, capabilities: { ask: { turn: host !== "cli-wait" } } });
    expect(answer.status).toBe(200);
    return answer.json.connectionId as string;
  };
  const delivers = async (connectionId: string) => {
    const answer = await call("POST", `/api/connections/${connectionId}/poll`, { status: "ready", waitMs: 0 });
    return ((answer.json?.commands ?? []) as Array<{ type: string; sendId?: string; text?: string }>).filter((command) => command.type === "deliver");
  };
  const capture = async () => {
    const answer = await call("POST", "/api/snapshots/capture", { file: file(`shot-${Math.random()}.png`, pngBytes(40, 30)) });
    expect(answer.status).toBe(200);
    return answer.json as { snapshot: { id: string }; collectionId: string };
  };
  return { root, dataDir, hub, call, file, sayHello, delivers, capture };
}

describe("hub input trust", () => {
  test("a send id is checked: a path is refused and nothing is written outside sends/", async () => {
    const h = setup();
    await h.sayHello("claude-code", "s1");
    const { collectionId } = await h.capture();
    const refused = await h.call("POST", `/api/snapshots/collection/${collectionId}/send`, { sendId: "../escaped" });
    expect(refused.status).toBe(400);
    expect(existsSync(join(h.dataDir, "snapshots", "escaped.json"))).toBe(false);
    expect(readdirSync(join(h.dataDir, "snapshots", "sends"))).toEqual([]);
    const sent = await h.call("POST", `/api/snapshots/collection/${collectionId}/send`, { sendId: "hs-fine_1" });
    expect(sent.status).toBe(200);
    expect(readdirSync(join(h.dataDir, "snapshots", "sends"))).toEqual(["hs-fine_1.json"]);
  });

  test("a capture is always checked as an image, even with a width and height", async () => {
    const h = setup();
    const text = h.file("secret.txt", "not an image at all, just a private file\n".repeat(4));
    const answer = await h.call("POST", "/api/snapshots/capture", { file: text, width: 100, height: 100 });
    expect(answer.status).toBe(400);
    expect((await h.call("GET", "/api/snapshots/state")).json.collection?.snapshots ?? []).toEqual([]);
    // A real PNG whose stated size disagrees with its header is refused too.
    const mismatch = await h.call("POST", "/api/snapshots/capture", { file: h.file("a.png", pngBytes(40, 30)), width: 4000, height: 3000 });
    expect(mismatch.status).toBe(400);
    const ok = await h.call("POST", "/api/snapshots/capture", { file: h.file("b.png", pngBytes(40, 30)), width: 40, height: 30 });
    expect(ok.status).toBe(200);
  });

  test("window text is taken only from the incoming folder", async () => {
    const h = setup();
    const outside = h.file("notes.txt", "private");
    const refused = await h.call("POST", "/api/snapshots/capture", { file: h.file("c.png", pngBytes(10, 10)), kind: "app", textFile: outside });
    expect(refused.status).toBe(400);
    expect(existsSync(outside)).toBe(true);
    const incoming = join(h.dataDir, "snapshots", "incoming");
    mkdirSync(incoming, { recursive: true });
    const textFile = join(incoming, "cap.txt");
    writeFileSync(textFile, "AXWindow  Settings");
    const ok = await h.call("POST", "/api/snapshots/capture", { file: h.file("d.png", pngBytes(10, 10)), kind: "app", textFile });
    expect(ok.status).toBe(200);
    expect((await h.call("GET", `/api/snapshots/snapshot/${ok.json.snapshot.id}/text`)).status).toBe(200);
  });

  test("a malformed boxes PATCH is refused and later sends still work", async () => {
    const h = setup();
    await h.sayHello("claude-code", "s1");
    const { snapshot, collectionId } = await h.capture();
    for (const boxes of [[{ id: "b1" }], [{ id: "b1", n: 1, rect: [0, 0, 5], comment: "x" }], "nope", [{ id: "b1", n: 1, rect: [0, 0, 5, 5], comment: 7 }]]) {
      expect((await h.call("PATCH", `/api/snapshots/snapshot/${snapshot.id}`, { boxes })).status).toBe(400);
    }
    expect((await h.call("PATCH", `/api/snapshots/snapshot/${snapshot.id}`, { strokes: [{ id: "s", tool: "laser" }] })).status).toBe(400);
    const good = await h.call("PATCH", `/api/snapshots/snapshot/${snapshot.id}`, { boxes: [{ id: "b1", n: 1, rect: [1, 2, 3, 4], comment: "this" }] });
    expect(good.status).toBe(200);
    const sent = await h.call("POST", `/api/snapshots/collection/${collectionId}/send`, {});
    expect(sent.status).toBe(200);
    expect(sent.json.text).toContain("① [1, 2, 3×4] this.");
  });

  test("HUD tokens are bounded: the oldest stops working", async () => {
    const h = setup();
    const tokens: string[] = [];
    for (let index = 0; index < MAX_HUD_TOKENS + 1; index++) tokens.push((await h.call("POST", "/api/snapshots/attach", {})).json.hudToken);
    expect((await h.call("GET", "/api/snapshots/state", undefined, tokens[0])).status).toBe(401);
    expect((await h.call("GET", "/api/snapshots/state", undefined, tokens[1])).status).toBe(200);
    expect((await h.call("GET", "/api/snapshots/state", undefined, tokens.at(-1))).status).toBe(200);
  });
});

describe("routing", () => {
  test("snapshot --wait re-points an open collection that already has a destination", async () => {
    const h = setup();
    const session = await h.sayHello("claude-code", "s1");
    const { collectionId } = await h.capture();
    expect((await h.call("GET", "/api/snapshots/state")).json.destination.sessionId).toBe("s1");
    const waiting = await h.sayHello("cli-wait", "wait-1");
    const state = (await h.call("GET", "/api/snapshots/state")).json;
    expect(state.destination).toMatchObject({ host: "cli-wait", sessionId: "wait-1", reason: "summoned" });
    const sent = await h.call("POST", `/api/snapshots/collection/${collectionId}/send`, {});
    expect(sent.status).toBe(200);
    const delivered = await h.delivers(waiting);
    expect(delivered.map((command) => command.sendId)).toEqual([sent.json.sendId]);
    expect(delivered[0]!.text).toContain("Plannotator: 1 snapshot from you");
    expect(await h.delivers(session)).toEqual([]);
  });
});
