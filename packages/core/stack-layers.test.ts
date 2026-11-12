import { describe, expect, it } from "bun:test";

import { lineOrigin, mapStackLines, type StackLayer, type StackLineMap } from "./stack-layers";

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
  const whole = patch(
    "diff --git a/app.ts b/app.ts",
    "index c4352f8..ff28d11 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,5 +1,6 @@",
    "+line 0 by L2",
    " line 1",
    "-line 2",
    "+line 2 by L2",
    " line 3",
    " line 4",
    " line 5",
    "@@ -12,7 +13,7 @@ line 11",
    " line 12",
    " line 13",
    " line 14",
    "-line 15",
    "+line 15 by L1",
    " line 16",
    " line 17",
    " line 18",
  );
  const layers: StackLayer[] = [
    { id: "pr-1", patch: l1 },
    { id: "pr-2", patch: l2 },
  ];
  const map = mapStackLines(layers, { reviewPatch: whole });

  it("gives a lower layer's line, moved down by the layer above", () => {
    expect(map.status).toBe("ok");
    expect(at(map, "app.ts", 16)).toEqual({ kind: "layer", id: "pr-1" });
    expect(at(map, "app.ts", 15)).toEqual({ kind: "unknown" });
  });

  it("gives the top layer's own line", () => {
    expect(at(map, "app.ts", 1)).toEqual({ kind: "layer", id: "pr-2" });
  });

  it("keeps both layers on a line the higher one rewrote, the writer of its text last", () => {
    expect(at(map, "app.ts", 3)).toEqual({ kind: "several", ids: ["pr-1", "pr-2"] });
  });
});

describe("three layers", () => {
  const whole = patch(
    "diff --git a/app.ts b/app.ts",
    "index ac9837c..39cc5ef 100644",
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,13 +1,15 @@",
    "+b by L2",
    " line 1",
    " line 2",
    " line 3",
    " line 4",
    "-line 5",
    " line 6",
    " line 7",
    " line 8",
    " line 9",
    " line 10",
    "+a1 by L1",
    "+a2 by L1",
    " line 11",
    " line 12",
    " line 13",
    "@@ -22,9 +24,10 @@ line 21",
    " line 22",
    " line 23",
    " line 24",
    "-line 25",
    "+line 25 by L2",
    " line 26",
    " line 27",
    " line 28",
    " line 29",
    " line 30",
    "+c by L3",
  );
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
  ], { reviewPatch: whole });

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
    const map = mapStackLines(layers, { reviewPatch: whole });
    expect(at(map, "final.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "final.ts", 9)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "old.ts", 3)).toEqual({ kind: "unknown" });
    expect(at(map, "mid.ts", 9)).toEqual({ kind: "unknown" });
  });

  it("labels a renamed file the review shows as added, leaving its base lines unlabelled", () => {
    const asAdded = patch(
      "diff --git a/final.ts b/final.ts",
      "new file mode 100644",
      "index 0000000..6c75871",
      "--- /dev/null",
      "+++ b/final.ts",
      "@@ -0,0 +1,12 @@",
      ...["line 1", "line 2", "line 3 by L1", "line 4", "line 5", "line 6", "line 7", "line 8", "line 9 by L2", "line 10", "line 11", "line 12"].map(
        (line) => `+${line}`,
      ),
    );
    const map = mapStackLines(layers, { reviewPatch: asAdded });
    expect(map.status).toBe("ok");
    expect(at(map, "final.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "final.ts", 9)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "final.ts", 4, 8)).toEqual({ kind: "unknown" });
  });
});

