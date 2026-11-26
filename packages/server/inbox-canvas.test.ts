/**
 * The canvas's one promise: an agent never replaces what the person did without having been shown it. Each test is a
 * way that promise was once broken, or a way the rule got in the way of plain work. The module runs against a
 * stand-in store in a temp folder; no Inbox is started.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { inboxBlobPath, inboxBlobsDir } from "@plannotator/shared/inbox/attachments";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasAuthor } from "@plannotator/shared/inbox/canvas/changes";
import { mergeSave } from "@plannotator/shared/inbox/canvas/changes";
import { emptyScene, type CanvasElement } from "@plannotator/shared/inbox/canvas/scene";
import { thingsOf } from "@plannotator/shared/inbox/canvas/reading";
import { CANVAS_GONE_KEEP_MS, commitCanvas, readCanvasLog, readCanvasScene, readCanvasTold, sweepGoneCanvases, writeAgentPicture } from "@plannotator/shared/inbox/canvas/store";
import { createInboxCanvas } from "./inbox-canvas";

const THREAD = "msg_T1";
const agent = (key?: string): CanvasAuthor => ({ kind: "agent", name: "Agent", ...(key ? { key } : {}) });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "canvas-server-"));
  const store = { dir, message: (id: string) => (id === THREAD ? { thread_id: THREAD } : null), onDeletion: () => () => {} } as never;
  const canvas = createInboxCanvas({
    store,
    serverSession: "srv",
    json: (data, status) => new Response(JSON.stringify(data), { status: status ?? 200 }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    sessionMismatch: () => null,
  });
  /** The person rewrites the label of the box that says `words`. */
  const person = (words: string, next: string) => {
    const scene = readCanvasScene(dir, THREAD);
    for (const el of scene.elements) {
      if (el.type === "text" && el.text === words) Object.assign(el, { text: next, originalText: next, version: (el.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });
    }
    return commitCanvas(dir, THREAD, scene, { kind: "person" }, new Date()).rev;
  };
  const words = () => readCanvasScene(dir, THREAD).elements.filter((e) => e.type === "text" && !e.isDeleted).map((e) => e.text);
  const revOf = (text: string) => Number(/rev (\d+)/.exec(text.split("\n").find((l) => l.startsWith("Canvas of") || l.startsWith("Done")) ?? "")?.[1]);
  return { dir, canvas, person, words, revOf };
}

/** A board of labelled boxes, drawn by another session, so the agent under test has been shown nothing. */
async function board(t: ReturnType<typeof setup>, labels: string[]) {
  const made = await t.canvas.apply(THREAD, agent("setup"), 0, labels.map((text, i) => ({ add: "box", text, at: [i * 300, 0] })));
  expect(made.ok).toBe(true);
}

