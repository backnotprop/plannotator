// The agents pages (/inbox/agents/ and /inbox/agents/<slug>/) read this one
// list: the overview's tiers and table and every agent's own page, so a fact
// can't say one thing on one page and another on the next.
//
// Every cell names where its fact comes from (`src`, repo paths, as of the
// commit that added this file). Short forms used below:
//   IB   apps/marketing/src/content/docs/reference/inbox.md (the Inbox reference)
//   INST apps/marketing/src/content/docs/getting-started/installation.md
//   AIF  apps/marketing/src/content/docs/guides/ai-features.md ("Ask this session")
//   LCH  docs/agent-guides/inbox-launch.md (starting agents from the Inbox)
//   WAKE packages/core/inbox-types.ts INBOX_WAKING_HOSTS (who a reply wakes)
//   AG   packages/server/inbox-agents.ts AGENT_SPECS (who `plannotator inbox` connects)
// When one of those changes, change the cell here; the pages follow.

export type Tier = 'plugin' | 'shim' | 'mcp';

/** yes: works. part: works with a condition the label names. no: doesn't. */
export type Level = 'yes' | 'part' | 'no';

export interface Cell {
  level: Level;
  /** A few words for the table. */
  label: string;
  /** One or two sentences for the agent's own page. */
  detail: string;
  /** Where the fact comes from (not shown). */
  src: string;
}

export interface Step {
  /** What to do, one sentence. */
  text: string;
  /** A command or a config line to copy. */
  code?: string;
  /** A file name shown above `code`. */
  file?: string;
}

export interface Agent {
  slug: string;
  name: string;
  tier: Tier;
  /** One sentence under the name on the agent's page. */
  lede: string;
  inbox: { tool: Cell; reply: Cell; start: Cell; permissions: Cell };
  plannotator: { plan: Cell; review: Cell; annotate: Cell; ask: Cell };
  install: Step[];
  windows: { text: string; src: string };
  /** What doesn't work yet, besides the cells marked no. */
  limits: { text: string; src: string }[];
  /** An Inbox screen from inbox-assets/ (InboxShot's name). */
  shot?: { name: string; alt: string };
  /** The full setup guide on docs.plannotator.ai, where one exists. */
  docs?: string;
}

export const TIERS: { id: Tier; name: string; get: string; miss: string }[] = [
  {
    id: 'plugin',
    name: 'Native plug-in',
    get: "Plannotator's own plug-in runs inside the agent. The Inbox is one of its tools and your reply arrives in the session as its next turn.",
    miss: 'On every agent but Claude Code the tool starts off, because it adds to each request the agent sends. You turn it on once in the Inbox’s Settings.',
  },
  {
    id: 'shim',
    name: 'Shim',
    get: "Plannotator hooks into the agent's own plan mode or adds its commands, and the agent reaches the Inbox as an MCP server.",
    miss: 'Your reply waits until the agent next checks the Inbox. Codex and Qwen Code are the exception: there it arrives as a new turn.',
  },
  {
    id: 'mcp',
    name: 'MCP only',
    get: 'The agent reaches the Inbox as an MCP server and can send you messages and questions and guided reviews.',
    miss: "Nothing wakes it: it sees your reply when it next checks the Inbox. Plan review and code review aren't wired in.",
  },
];

export const COLUMNS = {
  inbox: [
    { key: 'tool', name: 'Inbox tool', means: 'How the agent reaches the Inbox.' },
    { key: 'reply', name: 'Your reply', means: 'What happens when you answer in the Inbox.' },
    { key: 'start', name: 'Start from the Inbox', means: 'Start a new session of the agent from New message.' },
    { key: 'permissions', name: 'Permission cards', means: "Allow or deny the agent's permission prompts in the Inbox." },
  ],
  plannotator: [
    { key: 'plan', name: 'Plan review', means: 'The agent’s plan opens in Plannotator when it leaves plan mode.' },
    { key: 'review', name: 'Code review', means: 'Review the agent’s changes or a pull request and send it your comments.' },
    { key: 'annotate', name: 'Annotate', means: 'Mark up a file or a page or the agent’s last reply.' },
    { key: 'ask', name: 'Ask this session', means: 'Ask a question in a review and the session that opened it answers.' },
  ],
} as const;

