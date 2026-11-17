/**
 * Whether this Claude Code session's reminder carries the person's rules: not
 * when Claude Code's own rules file already holds the Inbox's note with them
 * (Claude Code loads that file itself, so they reach the session once).
 * Mirrors `inboxReminderRulesFor` in packages/shared/config.ts for Pi and
 * OpenCode. The file is read again at each moment the reminder goes (session
 * start, the first prompt of a conversation, a compaction), as Claude Code
 * reads its memory files again then: the two agree as the note changes.
 */
import { inboxReminderRulesAfterNote } from './enabled'
import { isAbsolutePath } from './paths'

/** Claude Code's rules file the Inbox writes its note into, or null without an absolute config folder. */
export function claudeNoteFile(configDirEnv: unknown, home: string | undefined): string | null {
  const dir = typeof configDirEnv === 'string' && configDirEnv ? configDirEnv : home ? `${home}/.claude` : null
  return dir !== null && isAbsolutePath(dir) ? `${dir}/rules/plannotator-inbox.md` : null
}

/**
 * The rules for the reminder: `rules` (config.json's, read at session start),
 * or null when the note file holds them. A file that is missing or cannot be
 * read holds nothing: the reminder carries them. Never throws.
 */
export async function reminderRulesWithNote(rules: string | null, file: string | null, read: (path: string) => unknown): Promise<string | null> {
  if (rules === null || file === null) return rules
  const note = await Promise.resolve()
    .then(() => read(file))
    .catch(() => null)
  return inboxReminderRulesAfterNote(rules, typeof note === 'string' ? note : null)
}
