// The agent-facing pages of plannotator.ai (https://llmstxt.org/): /llms.txt
// routes an agent to the page for its task, /llms/inbox.md is the Inbox for
// agents, /llms/agents/<slug>.md is one agent's setup and /llms/cli.md is the
// CLI reference. The agent lines and steps come from inbox-agents.ts, the
// question and action syntax from the constants `plannotator inbox --help`
// prints, and the CLI page from the plannotator skill, so a new agent or a
// changed rule reaches them with no edit here. The CLI page passes the skill in (a ?raw import, see
// pages/llms/cli.md.ts) so this module also loads under `bun test`.
import {
  COLUMNS,
  INSTALL,
  TURN_ON,
  INSTALL_WIN,
  LISTED_AGENTS,
  TEST,
  TIERS,
  agentHref,
  cellOf,
  type Agent,
  type Step,
} from './inbox-agents';
import { QUESTION_AUTHORING_GUIDE } from '../../../../packages/core/question-block';
import { INBOX_ACTION_EXAMPLE, INBOX_ACTION_GUIDE } from '../../../../packages/core/inbox-actions';
import { INBOX_RUN_EXAMPLE, INBOX_RUN_GUIDE, INBOX_SECRET_EXAMPLE } from '../../../../packages/core/inbox-run-guide';
import {
  INBOX_ANSWERS_WAKE_LINE,
  INBOX_ASK_RECOGNISE_RULE,
  INBOX_FILLED_ARGUMENTS,
  INBOX_FOLLOW_THROUGH_RULE,
  INBOX_PICTURES_RULE,
  INBOX_CHANGE_RULE,
  INBOX_REREAD_RULE,
  INBOX_SHOWING_RULE,
  INBOX_SUBAGENT_RULE,
  INBOX_THREAD_NEW_ISSUE_RULE,
  INBOX_THREAD_RULE,
  INBOX_TOOL_NAME,
} from '../../../../packages/shared/inbox/connection';

export const SITE = 'https://plannotator.ai';
export const LLMS_ROOT_PATH = '/llms.txt';
export const LLMS_INBOX_PATH = '/llms/inbox.md';
export const LLMS_CLI_PATH = '/llms/cli.md';
export const llmsAgentPath = (slug: string) => `/llms/agents/${slug}.md`;

