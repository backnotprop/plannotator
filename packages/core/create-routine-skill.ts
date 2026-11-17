/**
 * The Inbox's `/create-routine` skill (docs/agent-guides/inbox-routines.md): the person picks it in a message or
 * reply box, and the window pastes this body into what they send (human-only, as `/shape` and the review skills go),
 * so the agent reading their message learns to make the routine with `plannotator routine`
 * (apps/hook/server/routine-command.ts). The Inbox lists it only while the person has Routines on
 * (`inboxSkillCatalog`, packages/server/inbox-skills.ts); off, no agent reads a word of it.
 *
 * The person's Send of it is also their approval: it mints a one-time grant on the thread
 * (packages/server/inbox-routine-grants.ts), so the routine the agent makes with `--thread` naming that thread is on.
 *
 * The list line is the owner's, word for word. Browser-safe, no dependencies: the server lists it and the
 * window pastes it.
 */

export interface CreateRoutineSkillText {
  name: string;
  description: string;
  body: string;
}

const BODY = `# Make a routine

The person wants work to run on its own, on a schedule, and report back in the Plannotator Inbox. What they want is in their message above. Because they asked for it here, the routine you make is on from the start.

1. If they gave no time ("check it regularly"), ask them when, in this thread. Never make up a schedule.
2. Run \`plannotator routine create --help\` once.
3. Make it with \`--thread\` set to this thread's id (\`msg_1a2b\` below stands for it):

\`\`\`bash
plannotator routine create --name "Dependency check" --cron '0 9 * * 1-5' --thread msg_1a2b \\
  --prompt 'Check this repo for outdated dependencies. Reply with each outdated package, its current and latest version, and which updates look safe.'
\`\`\`

   Write the prompt for a fresh agent that knows nothing of this thread. For a long prompt, use \`--prompt -\` and a quoted heredoc. Runs work in your project unless you pass \`--folder <path>\`. \`--at <YYYY-MM-DDTHH:MM>\` in place of \`--cron\` runs it once.

   If it answers \`validation_error: agent: …\`, ask the person which agent runs it (claude-code, codex, opencode or pi) and pass their answer with \`--agent\`. Never pick one yourself.
4. Reply in this thread: the routine's name, that it is on, and when its next run is, as the command's result says. Ask whether they want any edits, and tell them they can see it under Routines in the Inbox.

If the result says it is off, tell them so, and that they turn it on under Routines in the Inbox. If a command answers \`routines_off\`, tell them Routines are off (Settings → Capabilities) and stop.

Do not start a run unless they ask for one now, and do not pass \`--model\` or \`--effort\` unless they ask.
`;

export const CREATE_ROUTINE_SKILL: CreateRoutineSkillText = {
  name: 'create-routine',
  description: 'Describe the routine you want an agent to create in your Plannotator Inbox',
  body: BODY,
};

/** The create-routine skill by name (the "/" list's built-in), or undefined. */
export function createRoutineSkill(name: string): CreateRoutineSkillText | undefined {
  return name === CREATE_ROUTINE_SKILL.name ? CREATE_ROUTINE_SKILL : undefined;
}
