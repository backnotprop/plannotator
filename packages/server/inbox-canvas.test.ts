/**
 * The canvas's one promise: an agent never replaces what the person did without having been shown it. Each test is a
 * way that promise was once broken, or a way the rule got in the way of plain work. The module runs against a
 * stand-in store in a temp folder; no Inbox is started.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasAuthor } from "@plannotator/shared/inbox/canvas/changes";
import { mergeSave } from "@plannotator/shared/inbox/canvas/changes";
import type { CanvasElement } from "@plannotator/shared/inbox/canvas/scene";
import { commitCanvas, readCanvasScene } from "@plannotator/shared/inbox/canvas/store";
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
    expect(added.text).toContain("For the rest: canvas");
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
    // The reply showed only what it listed: a session that read nothing else may change the picked box, not the other.
    expect((await t.canvas.apply(THREAD, agent("fresh"), sketch.rev, [{ set: "Mailer v2", text: "Mailer (agent)" }])).ok).toBe(false);
    expect((await t.canvas.apply(THREAD, agent("a"), sketch.rev, [{ set: "Ledger v2", text: "Ledger v2, behind the queue" }])).ok).toBe(true);
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