describe("reverts", () => {
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

  it("gives unknown for lines a higher layer deleted or put back to base", () => {
    const map = mapStackLines(layers, { reviewPatch: whole });
    expect(at(map, "f.ts", 1, 17)).toEqual({ kind: "unknown" });
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

  it("labels only the lines the review shows as changed", () => {
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

  it("takes every run from a file whose reviewed content is not the top layer's, even when its lines line up", () => {
    const map = mapStackLines(layers, { reviewPatch: l1 });
    expect(at(map, "a.ts", 2)).toEqual({ kind: "unknown" });
    expect(at(map, "b.ts", 2)).toEqual({ kind: "layer", id: "L1" });
  });

  it("still labels correctly when the review is only the top layer's diff", () => {
    const map = mapStackLines(layers, { reviewPatch: l2 });
    expect(at(map, "a.ts", 6)).toEqual({ kind: "layer", id: "L2" });
  });
});

describe("layers that do not chain into one stack", () => {
  const unavailable = (layers: StackLayer[], reviewPatch: string, reason: string) => {
    const map = mapStackLines(layers, { reviewPatch });
    expect(map).toMatchObject({ status: "unavailable", reason, runs: {} });
  };

  const l1Stale = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..4b5ce0b 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@",
      "+// header by L1",
      " line 1",
      " line 2",
      " line 3",
      "@@ -5,7 +6,7 @@ line 4",
      " line 5",
      " line 6",
      " line 7",
      "-line 8",
      "+line 8 by L1",
      " line 9",
      " line 10",
      " line 11",
      "diff --git a/b.ts b/b.ts",
      "index f985857..0759b20 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,6 +1,6 @@",
      " line 1",
      " line 2",
      "-line 3",
      "+line 3 by L1",
      " line 4",
      " line 5",
      " line 6",
    );
  const l2Stale = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..06f2de4 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
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
  const reviewStale = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..06f2de4 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -6,7 +6,7 @@ line 5",
      " line 6",
      " line 7",
      " line 8",
      "-line 9",
      "+line 9 by L2",
      " line 10",
      " line 11",
      " line 12",
      "diff --git a/b.ts b/b.ts",
      "index f985857..0759b20 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,6 +1,6 @@",
      " line 1",
      " line 2",
      "-line 3",
      "+line 3 by L1",
      " line 4",
      " line 5",
      " line 6",
    );

  it("keeps only the stale layer's own lines in a file where a lower layer gained a commit the layer above is not rebased on", () => {
    const stack = (rewrite: (p: string) => string): StackLayer[] => [
      { id: "L1", patch: l1Stale },
      { id: "L2", patch: rewrite(l2Stale) },
    ];
    const map = mapStackLines(stack((p) => p), { reviewPatch: reviewStale });
    expect(map).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(map, "a.ts", 9)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "a.ts", 1, 8)).toEqual({ kind: "unknown" });
    expect(at(map, "a.ts", 10, 13)).toEqual({ kind: "unknown" });
    expect(at(map, "b.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    const lying = mapStackLines(stack((p) => p.replace("index 624b469..06f2de4", "index 4b5ce0b..06f2de4")), {
      reviewPatch: reviewStale,
    });
    expect(lying).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(lying, "a.ts", 1, 13)).toEqual({ kind: "unknown" });
  });

  it("follows no changed file whose diff lacks its index line", () => {
    const noIndex = (p: string) => p.replace(/^index .*\n/gm, "");
    const map = mapStackLines(
      [
        { id: "L1", patch: noIndex(l1Stale) },
        { id: "L2", patch: noIndex(l2Stale) },
      ],
      { reviewPatch: noIndex(reviewStale) },
    );
    expect(map).toEqual({ status: "unavailable", reason: "unreadable", ids: ["L1", "L2"], runs: {} });
  });

  it("follows the layers above a diff that lacks its index line, and does not call them stale", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1Stale.replace(/^index .*\n/gm, "") },
        {
          id: "L2",
          patch: patch(
            "diff --git a/b.ts b/b.ts",
            "index 0759b20..1234567 100644",
            "--- a/b.ts",
            "+++ b/b.ts",
            "@@ -4,3 +4,3 @@ line 3 by L1",
            " line 4",
            "-line 5",
            "+line 5 by L2",
            " line 6",
          ),
        },
      ],
      {
        reviewPatch: patch(
          "diff --git a/b.ts b/b.ts",
          "index f985857..1234567 100644",
          "--- a/b.ts",
          "+++ b/b.ts",
          "@@ -1,6 +1,6 @@",
          " line 1",
          " line 2",
          "-line 3",
          "+line 3 by L1",
          " line 4",
          "-line 5",
          "+line 5 by L2",
          " line 6",
        ),
      },
    );
    expect(map).toMatchObject({ status: "partial", reason: "unreadable" });
    expect(at(map, "b.ts", 5)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "b.ts", 3)).toEqual({ kind: "unknown" });
  });

  it("keeps only the upper layer's own lines when the lower layer was force-pushed and the layer above was not rebased", () => {
    const l1 = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..01bed1d 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,12 +1,13 @@",
      "+// header by L1",
      " line 1",
      " line 2",
      " line 3",
      "-line 4",
      "+line 4 by L1",
      " line 5",
      " line 6",
      " line 7",
      " line 8",
      "-line 9",
      "+line 9 by L1",
      " line 10",
      " line 11",
      " line 12",
    );
    const l2 = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..bb39f27 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,12 +1,12 @@",
      " line 1",
      " line 2",
      " line 3",
      "-line 4",
      "+line 4 by L1",
      " line 5",
      " line 6",
      " line 7",
      " line 8",
      " line 9",
      "-line 10",
      "+line 10 by L2",
      " line 11",
      " line 12",
    );
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
      ],
      { reviewPatch: l2 },
    );
    expect(map).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(map, "a.ts", 4)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "a.ts", 10)).toEqual({ kind: "layer", id: "L2" });
    expect(map.runs["a.ts"]).toEqual([
      [4, 4, [1]],
      [10, 10, [1]],
    ]);
  });

  it("labels only the top layer's own lines when it is based on a layer lower than the one below it", () => {
    const l1 = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..7ce8701 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -6,6 +6,7 @@ line 5",
      " line 6",
      " line 7",
      " line 8",
      "+}",
      " line 9",
      " line 10",
      " line 11",
    );
    const l2 = patch(
      "diff --git a/a.ts b/a.ts",
      "index 7ce8701..6d7b4fd 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -7,6 +7,7 @@ line 6",
      " line 7",
      " line 8",
      " }",
      "+}",
      " line 9",
      " line 10",
      " line 11",
    );
    const l3 = patch(
      "diff --git a/a.ts b/a.ts",
      "index 7ce8701..fec6b52 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,4 +1,4 @@",
      "-line 1",
      "+line 1 by L3",
      " line 2",
      " line 3",
      " line 4",
    );
    const review = patch(
      "diff --git a/a.ts b/a.ts",
      "index 624b469..fec6b52 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,4 +1,4 @@",
      "-line 1",
      "+line 1 by L3",
      " line 2",
      " line 3",
      " line 4",
      "@@ -6,6 +6,7 @@ line 5",
      " line 6",
      " line 7",
      " line 8",
      "+}",
      " line 9",
      " line 10",
      " line 11",
    );
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
        { id: "L3", patch: l3 },
      ],
      { reviewPatch: review },
    );
    expect(map).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(map, "a.ts", 1)).toEqual({ kind: "layer", id: "L3" });
    expect(at(map, "a.ts", 9)).toEqual({ kind: "unknown" });
  });

  it("calls the stack unreadable, not stale, when it is both", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1Stale.replace("index f985857..0759b20 100644\n", "") },
        { id: "L2", patch: l2Stale },
      ],
      { reviewPatch: reviewStale },
    );
    expect(map).toMatchObject({ status: "partial", reason: "unreadable" });
    expect(at(map, "a.ts", 9)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "b.ts", 3)).toEqual({ kind: "unknown" });
  });

  it("labels a stale layer's own line in a file the lower layer changed again (git output)", () => {
    const l1 = patch(
      "diff --git a/a.txt b/a.txt",
      "index 8e399c4..07ebaed 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -2,12 +2,12 @@ base 1",
      " base 2",
      " base 3",
      " base 4",
      "-base 5",
      "+L1 five",
      " base 6",
      " base 7",
      " base 8",
      " base 9",
      "-base 10",
      "+L1 ten",
      " base 11",
      " base 12",
      " base 13",
    );
    const l2 = patch(
      "diff --git a/a.txt b/a.txt",
      "index c6a2268..e70062f 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -27,7 +27,7 @@ base 26",
      " base 27",
      " base 28",
      " base 29",
      "-base 30",
      "+L2 thirty",
      " base 31",
      " base 32",
      " base 33",
    );
    const review = patch(
      "diff --git a/a.txt b/a.txt",
      "index 8e399c4..e70062f 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -2,7 +2,7 @@ base 1",
      " base 2",
      " base 3",
      " base 4",
      "-base 5",
      "+L1 five",
      " base 6",
      " base 7",
      " base 8",
      "@@ -27,7 +27,7 @@ base 26",
      " base 27",
      " base 28",
      " base 29",
      "-base 30",
      "+L2 thirty",
      " base 31",
      " base 32",
      " base 33",
    );
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
      ],
      { reviewPatch: review },
    );
    expect(map).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(map, "a.txt", 30)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "a.txt", 5)).toEqual({ kind: "unknown" });
  });

  it("gives nothing for a layer that is two commits' diffs joined, naming a file twice", () => {
    const c1 = patch(
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
    const c2 = patch(
      "diff --git a/a.ts b/a.ts",
      "index c957be0..739aa0a 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,6 +3,6 @@ line 2 by L1",
      " line 3",
      " line 4",
      " line 5",
      "-line 6",
      "+line 6 by L1",
      " line 7",
      " line 8",
    );
    const review = patch(
      "diff --git a/a.ts b/a.ts",
      "index c8b13a5..739aa0a 100644",
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
      "+line 6 by L1",
      " line 7",
      " line 8",
    );
    unavailable([{ id: "L1", patch: c1 + c2 }], review, "unreadable");
  });
});

