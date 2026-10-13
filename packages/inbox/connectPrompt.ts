/**
 * The connect prompt: what the sidebar's "Copy connect prompt" puts on the
 * clipboard (owner approval, 2026-10-13; design record
 * `inbox-sidebar-connect-prompt`, not in this repo). The person pastes it into
 * any agent on this computer; the agent reads the Inbox's guide
 * (`plannotator inbox --help`), connects itself and sends a first message that
 * offers to send real recent work.
 *
 * The one place the text lives. It names this computer's absolute
 * `plannotator`, read from `GET /api/inbox/settings` `mcp_command` (the
 * server's `selfCommand()` plus `inbox mcp`), so it works when pasted into an
 * agent on this computer, whatever that agent's PATH. Before the settings
 * load it names bare `plannotator` and says where the binary usually is.
 */

import { shellLine } from './harnesses';

/** The idempotency key prefix the first message uses; the agent appends its host. */
export const CONNECT_IDEMPOTENCY_PREFIX = 'plannotator-inbox-connect-v1-';

/**
 * This computer's `plannotator` as a shell line: `mcp_command` without its
 * trailing `inbox mcp`. Null when the settings have not loaded, or the
 * command does not have that shape.
 */
export function connectCommand(mcpCommand: readonly string[] | null | undefined): string | null {
  if (!Array.isArray(mcpCommand) || mcpCommand.length < 3) return null;
  if (mcpCommand[mcpCommand.length - 2] !== 'inbox' || mcpCommand[mcpCommand.length - 1] !== 'mcp') return null;
  const self = mcpCommand.slice(0, -2);
  if (self.some((word) => typeof word !== 'string' || word === '')) return null;
  return shellLine(self);
}

/** The prompt, composed for this computer (`mcpCommand` from the settings, or null before they load). */
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

4. Tell me the message is there. Then wait for my answer: call wait_for_reply, or, if your host wakes you with Inbox replies, end your turn.
5. If I answer Yes, send one or two short, real messages from what we are working on in this project: an open decision as a question block, and a plan or document you wrote, attached. Never invent work, and never send secrets or .env files. Then resolve the first thread.

Never run uninstall, delete files or stop processes. If a sandbox or a missing permission blocks a command, give me the exact command to run myself.`;
}
