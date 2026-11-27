/**
 * Data an older Inbox left behind when Shape and Show me were still there. Show me is gone, but:
 *  - an Ask conversation holding a Show me turn (`kind`, `show_me` with a board's part, `again_shape`) reads back as
 *    it was stored, and a new question keeps that turn whole;
 *  - a question that still carries `kind`, `show_me` or `again_shape` is refused before anything is written;
 *  - the old boards' folder (`shapes/shp_…`) is left byte for byte by the store and the Ask paths.
 * What regresses: an old conversation that no longer opens, or loses its turns; an older window's Show me reaching an
 * agent; a start or a list that rewrites or prunes the old boards.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addInboxAskTurn, checkInboxAskInput, inboxAskFiles, pruneInboxAsks, readInboxAsk } from "./ask";
import { InboxError, inboxDir } from "./schema";
import { InboxStore } from "./store";

const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-ask-old-show-me-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const THREAD = "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0T";
const BOARD = "shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0B";

/** A conversation as an older Inbox wrote it: a plain Ask, then a Show me from a board's part, then a Show me again. */
const OLD = {
  v: 1,
  thread_id: THREAD,
  seen_at: null,
  turns: [
    { id: "turn-0001", at: "2026-11-10T10:00:00.000Z", session: "ses_a", question: "Why three retries?", answer: "Because…", answered_at: "2026-11-10T10:00:05.000Z" },
    {
      id: "turn-0002",
      at: "2026-11-10T10:01:00.000Z",
      session: "ses_a",
      question: "Show me after the third failure",
      kind: "show_me",
      show_me: { review: "msg_01J8ZK3TQ4VW7Y9A2B5C6D8E0F", file: "src/jobs/retry-worker.ts", lines: [16, 18], round: 1, words: "after the third failure", part: { board: BOARD, mark: "fails", name: "Fails", code: "src/jobs/retry-worker.ts#L16" } },
      answer: "Drew it.",
      answered_at: "2026-11-10T10:01:30.000Z",
    },
    { id: "turn-0003", at: "2026-11-10T10:02:00.000Z", session: "ses_a", question: "Show me again", kind: "show_me", show_me: { review: null, file: null, lines: null, round: null, words: "" }, again_shape: BOARD },
  ],
};

function oldWorld(name: string) {
  const dataDir = join(root, name);
  const inbox = inboxDir(dataDir);
  mkdirSync(join(inbox, "ask"), { recursive: true });
  writeFileSync(join(inbox, "ask", `${THREAD}.json`), `${JSON.stringify(OLD)}\n`);
  // An older Inbox's boards, beside the Inbox's own folder.
  const board = join(dataDir, "shapes", BOARD);
  mkdirSync(board, { recursive: true });
  const files: Record<string, string> = {
    "shape.json": JSON.stringify({ id: BOARD, title: "Kettle", claim: "Built." }),
    "versions.jsonl": `${JSON.stringify({ v: 1, at: "2026-11-10T10:01:20.000Z" })}\n`,
    "chat.jsonl": `${JSON.stringify({ at: "2026-11-10T10:01:25.000Z", text: "hello" })}\n`,
  };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(board, file), text);
  const shapesBytes = () => Object.fromEntries(readdirSync(board).sort().map((file) => [file, readFileSync(join(board, file), "utf8")]));
  return { dataDir, inbox, files, shapesBytes };
}

describe("an older Inbox's Show me turns", () => {
  test("read back exactly as stored, and a new question keeps them whole", () => {
    const w = oldWorld("read");
    expect(readInboxAsk(w.inbox, THREAD)).toEqual(OLD as never);
    const added = addInboxAskTurn(w.inbox, THREAD, { id: "turn-0004", at: "2026-11-11T09:00:00.000Z", session: "ses_a", host: "claude-code", question: "And now?" });
    expect(added.added).toBe(true);
    const after = readInboxAsk(w.inbox, THREAD)!;
    expect(after.turns.slice(0, 3)).toEqual(OLD.turns as never);
    expect(after.turns[3]).toMatchObject({ id: "turn-0004", question: "And now?" });
    expect("kind" in after.turns[3]!).toBe(false);
  });

  test("a question still carrying kind, show_me or again_shape is refused by field", () => {
    for (const [field, value] of [["kind", "show_me"], ["show_me", OLD.turns[1]!.show_me], ["again_shape", BOARD]] as const) {
      let thrown: unknown;
      try {
        checkInboxAskInput({ turn_id: "turn-0005", question: "Show me", [field]: value });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InboxError);
      expect([(thrown as InboxError).code, (thrown as InboxError).message]).toEqual(["validation_error", `${field}: not a field of a question.`]);
    }
    expect(checkInboxAskInput({ turn_id: "turn-0005", question: "Why?" })).toEqual({ id: "turn-0005", question: "Why?" });
  });
});

describe("an older Inbox's boards folder", () => {
  test("opening the store, listing and pruning the Ask conversations leave shapes/shp_… byte for byte", () => {
    const w = oldWorld("shapes");
    const before = w.shapesBytes();
    expect(before).toEqual(w.files);
    InboxStore.open(w.dataDir);
    expect(inboxAskFiles(w.inbox).map((file) => file.threadId)).toEqual([THREAD]);
    readInboxAsk(w.inbox, THREAD);
    pruneInboxAsks(w.inbox, () => true);
    InboxStore.open(w.dataDir);
    expect(w.shapesBytes()).toEqual(before);
    expect(readdirSync(join(w.dataDir, "shapes"))).toEqual([BOARD]);
  });
});
