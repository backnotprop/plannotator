import { describe, expect, it } from "bun:test";

import { lineOrigin, mapStackLines, type StackLayer, type StackLineMap } from "./stack-layers";

// Every patch below is real `git diff` output (git 2.50, default context and
// rename detection) from scratch repos with one commit per layer: "L1 diff" is
// base..L1, "L2 diff" is L1..L2, and "whole" is base..top.
const patch = (...rows: string[]) => `${rows.join("\n")}\n`;

const at = (map: StackLineMap, path: string, start: number, end = start) => lineOrigin(map, { path, start, end });

describe("two layers, one line changed by both", () => {
  const l1 = patch(
    "diff --git a/app.ts b/app.ts",
    "index c4352f8..7887ec9 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "@@ -12,7 +12,7 @@ line 11",
    " line 12",
    " line 13",
    " line 14",
    "-line 15",
    "+line 15 by L1",
    " line 16",
    " line 17",
    " line 18",
  );
  const l2 = patch(
    "diff --git a/app.ts b/app.ts",
    "index 7887ec9..ff28d11 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,5 +1,6 @@",
    "+line 0 by L2",
    " line 1",
    "-line 2 by L1",
    "+line 2 by L2",
    " line 3",
    " line 4",
    " line 5",
  );
  const layers: StackLayer[] = [
    { id: "pr-1", patch: l1 },
    { id: "pr-2", patch: l2 },
  ];
  const map = mapStackLines(layers);

  it("gives a lower layer's line, moved down by the layer above", () => {
    // "line 15 by L1" is line 16 at the top: L2 added a line above it.
    expect(at(map, "app.ts", 16)).toEqual({ kind: "layer", id: "pr-1" });
    expect(at(map, "app.ts", 15)).toEqual({ kind: "unknown" });
  });

  it("gives the top layer's own line", () => {
    expect(at(map, "app.ts", 1)).toEqual({ kind: "layer", id: "pr-2" });
  });

  it("keeps both layers on a line the higher one rewrote, the writer of its text last", () => {
    expect(at(map, "app.ts", 3)).toEqual({ kind: "several", ids: ["pr-1", "pr-2"] });
  });

  it("is plain data that survives JSON", () => {
    const sent: StackLineMap = JSON.parse(JSON.stringify(map));
    expect(at(sent, "app.ts", 16)).toEqual({ kind: "layer", id: "pr-1" });
    expect(at(sent, "app.ts", 3)).toEqual({ kind: "several", ids: ["pr-1", "pr-2"] });
  });
});

describe("three layers", () => {
  // Top file: 1 "b by L2", 11-12 "a1/a2 by L1", 27 "line 25 by L2", 33 "c by L3".
  const map = mapStackLines([
    {
      id: "L1",
      patch: patch(
        "diff --git a/app.ts b/app.ts",
        "index ac9837c..14af646 100644",
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -8,6 +8,8 @@ line 7",
        " line 8",
        " line 9",
        " line 10",
        "+a1 by L1",
        "+a2 by L1",
        " line 11",
        " line 12",
        " line 13",
      ),
    },
    {
      id: "L2",
      patch: patch(
        "diff --git a/app.ts b/app.ts",
        "index 14af646..f560f5b 100644",
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -1,3 +1,4 @@",
        "+b by L2",
        " line 1",
        " line 2",
        " line 3",
        "@@ -24,7 +25,7 @@ line 21",
        " line 22",
        " line 23",
        " line 24",
        "-line 25",
        "+line 25 by L2",
        " line 26",
        " line 27",
        " line 28",
      ),
    },
    {
      id: "L3",
      patch: patch(
        "diff --git a/app.ts b/app.ts",
        "index f560f5b..39cc5ef 100644",
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -3,7 +3,6 @@ line 1",
        " line 2",
        " line 3",
        " line 4",
        "-line 5",
        " line 6",
        " line 7",
        " line 8",
        "@@ -31,3 +30,4 @@ line 27",
        " line 28",
        " line 29",
        " line 30",
        "+c by L3",
      ),
    },
  ]);

  it("carries each layer's lines through every layer above it", () => {
    expect(at(map, "app.ts", 1)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "app.ts", 11, 12)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "app.ts", 27)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "app.ts", 33)).toEqual({ kind: "layer", id: "L3" });
  });

  it("gives several, bottom to top, for a span over several layers' lines", () => {
    expect(at(map, "app.ts", 10, 33)).toEqual({ kind: "several", ids: ["L1", "L2", "L3"] });
    expect(at(map, "app.ts", 26, 33)).toEqual({ kind: "several", ids: ["L2", "L3"] });
  });

  it("gives unknown for base lines, other files and lines past the end", () => {
    expect(at(map, "app.ts", 2, 10)).toEqual({ kind: "unknown" });
    expect(at(map, "app.ts", 13, 26)).toEqual({ kind: "unknown" });
    expect(at(map, "other.ts", 1, 40)).toEqual({ kind: "unknown" });
    expect(at(map, "app.ts", 34, 40)).toEqual({ kind: "unknown" });
  });

  it("ignores a span's base lines next to a layer's lines", () => {
    expect(at(map, "app.ts", 5, 12)).toEqual({ kind: "layer", id: "L1" });
  });
});

