// The Inbox reminder where a guard plugin skips the mod's prompt.context hook
// (#2159): the learned prompt.submit fallback (pure rules) and the plugin's
// SessionStart `compact` command hook, run for real under sh and bash (and
// PowerShell when it is installed) from the command hooks.json ships.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INBOX_REMINDER_ENV,
  INBOX_REMINDER_RESUMED_SLACK_MS,
  inboxReminderEnvValue,
  inboxReminderFirstTurnLesson,
  inboxReminderSubmitCopy,
  readReminderContextWorks,
  reminderSessionResumed,
  STORE_INBOX_REMINDER_CONTEXT_WORKS,
} from './inbox'
import { inboxReminderText } from './inbox-contract'

const TOOL = 'mcp__plugin_plannotator_tools__plannotator_inbox'
/**
 * A custom reminder (#2194) holding everything a shell or echo would read:
 * backslash escapes, a leading -n, printf's %, quotes, command substitutions
 * that would leave a marker file, a variable, and line breaks.
 */
const MARKER = `/tmp/plannotator-reminder-pwned-${process.pid}`
const HOSTILE = `-n Ask first. a\\b \\c\\n 100% %s %d "double" 'single' $(touch ${MARKER}-1) \`touch ${MARKER}-2\` \${HOME} $HOME\nsecond line\n\tthird \\ end\n`

describe('the prompt.submit copy (rule 2)', () => {
  // Every row of the decision: delivered × what the store says × meta × command.
  const rows: Array<[delivered: boolean, works: boolean | undefined, isMeta: boolean, command: boolean, copy: boolean]> = [
    // Not reached yet, no evidence prompt.context runs: the copy goes.
    [false, undefined, false, false, true],
    [false, false, false, false, true],
    // prompt.context known to run here: today's path alone.
    [false, true, false, false, false],
    // Already reached in this conversation (by either path): never twice.
    [true, undefined, false, false, false],
    [true, false, false, false, false],
    [true, true, false, false, false],
    // A meta prompt or a slash command never carries it.
    [false, undefined, true, false, false],
    [false, false, true, false, false],
    [false, undefined, false, true, false],
    [false, false, false, true, false],
    [false, true, true, true, false],
  ]
  for (const [delivered, works, isMeta, command, copy] of rows) {
    test(`delivered=${delivered} contextWorks=${works} isMeta=${isMeta} command=${command} → ${copy ? 'copy' : 'none'}`, () => {
      expect(inboxReminderSubmitCopy({ delivered, contextWorks: works, isMeta, command })).toBe(copy)
    })
  }
})

describe('the first turn of a conversation (rule 3)', () => {
  test('prompt.context did not run in a fresh conversation: learn false', () => {
    expect(inboxReminderFirstTurnLesson({ contextRan: false, aborted: false, resumed: false, contextWorks: undefined })).toEqual({ done: true, write: false })
    expect(inboxReminderFirstTurnLesson({ contextRan: false, aborted: false, resumed: false, contextWorks: true })).toEqual({ done: true, write: false })
  })

  test('already false: nothing to write', () => {
    expect(inboxReminderFirstTurnLesson({ contextRan: false, aborted: false, resumed: false, contextWorks: false })).toEqual({ done: true, write: null })
  })

  test('prompt.context ran: rule 1 already wrote true, nothing here', () => {
    for (const works of [undefined, true, false] as const) {
      expect(inboxReminderFirstTurnLesson({ contextRan: true, aborted: false, resumed: false, contextWorks: works })).toEqual({ done: true, write: null })
    }
  })

  test('a resumed conversation teaches nothing (its first turn here is not its first)', () => {
    expect(inboxReminderFirstTurnLesson({ contextRan: false, aborted: false, resumed: true, contextWorks: true })).toEqual({ done: true, write: null })
  })

  test('an aborted turn decides nothing: the next one is looked at', () => {
    expect(inboxReminderFirstTurnLesson({ contextRan: false, aborted: true, resumed: false, contextWorks: undefined })).toEqual({ done: false, write: null })
    expect(inboxReminderFirstTurnLesson({ contextRan: true, aborted: true, resumed: false, contextWorks: true })).toEqual({ done: false, write: null })
  })
})

describe('telling a resumed session from one started in this process', () => {
  const start = 1_000_000_000
  test('started at or after this process (minus the slack): not resumed', () => {
    expect(reminderSessionResumed(start, start)).toBe(false)
    expect(reminderSessionResumed(start - 5_000, start)).toBe(false)
    expect(reminderSessionResumed(start - INBOX_REMINDER_RESUMED_SLACK_MS, start)).toBe(false)
    expect(reminderSessionResumed(start + 60_000, start)).toBe(false)
  })
  test('started well before this process: resumed', () => {
    expect(reminderSessionResumed(start - INBOX_REMINDER_RESUMED_SLACK_MS - 1, start)).toBe(true)
    expect(reminderSessionResumed(start - 3_600_000, start)).toBe(true)
  })
  test('nothing readable: not resumed (learning proceeds as the spec has it)', () => {
    expect(reminderSessionResumed(undefined, start)).toBe(false)
    expect(reminderSessionResumed('x', start)).toBe(false)
    expect(reminderSessionResumed(Number.NaN, start)).toBe(false)
    expect(reminderSessionResumed(start - 3_600_000, null)).toBe(false)
  })
})

