// The agents pages (/inbox/agents/ and /inbox/agents/<slug>/) read this one
// list: the overview's tiers and table and every agent's setup page, so a fact
// can't say one thing on one page and another on the next.
//
// Every cell and every troubleshooting row names where its fact comes from
// (`src`, repo paths, as of the commit that changed this file). Setup steps
// quote commands and output from the same places. Short forms used below:
//   IB   apps/marketing/src/content/docs/reference/inbox.md (the Inbox reference)
//   INST apps/marketing/src/content/docs/getting-started/installation.md
//   AIF  apps/marketing/src/content/docs/guides/ai-features.md ("Ask this session")
//   LCH  docs/agent-guides/inbox-launch.md (starting agents from the Inbox)
//   WAKE packages/core/inbox-types.ts INBOX_WAKING_HOSTS (who a reply wakes)
//   AG   packages/server/inbox-agents.ts AGENT_SPECS (who `plannotator inbox` connects)
//   HAR  packages/inbox/harnesses.ts (the Inbox's own per-agent MCP steps)
//   SET  packages/inbox/components/AgentsSettings.tsx (Settings → Agents words)
//   SH   scripts/install.sh (what the installer prints)
//   HELP apps/hook/server/inbox-help.ts (`plannotator inbox --help`)
// When one of those changes, change the entry here; the pages follow.

export type Tier = 'plugin' | 'hooks' | 'mcp';

/** yes: works. part: works with a condition the label names. no: doesn't. */
export type Level = 'yes' | 'part' | 'no';

export interface Cell {
  level: Level;
  /** A few words: the agent page's list, and screen readers in the table. */
  label: string;
  /** The table's text for a `part` cell, when the label is too long for it. */
  short?: string;
  /** One or two sentences behind the label. Not shown on the pages. */
  detail: string;
  /** Where the fact comes from (not shown). */
  src: string;
}

export interface Step {
  /** What to do, one sentence. */
  do: string;
  /** A command or a config line to copy. */
  code?: string;
  /** A file name shown above `code`. */
  file?: string;
  /** What you should see after it. */
  see?: string;
}

export interface Trouble {
  symptom: string;
  fix: string;
  code?: string;
  src: string;
}

export interface Agent {
  slug: string;
  name: string;
  tier: Tier;
  /** One sentence under the name on the setup page. */
  lede: string;
  inbox: { tool: Cell; reply: Cell; start: Cell; permissions: Cell };
  plannotator: { plan: Cell; review: Cell; annotate: Cell; ask: Cell };
  /** The recommended setup, in order. */
  setup: Step[];
  /** Other ways to set it up: by hand, another platform, another install. */
  other: { title: string; steps: Step[] }[];
  /** One thing to do to see that it works. */
  check: { do: string; code?: string; see: string };
  trouble: Trouble[];
  /** What doesn't work yet, besides the cells marked no. */
  limits: { text: string; src: string }[];
  /** A few short things to try once it works. */
  examples: string[];
  /** An Inbox screen from inbox-assets/ (InboxShot's name). */
  shot?: { name: string; alt: string };
  /** The full setup guide on docs.plannotator.ai, where one exists. */
  docs?: string;
}

export const TIERS: { id: Tier; name: string; short: string }[] = [
  { id: 'plugin', name: 'Native plug-in', short: 'Inbox built in and your reply wakes it' },
  { id: 'hooks', name: 'Hooks and MCP', short: 'Plannotator’s hooks and commands plus the Inbox through MCP' },
  { id: 'mcp', name: 'MCP only', short: 'Inbox through MCP and it reads your reply when it checks' },
];

export const COLUMNS = {
  inbox: [
    { key: 'tool', name: 'Inbox tool', means: 'How the agent reaches the Inbox.' },
    { key: 'reply', name: 'Reply wakes it', means: 'Your answer in the Inbox arrives in the session as its next turn.' },
    { key: 'start', name: 'Start from Inbox', means: 'Start a new session of the agent from New message.' },
    { key: 'permissions', name: 'Permission cards', means: "Allow or deny the agent's permission prompts in the Inbox." },
  ],
  plannotator: [
    { key: 'plan', name: 'Plan review', means: 'The agent’s plan opens in Plannotator when it leaves plan mode.' },
    { key: 'review', name: 'Code review', means: 'Review the agent’s changes or a pull request and send it your comments.' },
    { key: 'annotate', name: 'Annotate', means: 'Mark up a file or a page or the agent’s last reply.' },
    { key: 'ask', name: 'Ask this session', means: 'Ask a question in a review and the session that opened it answers.' },
  ],
} as const;

export type ColumnKey = (typeof COLUMNS)['inbox'][number]['key'] | (typeof COLUMNS)['plannotator'][number]['key'];

export const cellOf = (agent: Agent, key: ColumnKey): Cell =>
  key in agent.inbox ? agent.inbox[key as keyof Agent['inbox']] : agent.plannotator[key as keyof Agent['plannotator']];

// ── Pieces many agents share ──

const INSTALL = 'curl -fsSL https://plannotator.ai/install.sh | bash';
const INSTALL_WIN = 'irm https://plannotator.ai/install.ps1 | iex';
/** The /inbox page's test request ([inbox].astro). */
const TEST = 'Send me a test question in the Plannotator Inbox, and read my answer when I tell you I sent it.';
const MCP_JSON = '{ "mcpServers": { "plannotator-inbox": { "command": "plannotator", "args": ["inbox", "mcp"] } } }';

const openInbox = (see: string): Step => ({ do: 'Open the Inbox. It connects the agents it finds on this computer.', code: 'plannotator inbox', see });
const onWindows = { title: 'On Windows', steps: [{ do: 'Install Plannotator from PowerShell. The other steps are the same.', code: INSTALL_WIN }] };

const wakeCheck = (name: string, delivered = name) => ({
  do: `Paste this into ${name}.`,
  code: TEST,
  see: `A question arrives in the Inbox. Answer it and press Send. The thread reads \`Delivered to ${delivered}\` and ${name} goes on with your answer.`,
});
const readCheck = (name: string) => ({
  do: `Paste this into ${name}.`,
  code: TEST,
  see: `A question arrives in the Inbox. Answer it and press Send. Tell ${name} you sent it and it reads your answer.`,
});

