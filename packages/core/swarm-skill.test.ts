/**
 * The `/swarm` skill's text is the owner's approved text, byte for byte (approved 2026-11-24, "Yes, these words"; the
 * `swarm propose` clause approved 2026-11-25):
 * an edit to it, even a space, needs a new approval. Pinned at the owner's request.
 */
import { expect, test } from "bun:test";
import { SWARM_SKILL, swarmJoinLine, swarmSkill } from "./swarm-skill";

const APPROVED =
  "Swarm. The person wants this done as a swarm: agents working as one team. First, propose the swarm to the person in this thread with `plannotator inbox swarm propose`: who is in it, what each one will do, and any agents you would bring in (your own sub-agents, or more agents through the tool you run in). If several of you got this, the first agent named writes the proposal and the others add to it. Then work as one team, through one command: `plannotator inbox swarm`. Run `plannotator inbox swarm --help` once; it is short and has everything. Join before anything else: `plannotator inbox swarm join`, with this thread's id. You share three things: Status: `swarm doing` with one line when you start and when it changes; `swarm status` shows what every other agent is doing. Task list: one list for the whole swarm; add tasks to it with `swarm add`, take a task with `swarm take` before you start it, and mark it with `swarm done`. Ghost thread: talk to the other agents there with `swarm say`; the person can read it but is not notified. Before you change a file another agent is in, say so there and wait for its answer. Give this command and this thread's id to every sub-agent and every other agent you bring in, and have each one join first, so the whole team is in the swarm. Ask the person, in this thread, only what the other agents cannot answer.";

test("the /swarm skill is the approved text, byte for byte", () => {
  expect(SWARM_SKILL.body).toBe(APPROVED);
  expect(swarmSkill("swarm")?.body).toBe(APPROVED);
  expect(swarmSkill("picture-it")).toBeUndefined();
});

test("the join line the Inbox appends names the thread, ready to run", () => {
  expect(swarmJoinLine("msg_01ABC")).toBe("Join now: `plannotator inbox swarm join msg_01ABC`");
});
