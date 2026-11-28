/**
 * Tagged you is a Spaces server's section: this computer's Inbox has one person, so its list builder never places a
 * row there and never sends the section, not even empty. Every placement this Inbox can make (`inboxSectionOf` over
 * the facts a row is placed by) and the list it answers (`inboxListSections`) are checked here; the window's side
 * (a list without it draws as before) is packages/inbox/listLocalUnchanged.test.tsx.
 */
import { expect, test } from "bun:test";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { inboxListSections, inboxSectionOf, type InboxSectionFacts } from "./list";

/** Every combination of the facts that move a row between sections. */
function* everyFacts(): Generator<InboxSectionFacts> {
  const at = "2026-11-25T10:00:00.000Z";
  for (const resolved of [null, at])
    for (const back of [false, true])
      for (const read of [null, at])
        for (const reask of [false, true])
          for (const open of [0, 1])
            for (const staged of [0, 1])
              for (const stopped of [false, true])
                for (const holds of [[], ["the release"]])
                  for (const answered of [false, true])
                    for (const sent of [null, { at, checked_at: null }, { at, checked_at: at }])
                      for (const unseen of [0, 2])
                        for (const unsent of [null, { reply_at: at, picks: 0, comments: 0 }])
                          yield {
                            resolved_at: resolved,
                            back_from_archive: back,
                            read_at: read,
                            reask_pending: reask,
                            questions: { open, picked: 0, staged, stopped, holds_up: holds, prompt: null, actions: 0 },
                            answered_not_sent: answered,
                            sent,
                            unseen,
                            unsent,
                          } as InboxSectionFacts;
}

test("no fact this Inbox knows places a row in Tagged you", () => {
  const placed = new Set<string>();
  for (const facts of everyFacts()) placed.add(inboxSectionOf(facts));
  expect(placed.has("tagged")).toBe(false);
  // The placements reach every other section, so the walk is not vacuous.
  expect([...placed].sort()).toEqual(["holding", "new", "quiet", "sent", "stopped", "waiting"]);
});

test("the list this Inbox answers never carries a Tagged you section, empty or not", () => {
  const row = (id: string, section: InboxListRow["section"]) => ({ thread_id: id, section, last_at: "2026-11-25T10:00:00.000Z" }) as InboxListRow;
  expect(inboxListSections([]).map((section) => section.id)).toEqual(["stopped", "holding", "waiting", "new", "sent", "quiet"]);
  const ids = inboxListSections([row("a", "waiting"), row("b", "new"), row("c", "quiet")]).map((section) => section.id);
  expect(ids).not.toContain("tagged");
});
