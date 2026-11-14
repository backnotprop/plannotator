/**
 * One reply tags any number of sessions (through 0.28.61, at most 8, refused
 * with a validation error), and a tag keeps a long agent name whole, as the
 * Inbox now stores names (a name over 80 characters was refused). A tag names
 * a T3 Code thread by T3's own id only under host `t3`.
 */
import { expect, test } from "bun:test";
import { T3_THREAD_ID_FORMS } from "../../../tests/helpers/fake-t3";
import { normalizeInboxTags } from "./store";

test("twelve tags arrive whole, in the order typed, with a long name kept", () => {
  const long = `Claude Code (worktree agent-a0316994da8440ab5) ${"x".repeat(120)}`;
  const tags = Array.from({ length: 12 }, (_, i) => ({ host: "claude-code", session: `ses_${i}`, wakes: true, ...(i === 0 ? { name: long } : {}) }));
  const out = normalizeInboxTags(tags, "ses_owner");
  expect(out.map((t) => t.session)).toEqual(tags.map((t) => t.session));
  expect(out[0]!.name).toBe(long);
});

test("a T3 thread's own id is a tag's session under t3 only; under another host the old rule holds", () => {
  for (const session of Object.values(T3_THREAD_ID_FORMS)) {
    expect(normalizeInboxTags([{ host: "t3", session, wakes: true }], null)).toEqual([{ host: "t3", session, wakes: true }]);
  }
  // `%` and `()` (a delegated task), or over 200 characters (a provider thread): not a session id of any other host.
  for (const host of ["cursor", "codex", "claude-code", null]) {
    for (const session of [T3_THREAD_ID_FORMS.delegated, T3_THREAD_ID_FORMS.provider]) {
      expect(() => normalizeInboxTags([{ host, session, wakes: true }], null)).toThrow("tags: each session an id.");
    }
  }
  for (const session of ["", " ", "a/../b", "thread/../x", "t\nx", `:${T3_THREAD_ID_FORMS.app}`, `a${"b".repeat(4096)}`, 42, null]) {
    expect(() => normalizeInboxTags([{ host: "t3", session, wakes: true }], null)).toThrow("tags: each session an id.");
  }
});
