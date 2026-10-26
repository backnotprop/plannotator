import { describe, expect, test } from 'bun:test'
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
  test('is matched on exactly the commands the mod answers', () => {
    const hooks = registrations().filter((hook) => hook.event === 'command.run')

    expect(hooks).toHaveLength(1)
    const matcher = hooks[0]?.matcher as { command?: unknown } | undefined
    expect(Array.isArray(matcher?.command)).toBe(true)
    expect([...(matcher?.command as string[])].sort()).toEqual([...Object.keys(COMMANDS), INBOX_COMMAND.name].sort())
    expect(Object.keys(COMMANDS).sort()).toEqual(['plannotator-annotate', 'plannotator-last', 'plannotator-review'])
    expect(INBOX_COMMAND.name).toBe('plannotator-inbox')
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