describe("a file turned into a symlink", () => {
  const l1 = patch(
    "diff --git a/f.txt b/f.txt",
    "index 8d3cb57..a0b591a 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -3,3 +3,4 @@ base 2",
    " base 3",
    " base 4",
    " base 5",
    "+L1 line",
  );
  const l2 = patch(
    "diff --git a/f.txt b/f.txt",
    "deleted file mode 100644",
    "index a0b591a..0000000",
    "--- a/f.txt",
    "+++ /dev/null",
    "@@ -1,6 +0,0 @@",
    "-base 1",
    "-base 2",
    "-base 3",
    "-base 4",
    "-base 5",
    "-L1 line",
    "diff --git a/f.txt b/f.txt",
    "new file mode 120000",
    "index 0000000..b310e29",
    "--- /dev/null",
    "+++ b/f.txt",
    "@@ -0,0 +1 @@",
    "+g.txt",
    "\\ No newline at end of file",
  );
  const review = patch(
    "diff --git a/f.txt b/f.txt",
    "deleted file mode 100644",
    "index 8d3cb57..0000000",
    "--- a/f.txt",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "-base 1",
    "-base 2",
    "-base 3",
    "-base 4",
    "-base 5",
    "diff --git a/f.txt b/f.txt",
    "new file mode 120000",
    "index 0000000..b310e29",
    "--- /dev/null",
    "+++ b/f.txt",
    "@@ -0,0 +1 @@",
    "+g.txt",
    "\\ No newline at end of file",
  );

  it("is not stale when every layer chains, and labels the link", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
      ],
      { reviewPatch: review },
    );
    expect(map).toEqual({ status: "ok", ids: ["L1", "L2"], runs: { "f.txt": [[1, 1, [1]]] } });
  });

  it("is still stale when the file it deletes is not the lower layer's", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2.replace("index a0b591a..0000000", "index 8d3cb57..0000000") },
      ],
      { reviewPatch: review },
    );
    expect(map).toMatchObject({ status: "partial", reason: "stale" });
    expect(at(map, "f.txt", 1)).toEqual({ kind: "layer", id: "L2" });
  });
});

