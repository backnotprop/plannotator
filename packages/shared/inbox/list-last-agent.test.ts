/**
 * A row with more than one agent in its thread says which agent wrote last (`last_agent`): the window's held line
 * names that agent ("Codex replied in “…”", packages/inbox/newsWords.ts). Without it the line would name the
 * thread's first agent for a reply another agent wrote. A row with one agent carries none (it is the row's own).
 * Proved on a real store in a temp dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const CODEX: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "codex", session: "ses_b", name: "Reviewer" };

test("the row names the agent that wrote last when several are in the thread, and none with one", () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-last-agent-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date("2026-11-18T10:00:00.000Z") });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const root = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "Started the refund work." }).message;
  const rowOf = () => store.listRows().find((r) => r.thread_id === root.id)!;
  expect(rowOf().last_agent).toBeUndefined();

  store.sendMessage({ project_id: project.id, author: CODEX, body: "Reviewed it.", reply_to: root.id });
  expect(rowOf().participants?.length).toBe(2);
  expect(rowOf().last_agent).toEqual({ host: "codex", name: "Reviewer" });

  store.sendMessage({ project_id: project.id, author: CLAUDE, body: "Fixed what you found.", reply_to: root.id });
  expect(rowOf().last_agent).toEqual({ host: "claude-code" });
});
