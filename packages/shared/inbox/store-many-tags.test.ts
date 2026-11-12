/**
 * One reply tags any number of sessions (through 0.28.61, at most 8, refused
 * with a validation error), and a tag keeps a long agent name whole, as the
 * Inbox now stores names (a name over 80 characters was refused).
 */
import { expect, test } from "bun:test";
import { normalizeInboxTags } from "./store";

test("twelve tags arrive whole, in the order typed, with a long name kept", () => {
  const long = `Claude Code (worktree agent-a0316994da8440ab5) ${"x".repeat(120)}`;
  const tags = Array.from({ length: 12 }, (_, i) => ({ host: "claude-code", session: `ses_${i}`, wakes: true, ...(i === 0 ? { name: long } : {}) }));
  const out = normalizeInboxTags(tags, "ses_owner");
  expect(out.map((t) => t.session)).toEqual(tags.map((t) => t.session));
  expect(out[0]!.name).toBe(long);
});
