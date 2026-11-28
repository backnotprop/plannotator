/**
 * The Inbox's built-in `/swarm` skill (docs/agent-guides/inbox-swarm.md): the one source of the text each agent of a
 * swarm receives. The Swarm badge in New message puts `/swarm` in the words; the window pastes this text into what is
 * sent (human-only, as `/picture-it`), and a person's message whose skills block names `swarm` makes its thread a swarm
 * (`inboxMessageStartsSwarm`, packages/shared/inbox/swarm-start.ts). The Inbox appends the real join line, with the
 * thread's id filled in, to what it hands each agent (`swarmJoinLine`).
 *
 * AGENT-FACING WORDS, APPROVED by the owner word for word on 2026-11-24 ("Yes, these words"; the record
 * `.product/approved/inbox-swarm-skill-text/approval.md`), and the `swarm propose` clause on 2026-11-25. Do not change a byte without a new approval
 * (swarm-skill.test.ts pins it). The text names the task subcommands (`swarm add`, `take`, `done`) that a later piece
 * builds; until then the command answers them with a short "not available yet" (apps/hook/server/inbox-swarm-command.ts).
 *
 * Browser-safe, no dependencies: the server lists it and the window pastes it.
 */

export interface SwarmSkillText {
  name: string;
  description: string;
  body: string;
}

/** The approved text, byte for byte. */
export const SWARM_SKILL_BODY =
  "Swarm. The person wants this done as a swarm: agents working as one team. First, propose the swarm to the person in this thread with `plannotator inbox swarm propose`: who is in it, what each one will do, and any agents you would bring in (your own sub-agents, or more agents through the tool you run in). If several of you got this, the first agent named writes the proposal and the others add to it. Then work as one team, through one command: `plannotator inbox swarm`. Run `plannotator inbox swarm --help` once; it is short and has everything. Join before anything else: `plannotator inbox swarm join`, with this thread's id. You share three things: Status: `swarm doing` with one line when you start and when it changes; `swarm status` shows what every other agent is doing. Task list: one list for the whole swarm; add tasks to it with `swarm add`, take a task with `swarm take` before you start it, and mark it with `swarm done`. Ghost thread: talk to the other agents there with `swarm say`; the person can read it but is not notified. Before you change a file another agent is in, say so there and wait for its answer. Give this command and this thread's id to every sub-agent and every other agent you bring in, and have each one join first, so the whole team is in the swarm. Ask the person, in this thread, only what the other agents cannot answer.";

export const SWARM_SKILL: SwarmSkillText = {
  name: "swarm",
  description: "Agents work together on this, as one team",
  body: SWARM_SKILL_BODY,
};

/** The skill for `name`, or undefined for any other skill. */
export function swarmSkill(name: string): SwarmSkillText | undefined {
  return name === SWARM_SKILL.name ? SWARM_SKILL : undefined;
}

/** The line the Inbox appends to what it hands each agent of a new swarm: the join command with the thread's id. */
export function swarmJoinLine(threadId: string): string {
  return `Join now: \`plannotator inbox swarm join ${threadId}\``;
}
