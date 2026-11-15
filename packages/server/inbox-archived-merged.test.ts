/**
 * The Archived group's read across linked machines (inbox-archived-merged.ts; approval "inbox-archived-group"): this
 * Inbox's archived threads and each linked machine's, as one page. What this catches: rows out of archived order
 * across machines, a page that skips or repeats a row (each machine is asked for its first offset + limit), a far
 * row without its machine (Unarchive would go to this store), a thread this store holds shown twice, an asleep
 * machine's last-known rows dropped or not marked away, a far answer's junk rows taken, and a project that lives here
 * asking every linked machine.
 */
import { describe, expect, test } from "bun:test";
import type { InboxListRow } from "@plannotator/core/inbox-types";
import { archivedAskOf, farArchivedPage, farRowTags, mergeArchived, type ArchivedPage } from "./inbox-archived-merged";

const M = "ibx_01K0000000000000000000000M";
const at = (minute: number) => `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
const row = (id: string, minute: number) => ({ thread_id: id, resolved_at: at(minute), last_at: at(0), project: { id: "prj_a", name: "a" } }) as unknown as InboxListRow;

function own(threads: InboxListRow[], offset = 0, limit = 3): ArchivedPage {
  return { serverSession: "s", cursor: 1, project: null, projects: [{ id: "prj_a", name: "a", archived: threads.length }], total: threads.length, offset, limit, threads };
}

describe("the merged Archived page", () => {
  test("a far row's tags read as the merged list's, and none from a machine that takes no tags from here", () => {
    const idOn = (machine: string, id: string) => (machine === M && id === "ini_far" ? "ini_merged" : null);
    const far = { ...row("far_1", 1), machine: M, tags: ["ini_far", "ini_gone"] };
    expect(farRowTags(far, new Set([M]), idOn).tags).toEqual(["ini_merged"]);
    expect(farRowTags(far, new Set(), idOn).tags).toBeUndefined();
  });

  test("a project that lives here asks no linked machine; one on a machine asks only it; no project asks every one", () => {
    const ownerOf = (project: string) => (project === "prj_far" ? M : null);
    expect(archivedAskOf("prj_a", true, ownerOf)).toBeNull();
    expect(archivedAskOf("prj_far", false, ownerOf)).toEqual({ owner: M });
    expect(archivedAskOf("prj_gone", false, ownerOf)).toBeNull();
    expect(archivedAskOf(null, false, ownerOf)).toEqual({ owner: null });
  });

  test("newest archived first across machines, each far row with its machine, cut to the asked slice", () => {
    const far = farArchivedPage(M, { total: 3, threads: [row("far_9", 9), row("far_5", 5), row("far_1", 1)], projects: [] });
    const merged = mergeArchived(own([row("own_8", 8), row("own_4", 4), row("own_2", 2)]), [{ machine: M, page: far, away: false }], () => false);
    expect(merged.threads.map((r) => r.thread_id)).toEqual(["far_9", "own_8", "far_5"]);
    expect(merged.threads.map((r) => r.machine ?? null)).toEqual([M, null, M]);
    expect(merged.total).toBe(6);
    expect(merged.machines).toEqual({ [M]: { away: false } });

    const next = mergeArchived(own([row("own_8", 8), row("own_4", 4), row("own_2", 2)], 3, 3), [{ machine: M, page: far, away: false }], () => false);
    expect(next.threads.map((r) => r.thread_id)).toEqual(["own_4", "own_2", "far_1"]);
  });

  test("an asleep machine's last-known rows stay, marked away; one never read adds nothing", () => {
    const held = farArchivedPage(M, { total: 1, threads: [row("far_9", 9)] });
    const merged = mergeArchived(own([row("own_8", 8)]), [{ machine: M, page: held, away: true }, { machine: "ibx_01K0000000000000000000000N", page: null, away: true }], () => false);
    expect(merged.threads.map((r) => r.thread_id)).toEqual(["far_9", "own_8"]);
    expect(merged.machines[M]).toEqual({ away: true });
    expect(merged.total).toBe(2);
  });

  test("a thread this store holds never comes from another machine, and a far row without a thread id or archived time is dropped", () => {
    const far = farArchivedPage(M, { threads: [row("own_8", 9), { thread_id: "live", resolved_at: null }, { nope: 1 }, row("far_3", 3)] });
    expect(far!.threads.map((r) => r.thread_id)).toEqual(["own_8", "far_3"]);
    const merged = mergeArchived(own([]), [{ machine: M, page: far, away: false }], (id) => id === "own_8");
    expect(merged.threads.map((r) => r.thread_id)).toEqual(["far_3"]);
    expect(farArchivedPage(M, "not a page")).toBeNull();
  });
});
