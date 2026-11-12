import { describe, expect, test } from "bun:test";
import {
  buildCallTreeRows,
  calleeName,
  callTreeAt,
  callTreeFromEntry,
  callTreeNodeMatches,
  findCallTreeRoot,
  type CallTreeNode,
  type CallTreeSourceTree,
} from "./call-tree";

function n(
  key: string,
  label: string,
  file: string | undefined,
  line: number | undefined,
  children: CallTreeNode[] = [],
  status: CallTreeNode["status"] = "same",
): CallTreeNode {
  return { key, label, status, ...(file ? { file } : {}), ...(line ? { line } : {}), children };
}

const label = n("getLabelSize", "this.getLabelSize(shape)", "note.ts", 600, [
  n("measure", "textMeasure.measureHtml(html)", "note.ts", 612, [
    n("rect", "elm.getBoundingClientRect()", "text.ts", 263, [], "removed"),
    n("parley", "parley.layout(html, opts)", "text.ts", 263, [], "added"),
  ]),
]);
const entry: CallTreeSourceTree = {
  entry: "onBeforeCreate",
  tree: n("root", "onBeforeCreate(next)", "note.ts", 520, [
    n("adjust", "getNoteSizeAdjustments(shape)", "note.ts", 582, [
      label,
      n("helper", "helper()", "note.ts", 590, [n("log", "log()", "note.ts", 705)]),
    ]),
  ]),
};

describe("findCallTreeRoot", () => {
  const hunk = { file: "note.ts", newStart: 608, newEnd: 618, oldStart: 608, oldEnd: 618 };

  test("roots at the call to the sem function around the hunk, with the caller trail", () => {
    const location = findCallTreeRoot([entry], hunk, { name: "getLabelSize", newStart: 605, newEnd: 640 });
    expect(location).not.toBeNull();
    const doc = callTreeAt([entry], location!);
    expect(doc.root).toBe(label);
    expect(doc.title).toBe("getLabelSize");
    expect(doc.trail).toEqual(["onBeforeCreate", "getNoteSizeAdjustments"]);
    expect(doc.rootPath).toBe("onBeforeCreate:0/adjust:0/getLabelSize:0");
  });

  test("never picks a same-file neighbour whose name does not match", () => {
    const location = findCallTreeRoot([entry], hunk, { name: "getLabelSize", newStart: 605, newEnd: 720 });
    expect(callTreeAt([entry], location!).root).toBe(label);
  });

  test("without sem, calls written inside the hunk decide", () => {
    const location = findCallTreeRoot([entry], { file: "note.ts", newStart: 700, newEnd: 710, oldStart: 690, oldEnd: 700 });
    expect(callTreeAt([entry], location!).title).toBe("helper");
  });

  test("a removed call is matched on the old side of the hunk", () => {
    const tree: CallTreeSourceTree = {
      entry: "run",
      tree: n("run", "run()", "a.ts", 1, [n("f", "f()", "a.ts", 3, [n("gone", "gone()", "b.ts", 40, [], "removed")])]),
    };
    const newSideOnly = findCallTreeRoot([tree], { file: "b.ts", newStart: 10, newEnd: 20, oldStart: 90, oldEnd: 99 });
    expect(newSideOnly).toBeNull();
    const oldSide = findCallTreeRoot([tree], { file: "b.ts", newStart: 10, newEnd: 20, oldStart: 35, oldEnd: 45 });
    expect(callTreeAt([tree], oldSide!).title).toBe("f");
  });

  test("an entry written in the function roots at the entry with no trail", () => {
    const location = findCallTreeRoot([entry], { file: "note.ts", newStart: 518, newEnd: 530, oldStart: 518, oldEnd: 530 }, {
      name: "onBeforeCreate", newStart: 518, newEnd: 600,
    });
    const doc = callTreeAt([entry], location!);
    expect(doc.root).toBe(entry.tree);
    expect(doc.trail).toEqual([]);
  });

  test("the shallowest copy of a call wins across entries", () => {
    const deep: CallTreeSourceTree = { entry: "a", tree: n("a", "a()", "x.ts", 1, [n("b", "b()", "x.ts", 2, [n("g", "g()", "x.ts", 3, [n("h", "h()", "x.ts", 51)])])]) };
    const shallow: CallTreeSourceTree = { entry: "c", tree: n("c", "c()", "y.ts", 1, [n("g2", "g()", "y.ts", 9, [n("h2", "h()", "x.ts", 51)])]) };
    const location = findCallTreeRoot([deep, shallow], { file: "x.ts", newStart: 48, newEnd: 55, oldStart: 48, oldEnd: 55 }, {
      name: "g", newStart: 45, newEnd: 60,
    });
    expect(location?.treeIndex).toBe(1);
    expect(callTreeAt([deep, shallow], location!).trail).toEqual(["c"]);
  });

  test("without sem, a change inside another call's arguments roots at the function making that call", () => {
    const tree: CallTreeSourceTree = {
      entry: "install",
      tree: n("install", "install()", "cf.ts", 846, [
        n("validate", "validatePrunedLanguage(nodePath)", "cf.ts", 930, [
          { ...n("run", "runCommand(executable, args, options)", "cf.ts", 651, [
            n("env", "gitColorFreeEnvironment(environment)", "cf.ts", 662, [], "added"),
          ]), endLine: 670 },
        ]),
      ]),
    };
    const location = findCallTreeRoot([tree], { file: "cf.ts", newStart: 657, newEnd: 665, oldStart: 657, oldEnd: 664 });
    const doc = callTreeAt([tree], location!);
    expect(doc.title).toBe("validatePrunedLanguage");
    expect(doc.trail).toEqual(["install"]);
  });

  test("a hunk with no calls in it finds no tree", () => {
    expect(findCallTreeRoot([entry], { file: "other.ts", newStart: 1, newEnd: 30, oldStart: 1, oldEnd: 30 })).toBeNull();
  });
});

