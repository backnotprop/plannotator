/**
 * The archived set (owner ruling 2026-10-12): which rows count as archived and
 * their order in Settings' Archived block. If an archived row were missed it
 * would vanish from the window entirely (out of the list, not in Settings);
 * if the order were unstable, "Show more" could skip or repeat rows.
 */
import { describe, expect, test } from "bun:test";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { inboxArchivedRows, inboxRowArchived, inboxSectionOf } from "./list";

const row = (thread_id: string, resolved_at: string | null): InboxListRow => ({ thread_id, resolved_at }) as InboxListRow;

describe("the archived set", () => {
  test("archived means resolved; it still places in Quiet for callers that keep it in the list", () => {
    expect(inboxRowArchived(row("a", "2026-10-12T10:00:00Z"))).toBe(true);
    expect(inboxRowArchived(row("b", null))).toBe(false);
    const facts = { resolved_at: "2026-10-12T10:00:00Z", questions: { open: 1, stopped: true, holds_up: [] }, answered_not_sent: false, sent: null, unseen: 2 };
    expect(inboxSectionOf(facts as unknown as Parameters<typeof inboxSectionOf>[0])).toBe("quiet");
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
