/**
 * The thread canvas's board rules (canvas-board.ts): what an agent's `plannotator canvas --file` and `--patch` accept,
 * and what they keep of the person's standing. What regresses: a bad board saved half way, a patch applied in part,
 * a part the person deleted coming back, a pinned part moved by the agent, or ids changing under a patch (the
 * person's pins and the read-back are by id).
 */
import { describe, expect, test } from "bun:test";
import { BOARD_MAX_CHARS, dropDeleted, emptyStanding, findIds, parseBoard, patchBoard, savedReply, writeBoard, type BoardPictures, type BoardStanding } from "./canvas-board";

const pictures: BoardPictures = {
  resolve: (src) => (src.includes("missing") ? { ok: false, error: `no file at ${src}` } : { ok: true, src: `files/${src.split("/").pop()}` }),
};

const BOARD = `<div id="app" data-frame="phone" style="display:flex;flex-direction:column;gap:8px">
  <p id="title" style="font-size:20px;font-weight:700">Settings</p>
  <div id="rows" style="display:flex;flex-direction:column">
    <div id="row-1" style="display:flex"><p id="row-1-label">Push alerts</p></div>
    <div id="row-2" style="display:flex"><p id="row-2-label"><b>Email updates</b></p></div>
  </div>
</div>
<aside id="note" data-note="row-2">Starts off</aside>
<a data-arrow from="note" to="row-2"></a>`;

const write = (src: string, standing: BoardStanding = emptyStanding(), version = 0) => writeBoard(src, standing, version, pictures, "/work");
const saved = (src = BOARD) => {
  const r = write(src);
  if (!r.ok) throw new Error(r.error);
  return r.html;
};
const idsOf = (html: string) => [...findIds(parseBoard(html).root).keys()].sort();
const patch = (html: string, ops: string, standing: BoardStanding = emptyStanding()) => patchBoard(html, ops, standing, "msg_T", pictures, "/work");

describe("a whole board", () => {
  test("a good board saves; its arrow gets an id named by its ends", () => {
    const r = write(BOARD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.ids.keys()]).toContain("arrow-note-row-2");
    expect(r.html).toContain('id="arrow-note-row-2"');
  });

  test("every problem is listed and nothing is saved", () => {
    const r = write(`<div id="a" style="position:absolute;color:#ff0000"><table></table><p>no id</p><p id="a">dup</p><i id="Bad"></i></div>`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toStartWith("error: board not saved");
    for (const bit of ['"position:absolute"', "<table> is not allowed", "needs an id", 'id "a" is already used', 'id "Bad" must be lowercase', 'colour in "color:#ff0000"']) expect(r.error).toContain(bit);
  });

  test("only board colours, sizes in range, no grid, no coordinates", () => {
    expect(write(`<p id="a" style="color:var(--ink);background:var(--blue-soft)">ok</p>`).ok).toBe(true);
    for (const style of ["color:var(--brand)", "font-size:40px", "display:grid", "left:10px", "margin-top:-4px", "background:url(x.png)", "width:3000px"]) {
      expect(write(`<p id="a" style="${style}">x</p>`).ok).toBe(false);
    }
    expect(write(`<p id="a" x="10">x</p>`).ok).toBe(false);
  });

  test("a full page, an empty board and a board over the limit are refused", () => {
    expect(write("<html><body><p id='a'>x</p></body></html>").ok).toBe(false);
    expect(write("   ").ok).toBe(false);
    expect(write(`<p id="a">${"x".repeat(60001)}</p>`).ok).toBe(false);
  });

  test("pictures: a file path goes through the resolver; a URL never does", () => {
    const r = write(`<img id="shot" src="/work/shot.png" alt="s">`);
    expect(r.ok && r.html).toContain('src="files/shot.png"');
    expect(write(`<img id="shot" src="https://example.com/a.png">`).ok).toBe(false);
    expect(write(`<img id="shot" src="data:image/png;base64,AA">`).ok).toBe(false);
    const missing = write(`<img id="shot" src="/work/missing.png">`);
    expect(!missing.ok && missing.error).toContain("no file at /work/missing.png");
  });

  test("arrows and notes must point at parts on the board", () => {
    expect(write(`<p id="a">x</p><a data-arrow from="a" to="nope"></a>`).ok).toBe(false);
    expect(write(`<p id="a">x</p><aside id="n" data-note="nope">x</aside>`).ok).toBe(false);
    expect(write(`<div id="d"><aside id="n" data-note="d">x</aside></div>`).ok).toBe(false);
  });

  test("the person's standing: a deleted id may not come back; pins are kept while their part is on the board", () => {
    const standing: BoardStanding = { pins: { title: { x: 1, y: 2, w: 3, h: 4 }, gone: { x: 0, y: 0, w: 1, h: 1 } }, deleted: ["row-1"], deletedHtml: {} };
    const back = write(BOARD, standing, 1);
    expect(!back.ok && back.error).toContain('"row-1" was deleted by the person');
    const without = BOARD.replace(/<div id="row-1".*?<\/div>\n/, "");
    const r = write(without, standing, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.pins)).toEqual(["title"]);
    expect(r.extra).toContain("#title");
    expect(r.extra).toContain("#gone");
    expect(r.extra).toContain("--patch");
    const first = write(without, { ...standing, pins: {} }, 0);
    expect(first.ok && first.extra).toBe("");
  });
});

