/**
 * The Inbox's `/create-routine` built-in (packages/core/create-routine-skill.ts) in the composers' "/" list. What can
 * regress: it listed while Routines are off (an agent then learns to make one the person cannot turn on), listed as a
 * skill the agent loads itself rather than pasted text, or listed over a skill of the person's own with the same name.
 *
 * Pure: `inboxSkillCatalog` with injected discovery, never the skill folders on this computer. Every call has a
 * switch on, so the catalog reads only `discovered` (with every switch off it scans the folders itself).
 */
import { expect, test } from "bun:test";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { inboxSkillCatalog } from "./inbox-skills";

type Row = { name: string; root: string; humanOnly?: boolean; description?: string };
const rows = async (response: Response) => ((await response.json()) as { skills: Row[] }).skills;
const none = () => [];

test("the / list offers /create-routine only while Routines are on, as a built-in the window pastes", async () => {
  expect((await rows(inboxSkillCatalog(true, none, true, false))).map((s) => s.name)).not.toContain(CREATE_ROUTINE_SKILL.name);
  const on = await rows(inboxSkillCatalog(false, none, false, true));
  expect(on.filter((s) => s.name !== "picture-it")).toEqual([{ name: "create-routine", root: INBOX_BUILTIN_SKILL_ROOT, description: CREATE_ROUTINE_SKILL.description, humanOnly: true }]);
  // Beside the other built-ins, after them: the review skills, then /shape, then /create-routine.
  const all = (await rows(inboxSkillCatalog(true, none, true, true))).map((s) => s.name);
  expect(all.slice(-2)).toEqual(["shape", "create-routine"]);
});

test("a skill of the person's own named create-routine wins over the built-in", async () => {
  const mine = await rows(inboxSkillCatalog(false, () => [{ name: "create-routine", root: "/x", description: "mine" }] as never, false, true));
  expect(mine.filter((s) => s.name === "create-routine")).toHaveLength(1);
  expect(mine.find((s) => s.name === "create-routine")).toMatchObject({ root: "/x", description: "mine" });
});
