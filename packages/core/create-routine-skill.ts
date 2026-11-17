/**
 * The Inbox's `/create-routine` skill (docs/agent-guides/inbox-routines.md): the person picks it in a message or
 * reply box, and the window pastes this body into what they send (human-only, as `/shape` and the review skills go),
 * so the agent reading their message learns to make the routine with `plannotator routine`
 * (apps/hook/server/routine-command.ts). The Inbox lists it only while the person has Routines on
 * (`inboxSkillCatalog`, packages/server/inbox-skills.ts); off, no agent reads a word of it.
 *
 * Agent-facing words: the owner OKs them word for word. Browser-safe, no dependencies: the server lists it and the
 * window pastes it.
 */

export interface CreateRoutineSkillText {
  name: string;
  description: string;
  body: string;
}

const BODY = `# Make a routine

The person wants work to run on its own, on a schedule, and report back in the Plannotator Inbox: a routine. What they want is in their message above. At each scheduled time the Inbox starts an agent on this computer, in the folder you chose, and that run replies in the routine's own Inbox thread. You make it with the \`plannotator routine\` command.

## Before you make it

1. Use the schedule the person gave. If they gave none ("check it regularly"), ask them when, in this thread. Never make up a time or a frequency.
2. Run \`plannotator routine create --help\` once and read it: every option and its default.

## Make it

\`\`\`bash
plannotator routine create --name "<a few words>" --cron '<minute hour day month weekday>' --thread <this thread's id> --prompt '<what each run does>'
\`\`\`

- Write the prompt for a fresh agent that knows nothing of this thread: what to do, where, and what to report. For a long prompt, or one with quotes in it, use \`--prompt -\` and a quoted heredoc.
- \`--thread\` takes this thread's id (\`thread_id\` from \`read_thread\`): the person then sees the new routine here.
- Each run works in your project unless you pass \`--folder <path>\` (or \`--scratch\` for an empty folder).
- It runs as the agent you are when the Inbox knows which agent that is. If \`create\` answers \`validation_error: agent: …\`, ask the person which agent runs it (claude-code, codex, opencode or pi) and pass their answer with \`--agent\`. Never pick one yourself.
- \`--at 2026-11-20T17:00\` in place of \`--cron\` runs it once.

Examples:

\`\`\`bash
# "Every weekday at 9, check for outdated dependencies."
plannotator routine create --name "Dependency check" --cron '0 9 * * 1-5' --thread msg_1a2b \\
  --prompt 'Check this repo for outdated dependencies. Reply with each outdated package, its current and latest version, and which updates look safe.'

# "Every Friday at 4 PM, draft the release notes." (a long prompt, from stdin)
plannotator routine create --name "Weekly release notes" --cron '0 16 * * 5' --thread msg_1a2b --prompt - <<'EOF'
Draft release notes from the pull requests merged since last Friday.
Group them into features, fixes and chores, and reply with the draft.
EOF

# "Make the dependency check 7 AM." / "Stop it." (take the id from list)
plannotator routine list
plannotator routine update sch_1a2b --cron '0 7 * * 1-5' --thread msg_1a2b
plannotator routine off sch_1a2b --thread msg_1a2b
\`\`\`

\`plannotator routine --help\` lists the other commands: \`get\`, \`on\`, \`run\`, \`delete\`.

## After you make it

Tell the person, in this thread, in two or three lines:

- its name and its schedule in words, as the command's result says them;
- that it is off until they turn it on in the Inbox, and it runs only after that;
- that each run replies in the routine's own Inbox thread.

## Do not

- Do not invent a schedule, or make it run more often than the person asked.
- Do not start a run (\`plannotator routine run\`) unless the person asks for one now.
- Do not try to turn it on for the person: until they turn it on once in the Inbox, \`on\` and \`run\` answer \`routine_not_approved\`. Leave it off and tell them.
- If a command answers \`routines_off\`, tell the person that Routines are off in the Inbox (Settings → Capabilities), and stop. Do not change their settings.
- Do not pass \`--model\` or \`--effort\` unless the person asks for them.
`;

export const CREATE_ROUTINE_SKILL: CreateRoutineSkillText = {
  name: 'create-routine',
  description: 'Have an agent run this on a schedule, each run reporting here',
  body: BODY,
};

/** The create-routine skill by name (the "/" list's built-in), or undefined. */
export function createRoutineSkill(name: string): CreateRoutineSkillText | undefined {
  return name === CREATE_ROUTINE_SKILL.name ? CREATE_ROUTINE_SKILL : undefined;
}