const url = (path: string) => `${SITE}${path}`;
const code = (text: string) => `\`${text}\``;
const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join(''));
const sentence = (text: string) => (/[.!?:]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

const agentsOfTier = (tier: string) => LISTED_AGENTS.filter((a) => a.tier === tier);
const inboxPlugins = () => LISTED_AGENTS.filter((a) => a.tier === 'plugin');

/** One agent's main columns as a short line: "Inbox: MCP. Reply: Not woken. Plan review: Yes. Code review: Yes." */
const ROOT_COLUMNS = [
  { key: 'tool', name: 'Inbox' },
  { key: 'reply', name: 'Reply' },
  { key: 'plan', name: 'Plan review' },
  { key: 'review', name: 'Code review' },
] as const;
function columnsLine(agent: Agent): string {
  return `${ROOT_COLUMNS.map((col) => `${col.name}: ${cellOf(agent, col.key).label}`).join('. ')}.`;
}

// ── /llms.txt ──

export function buildLlmsRoot(): string {
  const lines = [
    '# Plannotator',
    '',
    `> Plannotator is a local review tool for coding agents. The Plannotator Inbox is one window on the person's computer where agents leave messages, questions and finished work. The person answers when they can, and nothing holds the agent's session open. Plannotator also opens plans, code changes, files, web pages and running apps in the person's browser, and returns their feedback to the agent.`,
    '',
    'Rules for every agent:',
    '',
    '- Install or set up nothing for the person unless they asked you to. Before you change the settings of an agent other than yourself, ask them.',
    `- If you have a ${code(INBOX_TOOL_NAME)} tool (it can be listed with a prefix, for example ${code(`mcp__plannotator__${INBOX_TOOL_NAME}`)}), use it for the Inbox. Without it, the Inbox is the stdio MCP server ${code('plannotator inbox mcp')}.`,
    '- If you have a `plannotator` tool, call it instead of running `plannotator review`, `plannotator annotate` or `plannotator last`.',
    '- Plan review opens by itself when you leave plan mode. Never run bare `plannotator`: it is the hook entry point.',
    '- Check that the CLI is installed with `plannotator --version`. Once it is, `plannotator --help` and `plannotator inbox --help` describe the installed version. When they and these pages disagree, trust the CLI.',
    '- These pages follow the newest release. A step that needs a newer Plannotator says which version.',
    '',
    '## Pick your task',
    '',
    `- [Set up the Plannotator Inbox for your person](${url(LLMS_INBOX_PATH)}): when they asked you to. Install Plannotator, connect the agent you are, and send a test message. Your own agent's steps are also on its page under Agents below.`,
    `- [Use the Inbox well](${url(LLMS_INBOX_PATH)}): you have the ${code(INBOX_TOOL_NAME)} tool or the MCP server. When to send, questions, action items, attachments, and how the reply comes back.`,
    `- [Inbox setup script](${url('/inbox/prompt.md')}): the same setup as one script to follow from start to end, for a person who pasted it to you.`,
    `- [Pair a cloud agent](${url('/inbox/cloud-agent.md')}): you run in the cloud and the person gave you a pairing message from their Inbox.`,
    `- [Pair Muse by Meta](${url('/inbox/muse.md')}): the same, for Muse by Meta.`,
    `- [Review code changes or a pull request](${url(LLMS_CLI_PATH)}): ${code('plannotator review')} for local changes, ${code('plannotator review <PR_URL>')} for a pull request. See "plannotator review" there for flags.`,
    `- [Plan review](${url(LLMS_CLI_PATH)}): it opens by itself when you leave plan mode. A plan or spec saved as a file: ${code('plannotator annotate <file> --gate --json')}.`,
    `- [Annotate a file, folder, web page or running app](${url(LLMS_CLI_PATH)}): ${code('plannotator annotate <file>')}, ${code('plannotator annotate <folder/>')}, ${code('plannotator annotate <https-url>')} or ${code('plannotator annotate <http://localhost:PORT/>')}. Your last reply: ${code('plannotator last')}.`,
    '',
    'Which agents work with Plannotator: every agent below, with its page. "Reply" says whether the person\'s reply wakes the agent; "you" and "your" in these lines mean the person. Plan review needs the agent\'s hook or plugin. Code review and annotate need only a shell: where they read "No", the agent has no command of its own but can still run `plannotator review` and `plannotator annotate`. An agent not listed reaches the Inbox through MCP.',
    '',
  ];
  for (const tier of TIERS) {
    const agents = agentsOfTier(tier.id);
    if (agents.length === 0) continue;
    lines.push(`## Agents: ${tier.name}`, '', `${sentence(tier.baseline)}${tier.note ? ` ${sentence(tier.note)}` : ''}`, '');
    for (const agent of agents) lines.push(`- [${agent.name}](${url(llmsAgentPath(agent.slug))}): ${columnsLine(agent)}`);
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    `- [All agents, for people](${url('/inbox/agents/')}): the same agents as web pages.`,
    `- [Inbox reference for people](${url('/docs/reference/inbox/')}): the window, settings, data and troubleshooting.`,
    `- [Install script](${url('/install.sh')}): macOS, Linux and WSL. Windows: [install.ps1](${url('/install.ps1')}).`,
    '- [Plannotator docs](https://docs.plannotator.ai/llms.txt): the documentation for people.',
    '- [GitHub repository](https://github.com/backnotprop/plannotator): source, issues and releases.',
    '- [guides.show](https://guides.show): the Guided Review viewer and share host.',
    '',
  );
  return lines.join('\n');
}

// ── /llms/cli.md ──

/** The plannotator skill as a page: the CLI reference agents install as a skill, under this page's own H1 and summary. */
export function buildLlmsCli(skillMarkdown: string): string {
  // Strip YAML frontmatter.
  const body = skillMarkdown.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
  // The skill's own H1 would duplicate the page's H1.
  const withoutH1 = body.replace(/^# .*\n/, '').trimStart();
  // The skill's opening paragraph is the same summary as the `>` blockquote below.
  const withoutSummary = withoutH1.replace(/^[^\n]+\n\n/, '');
  // "This skill is the knowledge layer." orients an agent that loaded a skill;
  // a reader of this page did not, so only that sentence goes.
  const intro = withoutSummary.replace(/^This skill is the knowledge layer\.\s*/, '');
  const header = [
    '# Plannotator CLI for agents',
    '',
    '> Plannotator is a local, browser-based review layer for agent coding workflows: plan review, code review, and document or live-app annotation. A human marks things up in the UI and structured feedback returns to the agent on stdout. This page is the complete CLI reference, generated from the same source agents install as the `plannotator` skill.',
    '',
    `Back to the index: ${url(LLMS_ROOT_PATH)}. The Inbox for agents: ${url(LLMS_INBOX_PATH)}.`,
    '',
    '',
  ].join('\n');
  return header + intro;
}

// ── /llms/inbox.md ──

function stepLines(steps: Step[], indent = ''): string[] {
  return steps.flatMap((step, i) => {
    const out = [`${indent}${i + 1}. ${sentence(step.do)}`];
    if (step.code) {
      if (step.file) out.push(`${indent}   In ${code(step.file)}:`);
      out.push(`${indent}   \`\`\``, ...step.code.split('\n').map((l) => `${indent}   ${l}`), `${indent}   \`\`\``);
    }
    if (step.see) out.push(`${indent}   You should see: ${sentence(step.see)}`);
    return out;
  });
}

const PERSON_NOTE =
  'The steps are written for the person, as on the agent\'s page for people: "you" is the person. Run a step for them only when they asked you to set this up, and ask before you install anything.';

export function buildLlmsInbox(): string {
  const plugins = inboxPlugins();
  const lines: string[] = [
    '# Plannotator Inbox for agents',
    '',
    '> The Plannotator Inbox is one local window per computer. Agents leave the person messages, questions, files to annotate and guided reviews there. The person answers when they can. Nothing holds your session open: you send, then keep working or end your turn.',
    '',
    'Once Plannotator is installed, `plannotator inbox --help` prints the full guide for agents for the installed version. When it and this page disagree, trust it.',
    '',
    `Back to the index: ${url(LLMS_ROOT_PATH)}.`,
    '',
    '## What it is',
    '',
    "- One window per computer. It runs on `127.0.0.1` and keeps its data in Plannotator's data folder (`plannotator data-dir` prints it).",
    `- Agents reach it with the ${code(INBOX_TOOL_NAME)} tool, which Plannotator's plugins give some agents, or with the stdio MCP server ${code('plannotator inbox mcp')}.`,
    '- The person reads your message, answers its questions, annotates its files and presses Send. The reply goes back to the session that sent the message.',
    '- Some agents are woken by the reply. Others read it later with `read_thread`. See "How replies come back".',
    '',
    '## When to use it',
    '',
    'Use it for:',
    '',
    '- A question you cannot settle from the code or the conversation, which can wait for an answer.',
    '- A blocker. Say what stops you in a `Stopped:` line. When other work can go on, name what waits in a `Holds up:` line instead.',
    '- Something only the person can do outside the chat (approve a deploy, sign in, merge a pull request you cannot merge): one `:::action` item.',
    '- Long work you finished: one short summary with its pictures in place (`![alt](path)` in the body), and the files to look at in `attachments`.',
    '- A decision that needs pictures or files, even while the person writes in the chat.',
    '- A plan, document, HTML prototype or diagram for the person to read and annotate.',
    '- A guided review of a finished code change (`get_guide_brief`, then `submit_guide`).',
    '',
    'Do not use it for:',
    '',
    '- Something new the person raised in the chat that needs no pictures or files. Ask in the chat.',
    '- A checklist or a status update written as `:::action` blocks.',
    '- A sign-off on a plan, document or diff before you go on. Use a Plannotator review instead: plan review, `plannotator annotate` or `plannotator review` (see the CLI page).',
    '',
    INBOX_THREAD_RULE,
    '',
    INBOX_FOLLOW_THROUGH_RULE,
    '',
    INBOX_SUBAGENT_RULE,
    '',
    '## Use the Inbox well',
    '',
    '### Reach it',
    '',
    `- With the ${code(INBOX_TOOL_NAME)} tool: set \`action\` to the Inbox tool you want (\`send_message\`, \`read_thread\`, \`search\`, \`resolve_message\` and the others \`plannotator inbox --help\` lists) and pass that tool's fields beside it. The tool fills ${INBOX_FILLED_ARGUMENTS.map(code).join(', ')} for you. It may need loading through tool search first.`,
    '- Without it: the stdio MCP server `plannotator inbox mcp`, with the same tools. While the Inbox is on, every call starts it in the background when it is stopped, so never run `plannotator inbox` just to send. Bare `plannotator inbox` is for the person: it opens the window and turns the Inbox on. Until they have, a call answers that the Inbox is off: ask them in the chat instead.',
    '',
    '### Send one message',
    '',
    '- Call `send_message` with a markdown `body`. Put the decision, the summary or the blocker in that one message. Do not split it into several sends.',
    '- `thread`: a short name that keeps one work stream in one thread, across sessions. `reply_to`: a message id, to answer inside that thread. Take ids from the Inbox (the reply\'s first line, a `read_thread` result), never from memory. ' + INBOX_THREAD_NEW_ISSUE_RULE,
    '- `attachments`: files to show beside the message, absolute or relative to the project: a plan, an HTML prototype, a video, code. The person annotates them and the annotations come back in the reply. Folders and `.env` files are refused.',
    `- ${INBOX_SHOWING_RULE}`,
    `- Pictures: ${INBOX_PICTURES_RULE}`,
    `- Before and after: ${INBOX_CHANGE_RULE}`,
    `- ${INBOX_REREAD_RULE}`,
    '- `supersedes`: earlier questions of the thread that no longer apply. `done`: your own action items you saw done.',
    '- Thread steps exist only when the person turned them on in the Inbox\'s Settings → Capabilities. Then your tool lists a `steps` action, and `plannotator inbox --help` explains it.',
    '',
    QUESTION_AUTHORING_GUIDE.trimEnd().replace(/^## /m, '### '),
    `- ${INBOX_ASK_RECOGNISE_RULE}`,
    '',
    'Only in the Inbox, a question block can also carry these lines, each on its own line after the question:',
    '',
    '- `Stopped: <why>`: you cannot go on until this is answered. Leave the line out otherwise. Never write `Stopped: no`.',
    '- `Holds up: <name>; <name>`: you go on, and these pieces of work wait.',
    '- `Replaces: <message id>/<key>`: this question replaces an earlier open one of the same thread (send it with `reply_to` into that thread).',
    '',
    '### Action items only the person can do',
    '',
    INBOX_ACTION_GUIDE.trimEnd(),
    '',
    '```markdown',
    INBOX_ACTION_EXAMPLE.trimEnd(),
    '```',
    '',
    '### Commands the person runs, and secrets',
    '',
    INBOX_RUN_GUIDE.trimEnd(),
    '',
    '```markdown',
    INBOX_RUN_EXAMPLE.trimEnd(),
    '',
    INBOX_SECRET_EXAMPLE.trimEnd(),
    '```',
    '',
    '### What comes back, and when',
    '',
    '- The send result says whether the person\'s reply arrives in this session by itself.',
    '- If it does, end your turn, or go on with other work. Do not wait in a loop and do not poll. The reply arrives as a new message that starts with `Plannotator Inbox: <title> (<reply id>)`. Answer with `send_message` and `reply_to` set to that id.',
    '- If it does not, go on with your work and call `read_thread` with the `thread_id` later. `read_thread` with no id lists your threads; a thread the person wrote in for you reads `unread`.',
    '- The reply holds the person\'s words, then "Answers to your questions", then their comments on your text and their annotations on attached files.',
    `- ${INBOX_ANSWERS_WAKE_LINE}`,
    '- Questions they did not answer stay open, and the reply says how many. Do not ask them again.',
    '- Codex, Qwen Code and T3 Code are woken once per reply, and a lost wake is not sent again. If a reply has not arrived when you next work, list your threads with `read_thread`.',
    '',
    '### Chat or Inbox',
    '',
    'A decision you sent to the Inbox stays there. When the person comes back to the chat, say there what is waiting (a short summary and the thread\'s link). Never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): it blocks the chat and splits the answer. Ask in the chat only about something new the person raised there that needs no pictures or files, or when they ask you to.',
    '',
    '## Set up the Inbox for your person',
    '',
    `Do this only when the person asked you to. To follow one script from start to end, use [the setup script](${url('/inbox/prompt.md')}). This section is the same setup in short.`,
    '',
    '- Never run `plannotator uninstall`, never delete files, never stop processes. Never run `plannotator inbox stop` or `restart` unless the person asks: other agents use the same Inbox.',
    '- Never guess a flag. When unsure, run `plannotator --help` or `plannotator inbox --help`.',
    '- If a command fails because of a sandbox, missing permissions or no network, stop and give the person the exact command to run in their own terminal.',
    '- Connect other agents only when the person asks. Ask before you add an entry by hand for any agent other than yourself.',
    '',
    '1. Check: `plannotator --version`. If it is not found, try `~/.local/bin/plannotator --version`.',
    `2. Install it, with the person's yes. In a terminal on macOS, Linux or WSL: ${code(INSTALL)}. Windows PowerShell: ${code(INSTALL_WIN)}. Without prompts, for an agent: ${code('curl -fsSL https://plannotator.ai/install.sh | bash -s -- --non-interactive')} (PowerShell: ${code('& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -NonInteractive')}). The same command updates an older release.`,
    `3. Open the Inbox: ${code(TURN_ON)}. It opens the window in the browser, prints its URL, then connects the agents it finds on this computer that are not connected yet; its stderr names them. That is part of the setup the person asked for: tell them before you run it. If they want only you connected, run ${code(`PLANNOTATOR_INBOX_CONNECT=0 ${TURN_ON}`)} and connect yourself in step 4. It never adds back a connection the person removed or turned off. On SSH or a headless machine no browser opens: give the person the URL it prints.`,
    `4. Connect yourself: find your agent under Agents below and follow its steps. If step 3 connected you, or your config already has a \`plannotator-inbox\` server that runs the \`plannotator\` binary, skip this. A connection takes effect in the next session, never in the one already running; until then you can send through \`plannotator inbox mcp\` directly (step 4 of [the setup script](${url('/inbox/prompt.md')}) shows how).`,
    `5. Test it: send the person one message with a question, end your turn, and read their answer when it comes back. The person can also ask you this: "${TEST}"`,
    '',
    `Agents with a Plannotator plugin (${list(plugins.map((a) => a.name))}) get the ${code(INBOX_TOOL_NAME)} tool. Once the Inbox is on, it is on by default in Claude Code and off at first in the others, because they send every tool with each request. Step 3 turns it on when it finds the plugin, the first time, and so does the person's own \`plannotator inbox\` later. It can also be turned on with the switch in the Inbox's Settings → Agents, or by merging \`{ "inboxTool": { "<host>": true } }\` into \`config.json\` in the data folder, keeping its other keys. Tell the person before you turn it on.`,
    '',
    '## Agents',
    '',
    `What each agent gets, and its recommended steps. ${PERSON_NOTE}`,
    '',
    'An agent not listed here: add the stdio MCP server `plannotator inbox mcp`, named `plannotator-inbox`, in its MCP settings. `plannotator inbox --help` has the line for each host it knows.',
    '',
  ];
  for (const tier of TIERS) {
    const agents = agentsOfTier(tier.id);
    if (agents.length === 0) continue;
    lines.push(`### ${tier.name}`, '', `${sentence(tier.baseline)}${tier.note ? ` ${sentence(tier.note)}` : ''}`, '');
    for (const agent of agents) {
      lines.push(
        `#### ${agent.name}`,
        '',
        `- Inbox tool: ${agent.inbox.tool.label}. ${agent.inbox.tool.detail}`,
        `- Reply: ${agent.inbox.reply.label}. ${agent.inbox.reply.detail}`,
        '',
        ...stepLines(agent.setup.map(({ see: _see, ...step }) => step)),
        '',
        `Other ways, a check, troubleshooting and limits: ${url(llmsAgentPath(agent.slug))}`,
        '',
      );
    }
  }
  lines.push(
    '## How replies come back',
    '',
    'A woken session gets the reply as a new message once it is idle. Every other session reads it with `read_thread`. Each agent\'s section above says how.',
    '',
    '| Agent | Reply |',
    '| --- | --- |',
    ...TIERS.flatMap((tier) => agentsOfTier(tier.id)).map((a) => `| ${a.name} | ${a.inbox.reply.label} |`),
    '',
    '## Commands',
    '',
    '| Command | What it does |',
    '| --- | --- |',
    '| `plannotator inbox` | For the person: start the Inbox and open it, and connect the agents it finds. |',
    '| `plannotator inbox --background` | Start it detached without a browser, print its URL and exit. |',
    '| `plannotator inbox --open` | Open it in the browser and print its URL. Never blocks. Use it when the person asks where their Inbox is. |',
    '| `plannotator inbox mcp` | The stdio MCP server for agents. Starts a stopped Inbox in the background. |',
    '| `plannotator inbox status` | Read only: whether the Inbox runs. Exit 0 running, 1 not running, 2 not answering. |',
    '| `plannotator inbox call` | Run one Inbox action from a script: JSON in, one JSON result on stdout. `plannotator inbox call --help` lists the actions. |',
    '| `plannotator inbox --notes <ids>` | Add the Inbox note to these agents\' instructions files. Only with the person\'s yes. |',
    '| `plannotator inbox --help` | The full guide for agents: tools, threads, question syntax, where replies go. |',
    '',
    '## Limits',
    '',
    '- Local only. The Inbox binds `127.0.0.1`. The person may publish the window over their tailnet, but the MCP server and agent tools answer only on this computer. Add `--tailscale` only when the person asks.',
    '- A new connection works from the next session, never in the running one.',
    '- Starting a session from the Inbox works only for Claude Code, Codex and Pi.',
    '- Permission prompts come to the Inbox as cards only in Claude Code and Codex sessions that the Inbox started.',
    '- Cloud agents reach the Inbox through a relay after the person pairs them in Settings → Cloud agents. Files attached in the Inbox do not reach them, and the person\'s computer must be awake for them to read.',
    '- The Board (cards for long work) is off until the person turns it on in Settings → Capabilities.',
    '- Never run `plannotator uninstall`, delete threads or projects, or edit the Inbox\'s files for the person.',
    '',
  );
  return lines.join('\n');
}

// ── /llms/agents/<slug>.md ──

export function buildLlmsAgent(agent: Agent): string {
  const cols = [...COLUMNS.inbox, ...COLUMNS.plannotator];
  const lines: string[] = [
    `# ${agent.name} with Plannotator`,
    '',
    `> ${agent.lede}`,
    '',
    `${PERSON_NOTE} The page for people: ${url(agentHref(agent.slug))}. How to use the Inbox once it works: ${url(LLMS_INBOX_PATH)}.`,
    '',
    '## What works',
    '',
    ...cols.map((col) => {
      const cell = cellOf(agent, col.key);
      return `- ${col.name}: ${cell.label}. ${cell.detail}`;
    }),
    '',
    '## Setup',
    '',
    ...stepLines(agent.setup),
    '',
  ];
  if (agent.other.length > 0) {
    lines.push('## Other ways', '');
    for (const other of agent.other) lines.push(`### ${other.title}`, '', ...stepLines(other.steps), '');
  }
  lines.push('## Check that it works', '', ...stepLines([agent.check]), '');
  if (agent.trouble.length > 0) {
    lines.push('## Troubleshooting', '');
    for (const t of agent.trouble) {
      lines.push(`- ${t.symptom}: ${t.fix}`);
      if (t.code) lines.push('  ```', ...t.code.split('\n').map((l) => `  ${l}`), '  ```');
    }
    lines.push('');
  }
  if (agent.limits.length > 0) lines.push('## Limits', '', ...agent.limits.map((l) => `- ${l.text}`), '');
  if (agent.docs) lines.push(`The full guide for people: ${agent.docs}`, '');
  return lines.join('\n');
}

/** Every agent the site lists, with its page. An unlisted agent gets none. */
export const LLMS_AGENT_PAGES = LISTED_AGENTS.map((agent) => ({ slug: agent.slug, agent }));

// ── /inbox/prompt.md ──

/** The line in inbox-prompt.md that the per-agent list replaces. */
export const INBOX_PROMPT_AGENTS_SLOT = '{{AGENT_STEPS}}';

/** The prompt is served and copied as plain ASCII, so the agent entries' typography folds to it. */
const ascii = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, '>')
    .replace(/…/g, '...')
    .replace(/[–—]/g, '-');

/** The words of a step before `plannotator inbox --open`: its code, which is the install line. */
function beforeStep(step: Step): string {
  if (!step.code) return sentence(step.do);
  return `${step.file ? `In ${code(step.file)}: ` : ''}${step.code.split('\n').map(code).join(' then ')}.`;
}

/** The words of a step after `plannotator inbox --open`, less a sentence about what `plannotator inbox` did, and its code unless they quote it. */
function afterStep(step: Step): string {
  const words = step.do
    .split(/(?<=\.) (?=[A-Z`])/)
    .filter((s) => !s.startsWith('`plannotator inbox`'))
    .join(' ');
  const shown = (step.code?.split('\n') ?? []).filter((line) => !words.includes(code(line)));
  return shown.length ? `${sentence(words)} ${shown.map(code).join(' then ')}.` : sentence(words);
}

/** The by-hand MCP step: `plannotator inbox --open` has no way to connect the agent. */
const isByHandMcp = (step: Step) => step.prompt === 'after' && step.code === 'plannotator inbox mcp';

const agentLink = (agent: Agent) => `[${agent.name}](${url(llmsAgentPath(agent.slug))})`;

/** What each agent does around `plannotator inbox --open` in the install prompt, from the steps marked `prompt`. */
export function buildInboxPromptAgents(): string {
  const marked = (agent: Agent) => agent.setup.filter((step) => step.prompt);
  const lines: string[] = [];
  const nothing: Agent[] = [];
  const byHand: Agent[] = [];
  for (const agent of LISTED_AGENTS.filter((a) => a.tier !== 'cloud')) {
    const steps = marked(agent);
    if (steps.length === 0) nothing.push(agent);
    else if (steps.every(isByHandMcp)) byHand.push(agent);
    else {
      const before = steps.filter((s) => s.prompt === 'before').map(beforeStep);
      const after = steps.filter((s) => s.prompt === 'after').map(afterStep);
      const parts = [...(before.length ? [`Before step 2: ${before.join(' ')}`] : []), ...(after.length ? [`After step 2: ${after.join(' ')}`] : [])];
      lines.push(`- ${agentLink(agent)}. ${parts.join(' ')}`);
    }
  }
  if (byHand.length > 0) {
    lines.push(`- ${list(byHand.map(agentLink))}: step 2 does not connect them. In step 3 add a stdio MCP server \`plannotator-inbox\` that runs \`plannotator inbox mcp\`.`);
  }
  if (nothing.length > 0) lines.push(`- ${list(nothing.map(agentLink))}: nothing more. Step 2 connects them.`);
  const cloud = LISTED_AGENTS.filter((a) => a.tier === 'cloud');
  if (cloud.length > 0) {
    lines.push(`- ${list(cloud.map(agentLink))}: not this setup. Follow the pairing message the person copies from the Inbox's Settings > Cloud agents.`);
  }
  return ascii(lines.join('\n'));
}

/** The line in inbox-prompt.md's text that stands for the setup command (INBOX_SETUP_COMMAND). */
export const INBOX_PROMPT_TURN_ON_SLOT = '{{TURN_ON}}';

/** The install prompt: inbox-prompt.md (passed in, a ?raw import) with the per-agent list in its slot and the setup command in its own. */
export function buildInboxPrompt(source: string): string {
  return source.replace(INBOX_PROMPT_AGENTS_SLOT, buildInboxPromptAgents()).replaceAll(INBOX_PROMPT_TURN_ON_SLOT, TURN_ON);
}