describe('the stored value', () => {
  test('only booleans count', () => {
    expect(STORE_INBOX_REMINDER_CONTEXT_WORKS).toBe('inboxReminderContextWorks')
    expect(readReminderContextWorks(true)).toBe(true)
    expect(readReminderContextWorks(false)).toBe(false)
    for (const other of [undefined, null, 'true', 1, 0, {}, []]) expect(readReminderContextWorks(other)).toBeUndefined()
  })
})

describe('PLANNOTATOR_INBOX_REMINDER', () => {
  test('the reminder naming the tool by its registered name while on; unset otherwise', () => {
    expect(inboxReminderEnvValue(true, TOOL)).toBe(inboxReminderText(TOOL))
    expect(inboxReminderEnvValue(true, TOOL)).toContain(`${TOOL} send_message`)
    expect(inboxReminderEnvValue(false, TOOL)).toBeUndefined()
    expect(inboxReminderEnvValue(true, null)).toBeUndefined()
  })

  // #2194: a custom text is published as it is, whatever it holds; the hook prints it with printf.
  test('a custom text is published byte for byte, backslashes and a leading dash included', () => {
    expect(inboxReminderEnvValue(true, TOOL, HOSTILE)).toBe(HOSTILE)
    expect(inboxReminderEnvValue(true, 'a\\b')).toBe(inboxReminderText('a\\b'))
  })

  test('register.ts sets it under exactly this name (a string literal, as claude plugin validate needs)', () => {
    const source = readFileSync(join(import.meta.dir, 'register.ts'), 'utf8')
    expect(INBOX_REMINDER_ENV).toBe('PLANNOTATOR_INBOX_REMINDER')
    expect(source).toContain(`$.env.set('${INBOX_REMINDER_ENV}', inboxReminderEnvValue(`)
  })
})

describe("hooks.json's SessionStart compact hook", () => {
  const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>
  }
  const entries = hooks.hooks.SessionStart ?? []
  const command = entries[0]?.hooks[0]?.command ?? ''

  test('one command hook, matched on compact alone, short timeout, never the plannotator binary', () => {
    expect(entries).toHaveLength(1)
    expect(entries[0]?.matcher).toBe('compact')
    expect(entries[0]?.hooks).toHaveLength(1)
    expect(entries[0]?.hooks[0]?.type).toBe('command')
    expect(entries[0]?.hooks[0]?.timeout).toBe(5)
    expect(command).toContain(`$${INBOX_REMINDER_ENV}`)
    expect(command).not.toMatch(/\bplannotator\b(?!_)/i)
  })

  /** The command as a hook process runs it: a clean environment, plus the variable when given. */
  function run(shell: string, args: string[], value?: string) {
    const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
    if (value !== undefined) env[INBOX_REMINDER_ENV] = value
    return spawnSync(shell, [...args, command], { env, encoding: 'utf8', timeout: 10_000 })
  }

  const text = inboxReminderText(TOOL)
  // dash is Debian's and Ubuntu's /bin/sh (CI); its echo read backslashes, which is why the hook uses printf.
  const shells = ['/bin/sh', '/bin/bash', ...['/usr/bin/dash', '/bin/dash'].filter((path) => existsSync(path)).slice(0, 1)]
  for (const shell of shells) {
    test(`${shell}: set, prints the text and one newline; exit 0`, () => {
      const result = run(shell, ['-c'], text)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${text}\n`)
      expect(result.stderr).toBe('')
    })
    test(`${shell}: a custom text with backslashes, -n, %, quotes, $(...), backticks and line breaks comes out byte for byte, and nothing in it runs`, () => {
      const result = run(shell, ['-c'], HOSTILE)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`${HOSTILE}\n`)
      expect(result.stderr).toBe('')
      expect(existsSync(`${MARKER}-1`)).toBe(false)
      expect(existsSync(`${MARKER}-2`)).toBe(false)
    })
    test(`${shell}: unset, prints only whitespace (the engine trims it to nothing); exit 0`, () => {
      const result = run(shell, ['-c'])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(result.stderr).toBe('')
    })
  }

  // Claude Code runs a Windows hook in Git Bash, else PowerShell (-NoProfile);
  // there `$PLANNOTATOR_INBOX_REMINDER` is a PowerShell variable, always empty
  // (the mod never runs on Windows anyway). The line must parse and exit 0.
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' })
  test.skipIf(pwsh.status !== 0)('PowerShell: prints only whitespace and exits 0, set or not', () => {
    for (const value of [undefined, text, HOSTILE]) {
      const result = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command'], value)
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(result.stderr).toBe('')
    }
  })
})
