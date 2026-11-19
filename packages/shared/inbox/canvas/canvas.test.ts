import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps, seenWords } from "./apply";
import { mergeSave, sinceLines, undoneLine } from "./changes";
import { readThings, thingsOf } from "./reading";
import { asScene, boxOf, boxesOverlap, emptyScene, farElements, pictureTiles, tameFar, type CanvasElement, type CanvasScene } from "./scene";
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
    expect(sinceLines(readCanvasLog(dir, thread), 5, { kind: "agent", name: "Agent", key: "a" }).undone.map((entry) => entry.undid)).toEqual([1]);
    expect(sinceLines(readCanvasLog(dir, thread), 5, { kind: "agent", name: "Other", key: "o" }).undone).toEqual([]);
  });
});

describe("what the break pass found in an agent's placement", () => {
  test("a place a continent away is refused, with the reach", () => {
    const scene = applyOps(emptyScene(), [{ add: "box", text: "A" }], agent).scene;
    const far = applyOps(scene, [{ add: "box", text: "lost", at: [1e9, 1e9] }], agent);
    expect(far.ok).toBe(false);
    expect(far.errors[0]).toContain("20000");
    expect(applyOps(scene, [{ add: "box", text: "near enough", at: [5000, 0] }], agent).ok).toBe(true);
  });

  test("words nobody can see are not words; wide characters get the room they take", () => {
    expect(applyOps(emptyScene(), [{ add: "note", text: " \u200b\u200b " }], agent).ok).toBe(false);
    const made = applyOps(emptyScene(), [{ add: "box", text: "abcdefgh" }, { add: "box", text: "\u652f\u4ed8\u961f\u5217\u670d\u52a1\u7f51\u5173", below: "abcdefgh" }], agent);
    const [latin, cjk] = thingsOf(made.scene).filter((t) => t.kind === "box").sort((a, b) => a.box.y - b.box.y);
    // Eight Chinese characters need about twice the width of eight Latin letters.
    expect(cjk!.box.w).toBeGreaterThan(latin!.box.w * 1.3);
  });

  test("many things near one box make a block around it, not a line across the board", () => {
    let scene = applyOps(emptyScene(), [{ add: "box", text: "Hub" }], agent).scene;
    scene = applyOps(scene, Array.from({ length: 60 }, (_, i) => ({ add: "note", text: `n${i}`, near: "Hub" })), agent).scene;
    const all = thingsOf(scene);
    const xs = all.map((t) => t.box.x);
    const ys = all.map((t) => t.box.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(w, h) / Math.min(w, h)).toBeLessThan(3);
  });
});