// Cells that read the same for many agents.
const noStart: Cell = {
  level: 'no',
  label: 'No',
  detail: 'You can’t start a session of it from the Inbox yet. Claude Code and Codex and Pi are the agents you can start there.',
  src: 'LCH:3 (Claude Code, Pi and Codex are the launch hosts)',
};
const noPermissions: Cell = {
  level: 'no',
  label: 'No',
  detail: 'Its permission prompts stay in the agent.',
  src: 'LCH:81-83, LCH:194 (cards only for Claude Code and Codex sessions the Inbox started)',
};
const noAsk: Cell = {
  level: 'no',
  label: 'No',
  detail: 'Ask this session isn’t available. Ask AI in a review uses a provider you pick instead.',
  src: 'AIF:17-21 (Claude Code with the mod, Pi, OpenCode 2)',
};
const nextCheck = (src: string): Cell => ({
  level: 'part',
  label: 'On its next check',
  detail: 'Nothing wakes it. It sees your reply the next time it reads the thread, and the Inbox marks the reply unread until then.',
  src,
});
const mcpTool = (detail: string, src: string): Cell => ({ level: 'yes', label: 'MCP', detail, src });
const mcpByHand = (name: string): Cell => ({
  level: 'part',
  label: 'MCP by hand',
  detail: `Add \`plannotator inbox mcp\` to ${name} as an MCP server named \`plannotator-inbox\`. The Inbox doesn’t connect ${name} for you and its setup screen has no step for it yet.`,
  src: 'IB:310-312 (any MCP client); AG has no entry for this agent; apps/hook/server/inbox-help.ts has no line for it',
});
const noPlan = (src: string): Cell => ({
  level: 'no',
  label: 'No',
  detail: 'Plannotator doesn’t open its plans yet.',
  src,
});

