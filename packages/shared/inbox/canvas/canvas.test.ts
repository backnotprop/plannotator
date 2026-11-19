import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps } from "./apply";
import { mergeSave, sinceLines } from "./changes";
import { readThings, thingsOf } from "./reading";
import { emptyScene, type CanvasElement, type CanvasScene } from "./scene";
import { commitCanvas, readCanvasLog, readCanvasMeta, readCanvasScene } from "./store";

const agent = { by: "Agent", now: 1_000 };

function board(): CanvasScene {
  const made = applyOps(emptyScene(), [
    { add: "box", text: "Orders API" },
    { add: "box", text: "Orders worker", rightOf: "Orders API" },
    { add: "ellipse", text: "queue", below: "Orders API" },
    { connect: "Orders API", to: "queue", label: "enqueue" },
  ], agent);
  expect(made.ok).toBe(true);
  return made.scene;
}

function stroke(id: string, x: number, y: number, points: number[][], frameId: string | null = null): CanvasElement {
  return { id, type: "freedraw", x, y, width: 0, height: 0, points, frameId, version: 1, versionNonce: 1 };
}

const loop = (r: number) => Array.from({ length: 25 }, (_, i) => [Math.cos((i / 24) * Math.PI * 2) * r + r, Math.sin((i / 24) * Math.PI * 2) * r + r]);

describe("reading a canvas", () => {
  test("freehand strokes drawn together are one sketch, and a far one is another", () => {
    const scene: CanvasScene = {
      ...emptyScene(),
      elements: [
        stroke("head0001", 0, 0, loop(100)),
        stroke("eyeL0001", 55, 60, loop(8)),
        stroke("eyeR0001", 125, 60, loop(8)),
        stroke("smile001", 60, 130, [[0, 0], [40, 22], [80, 0]]),
        stroke("farAway1", 900, 900, [[0, 0], [60, 0]]),
      ],
    };
    const sketches = thingsOf(scene).filter((t) => t.kind === "sketch");
    expect(sketches.map((t) => t.strokes).sort()).toEqual([1, 4]);
    const face = sketches.find((t) => t.strokes === 4)!;
    const line = readThings(scene, thingsOf(scene)).lines.find((l) => l.includes(face.id))!;
    // A model with no vision gets the drawing's parts in words.
    expect(line).toContain("closed loop around the whole sketch");
    expect(line).toContain("like a smile");
  });

  test("a long reading is cut and names where to go on", () => {
    let scene = emptyScene();
    scene = applyOps(scene, Array.from({ length: 12 }, (_, i) => ({ add: "box", text: `Step ${i + 1}` })), agent).scene;
    const reading = readThings(scene, thingsOf(scene), { limit: 5 });
    expect(reading.lines).toHaveLength(5);
    const next = readThings(scene, thingsOf(scene), { limit: 5, after: reading.cutAfter });
    expect(next.lines[0]).not.toBe(reading.lines[4]);
    expect(reading.total).toBe(12);
  });
});

describe("an agent's changes", () => {
  test("one bad change changes nothing, and every bad change is listed", () => {
    const scene = board();
    const result = applyOps(scene, [{ set: "queue", text: "payments queue" }, { remove: "no such thing" }, { connect: "queue", to: "also missing" }], agent);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.scene).toBe(scene);
  });

  test("a name that fits two things is refused with both, never guessed", () => {
    const result = applyOps(board(), [{ remove: "Orders" }], agent);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Orders API");
    expect(result.errors[0]).toContain("Orders worker");
  });

  test("loose words find one thing and the answer says how they were read; overwrite and remove take only an id or whole words", () => {
    const scene = applyOps(emptyScene(), [{ add: "note", text: "Tests still failing on the J3 rig" }, { add: "box", text: "Release 4.2" }], agent).scene;
    const near = applyOps(scene, [{ add: "text", text: "lands a week late", near: "the failing tests note" }], agent);
    expect(near.ok).toBe(true);
    expect(near.done[0]).toContain('"the failing tests note" read as');
    // Which side `near` chose is said, with how to choose one.
    expect(near.done[0]).toMatch(/near put it (right of|below|left of|above)/);
    const loose = applyOps(scene, [{ set: "failing tests", text: "All green" }], agent);
    expect(loose.ok).toBe(false);
    expect(loose.errors[0]).toContain("Tests still failing on the J3 rig");
    expect(applyOps(scene, [{ set: "Tests still failing on the J3 rig", text: "All green" }], agent).ok).toBe(true);
  });

  test("a new thing never sits on a connector's line", () => {
    const scene = applyOps(emptyScene(), [{ add: "box", text: "A" }, { add: "box", text: "B", at: [900, 0] }, { connect: "A", to: "B" }], agent).scene;
    const arrow = scene.elements.find((e) => e.type === "arrow")!;
    // Asked for the middle of the arrow's run: it goes on along that side until it is clear of the line.
    const placed = applyOps(scene, [{ add: "box", text: "C", rightOf: "A" }], agent);
    const c = thingsOf(placed.scene).find((t) => t.words === "C")!;
    const y = arrow.y;
    const overLine = c.box.y - 8 <= y && c.box.y + c.box.h + 8 >= y && c.box.x < arrow.x + arrow.width && c.box.x + c.box.w > arrow.x;
    expect(overLine).toBe(false);
  });

  test("a new thing lands in a free place and an arrow is attached at both ends", () => {
    const scene = board();
    const result = applyOps(scene, [{ add: "note", text: "Why a queue here?", near: "Orders API" }], agent);
    const things = thingsOf(result.scene);
    const note = things.find((t) => t.words === "Why a queue here?")!;
    for (const other of things) {
      if (other === note || other.kind === "arrow") continue;
      const apart = note.box.x >= other.box.x + other.box.w || other.box.x >= note.box.x + note.box.w || note.box.y >= other.box.y + other.box.h || other.box.y >= note.box.y + note.box.h;
      expect(apart).toBe(true);
    }
    const arrow = things.find((t) => t.kind === "arrow")!;
    expect(arrow.from?.attached && arrow.to?.attached).toBe(true);
  });

  test("replacing a frame keeps the frame and swaps what it holds", () => {
    let scene = applyOps(emptyScene(), [{ add: "frame", text: "Flow" }, { add: "box", text: "Old", in: "Flow" }], agent).scene;
    scene = applyOps(scene, [{ replace: "Flow", with: [{ add: "box", text: "New A" }, { add: "box", text: "New B" }, { connect: "New A", to: "New B" }] }], agent).scene;
    const things = thingsOf(scene);
    const frame = things.find((t) => t.kind === "frame")!;
    expect(things.some((t) => t.words === "Old")).toBe(false);
    expect(things.filter((t) => t.frame === frame.id).map((t) => t.words).sort()).toEqual(["", "New A", "New B"]);
  });
});

