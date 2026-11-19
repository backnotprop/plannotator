import { expect, test } from "bun:test";
import { SHOW_ME_SKILL } from "@plannotator/core/show-me-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { inboxSkillCatalog } from "./inbox-skills";

type Row = { name: string; root: string; humanOnly?: boolean; description?: string };
const rows = async (response: Response) => ((await response.json()) as { skills: Row[] }).skills;
const none = () => [];

test("the / list offers /show-me with every switch off, as a built-in the window pastes", async () => {
  expect(await rows(inboxSkillCatalog(false, none, false, false))).toEqual([
    { name: "show-me", root: INBOX_BUILTIN_SKILL_ROOT, description: SHOW_ME_SKILL.description, humanOnly: true },
  ]);
});

test("/show-me is first among the built-ins, before the person's own skills", async () => {
  const names = (await rows(inboxSkillCatalog(true, () => [{ name: "readback", root: "claude", humanOnly: true }] as never, true, true))).map((s) => s.name);
  expect(names[0]).toBe("show-me");
  expect(names.at(-1)).toBe("readback");
});

test("a skill of the person's own named show-me wins over the built-in", async () => {
  const mine = await rows(inboxSkillCatalog(false, () => [{ name: "show-me", root: "/x", description: "mine" }] as never, false, false));
  expect(mine).toEqual([{ name: "show-me", root: "/x", description: "mine" } as Row]);
});

test("the page's file is named without a path only one system has, so Windows agents can save it too", () => {
  expect(SHOW_ME_SKILL.body).not.toMatch(/\/tmp\b|[A-Z]:\\/);
  expect(SHOW_ME_SKILL.body).toContain("temp folder");
});
