import { describe, expect, test } from "vitest";
import { clipboardCandidates } from "./clipboard";

describe("agent simulator clipboard candidates", () => {
  test("uses pbcopy on macOS", () => {
    expect(clipboardCandidates("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
  });

  test("uses cmd clip on Windows", () => {
    expect(clipboardCandidates("win32")).toEqual([{ command: "cmd", args: ["/c", "clip"] }]);
  });

  test("tries common Linux clipboard commands", () => {
    expect(clipboardCandidates("linux").map((candidate) => candidate.command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel",
    ]);
  });
});
