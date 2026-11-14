/**
 * Tags across linked machines (approval "inbox-thread-tags"): the merged list's one tag per name, and the merged id
 * each machine's own tag id reads as (`inboxMachineTags`).
 */
import { describe, expect, test } from "bun:test";
import { inboxMachineTags, type InboxInitiative } from "./inbox-initiatives";

const SELF = "ibx_self";
const MAC = "ibx_mac";
const MINI = "ibx_mini";
const tag = (id: string, name: string, at = "2026-11-12T09:00:00.000Z", deleted: string | null = null): InboxInitiative => ({
  id,
  name,
  created_at: at,
  created_by: { kind: "person" },
  updated_at: at,
  deleted_at: deleted,
});

describe("inboxMachineTags", () => {
  test("two machines each holding a tag of the same name give one tag, this Inbox's id, with each machine's id", () => {
    const { tags, idOn } = inboxMachineTags(SELF, [tag("ini_s_rel", "Release")], [{ machine: MAC, tags: [tag("ini_m_rel", "release ")] }]);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ id: "ini_s_rel", name: "Release", machines: { [SELF]: "ini_s_rel", [MAC]: "ini_m_rel" } });
    expect(idOn(MAC, "ini_m_rel")).toBe("ini_s_rel");
    expect(idOn(SELF, "ini_s_rel")).toBe("ini_s_rel");
  });

  test("a tag only another machine holds is listed by its id there; names differ by more than case and space stay apart", () => {
    const { tags, idOn } = inboxMachineTags(
      SELF,
      [tag("ini_s_rel", "Release", "2026-11-12T10:00:00.000Z")],
      [
        { machine: MAC, tags: [tag("ini_m_bill", "Billing", "2026-11-12T08:00:00.000Z"), tag("ini_m_rel2", "Release 2")] },
        { machine: MINI, tags: [tag("ini_n_bill", "BILLING")] },
      ],
    );
    // Oldest first, across machines.
    expect(tags.map((t) => [t.id, t.name])).toEqual([
      ["ini_m_bill", "Billing"],
      ["ini_m_rel2", "Release 2"],
      ["ini_s_rel", "Release"],
    ]);
    expect(tags[0]!.machines).toEqual({ [MAC]: "ini_m_bill", [MINI]: "ini_n_bill" });
    expect(idOn(MINI, "ini_n_bill")).toBe("ini_m_bill");
    expect(idOn(MAC, "ini_s_rel")).toBeNull();
  });

  test("a deleted tag joins nothing, and this Inbox's list never comes from another machine's copy of it", () => {
    const { tags, idOn } = inboxMachineTags(SELF, [tag("ini_s_rel", "Release")], [
      { machine: MAC, tags: [tag("ini_m_rel", "Release", undefined, "2026-11-12T11:00:00.000Z")] },
      { machine: SELF, tags: [tag("ini_s_other", "Other")] },
    ]);
    expect(tags.map((t) => t.id)).toEqual(["ini_s_rel"]);
    expect(tags[0]!.machines).toEqual({ [SELF]: "ini_s_rel" });
    expect(idOn(MAC, "ini_m_rel")).toBeNull();
  });
});
