/**
 * The Board's prompt (approval "inbox-board", intro amendment: the prompt in
 * `intro-mock/board-prompt.md`; columns v2: work an agent was asked to do and
 * has not started goes in To do, only a hand-over in In review). The first-visit dialog's Copy prompt and the
 * empty Board's "Copy prompt" copy it; the person pastes it into an agent,
 * which fills the Board with the work in flight it knows about.
 *
 * Every op and argument it names is the `card` action's as built
 * (packages/server/inbox-mcp-cards.ts); packages/server/inbox-board-prompt.test.ts checks that.
 */

import { connectCommand } from '../connectPrompt';

/** The prompt, naming this computer's `plannotator` (`mcpCommand` from the settings, or null before they load). */
export function boardPrompt(mcpCommand: readonly string[] | null | undefined): string {
  const p = connectCommand(mcpCommand) ?? 'plannotator';
  return `Fill my Plannotator Board with the work in flight that you know about.

The Board is a page in my Plannotator Inbox: one card per piece of work that outlasts a single reply, in the column of where it stands. Make cards with the \`card\` action of your \`plannotator_inbox\` tool. Without that tool, or when it has no card action (I turned the Board on after your session began), use the CLI: \`${p} card --help\`. If a call answers \`board_off\`, my Board is off: tell me to turn it on in the Inbox's Settings → Capabilities, and stop.

Columns (where the work stands now, never whose move it is):
- todo: work you were asked to do and have not started.
- in_progress: you are working on it (research, a plan, mocks, code, a draft PR).
- in_review: your part is done and handed to me on purpose (a PR ready to merge, screenshots, a sheet or options to pick from, a release go).
- backlog: an idea or follow-up nobody asked for yet. A card I put there is mine to move.
- A question you ask me mid-work leaves the card in in_progress. Always pass \`column\`.

1. List the cards first (op \`list\` with \`asked_by: "anyone"\`). Never make a second card for work that has one; update it with \`move\`, \`say\` or \`link\`.
2. Look at the work you know about: this session, this repository's open branches, worktrees and pull requests, and your own notes and plans. One card per real piece of work. Skip trivial things, and work that has shipped or stopped.
3. Give each card a \`title\` of 2–5 words naming the work ("Pi update fix"), never a sentence; where it stands goes in \`say\`, your last word in one line. Give its \`column\`. In in_review, put what I owe in \`you\` ("Merge #1963", "Pick one of three dialogs"). Link its PR with \`pr\` and an issue with \`ref\` (owner/repo#123 or the URL); more with op \`link\`. When a card is in in_review, link the Inbox thread where I make the call (\`thread_id\`), so "You: …" opens it.
4. For work in another repository, pass that folder as \`project_path\`. If a call answers that the project has no Board yet, send me one short Inbox message from that project, then try again.
5. Change nothing else: no commits, pushes or PR comments.

Then tell me in a few lines: the cards you made per column, what waits on me, and anything you were not sure about.`;
}