describe("what the agent was shown", () => {
  test("a read that is refused shows nothing, so it cannot stand in for a look", async () => {
    const t = setup();
    await board(t, ["Ledger", "Mailer"]);
    t.canvas.read(THREAD, agent("a"));
    const rev = t.person("Ledger", "Ledger v2 (the person's words)");
    expect(() => t.canvas.read(THREAD, agent("a"), { in: "No such frame" })).toThrow();
    const result = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Ledger v2 (the person's words)", text: "Ledger (agent)" }]);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("the person");
    expect(t.words()).toContain("Ledger v2 (the person's words)");
  });

  test("a refusal shows only what it lists: the other thing the person changed is still protected", async () => {
    const t = setup();
    await board(t, ["Ledger", "Mailer"]);
    t.canvas.read(THREAD, agent("a"));
    t.person("Ledger", "Ledger v2");
    const rev = t.person("Mailer", "Mailer v2");
    const first = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Ledger v2", text: "Ledger (agent)" }]);
    expect(first.ok).toBe(false);
    expect(first.text).toContain("Ledger v2");
    expect(first.text).not.toContain("Mailer v2");
    const second = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Mailer v2", text: "Mailer (agent)" }]);
    expect(second.ok).toBe(false);
    expect(t.words()).toContain("Mailer v2");
    // Shown now, the same change goes through: the agent decides knowing.
    expect((await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Mailer v2", text: "Mailer v2, queued" }])).ok).toBe(true);
  });

  test("a thing never shown to this session cannot be overwritten, whatever base it sends", async () => {
    const t = setup();
    await board(t, ["Ledger"]);
    const rev = t.person("Ledger", "Ledger v2");
    // No read at all: the rev came from somewhere else.
    const blind = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Ledger v2", text: "Ledger (agent)" }]);
    expect(blind.ok).toBe(false);
    expect(t.words()).toEqual(["Ledger v2"]);
  });

  test("calls that name no session share nothing: one caller's read never clears another's way", async () => {
    const t = setup();
    await board(t, ["Ledger"]);
    const seenByA = t.revOf(t.canvas.read(THREAD, agent()));
    t.person("Ledger", "Ledger v2");
    // Another unnamed caller reads the canvas as it is now.
    t.canvas.read(THREAD, agent());
    const stale = await t.canvas.apply(THREAD, agent(), seenByA, [{ set: "Ledger v2", text: "Ledger (agent)" }]);
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain("Ledger v2");
    expect(t.words()).toEqual(["Ledger v2"]);
    // And an unnamed caller's change is news to a named one (it is nobody's "own").
    const now = t.revOf(t.canvas.read(THREAD, agent()));
    t.canvas.read(THREAD, agent("named"));
    expect((await t.canvas.apply(THREAD, agent(), now, [{ add: "note", text: "from nobody in particular" }])).ok).toBe(true);
    expect(t.canvas.read(THREAD, agent("named"))).toContain("from nobody in particular");
  });

  test("a list of changes too long to tell whole leaves the untold things protected, and says how to hear the rest", async () => {
    const t = setup();
    const labels = Array.from({ length: 40 }, (_, i) => `Box ${i}`);
    await board(t, labels);
    t.canvas.read(THREAD, agent("a"));
    let rev = 0;
    for (const label of labels) rev = t.person(label, `${label} edited`);
    const heard = t.canvas.read(THREAD, agent("a"), { in: undefined });
    // The reading itself shows every thing as it is now, so nothing is hidden from an agent that reads.
    expect(heard).toContain("Box 39 edited");
    // An agent that only got a cut list (a change answer, not a reading) is not cleared for the rest.
    const b = agent("b");
    t.canvas.read(THREAD, b);
    for (const label of labels) rev = t.person(`${label} edited`, `${label} again`);
    const added = await t.canvas.apply(THREAD, b, rev, [{ add: "note", text: "unrelated" }]);
    expect(added.ok).toBe(true);
    expect(added.text).toContain(`For the rest: plannotator inbox canvas ${THREAD}`);
    const untold = labels.map((l) => `${l} again`).filter((l) => !added.text.includes(JSON.stringify(l)));
    expect(untold.length).toBeGreaterThan(0);
    const result = await t.canvas.apply(THREAD, b, added.rev, [{ set: untold[0]!, text: "overwritten" }]);
    expect(result.ok).toBe(false);
    expect(t.words()).toContain(untold[0]!);
  });

  test("an old base sent after the agent was told does not bring the refusal back", async () => {
    const t = setup();
    await board(t, ["Ledger"]);
    const first = t.revOf(t.canvas.read(THREAD, agent("a")));
    t.person("Ledger", "Ledger v2");
    expect(t.canvas.read(THREAD, agent("a"))).toContain("Ledger v2");
    const result = await t.canvas.apply(THREAD, agent("a"), first, [{ set: "Ledger v2", text: "Ledger v2, idempotent" }]);
    expect(result.ok).toBe(true);
  });

  test("the person's \"work on this\" shows the picked thing: the agent's change to it lands on the first try", async () => {
    const t = setup();
    await board(t, ["Ledger", "Mailer"]);
    t.canvas.read(THREAD, agent("a"));
    t.person("Ledger", "Ledger v2");
    t.person("Mailer", "Mailer v2");
    const picked = readCanvasScene(t.dir, THREAD).elements.filter((e) => e.type === "text" && e.text === "Ledger v2").map((e) => e.containerId as string);
    const sketch = t.canvas.replySketch(THREAD, { kind: "selection", elements: picked, pictures: {} })!;
    expect(sketch.reading).toContain("Ledger v2");
    // Building the reply shows nothing: a reply that is never stored must not clear anyone's way.
    expect((await t.canvas.apply(THREAD, agent("a"), sketch.rev, [{ set: "Ledger v2", text: "too early" }])).ok).toBe(false);
    const again = t.canvas.replySketch(THREAD, { kind: "selection", elements: picked, pictures: {} })!;
    // Stored, and sent to session a: shown to a, to nobody else.
    t.canvas.replyShown(THREAD, again, "a");
    expect((await t.canvas.apply(THREAD, agent("other"), again.rev, [{ set: "Ledger v2", text: "Ledger (other agent)" }])).ok).toBe(false);
    // The reply showed only what it listed: a session that read nothing else may change the picked box, not the other.
    expect((await t.canvas.apply(THREAD, agent("fresh"), again.rev, [{ set: "Mailer v2", text: "Mailer (agent)" }])).ok).toBe(false);
    // The refusal above showed session a the box as it is, so its change lands now either way; a session shown only by the reply:
    const b = setup();
    await board(b, ["Ledger"]);
    b.person("Ledger", "Ledger v2");
    const ids = readCanvasScene(b.dir, THREAD).elements.filter((e) => e.type === "text").map((e) => e.containerId as string);
    const told = b.canvas.replySketch(THREAD, { kind: "selection", elements: ids, pictures: {} })!;
    b.canvas.replyShown(THREAD, told, "a");
    expect((await b.canvas.apply(THREAD, agent("a"), told.rev, [{ set: "Ledger v2", text: "Ledger v2, behind the queue" }])).ok).toBe(true);
  });
});

describe("names", () => {
  test("a short label is its box, never the start of some other element's id", async () => {
    const t = setup();
    await board(t, ["DB", "Cache"]);
    // An element whose id starts with the label, as an imported file can hold.
    const scene = readCanvasScene(t.dir, THREAD);
    const stray: CanvasElement = { id: "DBx9stray", type: "rectangle", x: 900, y: 900, width: 50, height: 50, version: 1, versionNonce: 1 };
    commitCanvas(t.dir, THREAD, { ...scene, elements: [...scene.elements, stray] }, { kind: "person" }, new Date());
    const rev = t.revOf(t.canvas.read(THREAD, agent("a")));
    const result = await t.canvas.apply(THREAD, agent("a"), rev, [{ remove: "DB" }]);
    expect(result.ok).toBe(true);
    const left = readCanvasScene(t.dir, THREAD).elements.filter((e) => !e.isDeleted);
    expect(left.some((e) => e.id === "DBx9stray")).toBe(true);
    expect(left.some((e) => e.type === "text" && e.text === "DB")).toBe(false);
    // The start of an id is not a name.
    expect((await t.canvas.apply(THREAD, agent("a"), result.rev, [{ remove: "DBx9" }])).ok).toBe(false);
  });
});

describe("pictures", () => {
  test("a pasted photo's file outlives its deletion: delete, save, undo, save, and the file is still there", () => {
    const t = setup();
    const photo: CanvasElement = { id: "photo001", type: "image", x: 0, y: 0, width: 100, height: 80, fileId: "f1aa", version: 1, versionNonce: 1 };
    const file = { id: "f1aa", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA" };
    const save = (elements: CanvasElement[], files: Record<string, unknown>) => {
      const merged = mergeSave(readCanvasScene(t.dir, THREAD, false), { type: "excalidraw", version: 2, source: "", elements, appState: {}, files }, Date.now());
      commitCanvas(t.dir, THREAD, merged.scene, { kind: "person" }, new Date());
    };
    save([photo], { f1aa: file });
    save([{ ...photo, isDeleted: true, version: 2 }], {});
    // Undo in the window: the element is back; the window sends each file only once.
    save([{ ...photo, isDeleted: false, version: 3 }], {});
    const scene = readCanvasScene(t.dir, THREAD);
    expect(scene.elements.find((e) => e.id === "photo001")?.isDeleted).toBe(false);
    expect(scene.files.f1aa).toEqual(file);
  });
});

describe("what the second review broke", () => {
  test("a session named like something every object has, or like the old everyone mark, is no session", async () => {
    const t = setup();
    await board(t, ["Ledger"]);
    for (const key of ["__proto__", "constructor", "*"]) t.canvas.read(THREAD, agent(key));
    expect(Object.keys({}).length).toBe(0);
    expect(({} as Record<string, unknown>).length).toBeUndefined();
    const rev = t.person("Ledger", "Ledger v2");
    // Shown to "*" or "__proto__" is shown to nobody.
    expect((await t.canvas.apply(THREAD, agent("a"), rev, [{ set: "Ledger v2", text: "Ledger (agent)" }])).ok).toBe(false);
    expect(Object.keys(readCanvasTold(t.dir, THREAD)).sort()).toEqual(["a", "setup"]);
  });

  test("the check does not depend on how long the log is: 801 saves later the person's words are still protected", async () => {
    const t = setup();
    await board(t, ["Ledger", "Mailer"]);
    const ledger = /box (\S+) "Ledger"/.exec(t.canvas.read(THREAD, agent("a")))![1]!;
    t.person("Ledger", "Ledger, as the person wants it");
    let rev = 0;
    let words = "Mailer";
    for (let i = 0; i <= 800; i++) {
      rev = t.person(words, `Mailer ${i}`);
      words = `Mailer ${i}`;
    }
    expect(readCanvasLog(t.dir, THREAD).some((e) => e.changes.some((c) => c.line.includes("Ledger, as the person wants it")))).toBe(false);
    const result = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: ledger, text: "Ledger (agent)" }]);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Ledger, as the person wants it");
    expect(t.words()).toContain("Ledger, as the person wants it");
  }, 60_000);

  test("one save that changes more things than a log entry holds leaves every one of them protected", async () => {
    const t = setup();
    const labels = Array.from({ length: 320 }, (_, i) => `B${i}`);
    await board(t, labels.slice(0, 160));
    const more = await t.canvas.apply(THREAD, agent("setup"), 1, labels.slice(160).map((text, i) => ({ add: "box", text, at: [i * 300, 300] })));
    expect(more.ok).toBe(true);
    // The agent is shown all 320 (two pages of the reading and the rest).
    let page = t.canvas.read(THREAD, agent("a"));
    for (let guard = 0; guard < 10 && /--after '?([^\s']+)/.test(page); guard++) page = t.canvas.read(THREAD, agent("a"), { after: /--after '?([^\s']+)/.exec(page)![1]! });
    const scene = readCanvasScene(t.dir, THREAD);
    for (const el of scene.elements) if (el.type === "rectangle") Object.assign(el, { y: el.y + 500, version: (el.version ?? 1) + 1, versionNonce: 5 });
    const rev = commitCanvas(t.dir, THREAD, scene, { kind: "person" }, new Date()).rev;
    for (const label of ["B5", "B319"]) {
      const result = await t.canvas.apply(THREAD, agent("a"), rev, [{ set: label, text: `${label} (agent)` }]);
      expect({ label, ok: result.ok }).toEqual({ label, ok: false });
    }
  }, 60_000);

  test("more clashes than a refusal lists: the call it gives shows exactly the rest, and then the change lands", async () => {
    const t = setup();
    const labels = Array.from({ length: 45 }, (_, i) => `C${i}`);
    await board(t, labels);
    const rev = t.revOf(t.canvas.read(THREAD, agent("setup")));
    const change = labels.map((label) => ({ set: label, color: "red" }));
    const first = await t.canvas.apply(THREAD, agent("a"), rev, change);
    expect(first.ok).toBe(false);
    const rest = { things: /See exactly those first: plannotator inbox canvas \S+ --things '?([^\s']+)/.exec(first.text)![1]!.split(",") };
    expect(rest.things.length).toBe(15);
    t.canvas.read(THREAD, agent("a"), { things: rest.things });
    expect((await t.canvas.apply(THREAD, agent("a"), rev, change)).ok).toBe(true);
  });

  test("a refusal over another agent's change says so, and does not send the agent to the person", async () => {
    const t = setup();
    await board(t, ["Ledger"]);
    t.canvas.read(THREAD, agent("a"));
    const rev = t.revOf(t.canvas.read(THREAD, { kind: "agent", name: "Codex", key: "b" }));
    await t.canvas.apply(THREAD, { kind: "agent", name: "Codex", key: "b" }, rev, [{ set: "Ledger", text: "Ledger (Codex)" }]);
    const result = await t.canvas.apply(THREAD, agent("a"), rev + 1, [{ set: "Ledger (Codex)", text: "Ledger (a)" }]);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Codex");
    expect(result.text).not.toContain("ask them first");
  });
});

