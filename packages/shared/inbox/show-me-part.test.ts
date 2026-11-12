import { describe, expect, test } from "bun:test";
import { checkInboxShowMeInput, showMeShapes, type InboxAskTurn } from "./ask";

const REVIEW = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";
const at = (minute: number) => `2026-11-05T10:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (id: string, minute: number, ended: number | null, show_me: Record<string, unknown>, again?: string) =>
  ({ id, at: at(minute), question: "q", kind: "show_me", show_me: { file: null, lines: null, round: 1, ...show_me }, ...(ended !== null ? { answer: "ok", answered_at: at(ended) } : {}), ...(again ? { again_shape: again } : {}) }) as unknown as InboxAskTurn;
const version = (n: number, minute: number, through: string | null) => ({ n, at: at(minute), through });

describe("showMeShapes for a Show me from a board", () => {
  const part = { board: "shp_a", name: "A part" };

  test("from a review: the new board through that review, not a new version of the board it was pressed on", () => {
    const boards = [
      { id: "shp_a", versions: [version(1, 0, REVIEW), version(2, 6, REVIEW)] },
      { id: "shp_b", versions: [version(1, 7, REVIEW)] },
    ];
    expect(showMeShapes([turn("t1", 5, 9, { review: REVIEW, part })], boards, null).get("t1")).toBe("shp_b");
  });

  test("with no review: the new board stored with no --through", () => {
    const boards = [
      { id: "shp_a", versions: [version(1, 0, null)] },
      { id: "shp_b", versions: [version(1, 7, null)] },
    ];
    expect(showMeShapes([turn("t1", 5, null, { review: null, part })], boards, "t1").get("t1")).toBe("shp_b");
  });

  test("with no review: a new board stored with --thread and a --through (as shape --help says) is still the one it made", () => {
    const boards = [
      { id: "shp_a", versions: [version(1, 0, null), version(2, 8, "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E1G")] },
      { id: "shp_b", versions: [version(1, 7, "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E1G"), version(2, 8, "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E1G")] },
    ];
    expect(showMeShapes([turn("t1", 5, null, { review: null, part })], boards, "t1").get("t1")).toBe("shp_b");
    expect(showMeShapes([turn("t1", 5, 9, { review: null, part })], boards, null).get("t1")).toBe("shp_b");
    expect(showMeShapes([turn("t1", 5, 9, { review: null, part })], [boards[0]!], null).has("t1")).toBe(false);
  });

  test("three levels: each turn has its own board, and the next Show me's board is never the one before's", () => {
    const boards = [
      { id: "shp_a", versions: [version(1, 0, null)] },
      { id: "shp_b", versions: [version(1, 6, null)] },
      { id: "shp_c", versions: [version(1, 11, null)] },
    ];
    const turns = [turn("t1", 5, 7, { review: null, part }), turn("t2", 10, 12, { review: null, part: { board: "shp_b", name: "B" } })];
    const made = showMeShapes(turns, boards, null);
    expect(made.get("t1")).toBe("shp_b");
    expect(made.get("t2")).toBe("shp_c");
  });

  test("while it runs, a new version of the board it was pressed on is not its board; ended, it is what the agent did", () => {
    const boards = [{ id: "shp_a", versions: [version(1, 0, null), version(2, 6, null)] }];
    expect(showMeShapes([turn("t1", 5, null, { review: null, part })], boards, "t1").get("t1")).toBeUndefined();
    expect(showMeShapes([turn("t1", 5, 8, { review: null, part })], boards, null).get("t1")).toBe("shp_a");
  });

  test("Show me again on a board from a board takes only that board", () => {
    const boards = [
      { id: "shp_b", versions: [version(1, 1, null), version(2, 6, null)] },
      { id: "shp_c", versions: [version(1, 7, null)] },
    ];
    expect(showMeShapes([turn("t1", 5, 9, { review: null, part: { board: "shp_a", name: "A" } }, "shp_b")], boards, null).get("t1")).toBe("shp_b");
  });

  test("a turn with no end, and not running, has made nothing", () => {
    const boards = [{ id: "shp_b", versions: [version(1, 7, null)] }];
    expect(showMeShapes([turn("t1", 5, null, { review: null, part })], boards, null).has("t1")).toBe(false);
  });
});

describe("what the route takes", () => {
  const input = (show_me: Record<string, unknown>) => ({ kind: "show_me", show_me });
  const board = "shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0F";

  test("a part with no review", () => {
    const part = { board, name: "A part", code: "a.ts#L1" };
    expect(checkInboxShowMeInput(input({ review: null, file: null, lines: null, part }))?.target).toMatchObject({ review: null, part });
  });

  test("a review is still required without a part", () => {
    expect(() => checkInboxShowMeInput(input({ review: null, file: null, lines: null }))).toThrow(/show_me\.review/);
  });

  test("a part must name its board and itself, and sits on no lines", () => {
    expect(() => checkInboxShowMeInput(input({ review: null, file: null, lines: null, part: { board: "nope", name: "A" } }))).toThrow(/show_me\.part/);
    expect(() => checkInboxShowMeInput(input({ review: null, file: null, lines: null, part: { board } }))).toThrow(/show_me\.part/);
    expect(() => checkInboxShowMeInput(input({ review: null, file: "a.ts", lines: [1, 1], part: { board, name: "A" } }))).toThrow(/show_me\.part/);
  });

  test("a name is counted as the window cuts it, in characters: 600 emoji pass, 601 do not", () => {
    const name = (n: number) => "🙂".repeat(n);
    expect(checkInboxShowMeInput(input({ review: null, file: null, lines: null, part: { board, name: name(600) } }))?.target.part?.name).toBe(name(600));
    expect(() => checkInboxShowMeInput(input({ review: null, file: null, lines: null, part: { board, name: name(601) } }))).toThrow(/show_me\.part/);
  });

  test("an unknown field's error lists part among the fields", () => {
    expect(() => checkInboxShowMeInput(input({ review: null, file: null, lines: null, part: { board, name: "A" }, extra: 1 }))).toThrow(/show_me\.extra: not a field \(review, file, lines, round, words, part\)/);
  });
});