const inboxLog: Trouble = {
  symptom: 'The Inbox doesn’t open',
  fix: 'Read `~/.plannotator/inbox/inbox.log`. Stop a stuck Inbox process and run `plannotator inbox` again.',
  src: 'IB:466-468',
};
const toolEnv: Trouble = {
  symptom: 'The switches in Settings → Agents are greyed out',
  fix: '`PLANNOTATOR_INBOX_TOOL` is set in your shell. It decides for every agent until you unset it.',
  src: 'IB:427',
};
const noBinary: Trouble = {
  symptom: 'The tool says to install Plannotator',
  fix: 'It found no `plannotator` binary. Install Plannotator or set `PLANNOTATOR_BIN` to its path.',
  src: 'IB:429-431',
};
const notConnected = (name: string): Trouble => ({
  symptom: `\`plannotator inbox\` says it couldn’t connect ${name}`,
  fix: 'It prints why and tries again the next time you run it. To connect it now follow Connect the Inbox yourself under Other ways.',
  src: 'packages/server/inbox-agents.ts formatConnectReport (Couldn’t connect / needs connecting by hand)',
});
const neverWoken = (name: string): Trouble => ({
  symptom: 'Your reply never shows up in the session on its own',
  fix: `Nothing can wake ${name}: it sees a reply when it reads the thread. Tell it to check the Inbox.`,
  src: 'IB:438; SET:282-287 (seen when it checks the Inbox; it can’t be woken)',
});
const dockPath: Trouble = {
  symptom: 'The `plannotator-inbox` server fails to start',
  fix: 'An app started from the Dock may not see your shell’s `PATH`. Put the full path to `plannotator` in the config. `which plannotator` prints it.',
  src: 'IB:323',
};

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
const notWoken = (src: string): Cell => ({
  level: 'no',
  label: 'Not woken',
  detail: 'Nothing wakes it. It sees your reply the next time it reads the thread, and the Inbox marks the reply unread until then.',
  src,
});
const offAtFirst = (detail: string, src: string): Cell => ({ level: 'part', label: 'Built in, off at first', short: 'Turn on', detail, src });
const mcpTool = (detail: string, src: string): Cell => ({ level: 'yes', label: 'MCP', detail, src });
const mcpByHand = (name: string): Cell => ({
  level: 'part',
  label: 'MCP by hand',
  short: 'By hand',
  detail: `Add \`plannotator inbox mcp\` to ${name} as an MCP server named \`plannotator-inbox\`. The Inbox doesn’t connect ${name} for you.`,
  src: 'IB:310-312 (any MCP client); AG has no entry for this agent; HELP has no line for it',
});
const launchedOnly = (detail: string, src: string): Cell => ({ level: 'part', label: 'Sessions it started', short: 'Inbox-started', detail, src });
const noPlan = (src: string): Cell => ({ level: 'no', label: 'No', detail: 'Plannotator doesn’t open its plans yet.', src });
const filesOnly = (detail: string, src: string): Cell => ({ level: 'part', label: 'Files', detail, src });
const byHandMcp = (name: string) => ({
  do: `Add the Inbox to ${name} as a stdio MCP server named \`plannotator-inbox\` that runs this command. Plannotator has no step for ${name} yet: use its own MCP settings.`,
  code: 'plannotator inbox mcp',
});

