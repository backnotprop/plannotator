import { describe, expect, test } from 'bun:test'
import { COMMANDS } from './launch'
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
    // Plus Plannotator Shots' command, answered only when Shots is switched on.
    expect([...(matcher?.command as string[])].sort()).toEqual([...Object.keys(COMMANDS), 'plannotator-screenshot'].sort())
    expect(Object.keys(COMMANDS).sort()).toEqual(['plannotator-annotate', 'plannotator-last', 'plannotator-review'])
  })
})
