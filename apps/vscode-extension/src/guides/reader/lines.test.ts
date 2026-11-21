import { describe, expect, it } from "bun:test";
import { askLines, cancelDiffLineJump, findDiffLine, scrollToDiffLine } from "./lines";

describe("which lines a selection in the Guide tab asks about", () => {
  it("added or unchanged lines are the new version's, removed lines the old version's", () => {
    expect(askLines({ start: 25, end: 31, side: "additions" })).toEqual({ side: "new", start: 25, end: 31 });
    expect(askLines({ start: 25, end: 31 })).toEqual({ side: "new", start: 25, end: 31 });
    expect(askLines({ start: 12, end: 9, side: "deletions", endSide: "deletions" })).toEqual({ side: "old", start: 9, end: 12 });
  });

  it("a selection across removed and added lines is not asked", () => {
    expect(askLines({ start: 12, end: 23, side: "deletions", endSide: "additions" })).toBeNull();
    expect(askLines({ start: 20, end: 13, side: "additions", endSide: "deletions" })).toBeNull();
  });

  // Old 10-15, new 10-14: 10, 11 unchanged; old 12, 13 removed; new 12 added; then unchanged.
  const PATCH = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -10,6 +10,5 @@",
    " ten",
    " eleven",
    "-twelve",
    "-thirteen",
    "+twelve!",
    " fourteen",
    " fifteen",
    "@@ -30,4 +29,3 @@",
    " thirty",
    "-thirty-one",
    " thirty-two",
    " thirty-three",
  ].join("\n");

  it("unchanged rows take the side of the removed lines selected with them (the unified view reports them as new lines)", () => {
    // Second hunk: old 30 = new 29, old 31 removed, old 32 = new 30, old 33 = new 31.
    // Both ends are unchanged rows, but the removed line 31 lies between them: the old side, covering it.
    expect(askLines({ start: 29, end: 31, side: "additions", endSide: "additions" }, PATCH)).toEqual({ side: "old", start: 30, end: 33 });
    // Unchanged rows with nothing removed between them stay on the new side.
    expect(askLines({ start: 30, end: 31, side: "additions", endSide: "additions" }, PATCH)).toEqual({ side: "new", start: 30, end: 31 });
    expect(askLines({ start: 10, end: 12, side: "additions", endSide: "additions" }, PATCH)).toBeNull();
    // Removed lines only (both ends deletions): the old side.
    expect(askLines({ start: 12, end: 13, side: "deletions", endSide: "deletions" }, PATCH)).toEqual({ side: "old", start: 12, end: 13 });
    expect(askLines({ start: 29, end: 31, side: "additions", endSide: "deletions" }, PATCH)).toEqual({ side: "old", start: 30, end: 31 });
    expect(askLines({ start: 31, end: 31, side: "deletions", endSide: "additions" }, PATCH)).toEqual({ side: "old", start: 31, end: 33 });
    // Unchanged line above, removed lines (no added line between): the old side, old numbers.
    expect(askLines({ start: 11, end: 13, side: "additions", endSide: "deletions" }, PATCH)).toEqual({ side: "old", start: 11, end: 13 });
  });

  it("a selection that holds both removed and added lines is still not asked, patch or not", () => {
    // From the removed line 12 down to the unchanged line 14 (new 13): the added line 12 lies between.
    expect(askLines({ start: 12, end: 13, side: "deletions", endSide: "additions" }, PATCH)).toBeNull();
    // An endpoint the patch does not have (an expanded line far away): not guessed.
    expect(askLines({ start: 12, end: 200, side: "deletions", endSide: "additions" }, PATCH)).toBeNull();
    expect(askLines({ start: 29, end: 200, side: "additions", endSide: "additions" }, PATCH)).toBeNull();
    // Neither end in the patch, one side: the lines as selected.
    expect(askLines({ start: 100, end: 105, side: "additions", endSide: "additions" }, PATCH)).toEqual({ side: "new", start: 100, end: 105 });
  });
});