describe("buildCallTreeRows", () => {
  test("bands only a call whose own line changed; a wholly new subtree bands its top row only", () => {
    const tree: CallTreeSourceTree = {
      entry: "e",
      tree: n("e", "e()", "a.ts", 1, [
        n("new", "brandNew()", "a.ts", 2, [
          n("inner", "inner()", "b.ts", 5, [n("deeper", "deeper()", "b.ts", 9, [], "added")], "added"),
        ], "added"),
        n("old", "gone()", "a.ts", 3, [], "removed"),
      ]),
    };
    const rows = buildCallTreeRows(callTreeFromEntry(tree, 0));
    const byKey = new Map(rows.map((row) => [row.node.key, row]));
    expect(byKey.get("new")?.band).toBe("added");
    expect(byKey.get("inner")?.band).toBeNull();
    expect(byKey.get("inner")?.dot).toBe("added");
    expect(byKey.get("deeper")?.band).toBeNull();
    expect(byKey.get("old")?.band).toBe("removed");
    expect(byKey.get("e")?.band).toBeNull();
  });

  test("a repeated call is marked and not expanded again", () => {
    const body = () => [n("x", "x()", "s.ts", 11), n("y", "y()", "s.ts", 12)];
    const tree: CallTreeSourceTree = {
      entry: "e",
      tree: n("e", "e()", "a.ts", 1, [
        n("s1", "util.shared()", "a.ts", 2, body(), "same"),
        n("chg", "changed()", "a.ts", 3, [], "added"),
        n("s2", "util.shared()", "a.ts", 4, body(), "same"),
      ]),
    };
    const folds = new Map([["e:0/s1:0", false], ["e:0/s2:2", false]]);
    const rows = buildCallTreeRows(callTreeFromEntry(tree, 0), { folds });
    const shared = rows.filter((row) => row.node.label === "util.shared()");
    expect(shared.map((row) => row.repeat)).toEqual([false, true]);
    expect(rows.filter((row) => row.parentId === shared[0]!.id)).toHaveLength(2);
    expect(rows.filter((row) => row.parentId === shared[1]!.id)).toHaveLength(0);
  });

  test("unchanged branches fold by default with their count; changed paths stay open; a fold override wins", () => {
    const doc = callTreeFromEntry(entry, 0);
    const rows = buildCallTreeRows(doc);
    const helper = rows.find((row) => row.node.key === "helper")!;
    expect(helper.folded).toBe(true);
    expect(helper.childCount).toBe(1);
    expect(rows.some((row) => row.node.key === "parley")).toBe(true);
    expect(rows.some((row) => row.node.key === "log")).toBe(false);

    const unfolded = buildCallTreeRows(doc, { folds: new Map([[helper.id, false]]) });
    expect(unfolded.some((row) => row.node.key === "log")).toBe(true);
    const measure = rows.find((row) => row.node.key === "measure")!;
    const folded = buildCallTreeRows(doc, { folds: new Map([[measure.id, true]]) });
    expect(folded.some((row) => row.node.key === "parley")).toBe(false);
  });

  test("Changes only keeps the root and the paths to changes, nothing else", () => {
    const rows = buildCallTreeRows(callTreeFromEntry(entry, 0), { changesOnly: true });
    expect(rows.map((row) => row.node.key)).toEqual(["root", "adjust", "getLabelSize", "measure", "rect", "parley"]);
  });

  test("tree lines: the last child gets the elbow and closes its column", () => {
    const rows = buildCallTreeRows(callTreeFromEntry(entry, 0), { folds: new Map([["onBeforeCreate:0/adjust:0/helper:1", false]]) });
    const byKey = new Map(rows.map((row) => [row.node.key, row]));
    expect(byKey.get("root")?.branch).toBeNull();
    expect(byKey.get("adjust")).toMatchObject({ branch: "elbow", guides: [] });
    expect(byKey.get("getLabelSize")).toMatchObject({ branch: "tee", guides: ["blank"] });
    expect(byKey.get("measure")).toMatchObject({ branch: "elbow", guides: ["blank", "pipe"] });
    expect(byKey.get("helper")).toMatchObject({ branch: "elbow", guides: ["blank"] });
    expect(byKey.get("log")).toMatchObject({ branch: "elbow", guides: ["blank", "blank"] });
    expect(byKey.get("measure")?.callerFile).toBe("note.ts");
    expect(byKey.get("rect")?.callerFile).toBe("note.ts");
  });

  test("a deep tree and a few thousand rows build without recursion limits, quickly", () => {
    let deep: CallTreeNode = n("leaf", "leaf()", "d.ts", 1, [], "added");
    for (let depth = 0; depth < 4000; depth++) deep = n(`d${depth}`, `f${depth}()`, "d.ts", depth + 2, [deep]);
    expect(buildCallTreeRows(callTreeFromEntry({ entry: "deep", tree: deep }, 0))).toHaveLength(4001);

    const wide = n("w", "w()", "w.ts", 1, Array.from({ length: 60 }, (_, i) => (
      n(`c${i}`, `c${i}()`, "w.ts", i + 2, Array.from({ length: 80 }, (_, j) => n(`g${i}-${j}`, `g${i}_${j}()`, "w.ts", 1000 + i * 100 + j, [], j === 0 ? "added" : "same")))
    )));
    const started = performance.now();
    const rows = buildCallTreeRows(callTreeFromEntry({ entry: "wide", tree: wide }, 0));
    expect(rows).toHaveLength(1 + 60 + 60 * 80);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("calleeName", () => {
  test("is the called name without receiver, arguments or new", () => {
    expect(calleeName("textMeasure.measureHtml(html, { a })")).toBe("measureHtml");
    expect(calleeName("new Foo.Bar(x)")).toBe("Bar");
    expect(calleeName("if (x)")).toBe("if");
  });
});

describe("search rows", () => {
  const doc = callTreeFromEntry(entry, 0);

  test("keeps matches and their callers, all open, even inside a branch folded by default", () => {
    expect(buildCallTreeRows(doc).some((row) => row.node.key === "log")).toBe(false);
    const rows = buildCallTreeRows(doc, { query: "LOG(" });
    expect(rows.map((row) => row.node.key)).toEqual(["root", "adjust", "helper", "log"]);
    expect(rows.filter((row) => row.match).map((row) => row.node.key)).toEqual(["log"]);
    expect(rows.every((row) => !row.folded)).toBe(true);
  });

  test("matches the file path too, trimmed, in any case (the Paths rule)", () => {
    expect(callTreeNodeMatches(n("x", "foo()", "src/Text.ts", 1), "  text.TS ")).toBe(true);
    expect(callTreeNodeMatches(n("x", "foo()", "src/a.ts", 1), "   ")).toBe(false);
    const rows = buildCallTreeRows(doc, { query: "text.ts" });
    expect(rows.filter((row) => row.match).map((row) => row.node.key)).toEqual(["rect", "parley"]);
  });

  test("with Changes only, only changed paths are searched", () => {
    const all = buildCallTreeRows(doc, { query: "()" }).filter((row) => row.match).length;
    const changed = buildCallTreeRows(doc, { query: "()", changesOnly: true }).filter((row) => row.match);
    expect(changed.length).toBeLessThan(all);
    expect(changed.every((row) => row.hasChange)).toBe(true);
  });

  test("no match leaves the root alone; a fold made while searching hides that branch only", () => {
    expect(buildCallTreeRows(doc, { query: "nothing-matches" }).map((row) => row.node.key)).toEqual(["root"]);
    const rows = buildCallTreeRows(doc, { query: "()", folds: new Map([["onBeforeCreate:0/adjust:0/getLabelSize:0", true]]) });
    expect(rows.some((row) => row.node.key === "measure")).toBe(false);
    expect(rows.some((row) => row.node.key === "log")).toBe(true);
  });
});