describe("a file that turns binary and back", () => {
  const l1 = patch(
    "diff --git a/a.ts b/a.ts",
    "index f985857..44c0f44 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "diff --git a/t.dat b/t.dat",
    "index f985857..44c0f44 100644",
    "--- a/t.dat",
    "+++ b/t.dat",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
  );
  const l2 = patch("diff --git a/t.dat b/t.dat", "index 44c0f44..084bd32 100644", "Binary files a/t.dat and b/t.dat differ");
  const l3 = patch("diff --git a/t.dat b/t.dat", "index 084bd32..44c0f44 100644", "Binary files a/t.dat and b/t.dat differ");
  const review = patch(
    "diff --git a/a.ts b/a.ts",
    "index f985857..44c0f44 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
    "diff --git a/t.dat b/t.dat",
    "index f985857..44c0f44 100644",
    "--- a/t.dat",
    "+++ b/t.dat",
    "@@ -1,5 +1,5 @@",
    " line 1",
    "-line 2",
    "+line 2 by L1",
    " line 3",
    " line 4",
    " line 5",
  );

  it("forgets the file's lines at the binary step, and keeps the other files'", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
        { id: "L3", patch: l3 },
      ],
      { reviewPatch: review },
    );
    expect(map.status).toBe("ok");
    expect(at(map, "t.dat", 2)).toEqual({ kind: "unknown" });
    expect(at(map, "a.ts", 2)).toEqual({ kind: "layer", id: "L1" });
  });
});