describe("undo of an agent's change", () => {
  const post = (t: ReturnType<typeof setup>, path: string, body: unknown) =>
    t.canvas.route(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path).then(async (r) => (await r!.json()) as { rev: number; kept?: string[]; already?: boolean });

  test("what the person did after the change wins; a second press does nothing; an old change takes nothing of the person's with it", async () => {
    const t = setup();
    const first = await t.canvas.apply(THREAD, agent("a"), 0, [{ add: "box", text: "Ledger" }, { add: "box", text: "Mailer", at: [400, 0] }]);
    // The person builds on it.
    const scene = readCanvasScene(t.dir, THREAD);
    const mine: CanvasElement = { id: "personBox1", type: "rectangle", x: 0, y: 400, width: 100, height: 60, version: 1, versionNonce: 1 };
    commitCanvas(t.dir, THREAD, { ...scene, elements: [...scene.elements, mine] }, { kind: "person" }, new Date());
    const second = await t.canvas.apply(THREAD, agent("a"), first.rev + 1, [{ set: "Ledger", color: "red" }, { set: "Mailer", color: "red" }]);
    expect(second.ok).toBe(true);
    // After the agent's recolour the person moves Ledger and deletes Mailer.
    const now = readCanvasScene(t.dir, THREAD);
    for (const el of now.elements) {
      if (el.type === "rectangle" && el.strokeColor === "#e03131" && el.x === 0) Object.assign(el, { x: 900, version: (el.version ?? 1) + 1 });
      else if (el.x === 400 || (el.type === "text" && el.text === "Mailer")) Object.assign(el, { isDeleted: true, version: (el.version ?? 1) + 1 });
    }
    commitCanvas(t.dir, THREAD, now, { kind: "person" }, new Date());
    const path = `/api/inbox/threads/${THREAD}/canvas/undo`;
    const undone = await post(t, path, { rev: second.rev });
    const after = readCanvasScene(t.dir, THREAD);
    const ledger = after.elements.find((e) => e.type === "rectangle" && !e.isDeleted && e.id !== "personBox1")!;
    // The person's move stays; the agent's colour, which the person did not touch, goes back.
    expect(ledger.x).toBe(900);
    expect(ledger.strokeColor).toBe("#1e1e1e");
    expect(after.elements.filter((e) => e.type === "text" && !e.isDeleted).map((e) => e.text)).toEqual(["Ledger"]);
    expect(undone.kept ?? []).toEqual([]);
    // Again: nothing.
    const again = await post(t, path, { rev: second.rev });
    expect(again.already).toBe(true);
    expect(again.rev).toBe(undone.rev);
    // The agent's first change, long ago: its untouched things could go, the person's box stays.
    await post(t, path, { rev: first.rev });
    expect(readCanvasScene(t.dir, THREAD).elements.some((e) => e.id === "personBox1" && !e.isDeleted)).toBe(true);
    expect(existsSync(join(t.dir, "canvas", THREAD, "undo", `${second.rev}.json`))).toBe(false);
  });

  test("a compressed save that unpacks past the cap is refused, not held in memory", async () => {
    const t = setup();
    const bomb = gzipSync(Buffer.alloc(80 * 1024 * 1024, 32));
    const path = `/api/inbox/threads/${THREAD}/canvas`;
    const res = await t.canvas.route(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: bomb }), path);
    expect(res!.status).toBe(413);
  });
});

