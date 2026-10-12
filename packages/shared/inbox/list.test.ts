/**
 * The archived set (owner ruling 2026-10-12): which rows count as archived and
 * their order in Settings' Archived block. If an archived row were missed it
 * would vanish from the window entirely (out of the list, not in Settings);
 * if the order were unstable, "Show more" could skip or repeat rows.
 */
import { describe, expect, test } from "bun:test";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { inboxArchivedRows, inboxRowArchived, inboxSectionOf } from "./list";

const row = (thread_id: string, resolved_at: string | null, agent_after_archive?: boolean): InboxListRow =>
  ({ thread_id, resolved_at, ...(agent_after_archive === undefined ? {} : { agent_after_archive }) }) as InboxListRow;
const facts = (over: Record<string, unknown>) =>
  ({ resolved_at: null, questions: { open: 0, stopped: false, holds_up: [] }, answered_not_sent: false, sent: null, unseen: 0, ...over }) as unknown as Parameters<typeof inboxSectionOf>[0];

describe("the archived set", () => {
  test("archived means resolved; it still places in Quiet for callers that keep it in the list", () => {
    expect(inboxRowArchived(row("a", "2026-10-12T10:00:00Z"))).toBe(true);
    expect(inboxRowArchived(row("b", null))).toBe(false);
    expect(inboxSectionOf(facts({ resolved_at: "2026-10-12T10:00:00Z", questions: { open: 1, stopped: true, holds_up: [] }, unseen: 2 }))).toBe("quiet");
  });

  // The failure this guards: an agent's reply_to reply into an archived thread
  // stayed hidden in Settings, where the person never looks for news.
  test("an agent message after the archive makes it news again: placed like an open thread, not archived", () => {
    const at = "2026-10-12T10:00:00Z";
    expect(inboxRowArchived(row("a", at, true))).toBe(false);
    expect(inboxRowArchived(row("b", at, false))).toBe(true);
    expect(inboxSectionOf(facts({ resolved_at: at, agent_after_archive: true, unseen: 1 }))).toBe("new");
    expect(inboxSectionOf(facts({ resolved_at: at, agent_after_archive: true, questions: { open: 1, stopped: true, holds_up: [] }, unseen: 1 }))).toBe("stopped");
    expect(inboxSectionOf(facts({ resolved_at: at, agent_after_archive: true, questions: { open: 1, stopped: false, holds_up: [] }, unseen: 1 }))).toBe("waiting");
    // Once the person looked, it rests in Quiet in the list (still not archived).
    expect(inboxSectionOf(facts({ resolved_at: at, agent_after_archive: true }))).toBe("quiet");
    expect(inboxArchivedRows([row("a", at, true), row("b", at, false)]).map((r) => r.thread_id)).toEqual(["b"]);
  });

  test("only archived rows, newest archived first, ties on the thread id", () => {
    const rows = [
      row("msg_c", "2026-10-12T09:00:00Z"),
      row("msg_open", null),
      row("msg_b", "2026-10-12T11:00:00Z"),
      row("msg_a", "2026-10-12T11:00:00Z"),
    ];
    expect(inboxArchivedRows(rows).map((r) => r.thread_id)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });
});
