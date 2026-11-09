/**
 * The grill-me note, as the Claude Code mod appends it (register.ts:
 * `prompt.submit` on a typed grill-me command, `tool.call` on the Skill tool
 * running one).
 *
 * A COPY of packages/shared/inbox/grill-me.ts: a hooks module may import only
 * its own folder. Everything below the CONTRACT marker must stay byte for byte
 * the same as there; `grill-me.test.ts` fails when they differ. Edit the
 * shared file, then paste its contract section here.
 */

// --- CONTRACT (copied verbatim into apps/hook/hooks/mod/grill-me.ts) ---

/** The words of a skill or command name: its last `:` part, camelCase split, lowercased. */
function grillMeWords(name: string): string[] {
  const base = name.trim().replace(/^[/$@]+/, '').split(':').pop() ?? ''
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Whether a skill or slash command name is a grill-me interview, whoever wrote
 * it: a name with the words "grill me" (`grill-me`, `grill_me`, `grillme`,
 * `GrillMe`, `team:grill-me`, `grill-me-harder`, `odoo-grill-me`), or one that is
 * only `grill`, `grilling` or `grill-with-…` (Matt Pocock's `/grill-me` calls
 * `grilling`; `/grill-with-docs` runs it too).
 */
export function isGrillMeSkill(name: unknown): boolean {
  if (typeof name !== 'string') return false
  const words = grillMeWords(name)
  if (words.length === 0) return false
  if (words.includes('grillme')) return true
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === 'grill' && words[i + 1] === 'me') return true
  if (words.length === 1 && (words[0] === 'grill' || words[0] === 'grilling')) return true
  return words[0] === 'grill' && words[1] === 'with'
}

/** The tool name as the note says it; a host passes its registered name (Claude Code's is `mcp__…__plannotator_inbox`). */
export const GRILL_ME_NOTE_TOOL = 'plannotator_inbox'

/**
 * The note, for a host whose Inbox reply comes back as a turn (the Claude Code
 * mod, Pi, OpenCode 2). Fixed text apart from the tool's name. It points at the
 * send_message `body` field for the question format rather than repeating it.
 */
export const GRILL_ME_NOTE_TEXT = [
  'Plannotator: this is a grill-me interview, and the person uses the Plannotator Inbox. The skill still leads; this is only about where and how you ask.',
  '- Ask through the Inbox: plannotator_inbox send_message, each question a `:::question` block (one decision per block, choices in their natural order, then `Recommended:` and a `Why:` line; picture choices when the options are visual). Its `body` field shows the format.',
  "- Keep the skill's pace: one question at a time, or a round of related questions in one message when the skill or the person wants them together.",
  '- Their answers come back here as a message. While you wait, look up in the code what it can answer instead of asking.',
  '- If the person answers you here in the chat, or asks to be asked here, keep asking here. If the Inbox call fails, ask here and say nothing about it.',
].join('\n')

/** The same note for a host whose reply does not come back by itself (OpenCode 1): it says to read the thread. */
export const GRILL_ME_NOTE_TEXT_NO_WAKE = GRILL_ME_NOTE_TEXT.replace(
  'Their answers come back here as a message.',
  'Their answers do not come back here by themselves: when the person says they answered, read the thread with read_thread.',
)

/** The note naming the tool as the host registered it. */
export function grillMeNoteText(toolName: string = GRILL_ME_NOTE_TOOL, options: { wakes?: boolean } = {}): string {
  const text = options.wakes === false ? GRILL_ME_NOTE_TEXT_NO_WAKE : GRILL_ME_NOTE_TEXT
  return text.replace(GRILL_ME_NOTE_TOOL, toolName)
}