describe("a sketch sent from a clear spot on a canvas that already held something", () => {
  test("a sketch that names elements is read as only the things holding them; one that names none is the whole canvas", async () => {
    const t = setup();
    await board(t, ["Orders API", "Fraud check"]);
    // On this visit one box is added far from the rest (the window sends its element ids with kind "sketch").
    const made = await t.canvas.apply(THREAD, agent("p"), t.revOf(t.canvas.read(THREAD, agent("p"))), [{ add: "box", text: "Retry twice", at: [2400, 0] }]);
    expect(made.ok).toBe(true);
    const scene = readCanvasScene(t.dir, THREAD);
    const fresh = scene.elements.filter((e) => !e.isDeleted && thingsOf(scene).find((x) => x.words === "Retry twice")?.elementIds.includes(e.id)).map((e) => e.id);
    expect(fresh.length).toBeGreaterThan(0);
    const only = t.canvas.replySketch(THREAD, { kind: "sketch", elements: fresh, pictures: {} })!;
    expect(only.kind).toBe("sketch");
    expect(only.reading).toContain('"Retry twice"');
    expect(only.reading).not.toContain("Orders API");
    expect(only.reading).not.toContain("Fraud check");
    const whole = t.canvas.replySketch(THREAD, { kind: "sketch", elements: [], pictures: {} })!;
    for (const words of ["Retry twice", "Orders API", "Fraud check"]) expect(whole.reading).toContain(words);
  });

  test("its save never landed (failed, or held for a computer that is away): the reading comes from the reply's own canvas.excalidraw", async () => {
    const t = setup();
    await board(t, ["Orders API", "Fraud check"]);
    // What this visit drew is not in the stored scene; the reply carries it in its scene file.
    const drawn: CanvasElement[] = [
      { id: "oval-new", type: "ellipse", x: 2400, y: 0, width: 240, height: 130, version: 1, versionNonce: 1 },
      { id: "text-new", type: "text", x: 2420, y: 40, width: 120, height: 25, text: "Pending state", originalText: "Pending state", containerId: null, version: 1, versionNonce: 1 } as CanvasElement,
    ];
    const bytes = Buffer.from(JSON.stringify({ ...emptyScene(), elements: drawn }));
    const sha = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(inboxBlobsDir(t.dir), { recursive: true });
    writeFileSync(inboxBlobPath(t.dir, sha), bytes);
    const attached = [{ name: "canvas.png", sent_sha256: "0".repeat(64), size: 10 }, { name: "canvas.excalidraw", sent_sha256: sha, size: bytes.length }];
    const sketch = t.canvas.replySketch(THREAD, { kind: "sketch", elements: ["oval-new", "text-new"], pictures: {} }, attached)!;
    expect(sketch).toBeDefined();
    expect(sketch.reading).toContain("Pending state");
    expect(sketch.reading).not.toContain("Orders API");
    // With no scene file to fall back on, nothing is made up.
    expect(t.canvas.replySketch(THREAD, { kind: "sketch", elements: ["oval-new"], pictures: {} }, [])).toBeUndefined();
  });
});