describe("a layer that renames two files", () => {
  const l1 = patch(
    "diff --git a/b.ts b/b.ts",
    "index c8b13a5..f7ca596 100644",
    "--- a/b.ts",
    "+++ b/b.ts",
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
    "diff --git a/b.ts b/b2.ts",
    "similarity index 80%",
    "rename from b.ts",
    "rename to b2.ts",
    "index f7ca596..ab6feeb 100644",
    "--- a/b.ts",
    "+++ b/b2.ts",
    "@@ -4,5 +4,5 @@ line 3 by L1",
    " line 4",
    " line 5",
    " line 6",
    "-line 7",
    "+line 7 by L2",
    " line 8",
    "diff --git a/c.ts b/c2.ts",
    "similarity index 79%",
    "rename from c.ts",
    "rename to c2.ts",
    "index c8b13a5..ff8c03a 100644",
    "--- a/c.ts",
    "+++ b/c2.ts",
    "@@ -5,4 +5,4 @@ line 4",
    " line 5",
    " line 6",
    " line 7",
    "-line 8",
    "+line 8 by L2",
  );
  const review = patch(
    "diff --git a/c.ts b/b2.ts",
    "similarity index 61%",
    "rename from c.ts",
    "rename to b2.ts",
    "index c8b13a5..ab6feeb 100644",
    "--- a/c.ts",
    "+++ b/b2.ts",
    "@@ -1,8 +1,8 @@",
    " line 1",
    " line 2",
    "-line 3",
    "+line 3 by L1",
    " line 4",
    " line 5",
    " line 6",
    "-line 7",
    "+line 7 by L2",
    " line 8",
    "diff --git a/b.ts b/c2.ts",
    "similarity index 79%",
    "rename from b.ts",
    "rename to c2.ts",
    "index c8b13a5..ff8c03a 100644",
    "--- a/b.ts",
    "+++ b/c2.ts",
    "@@ -5,4 +5,4 @@ line 4",
    " line 5",
    " line 6",
    " line 7",
    "-line 8",
    "+line 8 by L2",
  );

  it("follows each layer's own pairing, as that layer's diff shows the lines", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: l1 },
        { id: "L2", patch: l2 },
      ],
      { reviewPatch: review },
    );
    expect(map.status).toBe("ok");
    expect(at(map, "b2.ts", 3)).toEqual({ kind: "layer", id: "L1" });
    expect(at(map, "b2.ts", 7)).toEqual({ kind: "layer", id: "L2" });
    expect(at(map, "c2.ts", 8)).toEqual({ kind: "layer", id: "L2" });
  });
});