describe("who changed what", () => {
  test("the person wins a tie with an agent's change to the same element, and keeps what only the store has", () => {
    const stored = board();
    const api = stored.elements.find((e) => e.type === "rectangle")!;
    // The window still holds the older scene and moved the box; meanwhile an agent recoloured it and added a note.
    const agentScene = applyOps(stored, [{ set: "Orders API", color: "red" }, { add: "note", text: "from the agent" }], agent).scene;
    const mine: CanvasScene = { ...stored, elements: stored.elements.map((e) => (e.id === api.id ? { ...e, x: e.x + 300, version: (e.version ?? 1) + 1, versionNonce: 7 } : e)) };
    const merged = mergeSave(agentScene, mine, 2_000).scene;
    expect(merged.elements.find((e) => e.id === api.id)!.x).toBe(api.x + 300);
    expect(thingsOf(merged).some((t) => t.words === "from the agent")).toBe(true);
  });

  test("the log says what the person changed since a revision, and a re-stamp alone is no change", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-store-"));
    const thread = "msg_TEST";
    const first = board();
    expect(commitCanvas(dir, thread, first, { kind: "agent", name: "Agent", key: "a" }, new Date(1)).rev).toBe(1);
    const moved: CanvasScene = { ...first, elements: first.elements.map((e) => (e.type === "ellipse" ? { ...e, x: e.x + 200, version: (e.version ?? 1) + 1 } : e)) };
    expect(commitCanvas(dir, thread, moved, { kind: "person" }, new Date(2)).rev).toBe(2);
    // The editor bumps a version without changing anything a reader sees.
    const stamped: CanvasScene = { ...moved, elements: moved.elements.map((e) => ({ ...e, version: (e.version ?? 1) + 1 })) };
    expect(commitCanvas(dir, thread, stamped, { kind: "person" }, new Date(3)).rev).toBe(2);
    // Nor is the editor naming the default background on a scene that had none.
    expect(commitCanvas(dir, thread, { ...stamped, appState: { viewBackgroundColor: "#ffffff" } }, { kind: "person" }, new Date(4)).rev).toBe(2);
    expect(readCanvasMeta(dir, thread).rev).toBe(2);
    expect(readCanvasScene(dir, thread).elements[0]!.version).toBe(stamped.elements[0]!.version);
    const since = sinceLines(readCanvasLog(dir, thread), 1, { kind: "agent", name: "Agent", key: "a" });
    expect(since.lines).toHaveLength(1);
    expect(since.lines[0]).toContain("the person moved");
    expect(since.lines[0]).toContain("queue");
    // Its own change is not news to the agent that made it.
    expect(sinceLines(readCanvasLog(dir, thread), 0, { kind: "agent", name: "Agent", key: "a" }).lines).toHaveLength(1);
    // A long list is cut at a whole revision, and the agent's point moves only as far as it was told.
    let scene = stamped;
    for (let i = 0; i < 3; i++) {
      scene = applyOps(scene, Array.from({ length: 20 }, (_, n) => ({ add: "box", text: `P${i}-${n}` })), { by: "Other", now: 9 }).scene;
      commitCanvas(dir, thread, scene, { kind: "agent", name: "Other", key: "o" }, new Date(10 + i));
    }
    const cut = sinceLines(readCanvasLog(dir, thread), 2, { kind: "agent", name: "Agent", key: "a" });
    expect(cut.cut).toBe(true);
    expect(cut.through).toBe(3);
    expect(cut.lines).toHaveLength(20);
    expect(sinceLines(readCanvasLog(dir, thread), cut.through, { kind: "agent", name: "Agent", key: "a" }).lines.length).toBeGreaterThan(0);
    // The person taking back the agent's change is said as that, to that agent only.
    commitCanvas(dir, thread, { ...scene, elements: scene.elements.map((e) => (e.type === "ellipse" ? { ...e, x: e.x - 200, version: (e.version ?? 1) + 5 } : e)) }, { kind: "person" }, new Date(20), { undid: 1 });
    expect(sinceLines(readCanvasLog(dir, thread), 5, { kind: "agent", name: "Agent", key: "a" }).undone).toEqual([1]);
    expect(sinceLines(readCanvasLog(dir, thread), 5, { kind: "agent", name: "Other", key: "o" }).undone).toEqual([]);
  });
});
