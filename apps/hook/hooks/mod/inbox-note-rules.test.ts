// The person's rules and Claude Code's rules file (the Inbox's note): the
// mod's reminder (first prompt, a launched session's first wake, the compact
// hook's PLANNOTATOR_INBOX_REMINDER) leaves them out while the file holds
// them, so they reach the session once, and carries them whenever the file
// cannot be read. No Claude Code, no Inbox: the mod's own helpers.
import { describe, expect, test } from 'bun:test'
import { inboxReminderEnvValue } from './inbox'
import { INBOX_RULES_LEAD, inboxReminderText } from './inbox-contract'
import type { SessionKind } from './enabled'
import { claudeNoteFile, claudeSessionNoteFile, currentRules, reminderRulesWithNote } from './inbox-note-rules'

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

  test('a T3 Code thread (or any host not proven to load the file) keeps them even while the note holds them; Claude Code itself does not', async () => {
    const reminderOf = async (kind: SessionKind, entrypoint: unknown) =>
      inboxReminderEnvValue(true, TOOL, null, await reminderRulesWithNote(RULES, claudeSessionNoteFile({ kind, entrypoint }, undefined, '/home/ann'), () => NOTE))
    const withRules = `${inboxReminderText(TOOL)}\n\n${INBOX_RULES_LEAD}\n${RULES}`
    // T3 runs Claude through the Agent SDK: twice there (the note, if it loads it, and the reminder), never none.
    expect(await reminderOf('t3', 't3-code')).toBe(withRules)
    expect(await reminderOf('panel', 'orca')).toBe(withRules)
    expect(await reminderOf('headless', 'sdk-ts')).toBe(withRules)
    // Claude Code's own prompt and its own VS Code panel load the file: once, as before.
    expect(await reminderOf('terminal', 'cli')).toBe(inboxReminderText(TOOL))
    expect(await reminderOf('panel', 'claude-vscode')).toBe(inboxReminderText(TOOL))
  })

  test('no rules, or no folder: nothing is read', async () => {
    const read = () => {
      throw new Error('read when it should not be')
    }
    expect(await reminderRulesWithNote(null, file, read)).toBeNull()
    expect(await reminderRulesWithNote(RULES, null, read)).toBe(RULES)
  })
})

describe('the rules of the moment, not of the session start', () => {
  const file = '/home/ann/.claude/rules/plannotator-inbox.md'
  const configPath = '/data/config.json'
  const configWith = (rules: string) => JSON.stringify({ prompts: { inbox: { rules } } })
  const noteWith = (rules: string) => NOTE.replace(RULES, rules)

  test('R1 at the start, the person saves R2 and the Inbox rewrites the note: the compaction carries neither twice', async () => {
    const R2 = 'Only message me when you are blocked.'
    let config = configWith(RULES)
    let note = noteWith(RULES)
    const at = async (before: string | null) => {
      const rules = await currentRules(before, configPath, () => config, () => true)
      return { rules, reminder: await reminderRulesWithNote(rules, file, () => note) }
    }
    const start = await at(null)
    expect(start).toEqual({ rules: RULES, reminder: null })
    // Saved, the note not rewritten yet (or it could not be): the reminder carries R2, once.
    config = configWith(R2)
    const saved = await at(start.rules)
    expect(saved).toEqual({ rules: R2, reminder: R2 })
    // The Inbox rewrote the note: R2 is in the file, so none in the reminder (never R1 again).
    note = noteWith(R2)
    expect(await at(saved.rules)).toEqual({ rules: R2, reminder: null })
    // Rules cleared: none anywhere.
    config = JSON.stringify({})
    expect(await at(R2)).toEqual({ rules: null, reminder: null })
  })

  test('a read that fails, or a file that is not a JSON object, keeps the last rules; a file gone or blank holds none', async () => {
    const never = () => {
      throw new Error('EACCES')
    }
    expect(await currentRules(RULES, configPath, never, () => true)).toBe(RULES)
    expect(await currentRules(RULES, configPath, () => Promise.reject(new Error('EIO')), () => true)).toBe(RULES)
    expect(await currentRules(RULES, configPath, () => '{"prompts": {"inbox": ', () => true)).toBe(RULES)
    expect(await currentRules(RULES, configPath, () => '[1]', () => true)).toBe(RULES)
    expect(await currentRules(RULES, configPath, () => null, () => false)).toBeNull()
    expect(await currentRules(RULES, configPath, () => ' \n', () => true)).toBeNull()
  })
})