describe("pictures and sketches for agents", () => {
  test("a picture path handed out stays good while newer pictures are written", () => {
    const t = setup();
    commitCanvas(t.dir, THREAD, { ...emptyScene(), elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10 }] }, { kind: "person" }, new Date());
    const first = writeAgentPicture(t.dir, THREAD, "first", new Uint8Array([1, 2, 3]));
    for (let i = 0; i < 40; i++) writeAgentPicture(t.dir, THREAD, `later-${i}`, new Uint8Array([1, 2, 3]));
    expect(existsSync(first)).toBe(true);
  });

  test("a sketch keeps its id when a stroke is added to it", () => {
    const stroke = (id: string, x: number): CanvasElement => ({ id, type: "freedraw", x, y: 0, width: 0, height: 0, points: [[0, 0], [10, 10]], version: 1, versionNonce: 1 });
    const one = thingsOf({ ...emptyScene(), elements: [stroke("m1111111", 0)] });
    // The added stroke's id sorts before the first one's.
    const two = thingsOf({ ...emptyScene(), elements: [stroke("m1111111", 0), stroke("a0000000", 12)] });
    expect(two).toHaveLength(1);
    expect(two[0]!.id).toBe(one[0]!.id);
  });

  test("the canvas of a thread deleted long ago is removed; a recent one is kept", () => {
    const t = setup();
    const gone = join(t.dir, "canvas", ".gone");
    mkdirSync(join(gone, `msg_OLD-${Date.now() - CANVAS_GONE_KEEP_MS - 1000}`), { recursive: true });
    mkdirSync(join(gone, `msg_NEW-${Date.now()}`), { recursive: true });
    expect(sweepGoneCanvases(t.dir, Date.now())).toBe(1);
    expect(readdirSync(gone)).toHaveLength(1);
  });
});

