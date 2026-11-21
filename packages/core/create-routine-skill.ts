/**
 * The Inbox's `/create-routine` skill (docs/agent-guides/inbox-routines.md): the person picks it in a message or
 * reply box, and the window pastes this body into what they send (human-only, as `/shape` and the review skills go),
 * so the agent reading their message learns to make the routine: with its Inbox tool's `routine` action first (the
 * connection fills the tool's session, so the grant below matches), else with `plannotator routine` from the shell
 * (apps/hook/server/routine-command.ts), whose call names a session only when the shell has one. The Inbox lists it
 * only while the person has Routines on (`inboxSkillCatalog`, packages/server/inbox-skills.ts); off, no agent reads
 * a word of it.
 *
 * The person's Send of it is also their approval: it mints a one-time grant on the thread
 * (packages/server/inbox-routine-grants.ts), so the routine the agent they wrote to makes with `thread_id`
 * (`--thread`) naming that thread is on.
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

The person wants work to run on its own, on a schedule, and report back in the Plannotator Inbox. What they want is in their message above. Because they asked you for it here, the routine you make is on from the start.

1. If they gave no time ("check it regularly"), ask them when, in this thread. Never make up a schedule.
2. Make it with your Inbox tool if you have one: the \`plannotator_inbox\` tool's \`routine\` action, or the \`routine\` tool of the Plannotator Inbox MCP server (the same fields, without \`action\`). Set \`thread_id\` to this thread's id (\`msg_1a2b\` below stands for it):

\`\`\`json
{"action": "routine", "op": "create", "name": "Dependency check", "schedule": {"cron": "0 9 * * 1-5"}, "thread_id": "msg_1a2b", "prompt": "Check this repo for outdated dependencies. Reply with each outdated package, its current and latest version, and which updates look safe."}
\`\`\`

   Only if you have no such tool, use the shell: run \`plannotator routine create --help\` once, then

\`\`\`bash
plannotator routine create --name "Dependency check" --cron '0 9 * * 1-5' --thread msg_1a2b \\
  --prompt 'Check this repo for outdated dependencies. Reply with each outdated package, its current and latest version, and which updates look safe.'
\`\`\`

   Write the prompt for a fresh agent that knows nothing of this thread. Runs work in your project unless you give a folder. To run it once, use \`{"at": "<YYYY-MM-DDTHH:MM>"}\` (\`--at\`) in place of the cron.

   If it answers \`validation_error: agent: …\`, ask the person which agent runs it (claude-code, codex, opencode or pi) and pass their answer as \`agent\` (\`--agent\`). Never pick one yourself.
3. Reply in this thread: the routine's name, that it is on, and when its next run is, as the result says. Ask whether they want any edits, and tell them they can see it under Routines in the Inbox.

If the result says it is off, do what it says when you can. If it stays off, tell them so, and that they turn it on under Routines in the Inbox. If a call answers \`routines_off\`, tell them Routines are off (Settings → Capabilities) and stop.

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