describe.skipIf(typeof document === "undefined")("the row of a line, for a jump to it", () => {
  it("finds a changed row by its own side's number and an unchanged row by either number, through shadow roots", () => {
    const shell = document.createElement("div");
    const host = document.createElement("div");
    shell.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = [
      '<div data-line="9" data-line-type="change-deletion"></div>',
      '<div data-line="20" data-line-type="change-addition"></div>',
      '<div data-line="21" data-alt-line="10" data-line-type="context"></div>',
      '<div data-line="9" data-alt-line="9" data-line-type="context"></div>',
    ].join("");
    expect(findDiffLine(shell, "old", 9)?.getAttribute("data-line-type")).toBe("change-deletion");
    expect(findDiffLine(shell, "new", 20)?.getAttribute("data-line-type")).toBe("change-addition");
    expect(findDiffLine(shell, "new", 21)?.getAttribute("data-alt-line")).toBe("10");
    expect(findDiffLine(shell, "old", 10)?.getAttribute("data-line")).toBe("21");
    expect(findDiffLine(shell, "new", 99)).toBeNull();
  });

  const shellOf = (html: string) => {
    const shell = document.createElement("div");
    const host = document.createElement("div");
    shell.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = html;
    return shell;
  };

  it("unified view: an unchanged row's data-line is new and data-alt-line old, so colliding numbers find the right row", () => {
    const shell = shellOf(
      '<div data-unified><div id="a" data-line="30" data-alt-line="25" data-line-type="context"></div>' +
        '<div id="b" data-line="35" data-alt-line="30" data-line-type="context"></div></div>',
    );
    expect(findDiffLine(shell, "old", 30)?.id).toBe("b");
    expect(findDiffLine(shell, "new", 30)?.id).toBe("a");
    expect(findDiffLine(shell, "old", 25)?.id).toBe("a");
    expect(findDiffLine(shell, "new", 35)?.id).toBe("b");
    expect(findDiffLine(shell, "old", 35)).toBeNull();
    expect(findDiffLine(shell, "new", 25)).toBeNull();
  });

  it("split view: in the removed column data-line is old; in the added column new; each side found in its own column", () => {
    const shell = shellOf(
      // Removed column: (old 30, new 35) then (old 35, new 40); added column: the same rows, numbers the other way.
      '<div data-deletions><div id="d1" data-line="30" data-alt-line="35" data-line-type="context"></div>' +
        '<div id="d2" data-line="35" data-alt-line="40" data-line-type="context"></div></div>' +
        '<div data-additions><div id="a1" data-line="35" data-alt-line="30" data-line-type="context"></div>' +
        '<div id="a2" data-line="40" data-alt-line="35" data-line-type="context"></div></div>',
    );
    expect(findDiffLine(shell, "old", 35)?.id).toBe("d2");
    expect(findDiffLine(shell, "new", 35)?.id).toBe("a1");
    expect(findDiffLine(shell, "old", 30)?.id).toBe("d1");
    expect(findDiffLine(shell, "new", 40)?.id).toBe("a2");
    expect(findDiffLine(shell, "old", 40)).toBeNull();
  });

  it("a changed row wins over an unchanged row with the same number", () => {
    const shell = shellOf(
      '<div data-unified><div id="ctx" data-line="40" data-alt-line="12" data-line-type="context"></div>' +
        '<div id="del" data-line="12" data-line-type="change-deletion"></div>' +
        '<div id="add" data-line="12" data-line-type="change-addition"></div></div>',
    );
    expect(findDiffLine(shell, "old", 12)?.id).toBe("del");
    expect(findDiffLine(shell, "new", 12)?.id).toBe("add");
  });
});

describe.skipIf(typeof document === "undefined")("a jump to a line", () => {
  const fileShell = (path: string) => {
    const shell = document.createElement("div");
    shell.setAttribute("data-guide-file-shell", path);
    document.body.appendChild(shell);
    return shell;
  };
  const row = (line: number) => {
    const el = document.createElement("div");
    el.setAttribute("data-line", String(line));
    el.setAttribute("data-line-type", "change-addition");
    let scrolled = 0;
    el.scrollIntoView = () => void scrolled++;
    return { el, scrolled: () => scrolled };
  };
  const fast = { firstMs: 5, everyMs: 5, tries: 40 };

  it("only the latest lands: an earlier jump still waiting for its row gives up when another starts", async () => {
    const late = fileShell("late.ts");
    const now = fileShell("now.ts");
    const lateRow = row(7);
    const nowRow = row(3);
    now.appendChild(nowRow.el);
    const first = scrollToDiffLine("late.ts", "new", 7, fast);
    await new Promise((r) => setTimeout(r, 15));
    const second = scrollToDiffLine("now.ts", "new", 3, fast);
    // The first jump's row turns up only after the second jump landed.
    expect(await second).toBe(true);
    late.appendChild(lateRow.el);
    expect(await first).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(lateRow.scrolled()).toBe(0);
    expect(nowRow.scrolled()).toBe(1);
    late.remove();
    now.remove();
  });

  it("is cancelled by a chapter jump or Back (cancelDiffLineJump)", async () => {
    const shell = fileShell("c.ts");
    const r = row(5);
    const jump = scrollToDiffLine("c.ts", "new", 5, fast);
    await new Promise((res) => setTimeout(res, 12));
    cancelDiffLineJump();
    shell.appendChild(r.el);
    expect(await jump).toBe(false);
    expect(r.scrolled()).toBe(0);
    shell.remove();
  });

  for (const type of ["wheel", "keydown", "pointerdown"] as const) {
    it(`gives up when the reader moves on before the row is drawn (${type})`, async () => {
      const shell = fileShell(`moved-${type}.ts`);
      const r = row(8);
      const jump = scrollToDiffLine(`moved-${type}.ts`, "new", 8, fast);
      await new Promise((res) => setTimeout(res, 12));
      window.dispatchEvent(new Event(type));
      shell.appendChild(r.el);
      expect(await jump).toBe(false);
      expect(r.scrolled()).toBe(0);
      // Once it is over, the reader's events stop touching later jumps.
      const next = scrollToDiffLine(`moved-${type}.ts`, "new", 8, fast);
      expect(await next).toBe(true);
      expect(r.scrolled()).toBe(1);
      shell.remove();
    });
  }
});