describe("what the recheck found (round 4)", () => {
  const post = (t: ReturnType<typeof setup>, path: string, body: unknown) =>
    t.canvas.route(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), path).then(async (r) => (await r!.json()) as { rev: number; kept?: string[]; kept_count?: number });
  /** The person's window saves: these elements changed (the editor bumps their version). */
  const personEdits = (t: ReturnType<typeof setup>, change: (el: CanvasElement) => Partial<CanvasElement> | null) => {
    const scene = readCanvasScene(t.dir, THREAD);
    for (const el of scene.elements) {
      const next = change(el);
      if (next) Object.assign(el, next, { version: (el.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });
    }
    return commitCanvas(t.dir, THREAD, scene, { kind: "person" }, new Date()).rev;
  };

  test("N1, N6: an Undo keeps a note the person moved together with its words, and the agent is told exactly what went back and what was kept", async () => {
    const t = setup();
    const first = await t.canvas.apply(THREAD, agent("a"), 0, [{ add: "box", text: "Orders API", at: [0, 0] }, { add: "box", text: "Payments queue", at: [300, 0] }, { add: "box", text: "Ledger writer", at: [600, 0] }]);
    const second = await t.canvas.apply(THREAD, agent("a"), first.rev, [{ add: "note", text: "Agent note", below: "Orders API" }, { set: "Ledger writer", text: "Ledger v2", color: "red" }, { remove: "Payments queue" }]);
    expect(second.ok).toBe(true);
    // The editor wrapped the agent's label for display (its `text` and size change, the words do not): not the person's doing.
    personEdits(t, (el) => (el.type === "text" && el.originalText === "Agent note" ? { text: "Agent\nnote", width: 61, height: 50 } : null));
    // The person drags the agent's note and retypes the box the agent renamed.
    personEdits(t, (el) => (el.type === "rectangle" && el.customData?.note ? { x: el.x + 200, y: el.y + 100 } : null));
    personEdits(t, (el) => (el.type === "text" && el.originalText === "Ledger v2" ? { text: "Ledger, mine", originalText: "Ledger, mine" } : null));
    const undone = await post(t, `/api/inbox/threads/${THREAD}/canvas/undo`, { rev: second.rev });
    const after = readCanvasScene(t.dir, THREAD);
    const liveText = after.elements.filter((e) => e.type === "text" && !e.isDeleted).map((e) => e.originalText).sort();
    // The moved note still has its words (it is not an empty box), the removed box is back with its label, the person's words stay.
    expect(liveText).toEqual(["Agent note", "Ledger, mine", "Orders API", "Payments queue"]);
    const ledger = after.elements.find((e) => e.type === "rectangle" && !e.isDeleted && e.x === 600)!;
    expect(ledger.strokeColor).toBe("#1e1e1e");
    // The window's line counts what stayed the person's: the note, and the box whose words they rewrote.
    expect(undone.kept_count).toBe(2);
    const told = t.canvas.read(THREAD, agent("a"));
    const line = told.split("\n").find((l) => l.startsWith("The person undid your change"))!;
    expect(line).toContain(`(rev ${second.rev})`);
    expect(line).toContain('Back as before: box "Payments queue".');
    expect(line).toContain('Partly back, with the person\'s own later change kept: box "Ledger, mine".');
    expect(line).toContain('Not undone, because the person changed it since: box "Agent note".');
    expect(told).not.toContain("what it added is gone");
  });

  test("N6: an Undo nobody got in the way of says it all went back", async () => {
    const t = setup();
    const first = await t.canvas.apply(THREAD, agent("a"), 0, [{ add: "box", text: "Orders API", at: [0, 0] }]);
    const second = await t.canvas.apply(THREAD, agent("a"), first.rev, [{ add: "note", text: "Agent note", below: "Orders API" }, { set: "Orders API", color: "red" }]);
    const undone = await post(t, `/api/inbox/threads/${THREAD}/canvas/undo`, { rev: second.rev });
    expect(undone.kept_count).toBe(0);
    const line = t.canvas.read(THREAD, agent("a")).split("\n").find((l) => l.startsWith("The person undid your change"))!;
    expect(line).toContain('Back as before: box "Orders API".');
    expect(line).toContain('Removed (you had added it): box "Agent note".');
    expect(line).not.toContain("kept");
  });

  test("29: asking for one thing by id gives all its words", async () => {
    const t = setup();
    const long = Array.from({ length: 70 }, (_, i) => `w${i}`).join(" ");
    await t.canvas.apply(THREAD, agent("a"), 0, [{ add: "box", text: long }]);
    const whole = t.canvas.read(THREAD, agent("a"));
    expect(whole).not.toContain(long);
    const call = whole.split("\n").find((l) => l.includes("All of a thing's words"))!;
    const id = /--things '?([^\s',]+)/.exec(call)![1]!;
    expect(t.canvas.read(THREAD, agent("a"), { things: [id] })).toContain(JSON.stringify(long));
  });

  test("N2: words the editor wrapped for display are still named by their whole words", async () => {
    const t = setup();
    const W = "\u652f\u4ed8\u7f51\u5173\u8d85\u65f6\u540e\u7684\u91cd\u8bd5\u7b56\u7565\u9700\u8981\u4e0e\u98ce\u63a7\u56e2\u961f\u786e\u8ba4\u540e\u624d\u80fd\u4e0a\u7ebf";
    const made = await t.canvas.apply(THREAD, agent("a"), 0, [{ add: "box", text: W }]);
    expect(t.words()).toEqual([W]);
    // The window saved the label as the editor wrapped it.
    personEdits(t, (el) => (el.type === "text" ? { text: `${W.slice(0, 10)}\n${W.slice(10, 20)}\n${W.slice(20)}`, originalText: W } : null));
    const again = await t.canvas.apply(THREAD, agent("a"), made.rev, [{ set: W, color: "red" }]);
    expect(again.text).not.toContain("nothing on the canvas is called");
    expect(again.ok).toBe(true);
  });
});

