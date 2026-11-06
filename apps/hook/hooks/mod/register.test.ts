import { describe, expect, test } from 'bun:test'
import { PromptDropped, submitOrThrow } from './host'
import { COMMANDS, INBOX_COMMAND } from './launch'
import { PLAN_TOOL } from './plan'
import { register } from './register'

/** Every `on(...)` the module makes, as written: the event, then the matcher when there is one. */
function registrations(): { event: string; matcher: unknown }[] {
  const out: { event: string; matcher: unknown }[] = []
  register((event: string, ...args: unknown[]) => {
    out.push({ event, matcher: args.length > 1 ? args[0] : undefined })
  })
  return out
}

// #1740: Claude Code shows a command's answer under the name of every plugin
// hooking `command.run`, so an unmatched hook here labeled other plugins'
// commands `<plugin>+plannotator: …`. A matcher that misses one of ours brings
// back the blocking skill for that command instead (the hook never runs).
describe('command.run registration', () => {
  test('is matched on exactly the commands the mod answers, and the two that change a session name', () => {
    const hooks = registrations().filter((hook) => hook.event === 'command.run')

    expect(hooks).toHaveLength(2)
    const matched = hooks.map((hook) => {
      const matcher = hook.matcher as { command?: unknown } | undefined
      expect(Array.isArray(matcher?.command)).toBe(true)
      return [...(matcher?.command as string[])].sort()
    })
    expect(matched).toContainEqual([...Object.keys(COMMANDS), INBOX_COMMAND.name].sort())
    expect(matched).toContainEqual(['clear', 'rename'])
    expect(Object.keys(COMMANDS).sort()).toEqual(['plannotator-annotate', 'plannotator-last', 'plannotator-review'])
    expect(INBOX_COMMAND.name).toBe('plannotator-inbox')
  })
})

// #2243: a classic hook cc-plugin-sec-default sends past the mod is a "hook was
// skipped" line every session on a guarded account. The session name must never
// bring these two back (owner's decision on #2450).
describe('no classic hook for the session name', () => {
  test('classic.PermissionRequest is the only classic event the mod hooks', () => {
    const events = registrations().map((hook) => hook.event)

    expect(new Set(events.filter((event) => event.startsWith('classic.')))).toEqual(new Set(['classic.PermissionRequest']))
  })
})

// #2159: a guard plugin seated above the mod (cc-plugin-sec-default) sends
// classic.PermissionRequest past it, and the engine prints "its
// classic.PermissionRequest hook was skipped" for every event the hook is
// selected for. Unmatched, that was the first permission prompt of any tool in
// every session. Matched on ExitPlanMode, the engine selects it for plan
// approvals alone, which the approval record plan.ts writes answers.
describe('classic.PermissionRequest registration', () => {
  test('is matched on ExitPlanMode alone', () => {
    const hooks = registrations().filter((hook) => hook.event === 'classic.PermissionRequest')

    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.matcher).toEqual({ tool_name: PLAN_TOOL })
    expect(PLAN_TOOL).toBe('ExitPlanMode')
  })

  test('no classic.* glob or wildcard hook selects other tools\' permission prompts', () => {
    const events = registrations().map((hook) => hook.event)

    expect(events.filter((event) => event === '*' || event.endsWith('.*') || event.startsWith('!'))).toEqual([])
  })
})

// The owner's report: Claude Code's `$.prompt.submit` RESOLVES `{ drop: <reason> }` for a prompt it refuses
// (after the person stopped the session, until someone types). Read as a turn that started, an Inbox reply was
// marked delivered and never went in. register.ts's `submit` is `submitOrThrow(() => $.prompt.submit({ text }))`.
describe("the submit adapter reads $.prompt.submit's answer", () => {
  const STOPPED = 'the session was stopped and nobody has sent input since'

  test('a drop rejects with PromptDropped, carrying the reason, whatever the reason', async () => {
    for (const reason of [STOPPED, 'plugin input is held', '']) {
      const error = await submitOrThrow(async () => ({ drop: reason })).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PromptDropped)
      expect((error as PromptDropped).reason).toBe(reason)
    }
  })

  test('a drop that is not a string is a refusal too, with no words of its own', async () => {
    for (const drop of [true, { reason: 'held' }, 1]) {
      const error = await submitOrThrow(async () => ({ drop })).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PromptDropped)
      expect((error as PromptDropped).reason).toBe('')
    }
  })

  test('a prompt that went in resolves, whatever the engine answered with', async () => {
    for (const answer of [undefined, null, {}, { text: 'x' }, { drop: undefined }, { drop: null }, { drop: false }]) await expect(submitOrThrow(async () => answer)).resolves.toBeUndefined()
  })

  test('a real failure keeps its own error', async () => {
    const failure = new Error('$.prompt.submit takes text alone')
    const error = await submitOrThrow(async () => Promise.reject(failure)).catch((caught: unknown) => caught)

    expect(error).toBe(failure)
    expect(error).not.toBeInstanceOf(PromptDropped)
  })
})
