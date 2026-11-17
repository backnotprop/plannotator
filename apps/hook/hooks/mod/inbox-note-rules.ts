/**
 * Whether this Claude Code session's reminder carries the person's rules: not
 * when Claude Code's own rules file already holds the Inbox's note with them
 * (Claude Code loads that file itself, so they reach the session once).
 * Mirrors `inboxReminderRulesFor` in packages/shared/config.ts for Pi and
 * OpenCode. The file is read again at each moment the reminder goes (session
 * start, the first prompt of a conversation, a compaction), as Claude Code
 * reads its memory files again then: the two agree as the note changes. The
 * rules are read again from config.json at the same moments (currentRules):
 * the Inbox rewrites the note when the person saves new rules, so an answer
 * made with the rules of the session's start would carry the old ones again.
 */
import { inboxReminderRulesAfterNote, resolveInboxReminderRules } from './enabled'
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

/**
 * The person's rules as config.json holds them now (for the claude-code host):
 * read at the moments the note is read again, so the note is compared with the
 * current rules. A read that fails, or text that is not a JSON object (a save
 * half done, a typo), keeps `before`; a file that is gone, or blank, holds none.
 * Never throws.
 */
export async function currentRules(
  before: string | null,
  path: string,
  read: (path: string) => unknown,
  exists: (path: string) => unknown,
): Promise<string | null> {
  const text = await Promise.resolve()
    .then(() => read(path))
    .catch(() => undefined)
  if (typeof text !== 'string') {
    const there = await Promise.resolve()
      .then(() => exists(path))
      .catch(() => true)
    return there ? before : null
  }
  if (!text.trim()) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return before
  } catch {
    return before
  }
  return resolveInboxReminderRules(text)
}
