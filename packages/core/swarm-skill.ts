/**
 * The Inbox's built-in `/swarm` skill (docs/agent-guides/inbox-compose.md, "Swarm"; the owner, 2026-11-24: "Swarm is
 * the `/swarm` skill, the badge just adds it, and the same skill works for one agent or several"). The Swarm badge in
 * New message and in the reply box puts `/swarm` in the words; the window pastes this text into what is sent
 * (human-only, as `/picture-it`), and a person's message whose skills block names `swarm` makes its thread a swarm
 * (`inboxMessageStartsSwarm`, packages/shared/inbox/swarm-start.ts).
 *
 * AGENT-FACING WORDS, all of them in this file, awaiting the owner's approval. ONE text for every case (the owner:
 * "I don't think it's smart to discriminate … maybe the same instructions"): one agent or a team, the agents first
 * propose the swarm to the person, then work as one team.
 *
 * Browser-safe, no dependencies: the server lists it and the window pastes it.
 */

export interface SwarmSkillText {
  name: string;
  description: string;
  body: string;
}

/** Who the message goes to (every agent's name as the Inbox shows it). The text is the same for any of them. */
export interface SwarmSkillContext {
  agents: readonly string[];
}

/**
 * THE SWITCH for what this slice does not have yet: the shared task list and the ghost thread. Off, the text leaves
 * out "You share three things:", the Task list and Ghost thread lines, and a file change is said "in this thread"
 * instead of "there" (the ghost thread). Turned on by the slice that ships both.
 */
export const SWARM_TASKS_AND_GHOST_THREAD = false;

/** The text, with or without the task list and the ghost thread (`SWARM_TASKS_AND_GHOST_THREAD`). */
export function swarmSkillBody(tasksAndGhostThread: boolean = SWARM_TASKS_AND_GHOST_THREAD): string {
  const lines = [
    '# Swarm',
    '',
    'The person wants this done as a swarm: agents working as one team. First, propose the swarm to the person in this thread: who is in it, what each one will do, and any agents you would bring in (your own sub-agents, more agents through the tool you run in, or through the Inbox). If several of you got this, the first agent named writes the proposal and the others add to it.',
    '',
    tasksAndGhostThread ? 'Then work as one team. You share three things:' : 'Then work as one team.',
    '',
    'Status: say what you are doing with your Inbox swarm action when you start and when it changes; call it without "doing" to see what every other agent is doing.',
    ...(tasksAndGhostThread
      ? [
          'Task list: one list for the whole swarm; add tasks to it, and take a task before you start it.',
          'Ghost thread: talk to the other agents there; the person can read it but is not notified.',
        ]
      : []),
    '',
    `Before you change a file another agent is in, say so ${tasksAndGhostThread ? 'there' : 'in this thread'} and wait for its answer. Ask the person, in this thread, only what the other agents cannot answer.`,
  ];
  return `${lines.join('\n')}\n`;
}

export const SWARM_SKILL: SwarmSkillText = {
  name: 'swarm',
  description: 'Agents work together on this, as one team',
  body: swarmSkillBody(),
};

/**
 * The text a message carries: the one place it is produced, the same for one agent or several (`context` is who the
 * message goes to, kept so the text can use it once the owner says how). Undefined for any other skill name.
 */
export function swarmSkill(name: string, context: SwarmSkillContext = { agents: [] }): SwarmSkillText | undefined {
  void context;
  return name === SWARM_SKILL.name ? SWARM_SKILL : undefined;
}