describe("renames", () => {
  const l1 = patch(
    "diff --git a/old.ts b/old.ts",
    "index 624b469..50ead15 100644",
    "--- a/old.ts",
    "+++ b/old.ts",
    "@@ -1,6 +1,6 @@",
    " line 1",
    " line 2",
    "-line 3",
    "+line 3 by L1",
    " line 4",
    " line 5",
    " line 6",
  );
  const l2 = patch(
    "diff --git a/old.ts b/mid.ts",
    "similarity index 86%",
    "rename from old.ts",
    "rename to mid.ts",
    "index 50ead15..6c75871 100644",
    "--- a/old.ts",
    "+++ b/mid.ts",
    "@@ -6,7 +6,7 @@ line 5",
    " line 6",
    " line 7",
    " line 8",
    "-line 9",
    "+line 9 by L2",
    " line 10",
    " line 11",
    " line 12",
  );
  const l3 = patch(
    "diff --git a/mid.ts b/final.ts",
    "similarity index 100%",
    "rename from mid.ts",
    "rename to final.ts",
  );
  const whole = patch(
    "diff --git a/old.ts b/final.ts",
    "similarity index 73%",
    "rename from old.ts",
    "rename to final.ts",
    "index 624b469..6c75871 100644",
    "--- a/old.ts",
    "+++ b/final.ts",
    "@@ -1,12 +1,12 @@",
    " line 1",
    " line 2",
    "-line 3",
    "+line 3 by L1",
    " line 4",
    " line 5",
    " line 6",
    " line 7",
    " line 8",
    "-line 9",
    "+line 9 by L2",
    " line 10",
    " line 11",
    " line 12",
  );
  const layers: StackLayer[] = [
    { id: "L1", patch: l1 },
    { id: "L2", patch: l2 },
    { id: "L3", patch: l3 },
  ];

  it("follows a file through a rename with hunks and one with none", () => {
    const map = mapStackLines(layers);
    expect(at(map, "final.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "final.ts", 9)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "old.ts", 3)).toEqual({ kind: "unknown" });
    expect(at(map, "mid.ts", 9)).toEqual({ kind: "unknown" });
  });

  it("passes the check against the whole-stack diff under the final name", () => {
    const map = mapStackLines(layers, { reviewPatch: whole });
    expect(at(map, "final.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "final.ts", 9)).toEqual({ kind: "layer", id: "L2" });
  });
});

describe("reverts", () => {
  // L1 adds "temp" after line 2 and rewrites lines 10 and 18 of f.ts, and line
  // 3 of r.ts. L2 removes "temp", puts line 10 back, and puts r.ts back whole.
  const l1 = patch(
    "diff --git a/f.ts b/f.ts",
    "index c4352f8..3bedaa9 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,5 +1,6 @@",
    " line 1",
    " line 2",
    "+temp by L1",
    " line 3",
    " line 4",
    " line 5",
    "@@ -7,7 +8,7 @@ line 6",
    " line 7",
    " line 8",
    " line 9",
    "-line 10",
    "+line 10 by L1",
    " line 11",
    " line 12",
    " line 13",
    "@@ -15,6 +16,6 @@ line 14",
    " line 15",
    " line 16",
    " line 17",
    "-line 18",
    "+line 18 by L1",
    " line 19",
    " line 20",
    "diff --git a/r.ts b/r.ts",
    "index 94c99a3..50a73b1 100644",
    "--- a/r.ts",
    "+++ b/r.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    " line 2",
    "-line 3",
    "+line 3 by L1",
    " line 4",
    " line 5",
  );
  const l2 = patch(
    "diff --git a/f.ts b/f.ts",
    "index 3bedaa9..72b44f5 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,6 +1,5 @@",
    " line 1",
    " line 2",
    "-temp by L1",
    " line 3",
    " line 4",
    " line 5",
    "@@ -8,7 +7,7 @@ line 6",
    " line 7",
    " line 8",
    " line 9",
    "-line 10 by L1",
    "+line 10",
    " line 11",
    " line 12",
    " line 13",
    "diff --git a/r.ts b/r.ts",
    "index 50a73b1..94c99a3 100644",
    "--- a/r.ts",
    "+++ b/r.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    " line 2",
    "-line 3 by L1",
    "+line 3",
    " line 4",
    " line 5",
  );
  const whole = patch(
    "diff --git a/f.ts b/f.ts",
    "index c4352f8..72b44f5 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -15,6 +15,6 @@ line 14",
    " line 15",
    " line 16",
    " line 17",
    "-line 18",
    "+line 18 by L1",
    " line 19",
    " line 20",
  );
  const layers: StackLayer[] = [
    { id: "L1", patch: l1 },
    { id: "L2", patch: l2 },
  ];

  it("leaves nothing of a line a higher layer deleted", () => {
    const map = mapStackLines(layers);
    expect(at(map, "f.ts", 1, 9)).toEqual({ kind: "unknown" });
    expect(at(map, "f.ts", 18)).toEqual({ kind: "layer", id: "L1" });
  });

  it("gives unknown, with the check, for lines put back to base", () => {
    const map = mapStackLines(layers, { reviewPatch: whole });
    expect(at(map, "f.ts", 10)).toEqual({ kind: "unknown" });
    expect(at(map, "r.ts", 1, 5)).toEqual({ kind: "unknown" });
    expect(at(map, "f.ts", 18)).toEqual({ kind: "layer", id: "L1" });
  });
});

describe("a file deleted by one layer and added back by the next", () => {
  const l1 = patch(
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index f985857..0000000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,6 +0,0 @@",
    "-line 1",
    "-line 2",
    "-line 3",
    "-line 4",
    "-line 5",
    "-line 6",
  );
  const l2 = patch(
    "diff --git a/gone.ts b/gone.ts",
    "new file mode 100644",
    "index 0000000..2dbbf8f",
    "--- /dev/null",
    "+++ b/gone.ts",
    "@@ -0,0 +1,6 @@",
    "+line 1",
    "+line 2",
    "+line 3",
    "+line 4 by L2",
    "+line 5",
    "+line 6",
  );
  const whole = patch(
    "diff --git a/gone.ts b/gone.ts",
    "index f985857..2dbbf8f 100644",
    "--- a/gone.ts",
    "+++ b/gone.ts",
    "@@ -1,6 +1,6 @@",
    " line 1",
    " line 2",
    " line 3",
    "-line 4",
    "+line 4 by L2",
    " line 5",
    " line 6",
  );
  const layers: StackLayer[] = [
    { id: "L1", patch: l1 },
    { id: "L2", patch: l2 },
  ];

  it("gives the whole file to the layer that added it back", () => {
    expect(at(mapStackLines(layers), "gone.ts", 1, 6)).toEqual({ kind: "layer", id: "L2" });
  });

  it("with the check, keeps only the lines the review shows as changed", () => {
    const map = mapStackLines(layers, { reviewPatch: whole });
    expect(at(map, "gone.ts", 4)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "gone.ts", 1, 3)).toEqual({ kind: "unknown" });
  });
});

describe("check", () => {
  const l1 = patch(
    "diff --git a/a.ts b/a.ts",
    "index c8b13a5..c957be0 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "diff --git a/b.ts b/b.ts",
    "index c8b13a5..c957be0 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
  );
  const l2 = patch(
    "diff --git a/a.ts b/a.ts",
    "index c957be0..7862675 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -3,6 +3,6 @@ line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "-line 6",
    "+line 6 by L2",
    " line 7",
    " line 8",
  );
  // The review was made before L2 was force-pushed: its line 6 differs.
  const staleReview = patch(
    "diff --git a/a.ts b/a.ts",
    "index c8b13a5..afcbc4e 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,8 +1,8 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "-line 6",
    "+line 6 by L2, pushed again",
    " line 7",
    " line 8",
    "diff --git a/b.ts b/b.ts",
    "index c8b13a5..c957be0 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
  );
  const layers: StackLayer[] = [
    { id: "L1", patch: l1 },
    { id: "L2", patch: l2 },
  ];

  it("takes every run from a file whose review lines a layer did not write", () => {
    const map = mapStackLines(layers, { reviewPatch: staleReview });
    expect(at(map, "a.ts", 1, 8)).toEqual({ kind: "unknown" });
    expect(at(map, "b.ts", 2)).toEqual({ kind: "layer", id: "L1" });
  });

  it("still labels correctly when the review is only the top layer's diff", () => {
    const map = mapStackLines(layers, { reviewPatch: l2 });
    expect(at(map, "a.ts", 6)).toEqual({ kind: "layer", id: "L2" });
  });
});

describe("malformed patches", () => {
  const good = patch(
    "diff --git a/a.ts b/a.ts",
    "index c8b13a5..c957be0 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
  );
  const truncated = good.split("\n").slice(0, -3).join("\n");
  const cases: [string, StackLayer[], { reviewPatch: string } | undefined][] = [
    ["a layer cut off mid-hunk", [{ id: "L1", patch: truncated }], undefined],
    ["a layer that is not a diff", [{ id: "L1", patch: "<html>rate limited</html>" }], undefined],
    ["a review cut off mid-hunk", [{ id: "L1", patch: good }], { reviewPatch: truncated }],
    ["a review that is not a diff", [{ id: "L1", patch: good }], { reviewPatch: "not a diff" }],
  ];

  for (const [name, layers, check] of cases) {
    it(`gives unknown for ${name}, without throwing`, () => {
      const map = mapStackLines(layers, check);
      expect(at(map, "a.ts", 1, 5)).toEqual({ kind: "unknown" });
      expect(map.ids).toEqual(["L1"]);
    });
  }

  it("treats an empty layer as one that changed nothing", () => {
    const map = mapStackLines([
      { id: "L1", patch: good },
      { id: "L2", patch: "" },
    ]);
    expect(at(map, "a.ts", 2)).toEqual({ kind: "layer", id: "L1" });
  });

  it("gives unknown for runs naming a layer the map has no id for", () => {
    const map: StackLineMap = { ids: ["L1"], runs: { "a.ts": [[1, 3, [4]]] } };
    expect(at(map, "a.ts", 2)).toEqual({ kind: "unknown" });
  });

  it("does not read object built-ins as paths", () => {
    const map = mapStackLines([{ id: "L1", patch: good }]);
    expect(at(map, "constructor", 1)).toEqual({ kind: "unknown" });
    expect(at(map, "__proto__", 1)).toEqual({ kind: "unknown" });
  });
});
