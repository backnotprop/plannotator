import { describe, expect, test } from "bun:test";
import { INBOX_NOTE_TEXT_MAX, inboxNoteBlocks, parseInboxNoteAnchor } from "./inbox-context-notes";

describe("inboxNoteBlocks: the thread agent's `:::note path#L…` blocks", () => {
  test("reads a block's file, lines, side, words and its place in the body", () => {
    const body = ["Here is what I found.", "", ":::note src/auth.ts#L42-L48", "Refresh happens **here**.", "Callers stop retrying.", ":::", "", "More after."].join("\n");
    expect(inboxNoteBlocks(body)).toEqual([
      { file: "src/auth.ts", side: "new", lineStart: 42, lineEnd: 48, text: "Refresh happens **here**.\nCallers stop retrying.", from: 2, to: 5 },
    ]);
  });

  test("one line, and ` old` for removed lines", () => {
    const body = ":::note a/b.ts#L7\nOne.\n:::\n:::note a/b.ts#L3-L4 old\nTwo.\n:::";
    const notes = inboxNoteBlocks(body);
    expect(notes.map((n) => [n.file, n.side, n.lineStart, n.lineEnd, n.text])).toEqual([
      ["a/b.ts", "new", 7, 7, "One."],
      ["a/b.ts", "old", 3, 4, "Two."],
    ]);
  });

  test("what is not a note stays text: no lines, no words, never closed, inside a code fence, a bare :::note", () => {
    expect(inboxNoteBlocks(":::note src/a.ts\nNo lines.\n:::")).toEqual([]);
    expect(inboxNoteBlocks(":::note src/a.ts#L2\n   \n:::")).toEqual([]);
    expect(inboxNoteBlocks(":::note src/a.ts#L2\nNever closed.")).toEqual([]);
    expect(inboxNoteBlocks("```md\n:::note src/a.ts#L2\nIn a fence.\n:::\n```")).toEqual([]);
    expect(inboxNoteBlocks(":::note\nA bare directive.\n:::")).toEqual([]);
    expect(inboxNoteBlocks(null)).toEqual([]);
  });

  test("a block after a fence still counts, and long words are cut", () => {
    const long = "x".repeat(INBOX_NOTE_TEXT_MAX + 50);
    const notes = inboxNoteBlocks(`\`\`\`\ncode\n\`\`\`\n:::note src/a.ts#L1-L2\n${long}\n:::`);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text.length).toBe(INBOX_NOTE_TEXT_MAX);
    expect(notes[0]!.text.endsWith("…")).toBe(true);
  });

  test("parseInboxNoteAnchor needs a file and #L lines", () => {
    expect(parseInboxNoteAnchor("src/a.ts#L5-L9 old")).toEqual({ file: "src/a.ts", side: "old", lineStart: 5, lineEnd: 9 });
    expect(parseInboxNoteAnchor("src/a.ts")).toBeNull();
    expect(parseInboxNoteAnchor("#L5")).toBeNull();
  });
});