describe("rewrites and moves", () => {
  const reindentL1 = patch(
    "diff --git a/a.ts b/a.ts",
    "index df6f8b2..a085d4d 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,7 +1,7 @@",
    " function f() {",
    "   stmt1();",
    "   stmt2();",
    "-  stmt3();",
    "+  stmt3(L1);",
    "   stmt4();",
    "   stmt5();",
    "   stmt6();",
  );
  const reindentL2 = patch(
    "diff --git a/a.ts b/a.ts",
    "index a085d4d..059acf6 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,8 +1,8 @@",
    " function f() {",
    "-  stmt1();",
    "-  stmt2();",
    "-  stmt3(L1);",
    "-  stmt4();",
    "-  stmt5();",
    "-  stmt6();",
    "+    stmt1();",
    "+    stmt2();",
    "+    stmt3(L1);",
    "+    stmt4();",
    "+    stmt5();",
    "+    stmt6();",
    " }",
  );
  const reindentReview = patch(
    "diff --git a/a.ts b/a.ts",
    "index df6f8b2..059acf6 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,8 +1,8 @@",
    " function f() {",
    "-  stmt1();",
    "-  stmt2();",
    "-  stmt3();",
    "-  stmt4();",
    "-  stmt5();",
    "-  stmt6();",
    "+    stmt1();",
    "+    stmt2();",
    "+    stmt3(L1);",
    "+    stmt4();",
    "+    stmt5();",
    "+    stmt6();",
    " }",
  );

  it("gives a re-indented block to the layer that re-indented it, not to the layer of one line in it", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: reindentL1 },
        { id: "L2", patch: reindentL2 },
      ],
      { reviewPatch: reindentReview },
    );
    expect(at(map, "a.ts", 2, 7)).toEqual({ kind: "layer", id: "L2" });
  });

  it("gives a file converted to CRLF to the layer that converted it", () => {
    const map = mapStackLines(
      [
        {
          id: "L1",
          patch: patch(
            "diff --git a/w.txt b/w.txt",
            "index f384549..b3091fc 100644",
            "--- a/w.txt",
            "+++ b/w.txt",
            "@@ -1,4 +1,4 @@",
            " one",
            "-two",
            "+two by L1",
            " three",
            " four",
          ),
        },
        {
          id: "L2",
          patch: patch(
            "diff --git a/w.txt b/w.txt",
            "index b3091fc..aa3cc27 100644",
            "--- a/w.txt",
            "+++ b/w.txt",
            "@@ -1,4 +1,4 @@",
            "-one",
            "-two by L1",
            "-three",
            "-four",
            "+one\r",
            "+two by L1\r",
            "+three\r",
            "+four\r",
          ),
        },
      ],
      {
        reviewPatch: patch(
          "diff --git a/w.txt b/w.txt",
          "index f384549..aa3cc27 100644",
          "--- a/w.txt",
          "+++ b/w.txt",
          "@@ -1,4 +1,4 @@",
          "-one",
          "-two",
          "-three",
          "-four",
          "+one\r",
          "+two by L1\r",
          "+three\r",
          "+four\r",
        ),
      },
    );
    expect(at(map, "w.txt", 1, 4)).toEqual({ kind: "layer", id: "L2" });
  });

  it("keeps a lower layer on lines a higher one replaced when they were all that layer's", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: reindentL1 },
        {
          id: "L2",
          patch: patch(
            "diff --git a/a.ts b/a.ts",
            "index a085d4d..1111111 100644",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -3,3 +3,3 @@ function f() {",
            "   stmt2();",
            "-  stmt3(L1);",
            "+  stmt3(L1, L2);",
            "   stmt4();",
          ),
        },
      ],
      {
        reviewPatch: patch(
          "diff --git a/a.ts b/a.ts",
          "index df6f8b2..1111111 100644",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -3,3 +3,3 @@ function f() {",
          "   stmt2();",
          "-  stmt3();",
          "+  stmt3(L1, L2);",
          "   stmt4();",
        ),
      },
    );
    expect(at(map, "a.ts", 4)).toEqual({ kind: "several", ids: ["L1", "L2"] });
  });

  it("gives a file moved without rename detection to the layer whose diff shows it added", () => {
    const map = mapStackLines(
      [
        {
          id: "L1",
          patch: patch(
            "diff --git a/a.ts b/a.ts",
            "index 50edde6..6abd749 100644",
            "--- a/a.ts",
            "+++ b/a.ts",
            "@@ -1,6 +1,6 @@",
            " base 1",
            " base 2",
            "-base 3",
            "+L1 three",
            " base 4",
            " base 5",
            " base 6",
          ),
        },
        {
          id: "L2",
          patch: patch(
            "diff --git a/a.ts b/a.ts",
            "deleted file mode 100644",
            "index 6abd749..0000000",
            "--- a/a.ts",
            "+++ /dev/null",
            "@@ -1,10 +0,0 @@",
            ...["base 1", "base 2", "L1 three", "base 4", "base 5", "base 6", "base 7", "base 8", "base 9", "base 10"].map((l) => `-${l}`),
            "diff --git a/x.ts b/x.ts",
            "new file mode 100644",
            "index 0000000..fe7eefb",
            "--- /dev/null",
            "+++ b/x.ts",
            "@@ -0,0 +1,10 @@",
            ...MOVED_X.map((l) => `+${l}`),
          ),
        },
      ],
      {
        reviewPatch: patch(
          "diff --git a/x.ts b/x.ts",
          "new file mode 100644",
          "index 0000000..fe7eefb",
          "--- /dev/null",
          "+++ b/x.ts",
          "@@ -0,0 +1,10 @@",
          ...MOVED_X.map((l) => `+${l}`),
        ),
      },
    );
    expect(map.status).toBe("ok");
    expect(at(map, "x.ts", 1, 10)).toEqual({ kind: "layer", id: "L2" });
  });

  it("follows no file whose diff changes its blob without showing the lines", () => {
    const hidden = reindentL1.split("@@")[0];
    const map = mapStackLines([{ id: "L1", patch: hidden }], { reviewPatch: reindentL1 });
    expect(map).toEqual({ status: "unavailable", reason: "unreadable", ids: ["L1"], runs: {} });
  });
});

