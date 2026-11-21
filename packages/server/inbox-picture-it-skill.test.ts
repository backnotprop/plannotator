import { expect, test } from "bun:test";
import { PICTURE_IT_SKILL } from "@plannotator/core/picture-it-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { inboxSkillCatalog } from "./inbox-skills";

type Row = { name: string; root: string; humanOnly?: boolean; description?: string };
const rows = async (response: Response) => ((await response.json()) as { skills: Row[] }).skills;
const none = () => [];

test("the / list offers /picture-it with every switch off, as a built-in the window pastes", async () => {
  expect(await rows(inboxSkillCatalog(false, none, false, false))).toEqual([
    { name: "picture-it", root: INBOX_BUILTIN_SKILL_ROOT, description: PICTURE_IT_SKILL.description, humanOnly: true },
  ]);
});

test("/picture-it is first among the built-ins, before the person's own skills", async () => {
  const names = (await rows(inboxSkillCatalog(true, () => [{ name: "readback", root: "claude", humanOnly: true }] as never, true, true))).map((s) => s.name);
  expect(names[0]).toBe("picture-it");
  expect(names.at(-1)).toBe("readback");
});

test("a skill of the person's own named picture-it wins over the built-in", async () => {
  const mine = await rows(inboxSkillCatalog(false, () => [{ name: "picture-it", root: "/x", description: "mine" }] as never, false, false));
  expect(mine).toEqual([{ name: "picture-it", root: "/x", description: "mine" } as Row]);
});

test("the page's file is named without a path only one system has, so Windows agents can save it too", () => {
  expect(PICTURE_IT_SKILL.body).not.toMatch(/\/tmp\b|[A-Z]:\\/);
  expect(PICTURE_IT_SKILL.body).toContain("temp folder");
});