export const AGENTS: Agent[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    tier: 'plugin',
    lede: 'The plugin gives Claude Code the Inbox tool and plan review. Your reply arrives as its next turn.',
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
      permissions: launchedOnly(
        'In a session the Inbox started, Claude’s permission prompts come to the Inbox as cards you allow or deny.',
        'LCH:81-83 (inbox permission-hook on PermissionRequest, launched sessions only)',
      ),
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'When Claude leaves plan mode the plan opens in Plannotator. Claude keeps the session free while you review and gets your decision as a message.',
        src: 'apps/hook/README.md:81-94',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request. Your comments come back to Claude.', src: 'README.md:147; apps/hook/README.md:83' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up Claude’s last reply.',
        src: 'README.md:135-139',
      },
      ask: { level: 'yes', label: 'Yes', detail: 'Ask a question in any review and the Claude session that opened it answers there.', src: 'AIF:17-19' },
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL, see: 'The installer ends with `CLAUDE CODE USERS: YOU\'RE ALL SET!`' },
      {
        do: 'Add the plugin.',
        code: 'claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator',
        see: '`claude plugin list` shows `plannotator@plannotator`.',
      },
      {
        do: 'Quit Claude Code and start it again. `claude --continue` brings back the conversation you were in.',
        code: 'claude --continue',
        see: 'Claude has a `plannotator_inbox` tool. It needs Claude Code 2.1.287 or newer.',
      },
      openInbox('The Inbox opens in your browser. Settings → Agents shows Claude Code as `Connected` through `Plannotator’s plugin`.'),
    ],
    other: [
      onWindows,
      {
        title: 'Inside Claude Code',
        steps: [{ do: 'Add the plugin from Claude Code’s prompt. Then restart it.', code: '/plugin marketplace add backnotprop/plannotator\n/plugin install plannotator@plannotator' }],
      },
      {
        title: 'For claude -p and SDK runs',
        steps: [{ do: 'The plugin adds no tool there. Connect the Inbox as an MCP server instead. Replies don’t wake those runs.', code: 'claude mcp add --scope user plannotator-inbox -- plannotator inbox mcp' }],
      },
      {
        title: 'Plan review without the plugin',
        steps: [
          {
            do: 'Add the hook to your settings yourself.',
            file: '~/.claude/settings.json',
            code: '{ "hooks": { "PermissionRequest": [{ "matcher": "ExitPlanMode", "hooks": [{ "type": "command", "command": "plannotator", "timeout": 345600 }] }] } }',
          },
        ],
      },
    ],
    check: wakeCheck('Claude Code'),
    trouble: [
      {
        symptom: 'Claude has no `plannotator_inbox` tool',
        fix: 'Check that `claude plugin list` shows `plannotator@plannotator` and restart Claude Code. The tool needs Claude Code 2.1.287 or newer in an interactive session.',
        code: 'claude plugin list',
        src: 'HELP:381; IB:203',
      },
      {
        symptom: 'Settings → Agents says the Claude Code mod is off',
        fix: 'Unset `PLANNOTATOR_CLAUDE_MOD=0` or remove `"claudeCodeMod": false` from `~/.plannotator/config.json`. Then restart Claude Code.',
        src: 'packages/server/inbox-agents.ts:2022; apps/marketing/src/content/docs/guides/claude-code.md:31-39',
      },
      {
        symptom: 'Settings → Agents says `plugin needs an update`',
        fix: 'Update the plugin and restart Claude Code.',
        code: 'claude plugin marketplace update plannotator\nclaude plugin update plannotator@plannotator',
        src: 'SET:39-41; INST:141',
      },
      {
        symptom: 'No Send now on a reply or the sidebar says Reload Claude Code',
        fix: 'That session runs an older plugin. Type `/reload-plugins` in it. If it is still listed, type `/exit` and start it again with the command the Inbox gives you.',
        code: 'cd <folder> && claude --resume <session id>',
        src: 'IB:436; IB:462',
      },
      {
        symptom: 'Your reply says Queued',
        fix: 'Claude is working and gets the reply when its turn ends. Press Send now to put it into the running turn.',
        src: 'IB:123; IB:435',
      },
      {
        symptom: 'On Windows the tool never appears',
        fix: 'The plugin needs Git Bash or a PowerShell 5.1 that may run `-EncodedCommand`. Constrained Language Mode or a security product can block it. `PLANNOTATOR_MOD_SHELL=sh` or `powershell` picks one.',
        src: 'docs/agent-guides/claude-code-mod.md:50-62',
      },
      {
        symptom: 'The installer says `DUPLICATE HOOK DETECTED`',
        fix: 'Remove the plannotator hook from `~/.claude/settings.json`. The plugin has its own and plan review would open twice.',
        src: 'SH:3627-3634',
      },
      inboxLog,
    ],
    limits: [
      { text: 'In `claude -p` and SDK runs the plugin adds no Inbox tool and nothing wakes the session.', src: 'IB:205' },
      { text: 'Starting Claude Code from the Inbox is off on Windows by default.', src: 'LCH:5' },
      { text: 'Claude’s own `AskUserQuestion` stays in Claude Code. Questions reach the Inbox when Claude sends them there.', src: 'LCH:81' },
    ],
    examples: [
      'Leave plan mode and the plan opens in Plannotator while Claude keeps working.',
      '`/plannotator-review` opens your changes. Your comments go back to Claude.',
      'Pick New Claude Code session in the Inbox to start one from there.',
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
    lede: 'The extension gives Pi the Inbox tool and plan review. Your reply arrives once Pi is idle.',
    inbox: {
      tool: offAtFirst(
        'The extension gives Pi a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because Pi sends every tool with each request (about 2,750 tokens for this one).',
        'IB:207-215',
      ),
      reply: { level: 'yes', label: 'Wakes it', detail: 'Your reply arrives as a follow-up once Pi is idle. Send now steers it into the run.', src: 'IB:213; WAKE' },
      start: {
        level: 'yes',
        label: 'Yes',
        detail: 'Pick New Pi session in a new message. Pi 0.79.1 or newer with the extension. The Inbox runs that session, so it pauses when the Inbox stops and your next reply continues it.',
        src: 'LCH:157-174',
      },
      permissions: { level: 'no', label: 'No', detail: 'Pi has no permission prompts of its own.', src: 'LCH:175' },
    },
    plannotator: {
      plan: {
        level: 'yes',
        label: 'Yes',
        detail: 'Start in plan mode (`--plan` or `/plannotator-plan-mode`) and Pi sends its plan to Plannotator. Your decision arrives later as a message.',
        src: 'docs/agent-guides/plan-review.md:65-75; apps/pi-extension/README.md:130-148',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/pi-extension/README.md:265,410' },
      annotate: {
        level: 'yes',
        label: 'Files and last reply',
        detail: 'Mark up a file or a folder or a URL, or Pi’s last reply.',
        src: 'apps/pi-extension/README.md:412; apps/pi-extension/index.ts:1195',
      },
      ask: { level: 'yes', label: 'Yes', detail: 'Ask a question in a review and the Pi session answers there.', src: 'AIF:20; apps/pi-extension/README.md:268' },
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL, see: 'The installer’s `PI USERS` part prints the extension command.' },
      { do: 'Add the extension. It needs Pi 0.79.1 or newer.', code: 'pi install npm:@plannotator/pi-extension' },
      openInbox('The Inbox opens in your browser. Settings → Agents lists Pi through `Plannotator’s extension`.'),
      { do: 'Turn the tool on for Pi in Settings → Agents. Then type `/reload` in Pi.', code: '/reload', see: 'Pi has a `plannotator_inbox` tool.' },
    ],
    other: [
      onWindows,
      { title: 'Turn the tool on without the Inbox', steps: [{ do: 'Merge this into your Plannotator config. Then `/reload` in Pi.', file: '~/.plannotator/config.json', code: '{ "inboxTool": { "pi": true } }' }] },
      { title: 'Oh My Pi', steps: [{ do: 'Install the extension as an OMP plugin. Then restart OMP.', code: 'omp plugin install @plannotator/pi-extension' }] },
      { title: 'Through MCP', steps: [{ do: 'Pi 0.99 or newer. Replies don’t wake Pi this way.', code: 'pi mcp add plannotator-inbox -- plannotator inbox mcp' }] },
    ],
    check: wakeCheck('Pi'),
    trouble: [
      {
        symptom: 'Pi has no `plannotator_inbox` tool',
        fix: 'The tool is off until you turn it on. Run `plannotator inbox` once and turn it on in Settings → Agents. Then `/reload` in Pi (`/restart` in Oh My Pi).',
        src: 'IB:424-425',
      },
      {
        symptom: 'Settings → Agents says Pi needs a reload',
        fix: 'Update the extension and reload Pi.',
        code: 'pi update --extensions',
        src: 'SET:75; IB:462',
      },
      noBinary,
      {
        symptom: 'No tool in print or JSON mode',
        fix: 'That is expected. Nothing could bring a reply back there, so the tool stays inactive.',
        src: 'IB:215',
      },
      toolEnv,
      inboxLog,
    ],
    limits: [
      { text: 'Ask this session doesn’t work in remote mode.', src: 'apps/pi-extension/README.md:268' },
      { text: 'Starting Pi from the Inbox is macOS and Linux for now.', src: 'LCH:244' },
    ],
    examples: [
      'Start Pi with `--plan` and review its plan in Plannotator.',
      'Pick New Pi session in the Inbox to start one from there.',
    ],
    shot: { name: '4.1', alt: 'A guided review arriving in a thread from Pi' },
    docs: 'https://docs.plannotator.ai/open-source/agents/pi',
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    tier: 'plugin',
    lede: 'The plugin gives OpenCode the Inbox tool and plan review. On OpenCode 2 your reply arrives as its next turn.',
    inbox: {
      tool: offAtFirst(
        'The plugin gives OpenCode a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because OpenCode sends every tool with each request.',
        'IB:217-223',
      ),
      reply: {
        level: 'part',
        label: 'Wakes OpenCode 2',
        short: 'OpenCode 2',
        detail: 'On OpenCode 2 your reply arrives as a new turn once the session is idle. OpenCode 1 has the tool but sees your reply only when it reads the thread.',
        src: 'IB:223; WAKE',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: { level: 'yes', label: 'Yes', detail: 'The plan agent sends its plan with the `submit_plan` tool and waits for your decision.', src: 'apps/opencode-plugin/README.md:50,79,198; INST:321' },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/opencode-plugin/README.md:47,69' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: 'Mark up a file or a folder or a URL, or the last reply.', src: 'apps/opencode-plugin/README.md:182-184' },
      ask: {
        level: 'part',
        label: 'OpenCode 2',
        detail: 'On OpenCode 2 the session answers questions in code review and annotation. In plan review it gives a quick answer from what it already knows.',
        src: 'AIF:21; apps/opencode-plugin/README.md:50',
      },
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL, see: 'The installer ends with `Then restart OpenCode (OpenCode 2: run opencode2 reload).`' },
      { do: 'Add the plugin to `opencode.json`. This is OpenCode 2.', file: 'opencode.json', code: '{ "plugins": [{ "package": "@plannotator/opencode@latest" }] }' },
      openInbox('The Inbox opens in your browser. Settings → Agents lists OpenCode through `Plannotator’s plugin`.'),
      { do: 'Turn the tool on for OpenCode in Settings → Agents. Then reload OpenCode.', code: 'opencode2 reload', see: '`opencode2 plugin list` shows `plannotator` and OpenCode has a `plannotator_inbox` tool.' },
    ],
    other: [
      onWindows,
      { title: 'OpenCode 1', steps: [{ do: 'OpenCode 1 reads `plugin`. Restart OpenCode after. It gets the tool but replies don’t wake it.', file: 'opencode.json', code: '{ "plugin": ["@plannotator/opencode@latest"] }' }] },
      { title: 'Turn the tool on without the Inbox', steps: [{ do: 'Merge this into your Plannotator config. Then reload OpenCode.', file: '~/.plannotator/config.json', code: '{ "inboxTool": { "opencode": true } }' }] },
    ],
    check: wakeCheck('OpenCode'),
    trouble: [
      {
        symptom: 'OpenCode has no `plannotator_inbox` tool',
        fix: 'Turn the tool on in Settings → Agents. Then run `opencode2 reload` on OpenCode 2 or restart OpenCode 1.',
        src: 'IB:424-425',
      },
      {
        symptom: 'OpenCode says `Plugin is not configured`',
        fix: 'Update the plugin.',
        code: 'opencode2 models && opencode2 plugin update @plannotator/opencode@latest',
        src: 'apps/opencode-plugin/README.md:43',
      },
      {
        symptom: 'An update didn’t load',
        fix: 'Point the plugin at `@latest` rather than an exact version. Then `opencode2 reload` or `opencode2 service restart`.',
        src: 'apps/opencode-plugin/README.md:41-45',
      },
      { ...neverWoken('OpenCode 1'), symptom: 'On OpenCode 1 your reply never shows up on its own' },
      noBinary,
      inboxLog,
    ],
    limits: [
      { text: 'Cancelling a turn doesn’t close a review that is open.', src: 'apps/opencode-plugin/README.md:51' },
      { text: 'The Windows installers don’t update the OpenCode 2 service for you.', src: 'docs/agent-guides/opencode-t3-and-codex.md:136' },
    ],
    examples: [
      'Ask the plan agent for a plan and review it in Plannotator.',
      'Answer a question with picture choices in the Inbox.',
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
    lede: 'The plugin gives DeepSeek Harness the Inbox tool and plan review. Your reply arrives once it is idle.',
    inbox: {
      tool: offAtFirst(
        'The plugin gives the agent a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because DeepSeek Harness sends every tool with each request.',
        'IB:227-233; apps/dsh-plugin/README.md',
      ),
      reply: { level: 'yes', label: 'Wakes it', detail: 'Your reply arrives as a new turn once the session is idle. Send now steers it into the running turn.', src: 'IB:233; WAKE' },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: { level: 'yes', label: 'Yes', detail: 'When the agent leaves plan mode the plan opens in Plannotator and DeepSeek Harness waits for your decision.', src: 'apps/dsh-plugin/README.md (How it works, Plan review)' },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request without holding the session.', src: 'apps/dsh-plugin/README.md (Review, annotate, last)' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up the last reply.', src: 'apps/dsh-plugin/README.md (Review, annotate, last)' },
      ask: { ...noAsk, src: 'docs/agent-guides/code-review.md:712; AIF:17-21' },
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      { do: 'Add the plugin to the profile you use.', code: 'dsh plugin --profile <profile> add @plannotator/dsh' },
      openInbox('The Inbox opens in your browser. Settings → Agents lists DeepSeek Harness.'),
      { do: 'Turn the tool on for DeepSeek Harness in Settings → Agents. Then restart DeepSeek Harness.', see: 'The agent has a `plannotator_inbox` tool.' },
    ],
    other: [
      { title: 'DeepSeek Harness Desktop', steps: [{ do: 'Open and quit Desktop once. Then add the plugin to its profile.', code: 'dsh plugin --profile desktop add @plannotator/dsh' }] },
      { title: 'From the Plugins page', steps: [{ do: 'Add `@plannotator/dsh` from the Plugins page in DeepSeek Harness Web or Desktop.' }] },
      { title: 'Turn the tool on without the Inbox', steps: [{ do: 'Merge this into your Plannotator config. Then restart DeepSeek Harness.', file: '~/.plannotator/config.json', code: '{ "inboxTool": { "dsh": true } }' }] },
    ],
    check: wakeCheck('DeepSeek Harness'),
    trouble: [
      {
        symptom: 'The agent has no `plannotator_inbox` tool',
        fix: 'Turn the tool on in Settings → Agents and restart DeepSeek Harness. The tool appears only once the Inbox has run on this computer.',
        src: 'HELP:383',
      },
      {
        symptom: 'No tool in a headless or sdk or acp profile',
        fix: 'Those profiles get no tool and no wake. Use an interactive profile.',
        src: 'IB:235',
      },
      {
        symptom: 'You connected it as an MCP server',
        fix: 'Use the plugin instead. Over MCP the Inbox can’t tell DeepSeek Harness sessions apart and can’t wake them.',
        src: 'HELP:383; HAR (dsh)',
      },
      inboxLog,
    ],
    limits: [
      { text: 'Needs DeepSeek Harness 0.2.1-rc.2 or newer and below 0.3.0.', src: 'apps/dsh-plugin/README.md (Requirements)' },
      { text: 'There is no reminder about the Inbox at the start of a session yet.', src: 'IB:233' },
      { text: 'By default DeepSeek Harness sends its session to DeepSeek, and that includes the Inbox messages the agent reads.', src: 'IB:239' },
      { text: 'Not verified on Windows.', src: 'apps/dsh-plugin/README.md (only a default binary path for Windows)' },
    ],
    examples: ['Leave plan mode and the plan opens in Plannotator.'],
  },
  {
    slug: 'cline',
    name: 'Cline',
    tier: 'plugin',
    lede: 'The plugin gives every Cline session the Inbox tool. Your reply arrives once the session is idle.',
    inbox: {
      tool: offAtFirst(
        'The plugin gives Cline a `plannotator_inbox` tool. It is off until you turn it on in the Inbox’s Settings, because Cline sends every tool with each request.',
        'apps/cline-plugin/README.md (Turn it on)',
      ),
      reply: { level: 'yes', label: 'Wakes it', detail: 'Your reply waits until the session is idle and then starts a turn. It never goes into a running turn.', src: 'apps/cline-plugin/README.md (Good to know); WAKE' },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/cline-plugin/index.ts (Inbox only)'),
      review: { level: 'no', label: 'No', detail: 'The plugin has no review command.', src: 'apps/cline-plugin/index.ts' },
      annotate: { level: 'no', label: 'No', detail: 'The plugin has no annotate command.', src: 'apps/cline-plugin/index.ts' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      { do: 'Add the plugin.', code: 'cline plugin install npm:@plannotator/cline' },
      openInbox('The Inbox opens in your browser. Settings → Agents lists Cline.'),
      { do: 'Turn the tool on for Cline in Settings → Agents. Start a new Cline session.', see: 'The new session has a `plannotator_inbox` tool.' },
    ],
    other: [
      {
        title: 'Legacy VS Code extension',
        steps: [{ do: 'It loads no plugins. In MCP Servers → Configure → Configure MCP Servers paste this. Replies don’t wake it this way.', code: MCP_JSON }],
      },
      { title: 'Turn the tool on without the Inbox', steps: [{ do: 'Merge this into your Plannotator config. It applies to new sessions.', file: '~/.plannotator/config.json', code: '{ "inboxTool": { "cline": true } }' }] },
    ],
    check: wakeCheck('Cline'),
    trouble: [
      {
        symptom: 'Cline has no `plannotator_inbox` tool',
        fix: 'Turn it on in Settings → Agents and start a new session. A running session keeps the tools it started with.',
        src: 'HELP:384',
      },
      {
        symptom: 'A reply arrives only after you type',
        fix: 'Cline stops a plugin after 30 idle minutes. Type anything in that session and the reply comes in.',
        src: 'apps/cline-plugin/README.md (Good to know)',
      },
      { symptom: 'No Send now', fix: 'Cline takes a reply only when it is idle, so there is no Send now.', src: 'HELP:411' },
      inboxLog,
    ],
    limits: [
      { text: 'Works in the Cline CLI and Kanban and the desktop app and the new VS Code extension.', src: 'apps/cline-plugin/README.md (Install)' },
      { text: 'Not verified on Windows.', src: 'docs/agent-guides/inbox-notifications-and-agents.md:252 (tests run on macOS and Linux)' },
    ],
    examples: ['Ask Cline to send you a question with options and pick one in the Inbox.'],
  },
  {
    slug: 'codex',
    name: 'Codex',
    tier: 'hooks',
    lede: 'Codex reaches the Inbox through MCP and a hook reviews its plans. On Codex 0.149 or newer your reply arrives as its next turn.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Codex for you. The Codex app and IDE extension share it.', 'IB:77; AG (codex)'),
      reply: {
        level: 'part',
        label: 'Wakes Codex 0.149+',
        short: '0.149+',
        detail: 'With Codex 0.149 or newer your reply arrives in the thread that asked as its next turn, never in the middle of one. An older Codex sees it when it reads the thread.',
        src: 'IB:325; WAKE; packages/server/inbox-codex-wake.ts',
      },
      start: { level: 'yes', label: 'Yes', detail: 'Pick New Codex session in a new message. Codex 0.149 or newer and signed in.', src: 'LCH:188-190 (CODEX_LAUNCH_MIN_VERSION 0.149.0)' },
      permissions: launchedOnly(
        'In a session the Inbox started, Codex’s approvals for commands and file changes come to the Inbox as cards.',
        'LCH:194 (inbox-launch-codex-permission.ts)',
      ),
    },
    plannotator: {
      plan: {
        level: 'part',
        label: 'At the end of a turn',
        short: 'End of turn',
        detail: 'Codex has no plan mode exit to catch, so a Stop hook opens the plan once the turn ends. Send feedback and Codex revises the plan in the same turn.',
        src: 'apps/codex/README.md:5,65,72; docs/agent-guides/opencode-t3-and-codex.md:253',
      },
      review: { level: 'yes', label: 'Yes', detail: '`$plannotator-review` (or `!plannotator review`) opens your changes or a pull request.', src: 'apps/codex/README.md:88-94' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: '`!plannotator annotate` marks up a file. `!plannotator last` marks up Codex’s last reply.', src: 'apps/codex/README.md:98-110' },
      ask: noAsk,
    },
    setup: [
      {
        do: 'Install Plannotator. It turns on Codex hooks and adds the plan review hook.',
        code: INSTALL,
        see: '`Restart Codex Desktop or CLI after installing.` and `Plan review is configured through the Codex Stop hook.`',
      },
      openInbox('The terminal says `Connected Codex … to the Inbox`. Settings → Agents lists Codex through `MCP server`.'),
      { do: 'Restart Codex. Your reply wakes it from Codex 0.149 on.', code: 'codex --version' },
    ],
    other: [
      { title: 'Connect the Inbox yourself', steps: [{ do: 'This also adds it to the Codex app and the IDE extension. Restart them after.', code: 'codex mcp add plannotator-inbox -- plannotator inbox mcp' }] },
      { title: 'In the Codex app', steps: [{ do: 'Settings → MCP servers → Add server → STDIO with the command `plannotator inbox mcp`. Then restart.' }] },
      {
        title: 'Plan review hook by hand',
        steps: [
          { do: 'Turn hooks on.', file: '~/.codex/config.toml', code: '[features]\nhooks = true' },
          { do: 'Add the Stop hook. Use the full path to `plannotator` for Codex Desktop.', file: '~/.codex/hooks.json', code: '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "plannotator", "timeout": 345600 }] }] } }' },
        ],
      },
      onWindows,
    ],
    check: {
      do: 'Paste this into Codex.',
      code: TEST,
      see: 'A question arrives in the Inbox. Answer it and press Send. The thread reads `Queued for Codex; it gets this as its next turn.` and Codex picks it up when its turn ends.',
    },
    trouble: [
      {
        symptom: 'Your reply isn’t delivered',
        fix: 'It needs Codex 0.149 or newer and a `codex` the Inbox can find on its `PATH` or in the ChatGPT app. An older Codex reads the reply when it checks the thread.',
        src: 'IB:439; IB:325',
      },
      {
        symptom: '`plannotator inbox` says Codex before 0.35 has no `codex mcp add`',
        fix: 'Update Codex or add `plannotator-inbox` to its `config.toml` by hand.',
        src: 'packages/server/inbox-agents.ts:986',
      },
      {
        symptom: 'Plan review never opens in the Codex app',
        fix: 'The app may not see your shell’s `PATH`. Put the full path to `plannotator` in `hooks.json` and restart Codex.',
        src: 'apps/codex/README.md:63',
      },
      {
        symptom: 'The installer says the Codex hooks file couldn’t be merged',
        fix: 'Follow Plan review hook by hand under Other ways.',
        src: 'SH:1711-1720',
      },
      { symptom: 'A `codex exec` run never got your reply', fix: 'One-shot runs end before a reply. It stays in the Inbox for a later run to read.', src: 'IB:325' },
      { symptom: 'No Send now', fix: 'Codex takes a reply only as its next turn, so there is no Send now.', src: 'IB:325' },
      { symptom: 'Starting Codex from the Inbox says to sign in', fix: 'Run `codex login` in a terminal.', code: 'codex login', src: 'packages/core/inbox-launch-ready.ts:45; SET:380' },
      inboxLog,
    ],
    limits: [
      { text: 'Plan review doesn’t work on Windows, because Codex hooks are off there.', src: 'scripts/install.ps1:1314-1322; INST:431' },
      { text: 'Starting Codex from the Inbox is macOS and Linux for now.', src: 'LCH:244' },
      { text: 'In a session the Inbox started, a question Codex asks on its own is answered Cancel for now. Questions it sends to the Inbox work.', src: 'LCH:195' },
    ],
    examples: [
      'Ask Codex for a plan. It opens in Plannotator when the turn ends.',
      '`$plannotator-review` opens your changes for review.',
      'Pick New Codex session in the Inbox to start one from there.',
    ],
    docs: 'https://docs.plannotator.ai/open-source/agents/codex',
  },
  {
    slug: 't3-code',
    name: 'T3 Code',
    tier: 'hooks',
    lede: 'Claude threads in T3 Code reach the Inbox through MCP. Your reply arrives in the thread as a new turn.',
    inbox: {
      tool: {
        level: 'part',
        label: 'MCP after sign-in',
        short: 'Sign in',
        detail: 'Sign Plannotator in to T3 once. Then `plannotator inbox mcp --t3` gives Claude threads in T3 the Inbox.',
        src: 'INST:368-379',
      },
      reply: {
        level: 'part',
        label: 'Wakes Claude threads',
        short: 'Claude threads',
        detail: 'In a T3 thread that runs Claude your reply arrives as a new turn. Other agents in T3 see it when they read the thread.',
        src: 'INST:379; WAKE (t3); packages/server/inbox-t3-wake.ts',
      },
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: {
        level: 'part',
        label: 'Not verified in T3',
        short: 'Not verified',
        detail: 'The T3 hook doesn’t route plan review. The Claude plugin’s own plan hook is left as it is, and whether it opens from a T3 thread isn’t verified.',
        src: 'packages/t3-code/README.md:70 (no ExitPlanMode routing; existing plan hooks keep working)',
      },
      review: {
        level: 'part',
        label: 'With the T3 hook',
        short: 'Opt-in hook',
        detail: 'Install with `--with-t3` and `/plannotator-review` in a T3 thread sends your comments back to that thread.',
        src: 'packages/t3-code/README.md:9-15; SH:132',
      },
      annotate: {
        level: 'part',
        label: 'With the T3 hook',
        short: 'Opt-in hook',
        detail: 'With the `--with-t3` hook, annotate and last route back to the T3 thread.',
        src: 'packages/t3-code/README.md:3; packages/t3-code/hook-routing.ts',
      },
      ask: {
        level: 'part',
        label: 'With the T3 hook',
        short: 'Opt-in hook',
        detail: 'With the `--with-t3` hook, Ask this session sends your question into the T3 thread and shows its answer in the review.',
        src: 'packages/t3-code/README.md:3',
      },
    },
    setup: [
      { do: 'Install Plannotator with the T3 hook. macOS and Linux.', code: 'curl -fsSL https://plannotator.ai/install.sh | bash -s -- --with-t3' },
      { do: 'In T3 open Settings → Environments. Open the environment’s menu and choose Copy MCP URL.' },
      {
        do: 'Sign Plannotator in to T3 with that URL. On T3’s sign-in page choose Supervised or higher.',
        code: 'plannotator t3 login --url <T3 MCP URL>',
        see: 'The terminal prints `Authorize Plannotator in T3:` and T3’s sign-in page opens.',
      },
      {
        do: 'Connect the Inbox for Claude. Skip this if `claude mcp get plannotator-inbox` already finds one.',
        code: 'claude mcp add -s user plannotator-inbox -- plannotator inbox mcp --t3',
        see: 'Inside a T3 thread Claude has the Inbox tools. Outside T3 that server shows none.',
      },
      { do: 'Start a new Claude thread in T3 so it loads the hook and the server.' },
    ],
    other: [
      { title: 'Without the review hook', steps: [{ do: 'Skip `--with-t3` and run the sign-in and connect steps. Replies still wake Claude threads.', code: INSTALL }] },
      { title: 'All the details', steps: [{ do: 'The T3 help lists every step and option.', code: 'plannotator t3 --help' }] },
    ],
    check: wakeCheck('the T3 thread', 'T3 Code'),
    trouble: [
      {
        symptom: 'The log says `No T3 grant reaches thread`',
        fix: 'The sign-in expired or was revoked. It lasts 30 days. Sign in again.',
        code: 'plannotator t3 login --url <T3 MCP URL>',
        src: 'packages/t3-code/auth.ts; packages/t3-code/README.md',
      },
      { symptom: 'T3 answers `capability_denied`', fix: 'Sign in again and choose Supervised or higher. Read only can’t send replies.', src: 'INST:377; packages/t3-code/README.md' },
      { symptom: '`plannotator t3 login` says `--url is required`', fix: 'Copy the URL from T3 Settings → Environments → Copy MCP URL.', src: 'packages/t3-code/cli.ts:42' },
      { symptom: 'No Inbox tools outside T3', fix: 'That is how `--t3` works: the server lists its tools only inside a T3 thread.', src: 'INST:377; apps/hook/server/cli.ts:590-591' },
      {
        symptom: 'A review doesn’t go back to the thread',
        fix: 'Read `t3-code/hook.log` in your Plannotator data folder. A hook added before T3 reported itself as `t3-code` never runs: install with `--with-t3` again. Then start a new thread.',
        src: 'packages/t3-code/README.md:13,31-33',
      },
      {
        symptom: 'Sign-in works but nothing arrives',
        fix: 'Use the same `PLANNOTATOR_DATA_DIR` for the sign-in and the Inbox and the hook.',
        src: 'packages/t3-code/README.md (data directory)',
      },
      { symptom: 'A Codex or OpenCode or Pi thread in T3 isn’t woken', fix: 'Only Claude threads wake. The others see your reply when they read the thread.', src: 'INST:379' },
    ],
    limits: [
      { text: 'Only Claude threads wake, and only threads with a UUID id.', src: 'packages/server/inbox-t3-wake.ts' },
      { text: 'The review hook doesn’t route compound commands or subagents or a folder below the project.', src: 'packages/t3-code/hook-routing.ts' },
      { text: 'The review hook adds about 320 ms to each Bash call in any Agent SDK session.', src: 'packages/t3-code/README.md:13' },
      { text: 'No Send now. No row in Settings → Agents yet. Not on Windows yet.', src: 'packages/inbox/components/AgentsSettings.tsx (no t3 row); scripts/install.ps1 (no T3 flag)' },
      { text: 'Tested on T3 Nightly 0.0.46.', src: 'packages/t3-code/README.md' },
    ],
    examples: ['Run `/plannotator-review` in a T3 thread and send your comments back to it.'],
  },
  {
    slug: 'qwen-code',
    name: 'Qwen Code',
    tier: 'hooks',
    lede: 'An extension opens Qwen Code’s plans in Plannotator and it reaches the Inbox through MCP. On macOS and Linux your reply arrives as its next turn.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to Qwen’s `settings.json` and keeps your comments in it.', 'IB:79,88; AG (qwen)'),
      reply: {
        level: 'part',
        label: 'Wakes it on macOS and Linux',
        short: 'macOS and Linux',
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
        short: 'Approve twice',
        detail: 'When the agent leaves plan mode the plan opens in Plannotator. After you approve Qwen Code asks you to confirm in the terminal too.',
        src: 'apps/qwen-code/README.md (Plan review in Qwen Code)',
      },
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/qwen-code/README.md:8' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: '`/plannotator-annotate` marks up a file. `/plannotator-last` marks up the last reply.', src: 'apps/qwen-code/README.md:8' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator. It adds the extension and the skills when it finds Qwen Code 0.13 or newer.', code: INSTALL, see: '`Plan review: when the agent calls exit_plan_mode, the plan opens in your browser.`' },
      openInbox('The terminal says `Plannotator can now send your replies straight into any running Qwen Code session`.'),
      { do: 'Restart Qwen Code.' },
    ],
    other: [
      { title: 'Connect the Inbox yourself', steps: [{ do: 'Merge this into `mcpServers` in Qwen Code’s settings. Don’t use `qwen mcp add`.', file: '~/.qwen/settings.json', code: MCP_JSON }] },
      onWindows,
    ],
    check: wakeCheck('Qwen Code'),
    trouble: [
      { symptom: 'The installer says Qwen Code is older than 0.13.0', fix: 'Update Qwen Code and run the installer again.', src: 'SH:3515-3517' },
      { symptom: 'The installer says the extension is turned off', fix: 'Turn it on.', code: 'qwen extensions enable plannotator', src: 'SH:3524' },
      { symptom: 'You approved the plan but Qwen is still waiting', fix: 'Qwen Code asks you to confirm once more in the terminal. That is expected.', src: 'INST:367' },
      {
        symptom: 'Your reply never shows up on its own',
        fix: 'It needs Qwen Code 0.24 or newer in a terminal on macOS or Linux. `qwen -p` and sessions an editor or `qwen serve` drives aren’t woken.',
        src: 'IB:327-332',
      },
      inboxLog,
    ],
    limits: [
      { text: 'Notes you add when you approve a plan can’t reach the agent, so plan review doesn’t offer them.', src: 'apps/qwen-code/README.md (Plan review in Qwen Code)' },
      { text: 'Replies don’t wake Qwen Code on Windows.', src: 'IB:332' },
    ],
    examples: ['Leave plan mode and the plan opens in Plannotator.'],
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    tier: 'hooks',
    lede: 'A hook opens Gemini CLI’s plans in Plannotator and it reaches the Inbox through MCP.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Gemini CLI for you (Gemini CLI 0.1.19 or newer).', 'IB:78; AG (gemini)'),
      reply: notWoken('WAKE (gemini not in it); SET:287'),
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
      annotate: filesOnly('`/plannotator-annotate` marks up a file. There is no command for the last reply.', 'apps/gemini/commands/ (review, annotate, inbox only)'),
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator. It adds the hook and the commands.', code: INSTALL, see: '`Added plannotator hook to` your Gemini settings.' },
      openInbox('The terminal says `Connected Gemini CLI … to the Inbox`.'),
      { do: 'Start a new Gemini CLI session. Plan review needs Gemini CLI 0.36 or newer.' },
    ],
    other: [
      { title: 'Connect the Inbox yourself', steps: [{ do: 'This adds it in every project.', code: 'gemini mcp add -s user plannotator-inbox plannotator inbox mcp' }] },
      onWindows,
    ],
    check: readCheck('Gemini CLI'),
    trouble: [
      {
        symptom: 'The installer says to add the hook to `~/.gemini/settings.json`',
        fix: 'It couldn’t merge your settings. Add the lines it printed. The Gemini guide has them too.',
        src: 'SH:3218-3265; apps/gemini/README.md:50',
      },
      { symptom: '`plannotator inbox` says Gemini CLI has no `gemini mcp add`', fix: 'Update Gemini CLI to 0.1.19 or newer.', src: 'packages/server/inbox-agents.ts:992' },
      neverWoken('Gemini CLI'),
      inboxLog,
    ],
    limits: [],
    examples: ['Use `/plan` and review the plan in Plannotator.'],
    docs: 'https://docs.plannotator.ai/open-source/agents/gemini-cli',
  },
  {
    slug: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    tier: 'hooks',
    lede: 'The plugin opens Copilot CLI’s plans in Plannotator. You connect the Inbox by hand.',
    inbox: {
      tool: mcpByHand('Copilot CLI'),
      reply: notWoken('WAKE (copilot not in it)'),
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
      annotate: { level: 'yes', label: 'Files and last reply', detail: '`/plannotator-annotate` marks up a file. `/plannotator-last` marks up the last reply.', src: 'apps/copilot/README.md:48-49' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      { do: 'In Copilot CLI add the plugin. Then restart Copilot CLI.', code: '/plugin marketplace add backnotprop/plannotator\n/plugin install plannotator-copilot@plannotator' },
      byHandMcp('Copilot CLI'),
    ],
    other: [onWindows],
    check: readCheck('Copilot CLI'),
    trouble: [
      { symptom: 'Plan review doesn’t open', fix: 'Restart Copilot CLI after you add the plugin. Plan mode is Shift+Tab.', src: 'apps/copilot/README.md:24-41' },
      { symptom: '`/plannotator-last` fails', fix: 'It reads Copilot’s session log, whose format can change between versions. Update Plannotator.', src: 'apps/copilot/README.md:64' },
      dockPath,
      neverWoken('Copilot CLI'),
    ],
    limits: [],
    examples: ['Press Shift+Tab for plan mode and review the plan in Plannotator.'],
    docs: 'https://docs.plannotator.ai/open-source/agents/copilot-cli',
  },
  {
    slug: 'amp',
    name: 'Amp',
    tier: 'hooks',
    lede: 'The plugin adds review and annotate to Amp’s command palette and it reaches the Inbox through MCP.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds the `plannotator-inbox` MCP server to Amp for you.', 'IB:80; AG (amp)'),
      reply: notWoken('WAKE (amp not in it); SET:287'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/amp-plugin/README.md:11-12'),
      review: { level: 'yes', label: 'Yes', detail: 'Plannotator: Review changes and Review changes or PR in the command palette.', src: 'apps/amp-plugin/README.md:5-6' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: 'Plannotator: Annotate file and Annotate last answer in the command palette.', src: 'apps/amp-plugin/README.md:7-8; INST:520' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      {
        do: 'Add the plugin.',
        code: 'mkdir -p ~/.config/amp/plugins\ncurl -fsSL https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/amp-plugin/plannotator.ts \\\n  -o ~/.config/amp/plugins/plannotator.ts',
      },
      { do: 'Restart Amp or run `plugins: reload` from the command palette.', see: 'The palette lists Plannotator: Review changes.' },
      openInbox('The terminal says `Connected Amp … to the Inbox`.'),
    ],
    other: [{ title: 'Connect the Inbox yourself', steps: [{ do: 'Run it in a terminal.', code: 'amp mcp add plannotator-inbox -- plannotator inbox mcp' }] }],
    check: readCheck('Amp'),
    trouble: [
      { symptom: 'Amp shows an `invalid structured output` notice', fix: 'Your plannotator is older than the plugin. Update Plannotator.', code: INSTALL, src: 'apps/amp-plugin/README.md:40-56' },
      notConnected('Amp'),
      neverWoken('Amp'),
    ],
    limits: [{ text: 'Not verified on Windows.', src: 'INST:495-505 (bash steps only)' }],
    examples: ['Run Plannotator: Annotate last answer from the command palette.'],
    docs: 'https://docs.plannotator.ai/open-source/agents/amp',
  },
  {
    slug: 'droid',
    name: 'Factory Droid',
    tier: 'hooks',
    lede: 'The plugin adds review and annotate commands to Droid. You connect the Inbox by hand.',
    inbox: {
      tool: mcpByHand('Droid'),
      reply: notWoken('WAKE (droid not in it)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/droid-plugin/README.md:10; INST:524'),
      review: { level: 'yes', label: 'Yes', detail: '`/plannotator-review` opens your changes or a pull request.', src: 'apps/droid-plugin/README.md:5' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: '`/plannotator-annotate` marks up a file or a folder or a URL. `/plannotator-last` marks up the last reply.', src: 'apps/droid-plugin/README.md:6-7' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      { do: 'Add the plugin. Then open a new Droid session.', code: 'droid plugin marketplace add https://github.com/backnotprop/plannotator\ndroid plugin install plannotator@plannotator', see: '`/plannotator-inbox` opens the Inbox.' },
      byHandMcp('Droid'),
    ],
    other: [],
    check: readCheck('Droid'),
    trouble: [
      { symptom: 'The commands are missing', fix: 'Open a new Droid session. A running one keeps the commands it started with.', src: 'INST:535-539' },
      dockPath,
      neverWoken('Droid'),
    ],
    limits: [{ text: 'Not verified on Windows.', src: 'apps/droid-plugin/README.md (no Windows notes)' }],
    examples: ['`/plannotator-last` opens Droid’s last reply for you to mark up.'],
    docs: 'https://docs.plannotator.ai/open-source/agents/droid',
  },
  {
    slug: 'kiro-cli',
    name: 'Kiro CLI',
    tier: 'hooks',
    lede: 'Plannotator adds review and annotate skills to Kiro CLI and it reaches the Inbox through MCP.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to `~/.kiro/settings/mcp.json` for you.', 'IB:81; AG (kiro)'),
      reply: notWoken('WAKE (kiro not in it); SET:287'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('apps/marketing/src/content/docs/guides/kiro-cli.md:9-10 (no background hooks)'),
      review: { level: 'yes', label: 'Yes', detail: 'The `plannotator-review` skill opens your changes or a pull request.', src: 'apps/marketing/src/content/docs/guides/kiro-cli.md:45' },
      annotate: filesOnly('The `plannotator-annotate` skill marks up a file. There is no skill for the last reply.', 'apps/kiro-cli/skills/ (review, annotate)'),
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator. It adds the skills and a plannotator agent for Kiro.', code: INSTALL, see: '`Launch it: kiro-cli chat --agent plannotator`' },
      openInbox('The terminal says `Connected Kiro … to the Inbox`.'),
      { do: 'Start Kiro with the plannotator agent.', code: 'kiro-cli chat --agent plannotator' },
    ],
    other: [{ title: 'Connect the Inbox yourself', steps: [{ do: 'Kiro picks it up without a restart.', file: '~/.kiro/settings/mcp.json', code: MCP_JSON }] }, onWindows],
    check: readCheck('Kiro'),
    trouble: [
      { symptom: 'Plans don’t open in Plannotator', fix: 'Kiro has no hooks Plannotator can use. Call the review and annotate skills yourself.', src: 'apps/marketing/src/content/docs/guides/kiro-cli.md:9-10' },
      notConnected('Kiro'),
      neverWoken('Kiro'),
    ],
    limits: [],
    examples: ['Ask the plannotator agent to review your changes.'],
    docs: 'https://docs.plannotator.ai/open-source/agents/kiro-cli',
  },
  {
    slug: 'mistral-vibe',
    name: 'Mistral Vibe',
    tier: 'hooks',
    lede: 'A hook opens Vibe’s plans in Plannotator and skills add review and annotate. You connect the Inbox by hand.',
    inbox: {
      tool: mcpByHand('Vibe'),
      reply: notWoken('WAKE (vibe not in it)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: { level: 'yes', label: 'Yes', detail: 'When the agent leaves plan mode the plan opens in Plannotator and Vibe waits for your decision. Vibe 2.25 or newer.', src: 'apps/vibe/hooks/hooks.toml:10-26' },
      review: { level: 'yes', label: 'Yes', detail: 'The `plannotator-review` skill opens your changes or a pull request.', src: 'SH:2862' },
      annotate: { level: 'yes', label: 'Files and last reply', detail: 'Skills mark up a file or the last reply.', src: 'SH:2863-2864' },
      ask: noAsk,
    },
    setup: [
      {
        do: 'Install Plannotator. It finds Vibe and adds the hook and the skills.',
        code: INSTALL,
        see: '`Plan review is configured through the Vibe pre_tool hook on exit_plan_mode`',
      },
      byHandMcp('Vibe'),
    ],
    other: [{ title: 'On Windows', steps: [{ do: 'The installer adds no hook there and prints the steps to add it by hand. The last-reply skill doesn’t work there yet.', code: INSTALL_WIN }] }],
    check: readCheck('Vibe'),
    trouble: [
      { symptom: 'The installer didn’t find Vibe', fix: 'Run Vibe once so it makes its home folder. Then run the installer again.', src: 'scripts/install.ps1:1250-1256; SH (Vibe detection)' },
      { symptom: 'Plan review doesn’t open', fix: 'It needs Vibe 2.25 or newer.', src: 'SH:3492' },
      { symptom: 'Your edits to `hooks.toml` are gone', fix: 'The installer replaces Plannotator’s block each time it runs. Keep your hooks outside it.', src: 'apps/vibe/hooks/hooks.toml:2-4' },
      neverWoken('Vibe'),
    ],
    limits: [],
    examples: ['Leave plan mode and the plan opens in Plannotator.'],
  },
  {
    slug: 'cursor',
    name: 'Cursor',
    tier: 'mcp',
    lede: 'Cursor reaches the Inbox through MCP. It sends you messages and questions and reads your answers when it checks.',
    inbox: {
      tool: mcpTool('`plannotator inbox` adds one `plannotator-inbox` key to `~/.cursor/mcp.json` for you.', 'IB:81; AG (cursor)'),
      reply: notWoken('WAKE (cursor not in it); IB:132 (Not woken)'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('AG and apps/ have no Cursor plan hook'),
      review: { level: 'no', label: 'No', detail: 'There is no review command for Cursor. You can run `plannotator review` in a terminal.', src: 'apps/ has no Cursor integration' },
      annotate: { level: 'no', label: 'No', detail: 'There is no annotate command for Cursor. You can run `plannotator annotate` in a terminal.', src: 'apps/ has no Cursor integration' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      openInbox('The terminal says `Connected Cursor … to the Inbox`. Settings → Agents lists Cursor through `MCP server`.'),
      {
        do: 'Copy the Inbox note into Cursor’s Customize → Rules. Settings → Agents has it under Show note. Or print it:',
        code: 'plannotator inbox --notes cursor',
        see: 'Cursor knows when to write to the Inbox.',
      },
    ],
    other: [
      { title: 'Add to Cursor', steps: [{ do: 'Settings → Agents in the Inbox has an Add to Cursor link. Cursor asks before it adds the server.' }] },
      { title: 'By hand', steps: [{ do: 'Add this to Cursor’s MCP config.', file: '~/.cursor/mcp.json', code: MCP_JSON }] },
      onWindows,
    ],
    check: readCheck('Cursor'),
    trouble: [
      { symptom: 'Settings → Agents says `Not found on this computer`', fix: 'The Inbox looks for `~/.cursor` or `cursor` or `cursor-agent` on your `PATH`. Open Cursor once or add the server by hand.', src: 'IB:81' },
      dockPath,
      neverWoken('Cursor'),
      { symptom: 'Cursor forgets to use the Inbox', fix: 'Cursor has no global rules file, so Plannotator can’t add its note for you. Paste it into Customize → Rules.', src: 'IB:108-110' },
    ],
    limits: [{ text: 'You can run `plannotator review` or `plannotator annotate` in a terminal next to Cursor.', src: 'apps/hook/server/cli.ts' }],
    examples: ['Ask Cursor to send you a question when it needs a decision. Answer it in the Inbox.'],
    shot: { name: 'first-run', alt: 'The first run screen with the three Plannotator connections and a picker for any other agent' },
  },
  {
    slug: 'other-mcp-agents',
    name: 'Any MCP agent',
    tier: 'mcp',
    lede: 'VS Code and Windsurf and Zed and Goose and JetBrains and the Claude app reach the Inbox through MCP. So does any agent that speaks MCP.',
    inbox: {
      tool: mcpTool('Add `plannotator inbox mcp` as a stdio MCP server named `plannotator-inbox`. The Inbox’s first screen and Settings give the exact step for each app.', 'IB:310-323; AG (windsurf, claude-app)'),
      reply: notWoken('IB:340'),
      start: noStart,
      permissions: noPermissions,
    },
    plannotator: {
      plan: noPlan('no integration in apps/ for these hosts'),
      review: { level: 'no', label: 'No', detail: 'There is no review command. You can run `plannotator review` in a terminal.', src: 'no integration in apps/' },
      annotate: { level: 'no', label: 'No', detail: 'There is no annotate command. You can run `plannotator annotate` in a terminal.', src: 'no integration in apps/' },
      ask: noAsk,
    },
    setup: [
      { do: 'Install Plannotator.', code: INSTALL },
      openInbox('Windsurf and the Claude app are connected if it finds them. Editors are never changed for you.'),
      { do: 'Add the Inbox to your agent as a stdio MCP server named `plannotator-inbox`. Settings → Agents has the exact step for your app.', code: 'plannotator inbox mcp' },
    ],
    other: [
      { title: 'VS Code', steps: [{ do: 'Use Install in VS Code in Settings → Agents, or run this.', code: 'code --add-mcp \'{"name":"plannotator-inbox","type":"stdio","command":"plannotator","args":["inbox","mcp"]}\'' }] },
      { title: 'Windsurf', steps: [{ do: 'Adds it in every project.', code: 'devin mcp add -s user plannotator-inbox -- plannotator inbox mcp' }] },
      { title: 'Zed', steps: [{ do: 'Merge it into Zed’s settings.', file: '~/.config/zed/settings.json', code: '{ "context_servers": { "plannotator-inbox": { "command": "plannotator", "args": ["inbox", "mcp"], "env": {} } } }' }] },
      { title: 'The Claude app', steps: [{ do: 'Merge it into `mcpServers` in Claude → Settings → Developer → Edit Config. Then quit and reopen Claude.', code: MCP_JSON }] },
      { title: 'JetBrains', steps: [{ do: 'Paste it in Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add.', code: MCP_JSON }] },
      { title: 'Goose', steps: [{ do: 'Use Add to Goose in Settings → Agents, or Extensions → Add custom extension → Standard IO with this command.', code: 'plannotator inbox mcp' }] },
    ],
    check: readCheck('your agent'),
    trouble: [
      dockPath,
      { symptom: 'claude.ai can’t reach the Inbox', fix: 'claude.ai connectors can’t reach this computer. Use the Claude app.', src: 'HAR:174' },
      { symptom: 'Your agent only takes an address', fix: 'Use `http://127.0.0.1:<port>/mcp`. Prefer the command: the port can change when the Inbox restarts.', src: 'HAR:290-293' },
      neverWoken('an MCP agent'),
    ],
    limits: [],
    examples: ['Ask your agent to send you a guided review of its change. Comment on it in the Inbox.'],
  },
];

export const agentHref = (slug: string) => `/inbox/agents/${slug}/`;
export const agentsOfTier = (tier: Tier) => AGENTS.filter((a) => a.tier === tier);
export const tierOf = (id: Tier) => TIERS.find((t) => t.id === id)!;