export const AGENTS: Agent[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    tier: 'plugin',
    lede: 'The fullest Plannotator connection. The Inbox tool is on from the start and you can start Claude Code sessions from the Inbox.',
    inbox: {
      tool: {
        level: 'yes',
        label: 'Built in',
        detail: 'The plugin gives Claude a `plannotator_inbox` tool. It is on by default and its first use starts the Inbox in the background.',
        src: 'IB:201-205; docs/agent-guides/claude-code-mod.md:918',
      },
      reply: {
        level: 'yes',
        label: 'Wakes it',
        detail: 'Your reply arrives as a new turn once Claude finishes what it is doing. Send now puts it into the turn Claude is in.',
        src: 'IB:203; WAKE',
      },
      start: {
        level: 'yes',
        label: 'Yes',
        detail: 'Pick New Claude Code session in a new message and it starts in the project with your own settings. Claude Code 2.1.314 or newer.',
        src: 'LCH:1-11 (claude --bg, CLAUDE_LAUNCH_MIN_VERSION)',
      },
      permissions: {
        level: 'part',
        label: 'Sessions it started',
        detail: 'In a session the Inbox started, Claude’s permission prompts come to the Inbox as cards you allow or deny.',
        src: 'LCH:81-83 (inbox permission-hook on PermissionRequest, launched sessions only)',
      },
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'When Claude leaves plan mode the plan opens in Plannotator. Claude keeps the session free while you review and gets your decision as a message.',
        src: 'apps/hook/README.md:81-94',
      },
      review: {
        level: 'yes',
        label: 'Yes',
        detail: '`/plannotator-review` opens your changes or a pull request. Your comments come back to Claude.',
        src: 'README.md:147; apps/hook/README.md:83',
      },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up Claude’s last reply.',
        src: 'README.md:135-139',
      },
      ask: {
        level: 'yes',
        label: 'Yes',
        detail: 'Ask a question in any review and the Claude session that opened it answers there.',
        src: 'AIF:17-19',
      },
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin.', code: 'claude plugin marketplace add backnotprop/plannotator' },
      { text: '', code: 'claude plugin install plannotator@plannotator' },
      { text: 'Quit Claude Code and start it again. Claude Code 2.1.287 or newer.' },
    ],
    windows: {
      text: 'Works on Windows. Starting sessions from the Inbox is off there by default.',
      src: 'INST:24-42; docs/agent-guides/claude-code-mod.md:50-62; LCH:5',
    },
    limits: [
      {
        text: 'In `claude -p` and SDK runs the plugin adds no Inbox tool and nothing wakes the session. Connect the Inbox as an MCP server there.',
        src: 'IB:205',
      },
      {
        text: 'While a plan review is open Claude isn’t held. If you leave plan mode before you approve it can start editing.',
        src: 'apps/hook/README.md:88',
      },
      {
        text: 'Claude’s own `AskUserQuestion` stays in Claude Code. Questions reach the Inbox when Claude sends them there.',
        src: 'LCH:81',
      },
    ],
    shot: {
      name: 'design-doc',
      alt: "Claude Code's design doc next to its thread with a Mermaid diagram two saved comments and a third being written",
    },
    docs: 'https://docs.plannotator.ai/open-source/agents/claude-code',
  },
  {
    slug: 'pi',
    name: 'Pi',
    tier: 'plugin',
    lede: 'Plannotator’s Pi extension gives Pi the Inbox and plan review that never holds the session. You can start Pi sessions from the Inbox.',
    inbox: {
      tool: {
        level: 'part',
        label: 'Built in, off at first',
        detail: 'The extension gives Pi a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because Pi sends every tool with each request (about 2,750 tokens for this one).',
        src: 'IB:207-215',
      },
      reply: {
        level: 'yes',
        label: 'Wakes it',
        detail: 'Your reply arrives as a follow-up once Pi is idle. Send now steers it into the run.',
        src: 'IB:213; WAKE',
      },
      start: {
        level: 'yes',
        label: 'Yes',
        detail: 'Pick New Pi session in a new message. Pi 0.79.1 or newer with the extension. The Inbox runs that session, so it pauses when the Inbox stops and your next reply continues it.',
        src: 'LCH:157-174',
      },
      permissions: {
        level: 'no',
        label: 'No',
        detail: 'Pi has no permission prompts of its own.',
        src: 'LCH:175',
      },
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'Start in plan mode (`--plan` or `/plannotator-plan-mode`) and Pi sends its plan to Plannotator. Your decision arrives later as a message.',
        src: 'docs/agent-guides/plan-review.md:65-75; apps/pi-extension/README.md:130-148',
      },
      review: {
        level: 'yes',
        label: 'Yes',
        detail: '`/plannotator-review` opens your changes or a pull request.',
        src: 'apps/pi-extension/README.md:265,410',
      },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: 'Mark up a file or a folder or a URL, or Pi’s last reply.',
        src: 'apps/pi-extension/README.md:412; apps/pi-extension/index.ts:1195',
      },
      ask: {
        level: 'yes',
        label: 'Yes',
        detail: 'Ask a question in a review and the Pi session answers there.',
        src: 'AIF:20; apps/pi-extension/README.md:268',
      },
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the extension.', code: 'pi install npm:@plannotator/pi-extension' },
      { text: 'Run `plannotator inbox` once. It turns the Inbox tool on for Pi. Then start a new Pi session or run `/reload`.', code: 'plannotator inbox' },
    ],
    windows: {
      text: 'The extension installs on Windows. Starting Pi from the Inbox is macOS and Linux for now.',
      src: 'scripts/install.ps1:1398; LCH:244',
    },
    limits: [
      { text: 'The Inbox tool is inactive in print and JSON mode, because nothing could bring a reply back there.', src: 'IB:213' },
      { text: 'Ask this session doesn’t work in remote mode.', src: 'apps/pi-extension/README.md:268' },
    ],
    shot: { name: '4.1', alt: 'A guided review arriving in a thread from Pi' },
    docs: 'https://docs.plannotator.ai/open-source/agents/pi',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    tier: 'plugin',
    lede: 'Plannotator’s OpenCode plugin adds plan review and the Inbox. On OpenCode 2 your replies arrive in the session on their own.',
    inbox: {
      tool: {
        level: 'part',
        label: 'Built in, off at first',
        detail: 'The plugin gives OpenCode a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because OpenCode sends every tool with each request.',
        src: 'IB:217-223',
      },
      reply: {
        level: 'part',
        label: 'Wakes OpenCode 2',
        detail: 'On OpenCode 2 your reply arrives as a new turn once the session is idle. OpenCode 1 has the tool but sees your reply only when it reads the thread.',
        src: 'IB:223; WAKE',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'The plan agent sends its plan with the `submit_plan` tool and waits for your decision.',
        src: 'apps/opencode-plugin/README.md:50,79,198; INST:321',
      },
      review: {
        level: 'yes',
        label: 'Yes',
        detail: '`/plannotator-review` opens your changes or a pull request.',
        src: 'apps/opencode-plugin/README.md:47,69',
      },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: 'Mark up a file or a folder or a URL, or the last reply.',
        src: 'apps/opencode-plugin/README.md:182-184',
      },
      ask: {
        level: 'part',
        label: 'OpenCode 2',
        detail: 'On OpenCode 2 the session answers questions in code review and annotation. In plan review it gives a quick answer from what it already knows.',
        src: 'AIF:21; apps/opencode-plugin/README.md:50',
      },
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin to opencode.json. On OpenCode 2:', file: 'opencode.json', code: '{ "plugins": [{ "package": "@plannotator/opencode@latest" }] }' },
      { text: 'On OpenCode 1:', file: 'opencode.json', code: '{ "plugin": ["@plannotator/opencode@latest"] }' },
      { text: 'Run `plannotator inbox` once. It turns the Inbox tool on for OpenCode. Then restart OpenCode.', code: 'plannotator inbox' },
    ],
    windows: {
      text: 'The plugin works on Windows. The Windows installers don’t update the OpenCode 2 service for you.',
      src: 'scripts/install.ps1:1371-1382; docs/agent-guides/opencode-t3-and-codex.md:136',
    },
    limits: [
      { text: 'Cancelling a turn doesn’t close a review that is open.', src: 'apps/opencode-plugin/README.md:51' },
    ],
    shot: {
      name: 'question-pictures',
      alt: 'A question from OpenCode with three invoice layouts as picture choices and the second one picked',
    },
    docs: 'https://docs.plannotator.ai/open-source/agents/opencode',
  },
  {
    slug: 'deepseek-harness',
    name: 'DeepSeek Harness',
    tier: 'plugin',
    lede: 'Plannotator’s DeepSeek Harness plugin opens plans in Plannotator and gives the agent the Inbox.',
    inbox: {
      tool: {
        level: 'part',
        label: 'Built in, off at first',
        detail: 'The plugin gives the agent a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because DeepSeek Harness sends every tool with each request.',
        src: 'IB:227-233; apps/dsh-plugin/README.md',
      },
      reply: {
        level: 'yes',
        label: 'Wakes it',
        detail: 'Your reply arrives as a new turn once the session is idle. Send now steers it into the running turn.',
        src: 'IB:233; WAKE',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'When the agent leaves plan mode the plan opens in Plannotator and DeepSeek Harness waits for your decision.',
        src: 'apps/dsh-plugin/README.md (How it works, Plan review)',
      },
      review: {
        level: 'yes',
        label: 'Yes',
        detail: '`/plannotator-review` opens your changes or a pull request without holding the session.',
        src: 'apps/dsh-plugin/README.md (Review, annotate, last)',
      },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up the last reply.',
        src: 'apps/dsh-plugin/README.md (Review, annotate, last)',
      },
      ask: { ...noAsk, src: 'docs/agent-guides/code-review.md:712; AIF:17-21' },
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin to a profile. Or add `@plannotator/dsh` from the Plugins page in DeepSeek Harness Web or Desktop.', code: 'dsh plugin --profile <profile> add @plannotator/dsh' },
      { text: 'Run `plannotator inbox` once. It turns the Inbox tool on for DeepSeek Harness. Then restart it.', code: 'plannotator inbox' },
    ],
    windows: { text: 'Not verified on Windows.', src: 'apps/dsh-plugin/README.md (only a default binary path for Windows)' },
    limits: [
      { text: 'Needs DeepSeek Harness 0.2.1-rc.2 or newer and below 0.3.0.', src: 'apps/dsh-plugin/README.md (Requirements)' },
      { text: 'The headless and sdk and acp profiles get no Inbox tool and no commands.', src: 'IB:233' },
      { text: 'There is no reminder about the Inbox at the start of a session yet.', src: 'IB:233' },
      { text: 'By default DeepSeek Harness sends its session to DeepSeek, and that includes the Inbox messages the agent reads.', src: 'IB:239' },
    ],
  },
  {
    slug: 'cline',
    name: 'Cline',
    tier: 'plugin',
    lede: 'Plannotator’s Cline plugin connects every Cline session to the Inbox. It doesn’t add plan review or code review.',
    inbox: {
      tool: {
        level: 'part',
        label: 'Built in, off at first',
        detail: 'The plugin gives Cline a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because Cline sends every tool with each request.',
        src: 'apps/cline-plugin/README.md (Turn it on)',
      },
      reply: {
        level: 'yes',
        label: 'Wakes it',
        detail: 'Your reply waits until the session is idle and then starts a turn. It never goes into a running turn.',
        src: 'apps/cline-plugin/README.md (Good to know); WAKE',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/cline-plugin/index.ts (Inbox only)'),
      review: { level: 'no', label: 'No', detail: 'The plugin has no review command.', src: 'apps/cline-plugin/index.ts' },
      annotate: { level: 'no', label: 'No', detail: 'The plugin has no annotate command.', src: 'apps/cline-plugin/index.ts' },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin.', code: 'cline plugin install npm:@plannotator/cline' },
      { text: 'Turn on Cline under Settings → Agents in the Inbox. It applies to Cline sessions started after that.' },
    ],
    windows: { text: 'Not verified on Windows.', src: 'docs/agent-guides/inbox-notifications-and-agents.md:252 (tests run on macOS and Linux)' },
    limits: [
      { text: 'Works in the Cline CLI and Kanban and the desktop app and the new VS Code extension. The Legacy VS Code extension loads no plugins: add the Inbox as an MCP server there.', src: 'apps/cline-plugin/README.md (Install)' },
      { text: 'Cline stops a plugin after 30 idle minutes. A reply sent meanwhile arrives after you next type in that session.', src: 'apps/cline-plugin/README.md (Good to know)' },
    ],
  },
  {
    slug: 'codex',
    name: 'Codex',
    tier: 'shim',
    lede: 'Codex reaches the Inbox as an MCP server and a hook reviews its plans. On a recent Codex your replies arrive as a new turn and you can start Codex from the Inbox.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Codex for you. The Codex app and IDE extension share it.', 'IB:77; AG (codex)'),
      reply: {
        level: 'part',
        label: 'Wakes Codex 0.149+',
        detail: 'With Codex 0.149 or newer your reply arrives in the thread that asked as its next turn, never in the middle of one. An older Codex sees it when it reads the thread.',
        src: 'IB:325; WAKE; packages/server/inbox-codex-wake.ts',
      },
      start: {
        level: 'yes',
        label: 'Yes',
        detail: 'Pick New Codex session in a new message. Codex 0.149 or newer and signed in.',
        src: 'LCH:188-190 (CODEX_LAUNCH_MIN_VERSION 0.149.0)',
      },
      permissions: {
        level: 'part',
        label: 'Sessions it started',
        detail: 'In a session the Inbox started, Codex’s approvals for commands and file changes come to the Inbox as cards.',
        src: 'LCH:194 (inbox-launch-codex-permission.ts)',
      },
    },
    plannotator: {
      plan: {
        level: 'part',
        label: 'At the end of a turn',
        detail: 'Codex has no plan mode exit to catch, so a Stop hook opens the plan once the turn ends. Send feedback and Codex revises the plan in the same turn.',
        src: 'apps/codex/README.md:5,65,72; docs/agent-guides/opencode-t3-and-codex.md:253',
      },
      review: {
        level: 'yes',
        label: 'Yes',
        detail: '`$plannotator-review` (or `!plannotator review`) opens your changes or a pull request.',
        src: 'apps/codex/README.md:88-94',
      },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`!plannotator annotate` marks up a file. `!plannotator last` marks up Codex’s last reply.',
        src: 'apps/codex/README.md:98-110',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator. The installer adds the skills and the plan review hook.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Connect the Inbox. `plannotator inbox` does this for you, or run:', code: 'codex mcp add plannotator-inbox -- plannotator inbox mcp' },
      { text: 'Restart Codex.' },
    ],
    windows: {
      text: 'The Inbox works on Windows. Plan review doesn’t, because Codex hooks are off on Windows. Starting Codex from the Inbox is macOS and Linux for now.',
      src: 'scripts/install.ps1:1235,1315-1322; INST:431; LCH:244',
    },
    limits: [
      { text: 'A one-shot `codex exec` run is never woken. Your reply stays in the Inbox for a later run.', src: 'IB:325' },
      { text: 'Codex hooks are experimental.', src: 'INST:429-430' },
      { text: 'In a session the Inbox started, a question Codex asks on its own is answered Cancel for now. Questions it sends to the Inbox work.', src: 'LCH:195' },
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/codex',
  },
  {
    slug: 'qwen-code',
    name: 'Qwen Code',
    tier: 'shim',
    lede: 'A Qwen Code extension opens plans in Plannotator and the agent reaches the Inbox as an MCP server. On macOS and Linux your replies arrive as a new turn.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to Qwen’s `settings.json` and keeps your comments in it.', 'IB:79,88; AG (qwen)'),
      reply: {
        level: 'part',
        label: 'Wakes it on macOS and Linux',
        detail: 'With Qwen Code 0.24 or newer in a terminal on macOS or Linux your reply arrives as its next turn. Plannotator registers itself as a trusted sender in Qwen Code to do that.',
        src: 'IB:327-332; WAKE; packages/server/inbox-qwen-wake.ts',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'part',
        label: 'Yes, approve twice',
        detail: 'When the agent leaves plan mode the plan opens in Plannotator. After you approve Qwen Code asks you to confirm in the terminal too.',
        src: 'apps/qwen-code/README.md (Plan review in Qwen Code)',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/qwen-code/README.md:8' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file. `/plannotator-last` marks up the last reply.',
        src: 'apps/qwen-code/README.md:8',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator. It installs the extension and connects the Inbox when it finds Qwen Code 0.13 or newer.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Run `plannotator inbox` once if the Inbox isn’t connected yet.', code: 'plannotator inbox' },
    ],
    windows: {
      text: 'Plan review and the commands work on Windows. Replies don’t wake Qwen Code there.',
      src: 'apps/qwen-code/README.md (Install); IB:332; packages/core/inbox-types.ts:2602-2606',
    },
    limits: [
      { text: 'Notes you add when you approve a plan can’t reach the agent, so plan review doesn’t offer them.', src: 'apps/qwen-code/README.md (Plan review in Qwen Code)' },
      { text: 'A `qwen -p` run and a session an editor or `qwen serve` drives aren’t woken.', src: 'IB:329-331' },
    ],
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    tier: 'shim',
    lede: 'A hook opens Gemini CLI’s plans in Plannotator and the agent reaches the Inbox as an MCP server.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Gemini CLI for you (Gemini CLI 0.1.19 or newer).', 'IB:78; AG (gemini)'),
      reply: nextCheck('WAKE (gemini not in it); packages/inbox/components/AgentsSettings.tsx:287'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'Use `/plan`. When the agent leaves plan mode the plan opens in Plannotator and Gemini waits for your decision. Gemini CLI 0.36 or newer.',
        src: 'apps/gemini/README.md:25-38,83',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/gemini/README.md:44' },
      annotate: {
        level: 'part',
        label: 'Files',
        detail: '`/plannotator-annotate` marks up a file. There is no command for the last reply.',
        src: 'apps/gemini/commands/ (review, annotate, inbox only)',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator. It adds the hook and the commands to Gemini CLI.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Run `plannotator inbox` once to connect the Inbox.', code: 'plannotator inbox' },
    ],
    windows: { text: 'Works on Windows.', src: 'scripts/install.ps1:2445-2473' },
    limits: [
      { text: 'If you already had `~/.gemini/settings.json` the installer may leave the hook out. The Gemini guide has the lines to add.', src: 'apps/gemini/README.md:50' },
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/gemini-cli',
  },
  {
    slug: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    tier: 'shim',
    lede: 'Plannotator’s Copilot CLI plugin opens plans in Plannotator and adds the review commands. You connect the Inbox yourself.',
    inbox: {
      tool: mcpByHand('Copilot CLI'),
      reply: nextCheck('WAKE (copilot not in it)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'Enter plan mode with Shift+Tab. When the agent leaves plan mode the plan opens in Plannotator and Copilot waits for your decision.',
        src: 'apps/copilot/README.md:28-41; apps/copilot/hooks.json',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/copilot/README.md:47' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file. `/plannotator-last` marks up the last reply.',
        src: 'apps/copilot/README.md:48-49',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'In Copilot CLI add the plugin.', code: '/plugin marketplace add backnotprop/plannotator' },
      { text: '', code: '/plugin install plannotator-copilot@plannotator' },
      { text: 'Restart Copilot CLI.' },
    ],
    windows: { text: 'Works on Windows.', src: 'apps/copilot/hooks.json (powershell entry); apps/copilot/README.md:17-19' },
    limits: [
      { text: '`/plannotator-last` reads Copilot’s session log, whose format can change between versions.', src: 'apps/copilot/README.md:64' },
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/copilot-cli',
  },
  {
    slug: 'amp',
    name: 'Amp',
    tier: 'shim',
    lede: 'Plannotator’s Amp plugin adds review and annotate to the command palette and the agent reaches the Inbox as an MCP server.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Amp for you.', 'IB:80; AG (amp)'),
      reply: nextCheck('WAKE (amp not in it); packages/inbox/components/AgentsSettings.tsx:287'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/amp-plugin/README.md:11-12'),
      review: { level: 'yes', label: 'Yes', detail: 'Plannotator: Review changes and Review changes or PR in the command palette.', src: 'apps/amp-plugin/README.md:5-6' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: 'Plannotator: Annotate file and Annotate last answer in the command palette.',
        src: 'apps/amp-plugin/README.md:7-8; INST:520',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin.', code: 'mkdir -p ~/.config/amp/plugins\ncurl -fsSL https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/amp-plugin/plannotator.ts \\\n  -o ~/.config/amp/plugins/plannotator.ts' },
      { text: 'Restart Amp or run `plugins: reload` from the command palette. Then run `plannotator inbox` once to connect the Inbox.', code: 'plannotator inbox' },
    ],
    windows: { text: 'Not verified on Windows.', src: 'INST:495-505 (bash steps only)' },
    limits: [
      { text: 'An older plannotator shows an “invalid structured output” notice. Update Plannotator.', src: 'apps/amp-plugin/README.md:40-56' },
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/amp',
  },
  {
    slug: 'droid',
    name: 'Factory Droid',
    tier: 'shim',
    lede: 'Plannotator’s Droid plugin adds the review and annotate commands. You connect the Inbox yourself.',
    inbox: {
      tool: mcpByHand('Droid'),
      reply: nextCheck('WAKE (droid not in it)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/droid-plugin/README.md:10; INST:524'),
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/droid-plugin/README.md:5' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up the last reply.',
        src: 'apps/droid-plugin/README.md:6-7',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the plugin.', code: 'droid plugin marketplace add https://github.com/backnotprop/plannotator' },
      { text: '', code: 'droid plugin install plannotator@plannotator' },
      { text: 'Open a new Droid session. `/plannotator-inbox` opens the Inbox.' },
    ],
    windows: { text: 'Not verified on Windows.', src: 'apps/droid-plugin/README.md (no Windows notes)' },
    limits: [],
    docs: 'https://docs.plannotator.ai/open-source/agents/droid',
  },
  {
    slug: 'kiro-cli',
    name: 'Kiro CLI',
    tier: 'shim',
    lede: 'Plannotator adds review and annotate skills to Kiro CLI and the agent reaches the Inbox as an MCP server.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to `~/.kiro/settings/mcp.json` for you.', 'IB:81; AG (kiro)'),
      reply: nextCheck('WAKE (kiro not in it); packages/inbox/components/AgentsSettings.tsx:287'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/marketing/src/content/docs/guides/kiro-cli.md:9-10 (no background hooks)'),
      review: { level: 'yes', label: 'Yes', detail: 'The `plannotator-review` skill opens your changes or a pull request.', src: 'apps/marketing/src/content/docs/guides/kiro-cli.md:45' },
      annotate: {
        level: 'part',
        label: 'Files',
        detail: 'The `plannotator-annotate` skill marks up a file. There is no skill for the last reply.',
        src: 'apps/kiro-cli/skills/ (review, annotate)',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator. It adds the skills and a plannotator agent for Kiro.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Start Kiro with that agent.', code: 'kiro-cli chat --agent plannotator' },
      { text: 'Run `plannotator inbox` once to connect the Inbox.', code: 'plannotator inbox' },
    ],
    windows: { text: 'Works on Windows.', src: 'INST:333-353' },
    limits: [
      { text: 'Kiro has no hooks Plannotator can use, so you call the skills yourself.', src: 'apps/marketing/src/content/docs/guides/kiro-cli.md:9-10' },
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/kiro-cli',
  },
  {
    slug: 'mistral-vibe',
    name: 'Mistral Vibe',
    tier: 'shim',
    lede: 'A hook opens Vibe’s plans in Plannotator and skills add review and annotate. You connect the Inbox yourself.',
    inbox: {
      tool: mcpByHand('Vibe'),
      reply: nextCheck('WAKE (vibe not in it)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'When the agent leaves plan mode the plan opens in Plannotator and Vibe waits for your decision. Vibe 2.25 or newer.',
        src: 'apps/vibe/hooks/hooks.toml:10-26',
      },
      review: { level: 'yes', label: 'Yes', detail: 'The `plannotator-review` skill opens your changes or a pull request.', src: 'scripts/install.sh:2862' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: 'Skills mark up a file or the last reply.',
        src: 'scripts/install.sh:2863-2864',
      },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator. It finds Vibe and adds the hook and the skills.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
    ],
    windows: {
      text: 'On Windows the installer adds no hook and prints the steps to do it by hand. The last-reply skill doesn’t work there.',
      src: 'scripts/install.ps1:1250-1262',
    },
    limits: [
      { text: 'Edits you make inside Plannotator’s block in `hooks.toml` are replaced each time the installer runs.', src: 'apps/vibe/hooks/hooks.toml:2-4' },
    ],
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    tier: 'mcp',
    lede: 'Cursor reaches the Inbox as an MCP server. It can send you messages and questions and reads your answers when it next checks.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to `~/.cursor/mcp.json` for you.', 'IB:81; AG (cursor)'),
      reply: nextCheck('WAKE (cursor not in it); IB:132 (Not woken)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('AG and apps/ have no Cursor plan hook'),
      review: { level: 'no', label: 'No', detail: 'There is no review command for Cursor. You can run `plannotator review` in a terminal.', src: 'apps/ has no Cursor integration' },
      annotate: { level: 'no', label: 'No', detail: 'There is no annotate command for Cursor. You can run `plannotator annotate` in a terminal.', src: 'apps/ has no Cursor integration' },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Run `plannotator inbox`. It connects Cursor when it finds it. Or add this yourself:', file: '~/.cursor/mcp.json', code: '{ "mcpServers": { "plannotator-inbox": { "command": "plannotator", "args": ["inbox", "mcp"] } } }' },
      { text: 'Copy the Inbox note into Cursor’s Customize → Rules. The Inbox shows it in Settings → Agents.' },
    ],
    windows: { text: 'The Inbox MCP server runs on Windows.', src: 'INST:24-42 (Windows installers); IB:310-312' },
    limits: [
      { text: 'Cursor has no global rules file, so Plannotator can’t add its Inbox note for you or keep it up to date.', src: 'IB:108-110' },
    ],
    shot: { name: 'first-run', alt: 'The first run screen with the three Plannotator connections and a picker for any other agent' },
  },
  {
    slug: 'other-mcp-agents',
    name: 'Any MCP agent',
    tier: 'mcp',
    lede: 'VS Code and Windsurf and Zed and Goose and JetBrains and the Claude app reach the Inbox as an MCP server. So does any other agent that speaks MCP.',
    inbox: {
      tool: mcpTool('Add `plannotator inbox mcp` as a stdio MCP server named `plannotator-inbox`. The Inbox’s first screen and Settings give the exact step for each app.', 'IB:310-323; AG (windsurf, claude-app)'),
      reply: nextCheck('IB:340'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('no integration in apps/ for these hosts'),
      review: { level: 'no', label: 'No', detail: 'There is no review command. You can run `plannotator review` in a terminal.', src: 'no integration in apps/' },
      annotate: { level: 'no', label: 'No', detail: 'There is no annotate command. You can run `plannotator annotate` in a terminal.', src: 'no integration in apps/' },
      ask: noAsk,
    },
    install: [
      { text: 'Install Plannotator.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash' },
      { text: 'Add the Inbox to your agent as a stdio MCP server named `plannotator-inbox`.', code: 'plannotator inbox mcp' },
      { text: '`plannotator inbox` connects Windsurf and the Claude app when it finds them. It never changes editors: VS Code and Zed and JetBrains and Goose get a one-click link or a snippet in the Inbox’s Settings.' },
    ],
    windows: { text: 'The Inbox MCP server runs on Windows.', src: 'INST:24-42; IB:310-312' },
    limits: [
      { text: 'Apps started from the Dock may not see your shell’s PATH. Use the full path to plannotator, which the Inbox fills in for you.', src: 'IB:323' },
    ],
  },
];

export const agentHref = (slug: string) => `/inbox/agents/${slug}/`;
export const agentsOfTier = (tier: Tier) => AGENTS.filter((a) => a.tier === tier);
export const tierOf = (id: Tier) => TIERS.find((t) => t.id === id)!;
