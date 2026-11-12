import { shellLine } from './harnesses';

export const CONNECT_IDEMPOTENCY_PREFIX = 'plannotator-inbox-connect-v1-';

export function connectCommand(mcpCommand: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(mcpCommand) || mcpCommand.length < 3) return null;
  if (mcpCommand[mcpCommand.length - 2] !== 'inbox' || mcpCommand[mcpCommand.length - 1] !== 'mcp') return null;
  const self = mcpCommand.slice(0, -2);
  if (self.some((word) => typeof word !== 'string' || word === '')) return null;
  return shellLine(self);
}

export function connectPrompt(mcpCommand: readonly string[] | null | undefined): string {
  const known = connectCommand(mcpCommand);
  const p = known ?? 'plannotator';
  const where = known
    ? `The Inbox runs on this computer. Run Plannotator as: ${p}`
    : 'The Inbox runs on this computer. Run Plannotator as `plannotator`; if that is not found, use ~/.local/bin/plannotator (Windows: %LOCALAPPDATA%\\plannotator\\plannotator.exe).';
  return `Connect yourself to my Plannotator Inbox, then send me a first message there.

${where}

1. Read the Inbox's guide for agents: \`${p} inbox --help\`. Where it and this prompt differ, follow the guide.
2. Connect yourself for your next sessions, as its "Connecting yourself" section says for the agent you are. If a \`plannotator-inbox\` server that runs this command is already set up for you, change nothing. Tell me if I need to restart you.
3. Send me a first message now; do not wait for a restart. Use your \`plannotator_inbox\` tool if you have one, otherwise the stdio server \`${p} inbox mcp\` (then also pass your \`agent_name\` and \`agent_host\`). Call send_message with \`idempotency_key\` "${CONNECT_IDEMPOTENCY_PREFIX}<your host>", a subject such as "<your name> is connected to your Inbox", and a short body: one sentence on what you can leave me here now (questions, files to annotate, reviews of your work), then this question block:

   :::question
   Want me to send some of our recent work here so you can see how it works?

   - [ ] Yes, send something from what we are working on
   - [ ] No, the connection is enough for now

   Recommended: Yes, send something from what we are working on
   :::

4. Tell me the message is there and end your turn. If your host wakes you with Inbox replies, my answer arrives by itself; otherwise call read_thread when I tell you I answered.
5. If I answer Yes, send one or two short, real messages from what we are working on in this project: an open decision as a question block, and a plan or document you wrote, attached. Never invent work, and never send secrets or .env files. Then resolve the first thread.

Never run uninstall, delete files or stop processes. If a sandbox or a missing permission blocks a command, give me the exact command to run myself.`;
}
