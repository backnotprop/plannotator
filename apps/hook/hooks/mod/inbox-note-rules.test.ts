// The person's rules and Claude Code's rules file (the Inbox's note): the
// mod's reminder (first prompt, a launched session's first wake, the compact
// hook's PLANNOTATOR_INBOX_REMINDER) leaves them out while the file holds
// them, so they reach the session once, and carries them whenever the file
// cannot be read. No Claude Code, no Inbox: the mod's own helpers.
import { describe, expect, test } from 'bun:test'
import { inboxReminderEnvValue } from './inbox'
import { INBOX_RULES_LEAD, inboxReminderText } from './inbox-contract'
import { claudeNoteFile, reminderRulesWithNote } from './inbox-note-rules'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
const RULES = 'Ask me before you delete any file.'
const NOTE = [
  '<!-- plannotator-inbox:start v9 · added by Plannotator. Remove it in the Inbox\'s Settings or with `plannotator uninstall` -->',
  '## Plannotator Inbox',
  '',
  'The note.',
  '',
  INBOX_RULES_LEAD,
  RULES,
  '<!-- plannotator-inbox:end -->',
  '',
].join('\n')

describe('where the mod looks', () => {
  test("CLAUDE_CONFIG_DIR's rules folder, else ~/.claude's; nothing without an absolute folder", () => {
    expect(claudeNoteFile('/work/claude-config', '/home/ann')).toBe('/work/claude-config/rules/plannotator-inbox.md')
    expect(claudeNoteFile(undefined, '/home/ann')).toBe('/home/ann/.claude/rules/plannotator-inbox.md')
    expect(claudeNoteFile('', '/home/ann')).toBe('/home/ann/.claude/rules/plannotator-inbox.md')
    expect(claudeNoteFile(undefined, undefined)).toBeNull()
    expect(claudeNoteFile('relative/dir', '/home/ann')).toBeNull()
  })
})

describe('the rules the reminder carries', () => {
  const file = '/home/ann/.claude/rules/plannotator-inbox.md'

  test('the note holds them: none, and the compact hook prints today\'s line', async () => {
    const reads: string[] = []
    const rules = await reminderRulesWithNote(RULES, file, (path) => {
      reads.push(path)
      return NOTE
    })
    expect(reads).toEqual([file])
    expect(rules).toBeNull()
    expect(inboxReminderEnvValue(true, TOOL, null, rules)).toBe(inboxReminderText(TOOL))
  })

  test('no file, a read that fails or throws, other rules: the reminder carries them', async () => {
    for (const read of [() => null, () => Promise.reject(new Error('EACCES')), () => {
      throw new Error('no fs')
    }, () => NOTE.replace(RULES, 'Older rules.')]) {
      const rules = await reminderRulesWithNote(RULES, file, read)
      expect(rules).toBe(RULES)
      expect(inboxReminderEnvValue(true, TOOL, null, rules)).toBe(`${inboxReminderText(TOOL)}\n\n${INBOX_RULES_LEAD}\n${RULES}`)
    }
  })

  test('no rules, or no folder: nothing is read', async () => {
    const read = () => {
      throw new Error('read when it should not be')
    }
    expect(await reminderRulesWithNote(null, file, read)).toBeNull()
    expect(await reminderRulesWithNote(RULES, null, read)).toBe(RULES)
  })
})
