/**
 * The Feedback dialog's "Prompt your agent to send feedback": the one place
 * its text lives. Pasted into any agent on this computer, it has the agent ask
 * the person for their feedback, show them the exact text and send it with
 * `plannotator feedback --stdin` only after they say yes. The text goes on
 * stdin in a quoted heredoc ending in FEEDBACK_HEREDOC_END (bash, zsh, sh), or
 * a single-quoted here-string with UTF-8 output (PowerShell), so no shell
 * expands `$VAR`, backticks or `$(…)` in it, and never in double quotes.
 * apps/hook/server/feedback-command.test.ts runs the bash form below, as
 * copied, through bash.
 *
 * The command always reads `plannotator feedback …`; when the settings name
 * this computer's installed binary (`mcp_command` is `<…/plannotator> inbox
 * mcp`), the prompt adds it as the fallback for an agent whose PATH lacks it.
 * A source run's `bun <script>` is never named: it is no command an installed
 * user has.
 */

import { FEEDBACK_HEREDOC_END } from '@plannotator/core/product-feedback';
import { connectCommand } from './connectPrompt';
import type { InboxToastModel } from './components/Toast';

/** The window's toast after "Prompt your agent to send feedback" (the dialog closes so it is in view). */
export function feedbackCopiedToast(ok: boolean): Omit<InboxToastModel, 'id'> {
  return ok
    ? { icon: 'check', lead: 'Prompt copied', phoneLead: 'Copied', detail: 'Paste it into your agent: it asks for your feedback and sends it once you say yes.' }
    : { icon: 'warn', lead: "Couldn't copy the prompt", wrap: true };
}

/** This computer's installed `plannotator` (one word, a file named plannotator or plannotator.exe) as a shell word, or null. */
export function installedPlannotator(mcpCommand: readonly string[] | null | undefined): string | null {
  const line = connectCommand(mcpCommand);
  if (!line || !Array.isArray(mcpCommand) || mcpCommand.length !== 3) return null;
  return /(^|[\\/])plannotator(\.exe)?$/i.test(mcpCommand[0]!) ? line : null;
}

/** The line in both shell forms that the agent replaces with the approved text. */
export const FEEDBACK_PROMPT_TEXT_LINE = '<the exact text I approved>';

export function feedbackPrompt(mcpCommand: readonly string[] | null | undefined, draft = ''): string {
  const installed = installedPlannotator(mcpCommand);
  const fallback = installed && installed !== 'plannotator' ? ` If \`plannotator\` is not found, use ${installed} in its place.` : '';
  const started = draft.trim();
  const quoted = started
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const end = FEEDBACK_HEREDOC_END;
  return `Help me send feedback about Plannotator to its maintainers.

1. Ask me what I want to say: what works, what doesn't, what I'd like. Keep my words; tidy them only if I ask.${started ? ` Start from what I wrote so far:\n\n${quoted}\n` : ''}
2. Show me the exact text you will send, with a category (bug, idea or other) and an email only if I give one. Add nothing from our files, code or conversation.
3. Only after I say yes, send it. The text goes on stdin exactly as written, so the shell changes nothing. Never put it in double quotes, in any shell: they expand $VAR, backticks and $(...).

In bash, zsh or sh, a quoted heredoc:

\`\`\`
plannotator feedback --stdin --category idea --contact 'ada@example.com' <<'${end}'
${FEEDBACK_PROMPT_TEXT_LINE}
${end}
\`\`\`

In PowerShell, a single-quoted here-string, with UTF-8 so accents and emoji survive:

\`\`\`
$OutputEncoding = [Text.UTF8Encoding]::new($false)
@'
${FEEDBACK_PROMPT_TEXT_LINE}
'@ | plannotator feedback --stdin --category idea --contact 'ada@example.com'
\`\`\`

Use my category, or leave out --category; leave out --contact unless I gave one, and write a ' in it as '\\'' (bash) or '' (PowerShell). If a line of the text is exactly ${end}, pick another end word; in PowerShell, if a line starts with '@, use the bash form instead. It prints "Sent". \`plannotator feedback --help\` has the details.${fallback}
4. Tell me it was sent, or what went wrong.`;
}