const MOVED_X = ["base 1", "base 2", "L1 three", "base 4", "base 5", "base 6", "base 7", "L2 eight", "base 9", "base 10"];

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
  const badHeader = good.replace("@@ -1,5 +1,5 @@", "@@ -1,5 +1,5@@");
  const cases: [string, string, string][] = [
    ["a layer cut off mid-hunk", truncated, good],
    ["a layer whose first hunk header cannot be read", badHeader, good],
    ["a layer that is not a diff", "<html>rate limited</html>", good],
    ["a layer with a file header whose paths cannot be read", `${good}diff --git ???\n`, good],
    ["a review cut off mid-hunk", good, truncated],
    ["a review that is not a diff", good, "not a diff"],
  ];

  for (const [name, layer, reviewPatch] of cases) {
    it(`gives nothing for ${name}, without throwing`, () => {
      const map = mapStackLines([{ id: "L1", patch: layer }], { reviewPatch });
      expect(map).toEqual({ status: "unavailable", reason: "unreadable", ids: ["L1"], runs: {} });
    });
  }

  it("tells an empty stack, with nothing to label, from an unreadable one", () => {
    expect(mapStackLines([{ id: "L1", patch: "" }], { reviewPatch: "" }).status).toBe("ok");
  });

  it("treats an empty layer as one that changed nothing", () => {
    const map = mapStackLines(
      [
        { id: "L1", patch: good },
        { id: "L2", patch: "" },
      ],
      { reviewPatch: good },
    );
    expect(at(map, "a.ts", 2)).toEqual({ kind: "layer", id: "L1" });
  });

  it("gives unknown for runs naming a layer the map has no id for", () => {
    const map: StackLineMap = { status: "ok", ids: ["L1"], runs: { "a.ts": [[1, 3, [4]]] } };
    expect(at(map, "a.ts", 2)).toEqual({ kind: "unknown" });
  });

  it("does not read object built-ins as paths", () => {
    const map = mapStackLines([{ id: "L1", patch: good }], { reviewPatch: good });
    expect(at(map, "constructor", 1)).toEqual({ kind: "unknown" });
    expect(at(map, "__proto__", 1)).toEqual({ kind: "unknown" });
  });
});