describe("what six fresh agents tripped on (round 5)", () => {
  test("5: a selection reply lists what its things are joined to, marked as not selected, and that counts as shown: the first change lands", async () => {
    const t = setup();
    const made = await t.canvas.apply(THREAD, agent("setup"), 0, [
      { add: "box", text: "Orders API", at: [0, 0] },
      { add: "diamond", text: "Fraud check", at: [500, 0] },
      { add: "ellipse", text: "payments queue", at: [0, 300] },
      { add: "box", text: "Unrelated", at: [1200, 600] },
      { connect: "Orders API", to: "Fraud check", label: "sync" },
      { connect: "Orders API", to: "payments queue" },
    ]);
    expect(made.ok).toBe(true);
    const scene = readCanvasScene(t.dir, THREAD);
    const fraud = scene.elements.find((e) => e.type === "diamond")!;
    const sketch = t.canvas.replySketch(THREAD, { kind: "selection", elements: [fraud.id], pictures: {} })!;
    const [picked, joined] = sketch.reading.split("Connected, not selected:\n");
    expect(picked).toContain('"Fraud check"');
    expect(joined).toContain('"sync"');
    expect(joined).toContain('"Orders API"');
    // One step out, no farther, for what is shown in full: the queue hangs off Orders API, not off the selection.
    expect(joined!.split("Also on the canvas:")[0]).not.toContain("payments queue");
    // Everything else is named, with its id and words and no more: the agent knows a queue exists and does not draw another.
    const also = sketch.reading.split("\n").find((l) => l.startsWith("Also on the canvas: "))!;
    expect(also).toMatch(/ellipse \S+ "payments queue"/);
    expect(also).toMatch(/box \S+ "Unrelated"/);
    expect(also).not.toMatch(/ at -?\d+,-?\d+/);
    expect(also).not.toContain("Fraud check");
    t.canvas.replyShown(THREAD, sketch, "a");
    // The agent re-points the arrow it was shown as connected, with no read first.
    const arrow = thingsOf(scene).find((x) => x.kind === "arrow" && x.words === "sync")!;
    const first = await t.canvas.apply(THREAD, agent("a"), sketch.rev, [{ remove: arrow.id }, { set: "Orders API", color: "blue" }]);
    expect(first.text).not.toContain("not as you were last shown");
    expect(first.ok).toBe(true);
    // Named in the outline is enough to connect to it...
    const joinedUp = await t.canvas.apply(THREAD, agent("a"), first.rev, [{ connect: "payments queue", to: "Fraud check" }]);
    expect(joinedUp.ok).toBe(true);
    // ...but not to change it: what it was not shown in full is still protected.
    expect((await t.canvas.apply(THREAD, agent("a"), joinedUp.rev, [{ set: "payments queue", color: "red" }])).ok).toBe(false);
    expect((await t.canvas.apply(THREAD, agent("a"), joinedUp.rev, [{ set: "Unrelated", color: "red" }])).ok).toBe(false);
  });

  test("10: a name the person has since rewritten is refused with the thing as it is now, and that shows it: the next call lands", async () => {
    const t = setup();
    await board(t, ["J3 slips to the 14th.", "Beta"]);
    t.canvas.read(THREAD, agent("a"));
    // The agent's first read told it everything; then the person adds a sentence, and the agent was told of that too by a later answer.
    t.person("J3 slips to the 14th.", "J3 slips to the 14th. QA needs two more days.");
    const told = t.canvas.read(THREAD, agent("a"));
    expect(told).toContain('renamed "J3 slips to the 14th." → "J3 slips to the 14th. QA needs two more days."');
    // Then the person rewrites it again, and the agent, not having looked, names it by the words it last saw.
    t.person("J3 slips to the 14th. QA needs two more days.", "J3 slips a week. QA needs two more days.");
    const base = t.revOf(told);
    const refused = await t.canvas.apply(THREAD, agent("a"), base, [{ set: "J3 slips to the 14th. QA needs two more days.", text: "J3 slips to next Friday." }]);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("J3 slips a week. QA needs two more days.");
    const id = /box (\S+) "J3 slips a week/.exec(refused.text)![1]!;
    // Two calls, not three: the refusal showed the note as it is.
    const next = await t.canvas.apply(THREAD, agent("a"), refused.rev, [{ set: id, text: "J3 slips to next Friday. QA needs two more days." }]);
    expect(next.text).not.toContain("Nothing changed");
    expect(next.ok).toBe(true);
    // Only what a refusal lists is shown by it: a name that is close to nothing shows nothing.
    const cold = await t.canvas.apply(THREAD, agent("cold"), next.rev, [{ set: "Zzz", color: "red" }]);
    expect(cold.ok).toBe(false);
    expect((await t.canvas.apply(THREAD, agent("cold"), next.rev, [{ set: "Beta", color: "red" }])).ok).toBe(false);
  });
});