describe("what the recheck found (round 4)", () => {
  const URL = "https://example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a?tab=comments&filter=unresolved";
  const CJK = "\u652f\u4ed8\u7f51\u5173\u8d85\u65f6\u540e\u7684\u91cd\u8bd5\u7b56\u7565\u9700\u8981\u4e0e\u98ce\u63a7\u56e2\u961f\u786e\u8ba4\u540e\u624d\u80fd\u4e0a\u7ebf";

  test("N2: an agent's words are stored exactly as given; no line break is ever put into them", () => {
    const made = applyOps(emptyScene(), [
      { add: "box", text: URL },
      { add: "box", text: CJK, below: URL },
      { add: "box", text: "B", rightOf: URL },
      { connect: URL, to: "B", label: "enqueue" },
      { add: "text", text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", below: CJK },
    ], agent);
    expect(made.ok).toBe(true);
    const texts = made.scene.elements.filter((e) => e.type === "text").map((e) => e.text);
    expect(texts).toContain(URL);
    expect(texts).toContain(CJK);
    expect(texts).toContain("enqueue");
    for (const el of made.scene.elements.filter((e) => e.type === "text")) expect(el.text).toBe(el.originalText!);
    // A long free text keeps to a column by its width (the editor wraps it on screen), not by breaks in its words.
    const long = made.scene.elements.find((e) => e.type === "text" && String(e.text).startsWith("one two"))!;
    expect(long.autoResize).toBe(false);
    expect(long.text).not.toContain("\n");
    // Whole words name the thing, also when they are Chinese (no spaces to split on).
    const recolour = applyOps(made.scene, [{ set: CJK, color: "red" }], agent);
    expect(recolour.errors).toEqual([]);
  });

  test("N2: the reading and a name go by the words as written, not by the line breaks the editor drew them with", () => {
    const scene = applyOps(emptyScene(), [{ add: "box", text: URL }], agent).scene;
    // The editor wrapped the label for display: `text` has breaks, `originalText` is the words.
    const wrapped: CanvasScene = { ...scene, elements: scene.elements.map((e) => (e.type === "text" ? { ...e, text: `${URL.slice(0, 29)}\n${URL.slice(29, 58)}\n${URL.slice(58)}`, originalText: URL } : e)) };
    const thing = thingsOf(wrapped)[0]!;
    expect(thing.words).toBe(URL);
    expect(readThings(wrapped, thingsOf(wrapped), { full: true }).lines[0]).toContain(JSON.stringify(URL));
    expect(applyOps(wrapped, [{ set: URL, color: "blue" }], agent).ok).toBe(true);
  });

  test("N3: the joiner inside an emoji stays, a script's non-joiner stays, and invisible characters alone are still no words", () => {
    const dev = "\u{1f469}\u{1f3fd}\u200d\u{1f4bb}";
    expect(seenWords(`Fox ${dev}`)).toBe(`Fox ${dev}`);
    expect(seenWords("a\u200db\u200bc\ufeff")).toBe("abc");
    const persian = "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645";
    expect(seenWords(persian)).toBe(persian);
    const made = applyOps(emptyScene(), [{ add: "ellipse", text: `Fox owns the retry lane ${dev}` }], agent);
    expect(made.scene.elements.find((e) => e.type === "text")!.text).toContain(dev);
    expect(applyOps(emptyScene(), [{ add: "note", text: "\u200d\u200c \u200b" }], agent).ok).toBe(false);
    // A name typed without the invisible characters still finds the thing.
    const named = applyOps(emptyScene(), [{ add: "box", text: "\u0110\u1eb7ng\u200b approves" }], agent).scene;
    expect(applyOps(named, [{ set: "\u0110\u1eb7ng approves", color: "red" }], agent).ok).toBe(true);
  });

  test("6: a thing a billion pixels away is not the drawing's size, is brought beside the rest, and a place that is text is a number", () => {
    const scene = asScene({
      elements: [
        { id: "a1", type: "rectangle", x: 0, y: 0, width: 150, height: 80 },
        { id: "a2", type: "rectangle", x: 170, y: 0, width: 150, height: 80 },
        { id: "a3", type: "rectangle", x: 340, y: 0, width: 150, height: 80 },
        { id: "far1", type: "rectangle", x: 1e9, y: 1e9, width: 150, height: 80 },
        { id: "odd1", type: "rectangle", x: "12", y: null, width: 100, height: 100 },
      ],
    });
    // The element whose place was text is kept (the editor keeps it too), as a number.
    expect(scene.elements.find((e) => e.id === "odd1")).toMatchObject({ x: 12, y: 0 });
    expect([...farElements(scene.elements)]).toEqual(["far1"]);
    const reading = readThings(scene, thingsOf(scene));
    expect(Math.round(reading.box.w)).toBe(490);
    expect(reading.lines.find((l) => l.includes("far1"))).toContain("far from the rest");
    const tamed = tameFar(scene.elements);
    expect(tamed.moved).toEqual(["far1"]);
    expect(farElements(tamed.elements).size).toBe(0);
    const home = tamed.elements.find((e) => e.id === "far1")!;
    expect(home.x).toBeGreaterThan(490);
    expect(home.x).toBeLessThan(1000);
    // One thing alone, wherever it is, is the drawing: nothing to be far from.
    expect(farElements([{ id: "solo", type: "rectangle", x: 1e9, y: 1e9, width: 10, height: 10 }]).size).toBe(0);
  });

  test("16: one drag saved three times is told as one move, and a colour changed and changed back is not told", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-net-"));
    const thread = "msg_net";
    let scene = board();
    commitCanvas(dir, thread, scene, { kind: "agent", name: "Agent", key: "a" }, new Date(1));
    const step = (change: (e: CanvasElement) => Partial<CanvasElement>, type: string) => {
      scene = { ...scene, elements: scene.elements.map((e) => (e.type === type ? { ...e, ...change(e), version: (e.version ?? 1) + 1, versionNonce: (e.versionNonce ?? 1) + 1 } : e)) };
      commitCanvas(dir, thread, scene, { kind: "person" }, new Date(2));
    };
    for (let i = 0; i < 3; i++) step((e) => ({ x: e.x + 40, y: e.y + 30 }), "ellipse");
    step(() => ({ strokeColor: "#e03131", backgroundColor: "#ffc9c9" }), "ellipse");
    step(() => ({ strokeColor: "#1e1e1e", backgroundColor: "transparent" }), "ellipse");
    const since = sinceLines(readCanvasLog(dir, thread), 1, { kind: "agent", name: "Agent", key: "a" });
    const queue = since.lines.filter((l) => l.includes('"queue"'));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatch(/the person moved: ellipse/);
    expect(queue[0]).not.toContain("new colour");
  });

  test("N6: the Undo's line says what went back and what the person kept, by name", () => {
    const line = undoneLine({ rev: 5, at: "", by: { kind: "person" }, changes: [], undid: 2, undone: { back: ['box "Payments queue"'], part: ['box "Ledger, mine"'], kept: ['box "Agent note"'], gone: [] } });
    expect(line).toContain("undid your change (rev 2)");
    expect(line).toContain('Back as before: box "Payments queue".');
    expect(line).toContain('Partly back, with the person\'s own later change kept: box "Ledger, mine".');
    expect(line).toContain('Not undone, because the person changed it since: box "Agent note".');
    expect(line).not.toContain("what it added is gone");
  });

  test("29: a thing asked for by id comes with all its words; a reading cuts them and names the ones it cut", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const scene = applyOps(emptyScene(), [{ add: "box", text: long }], agent).scene;
    const things = thingsOf(scene);
    const cut = readThings(scene, things);
    expect(cut.lines[0]).toContain("\u2026");
    expect(cut.cutWords).toEqual([things[0]!.id]);
    const whole = readThings(scene, things, { only: new Set([things[0]!.id]), full: true });
    expect(whole.lines[0]).toContain(JSON.stringify(long));
    expect(whole.cutWords).toEqual([]);
  });

  test("29: three thousand strokes are said as what they are made of and where they gather, not as eight of them and a count", () => {
    const strokes: CanvasElement[] = [];
    for (let i = 0; i < 3000; i++) strokes.push(stroke(`s${String(i).padStart(5, "0")}x`, (i % 60) * 20, Math.floor(i / 60) * 20, i % 10 === 0 ? loop(8) : [[0, 0], [14, 1], [28, 0]]));
    const scene: CanvasScene = { ...emptyScene(), elements: strokes };
    const line = readThings(scene, thingsOf(scene)).lines[0]!;
    expect(line).toContain("3000 freehand strokes");
    expect(line).toMatch(/2700 flat lines/);
    expect(line).toMatch(/300 (closed loops|dots)/);
    expect(line).toContain("spread evenly");
    expect(line).not.toMatch(/\d+ more/);
    expect(line.length).toBeLessThan(500);
  });

  test("33: a frame's title has a length", () => {
    const made = applyOps(emptyScene(), [{ add: "frame", text: "t".repeat(121) }], agent);
    expect(made.ok).toBe(false);
    expect(made.errors[0]).toContain("120");
    const framed = applyOps(emptyScene(), [{ add: "frame", text: "Release" }], agent).scene;
    expect(applyOps(framed, [{ set: "Release", text: "x".repeat(121) }], agent).ok).toBe(false);
    expect(applyOps(framed, [{ set: "Release", text: "x".repeat(120) }], agent).ok).toBe(true);
  });

  test("10: a long strip is cut along its length into readable pieces; anything else is one picture", () => {
    expect(pictureTiles({ x: 0, y: 0, w: 1500, h: 900 })).toHaveLength(1);
    expect(pictureTiles({ x: 0, y: 0, w: 448, h: 2000 })).toHaveLength(1);
    const tiles = pictureTiles({ x: 10, y: 20, w: 448, h: 9048 });
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.w).toBe(448);
      expect(tile.h).toBeLessThanOrEqual(2400);
    }
    // In order, nothing left out between two pieces.
    expect(tiles[0]!.y).toBe(20);
    for (let i = 1; i < tiles.length; i++) expect(tiles[i]!.y).toBeLessThanOrEqual(tiles[i - 1]!.y + tiles[i - 1]!.h);
    expect(tiles[3]!.y + tiles[3]!.h).toBe(9068);
    expect(pictureTiles({ x: 0, y: 0, w: 12000, h: 800 }).every((t) => t.h === 800)).toBe(true);
  });

  test("18: a long label between two things that stand close sits beside them: the arrow bows out, the words lie on no thing", () => {
    const made = applyOps(emptyScene(), [
      { add: "box", text: "J", at: [0, 0] },
      { add: "ellipse", text: "Fox owns the retry lane", at: [300, -10] },
      { connect: "J", to: "Fox owns the retry lane", label: "Benachrichtigungseinstellungen \u2192 Param\u00e8tres de confidentialit\u00e9 et de s\u00e9curit\u00e9" },
    ], agent);
    expect(made.ok).toBe(true);
    const arrow = made.scene.elements.find((e) => e.type === "arrow")!;
    expect(arrow.points).toHaveLength(3);
    const label = made.scene.elements.find((e) => e.type === "text" && e.containerId === arrow.id)!;
    // The label is centred on the arrow's middle point, where the editor draws it.
    const mid = [arrow.x + arrow.points![1]![0]!, arrow.y + arrow.points![1]![1]!];
    expect(Math.abs(label.x + label.width / 2 - mid[0]!)).toBeLessThan(2);
    for (const shape of made.scene.elements.filter((e) => e.type === "rectangle" || e.type === "ellipse")) expect(boxesOverlap(boxOf(shape), boxOf(label))).toBe(false);
    // With room between the two, the arrow is straight.
    const roomy = applyOps(emptyScene(), [{ add: "box", text: "A", at: [0, 0] }, { add: "box", text: "B", at: [700, 0] }, { connect: "A", to: "B", label: "enqueue" }], agent);
    expect(roomy.scene.elements.find((e) => e.type === "arrow")!.points).toHaveLength(2);
  });

  test("19: words with marks that stack on letters are drawn in the plain face, which carries them", () => {
    const made = applyOps(emptyScene(), [{ add: "diamond", text: "approves? Z\u0351\u034c\u0300a\u0310\u0311l\u0352g\u0301o\u0300" }, { add: "box", text: "\u0110\u1eb7ng Th\u1ecb Ng\u1ecdc H\u00e2n", at: [0, 400] }], agent);
    const [zalgo, viet] = made.scene.elements.filter((e) => e.type === "text");
    expect(zalgo!.fontFamily).toBe(2);
    // Composed letters need no stacking: they keep the hand-drawn face.
    expect(viet!.fontFamily).toBe(5);
  });
});