describe("a patch", () => {
  test("text keeps a lone bold wrapper and every id stays", () => {
    const html = saved();
    const r = patch(html, `text #row-2-label "Email digest"`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('<p id="row-2-label"><b>Email digest</b></p>');
    expect(idsOf(r.html)).toEqual(idsOf(html));
  });

  test("set merges style, add/move/arrow place by id, remove takes its arrows and notes with it", () => {
    const html = saved();
    const r = patch(
      html,
      [
        `set #title style="color:var(--blue)"`,
        `add after #row-2 <div id="row-3" style="display:flex"><p id="row-3-label">Haptics</p></div>`,
        `move #row-1 after #row-3`,
        `arrow #title -> #row-3 "new"`,
        `remove #row-2`,
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain('style="font-size:20px;font-weight:700;color:var(--blue)"');
    const ids = [...findIds(r.root).keys()];
    expect(ids).toContain("arrow-title-row-3");
    expect(ids).not.toContain("row-2");
    expect(ids).not.toContain("note");
    expect(ids).not.toContain("arrow-note-row-2");
    expect(r.html.indexOf('id="row-3"')).toBeLessThan(r.html.indexOf('id="row-1"'));
    expect(r.ops).toBe(5);
  });

  test("a patch that would grow the board past what a whole write may hold is refused with the write's words", () => {
    const html = saved();
    const row = (i: number) => `add into #rows <div id="pad-${i}" style="display:flex"><p id="pad-${i}-label">${"Lorem ipsum dolor sit amet ".repeat(8)}</p></div>`;
    const lines = Array.from({ length: Math.ceil(BOARD_MAX_CHARS / 250) + 5 }, (_, i) => row(i));
    const r = patch(html, lines.join("\n"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(new RegExp(`^error: the board is \\d+ characters; keep it under ${BOARD_MAX_CHARS} \\(split detail into a second board or simplify\\)$`));
    // Under the cap the same kind of patch applies.
    expect(patch(html, lines.slice(0, 3).join("\n")).ok).toBe(true);
  });

  test("all or nothing: one bad line and the board is unchanged", () => {
    const html = saved();
    const r = patch(html, `text #title "New"\nset #nope style="color:var(--ink)"`);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toStartWith("error: patch not applied, nothing changed");
    expect(r.error).toContain("no part #nope");
  });

  test("ids are stable: set id, coordinates, unknown ops, duplicate adds and an empty patch are refused", () => {
    const html = saved();
    for (const ops of [`set #title id="t2"`, `set #title x="4"`, `position #title 10 10`, `add after #title <p id="row-1">dup</p>`, "", "// just a comment"]) {
      expect(patch(html, ops).ok).toBe(false);
    }
  });

  test("the person's deletions: a deleted part cannot be targeted", () => {
    const html = dropDeleted(saved(), ["row-1"]).html;
    const r = patch(html, `text #row-1-label "back"`, { pins: {}, deleted: ["row-1", "row-1-label"], deletedHtml: {} });
    expect(!r.ok && r.error).toContain("was deleted by the person");
  });

  test("a pinned part: its place is the person's; a size change moves the pin's size and says so", () => {
    const html = saved();
    const standing: BoardStanding = { pins: { "row-2": { x: 10, y: 20, w: 300, h: 40 } }, deleted: [], deletedHtml: {} };
    const moved = patch(html, `move #row-2 before #row-1`, standing);
    expect(!moved.ok && moved.error).toContain("#row-2 was placed by the person");
    const resized = patch(html, `set #row-2 style="width:360px;height:85px"`, standing);
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(resized.pins["row-2"]).toEqual({ x: 10, y: 20, w: 360, h: 85 });
    expect(resized.notes.join(" ")).toContain("#row-2 is pinned by the person");
    expect(standing.pins["row-2"].w).toBe(300);
    const recoloured = patch(html, `set #row-2 style="background:var(--amber-soft)"`, standing);
    expect(recoloured.ok && recoloured.notes).toEqual([]);
  });

  test("removing a pinned part drops its pin and it cannot be re-added in the same patch", () => {
    const html = saved();
    const standing: BoardStanding = { pins: { "row-2": { x: 10, y: 20, w: 300, h: 40 } }, deleted: [], deletedHtml: {} };
    const r = patch(html, `remove #row-2`, standing);
    expect(r.ok && r.pins).toEqual({});
    const readd = patch(html, `remove #row-2\nadd after #row-1 <div id="row-2"><p id="row-2-label">x</p></div>`, standing);
    expect(!readd.ok && readd.error).toContain("would undo the person's move");
  });
});

describe("deleted parts", () => {
  test("dropDeleted removes the part, what is inside it, and arrows and notes that pointed at it; keeps what it was", () => {
    const { html, was } = dropDeleted(saved(), ["row-2"]);
    const ids = idsOf(html);
    expect(ids).not.toContain("row-2");
    expect(ids).not.toContain("row-2-label");
    expect(ids).not.toContain("note");
    expect(ids).not.toContain("arrow-note-row-2");
    expect(ids).toContain("row-1");
    expect(was["row-2"]).toContain('id="row-2-label"');
    expect(was["row-2"]).not.toContain("\n");
  });
});

describe("the reply", () => {
  test("no window to lay out: the agent is told the layout is not checked yet; warnings are listed one per line", () => {
    const r = write(BOARD);
    if (!r.ok) throw new Error(r.error);
    expect(savedReply(1, r.root, null, "")).toContain("layout: not checked yet");
    const warned = savedReply(1, r.root, ["#title overflows #app", "#note covers #rows"], "").split("\n");
    expect(warned).toContain("- #title overflows #app");
    expect(warned).toContain("- #note covers #rows");
    expect(savedReply(1, r.root, [], "")).toContain("layout: no problems found.");
  });
});