describe("a file's route says what is wrong with it", () => {
  /** The canvas with a stale-tab guard: a page session other than this run's is a stale tab (409). */
  function guarded() {
    const dir = mkdtempSync(join(tmpdir(), "canvas-guard-"));
    const store = { dir, message: (id: string) => (id === THREAD ? { thread_id: THREAD } : null), onDeletion: () => () => {} } as never;
    const json = (data: unknown, status?: number) => new Response(JSON.stringify(data), { status: status ?? 200 });
    return createInboxCanvas({
      store,
      serverSession: "srv",
      json,
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      sessionMismatch: (body) => (typeof body.serverSession === "string" && body.serverSession !== "srv" ? json({ code: "server_session_mismatch" }, 409) : null),
    });
  }
  const post = (canvas: ReturnType<typeof guarded>, path: string, query: string, body: BodyInit, type = "application/json") =>
    canvas.route(new Request(`http://localhost${path}${query}`, { method: "POST", headers: { "content-type": type }, body }), path);

  test("pictures' files: bad JSON is 400, only a body past a canvas's size is 413", async () => {
    const canvas = guarded();
    const path = `/api/inbox/threads/${THREAD}/canvas/files`;
    expect((await post(canvas, path, "", "{not json"))!.status).toBe(400);
    expect((await post(canvas, path, "", new Uint8Array(64 * 1024 * 1024 + 1)))!.status).toBe(413);
    expect((await post(canvas, path, "", JSON.stringify({ files: { f1: { id: "f1", mimeType: "image/png", dataURL: "data:image/png;base64,AA==" } } })))!.status).toBe(200);
  });

  test("a tab left open on an older run is refused on the routes that carry bytes, as an upload is (its session in the query)", async () => {
    const canvas = guarded();
    const files = `/api/inbox/threads/${THREAD}/canvas/files`;
    const picture = `/api/inbox/threads/${THREAD}/canvas/picture`;
    const job = `/api/inbox/canvas/jobs/job_${"a".repeat(32)}`;
    const place = "x=0&y=0&w=10&h=10&scale=1&rev=1";
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
    expect((await post(canvas, files, "?serverSession=old", JSON.stringify({ files: {} })))!.status).toBe(409);
    expect((await post(canvas, picture, `?${place}&serverSession=old`, png, "image/png"))!.status).toBe(409);
    expect((await post(canvas, job, "?failed=1&serverSession=old", new Uint8Array(0), "image/png"))!.status).toBe(409);
    // This run's page, or a linked computer's request (its session stays with its own Inbox): taken.
    expect((await post(canvas, files, "?serverSession=srv", JSON.stringify({ files: {} })))!.status).toBe(200);
    expect((await post(canvas, picture, `?${place}`, png, "image/png"))!.status).toBe(200);
    expect((await post(canvas, job, "?failed=1", new Uint8Array(0), "image/png"))!.status).toBe(200);
  });
});

describe("a drawing job and a linked computer with no window that can draw it", () => {
  const answer = (t: ReturnType<typeof setup>, id: string, query: string, body: BodyInit = new Uint8Array(0)) =>
    t.canvas.route(new Request(`http://localhost/api/inbox/canvas/jobs/${id}${query}`, { method: "POST", headers: { "content-type": "image/png" }, body }), `/api/inbox/canvas/jobs/${id}`);

  test("its `none` leaves the job to this computer's own window, which still draws it", async () => {
    const t = setup();
    await board(t, ["Alpha"]);
    const linked: string[] = [];
    const window: string[] = [];
    t.canvas.listen((event, data) => event === "canvas-job" && linked.push((data as { id: string }).id));
    t.canvas.listen((event, data) => event === "canvas-job" && window.push((data as { id: string }).id));
    const asked = t.canvas.agent({ thread_id: THREAD, picture: true, by: { name: "Agent" } });
    await Bun.sleep(10);
    expect(linked.length).toBe(1);
    await answer(t, linked[0]!, "?none=1");
    // This computer's window answers a moment later, with its drawing.
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await answer(t, window[0]!, "?x=0&y=0&w=100&h=100&scale=1", png);
    const done = await asked;
    expect(done.ok).toBe(true);
    expect(done.structured?.picture).toEqual(expect.any(String));
  });

  test("when every stream it went to says `none`, the agent hears at once that no window drew it", async () => {
    const t = setup();
    await board(t, ["Alpha"]);
    const linked: string[] = [];
    t.canvas.listen((event, data) => event === "canvas-job" && linked.push((data as { id: string }).id));
    const started = Date.now();
    const asked = t.canvas.agent({ thread_id: THREAD, picture: true, by: { name: "Agent" } });
    await Bun.sleep(10);
    await answer(t, linked[0]!, "?none=1");
    await expect(asked).rejects.toThrow(/no Inbox window is open/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
