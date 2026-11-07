import { describe, expect, test } from 'bun:test'
import type { register } from './register'

// The plan review switch (`PLANNOTATOR_PLAN_REVIEW` / `planReview`, #2299):
// off, the mod leaves ExitPlanMode to Claude Code's own dialog. It fails when
// the mod still denies the call with "waiting for review", or answers
// classic.PermissionRequest itself, for a person who turned it off.

const DATA = '/data'

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

function hooks(registerOn: typeof register) {
  const held = new Map<string, Hook>()
  registerOn((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  })
  return (event: string) => held.get(event)!
}

/** Each test gets its own module: session.start decides once per process. */
async function freshRegister(name: string): Promise<typeof register> {
  const path = `./register?${name}`
  return ((await import(path)) as { register: typeof register }).register
}

function engine(env: Record<string, string>, config?: Record<string, unknown>) {
  const files = new Map<string, string>([['/bin/sh', '']])
  if (config) files.set(`${DATA}/config.json`, JSON.stringify(config))
  // A sleep moves the clock, so a wait in the mod ends instead of spinning.
  let now = 1_000_000
  const values: Record<string, string> = { HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, PLANNOTATOR_INBOX_TOOL: '0', ...env }
  return {
    env: { get: async (name: string) => values[name], set: async () => undefined },
    fs: {
      exists: async (path: string) => files.has(path) || path === DATA,
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      write: async (path: string, text: string) => void files.set(path, text),
      mkdir: async () => undefined,
      remove: async () => undefined,
      stat: async () => null,
    },
    session: {
      id: async () => 'sess-plan',
      cwd: async () => '/w',
      root: async () => '/w',
      messages: async () => [],
      version: async () => ({ version: '2.1.316', base: '2.1.316' }),
    },
    clock: { now: async () => now, sleep: async (ms: number) => void (now += ms), every: () => ({ cancel: () => undefined }) },
    store: { get: async () => undefined, set: async () => undefined },
    process: {
      // The detached CLI comes up at once (`plannotator-launch <dir> ...` writes its ready file).
      run: async (argv: string[]) => {
        const at = argv.indexOf('plannotator-launch')
        if (at >= 0) files.set(`${argv[at + 1]}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      spawn: async () => ({ pid: 1 }),
    },
    http: { fetch: async () => ({ status: 404, ok: false, text: '' }) },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
    command: { list: async () => [], register: async () => undefined },
    ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
    prompt: { submit: async () => undefined, suggest: async () => undefined },
    turn: { abort: async () => undefined },
  }
}

const planCall = { tool: 'ExitPlanMode', tool_use_id: 'toolu_1', plan: '# Ship it\n' }
const permission = { tool_name: 'ExitPlanMode', tool_use_id: 'toolu_1', tool_input: { plan: '# Ship it\n' } }
const passed = { passed: true }

describe('the plan review switch', () => {
  test('off: ExitPlanMode and its permission request pass through to Claude Code', async () => {
    const on = hooks(await freshRegister('plan-review-off'))
    const $ = engine({ PLANNOTATOR_PLAN_REVIEW: '0' })
    await on('session.start')($, { isInteractive: true }, async () => ({ cwd: '/w' }))
    expect(await on('tool.call')($, planCall, () => passed)).toBe(passed)
    expect(await on('classic.PermissionRequest')($, permission, () => passed)).toBe(passed)
  })

  // The PR's own config key, with a control: unset, the same engine gets the
  // mod's review, so the pass-through is the switch and not a mod that never
  // started. Fails when the mod ignores `planReview` in config.json.
  test('config.json planReview false: ExitPlanMode passes through, where unset the mod reviews it', async () => {
    const reviewing = hooks(await freshRegister('plan-review-unset'))
    const $on = engine({})
    await reviewing('session.start')($on, { isInteractive: true }, async () => ({ cwd: '/w' }))
    const reviewed = (await reviewing('tool.call')($on, planCall, () => passed)) as { deny?: string }
    expect(reviewed).not.toBe(passed)
    expect(reviewed.deny).toContain('NOT approved')

    const off = hooks(await freshRegister('plan-review-config-off'))
    const $off = engine({}, { planReview: false })
    await off('session.start')($off, { isInteractive: true }, async () => ({ cwd: '/w' }))
    expect(await off('tool.call')($off, planCall, () => passed)).toBe(passed)
    expect(await off('classic.PermissionRequest')($off, permission, () => passed)).toBe(passed)
  })
})
