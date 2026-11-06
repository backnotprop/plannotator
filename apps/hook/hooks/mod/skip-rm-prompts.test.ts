/**
 * CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS beside Plannotator's plan
 * hook (skip-rm-prompts.ts). What can regress: the mod answering a removal
 * prompt the person did not waive (no variable, not bypass, a nested session),
 * overriding the person's own "ask before rm" rule or hook, or a plugin's hook
 * that asked; or leaving the prompt up where the variable promises none (main
 * loop and subagents alike). Driven through the real hooks register.ts adds.
 */
import { describe, expect, test } from 'bun:test'
import { isBareRemovalAsk, personGuardsRemovals } from './skip-rm-prompts'

type Hook = ($: unknown, e: any, next: (e: unknown) => unknown) => unknown

/** Every hook register() adds, with its matcher, so a call can be dispatched the way the engine selects. */
async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held: { event: string; matcher: Record<string, unknown> | undefined; hook: Hook }[] = []
  register(((event: string, ...args: unknown[]) => {
    held.push({ event, matcher: args.length > 1 ? (args[0] as Record<string, unknown>) : undefined, hook: args.at(-1) as Hook })
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string, e: Record<string, unknown>) => {
    const hooks = held.filter((h) => {
      if (h.event !== event) return false
      if (!h.matcher) return true
      return Object.entries(h.matcher).every(([key, want]) => (Array.isArray(want) ? want.includes(e[key]) : want === e[key]))
    })
    return hooks
  }
}

const RM_ASK = {
  decision: 'ask',
  reason: "Dangerous rm operation detected: '/w/proj/t/logs/*/*'\n\nThis command's glob pattern traverses directories that cannot be statically enumerated.",
}
const COMMAND = 'mkdir -p t/logs/a && rm -rf t/logs/*/*'
const BENEATH = { decision: { behavior: 'deny', message: 'the dialog, beneath' } }

function engine(options: { env?: Record<string, string>; settings?: unknown; settingsThrows?: boolean } = {}) {
  const env = new Map<string, string>(Object.entries({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: '/data', ...options.env }))
  const store = new Map<string, unknown>()
  return {
    env: { get: async (name: string) => env.get(name), set: async (name: string, value: string) => void env.set(name, value) },
    fs: {
      exists: async (path: string) => path === '/bin/sh',
      read: async () => {
        throw new Error('ENOENT')
      },
      write: async () => undefined,
      stat: async () => null,
    },
    settings: {
      read: async () => {
        if (options.settingsThrows) throw new Error('unreadable')
        return options.settings ?? {}
      },
    },
    session: {
      id: async () => 'sess-rm',
      cwd: async () => '/w/proj',
      root: async () => '/w/proj',
      messages: async () => [],
      version: async () => ({ version: '2.1.318', base: '2.1.318' }),
    },
    clock: { now: async () => 1_000_000, sleep: async () => undefined, every: () => ({ cancel: () => undefined }) },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    http: { fetch: async () => ({ status: 404, ok: false, text: '' }) },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
    command: { list: async () => [], register: async () => undefined },
    ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
    prompt: { submit: async () => undefined, suggest: async () => undefined },
    turn: { abort: async () => undefined },
  }
}

let fresh = 0

/**
 * One Bash call through the mod as Claude Code raises it: its verdict
 * (`tool.check`, the engine's own beneath), then its permission prompt.
 * Returns what the prompt was answered with: the mod's allow, or what lies beneath.
 */
async function removalPrompt(options: {
  variable?: string
  mode?: string
  agentId?: string
  verdict?: Record<string, unknown>
  settings?: unknown
  settingsThrows?: boolean
  env?: Record<string, string>
  skipCheck?: boolean
}) {
  const hooks = await freshHooks(`skip-rm-${fresh++}`)
  const env = { ...(options.variable === undefined ? {} : { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: options.variable }), ...options.env }
  const $ = engine({ env, settings: options.settings, settingsThrows: options.settingsThrows })
  for (const { hook } of hooks('session.start', {})) await hook($, { isInteractive: true }, async () => ({ cwd: '/w/proj' }))
  if (!options.skipCheck) {
    const check = { tool: 'Bash', input: { command: COMMAND }, tool_use_id: 'toolu_1', ...(options.agentId ? { agentId: options.agentId } : {}) }
    for (const { hook } of hooks('tool.check', check)) await hook($, check, async () => options.verdict ?? RM_ASK)
  }
  const prompt = {
    tool_name: 'Bash',
    tool_input: { command: COMMAND, description: 'clean the logs' },
    permission_mode: options.mode ?? 'bypassPermissions',
    ...(options.agentId ? { agent_id: options.agentId, agent_type: 'general-purpose' } : {}),
  }
  const selected = hooks('classic.PermissionRequest', prompt)
  // Each hook runs over the ones after it; the last falls through to the dialog.
  const run = (i: number): Promise<unknown> => (i < selected.length ? Promise.resolve(selected[i]!.hook($, prompt, () => run(i + 1))) : Promise.resolve(BENEATH))
  return run(0)
}

const ALLOWED = { decision: { behavior: 'allow' } }

describe('with the variable set, in bypass mode', () => {
  test('a removal prompt is answered with allow, on the main loop', async () => {
    expect(await removalPrompt({ variable: '1' })).toEqual(ALLOWED)
  })

  test('and in a subagent (its own verdict, its own mode)', async () => {
    expect(await removalPrompt({ variable: '1', agentId: 'agent-7' })).toEqual(ALLOWED)
    expect(await removalPrompt({ variable: 'true', agentId: 'agent-7', mode: 'acceptEdits' })).toEqual(BENEATH)
  })

  test("Plannotator's own plan hook in settings (ExitPlanMode only) and hooks on other tools do not count as the person's", async () => {
    const settings = {
      hooks: {
        PermissionRequest: [{ matcher: 'ExitPlanMode', hooks: [{ type: 'command', command: 'plannotator' }] }],
        PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt-check' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'log' }] }],
      },
      permissions: { ask: ['WebFetch'], allow: ['Bash(npm test:*)'] },
    }
    expect(await removalPrompt({ variable: '1', settings })).toEqual(ALLOWED)
  })
})

describe('nothing changes without the variable or outside bypass', () => {
  test('no variable: the prompt goes to the dialog', async () => {
    expect(await removalPrompt({})).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '' })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '0' })).toEqual(BENEATH)
    expect(await removalPrompt({ agentId: 'agent-7' })).toEqual(BENEATH)
  })

  test('the variable set, but the loop is not in bypass mode', async () => {
    for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) expect(await removalPrompt({ variable: '1', mode })).toEqual(BENEATH)
  })

  test('a nested session, where Claude Code itself ignores the variable', async () => {
    expect(await removalPrompt({ variable: '1', env: { CLAUDE_CODE_CHILD_SESSION: '1' } })).toEqual(BENEATH)
  })

  test('the mod turned off', async () => {
    expect(await removalPrompt({ variable: '1', env: { PLANNOTATOR_CLAUDE_MOD: '0' } })).toEqual(BENEATH)
  })

  test('an ask that is not the removal check alone', async () => {
    const asks = [
      { decision: 'ask', reason: 'This command requires approval' },
      { decision: 'ask', reason: 'Reads outside the working directories', setting: 'permissions.blockReadsOutsideWorkingDirectories' },
      { decision: 'allow' },
    ]
    for (const verdict of asks) expect(await removalPrompt({ variable: '1', verdict })).toEqual(BENEATH)
  })

  test('a prompt whose verdict the mod never saw', async () => {
    expect(await removalPrompt({ variable: '1', skipCheck: true })).toEqual(BENEATH)
  })
})

describe("the person's own rules and hooks win", () => {
  test('an ask or deny rule on Bash or rm', async () => {
    for (const permissions of [{ ask: ['Bash(rm *)'] }, { ask: ['Bash'] }, { deny: ['Bash(rm -rf:*)'] }, { ask: ['PowerShell(Remove-Item *)'] }, { deny: ['Monitor'] }, { blockReadsOutsideWorkingDirectories: true }]) {
      expect(await removalPrompt({ variable: '1', settings: { permissions } })).toEqual(BENEATH)
    }
  })

  test('a PreToolUse hook that could run for Bash (the "ask before rm" hook that was overridden before)', async () => {
    for (const matcher of ['Bash', '*', '', undefined, 'Bash|Monitor', 'Ba.*', '(unclosed']) {
      const settings = { hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'ask-before-rm.sh' }] }] } }
      expect(await removalPrompt({ variable: '1', settings })).toEqual(BENEATH)
      expect(await removalPrompt({ variable: '1', settings, agentId: 'agent-7' })).toEqual(BENEATH)
    }
  })

  test('a PermissionRequest hook of their own on Bash', async () => {
    const settings = { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'notify' }] }] } }
    expect(await removalPrompt({ variable: '1', settings })).toEqual(BENEATH)
  })

  test("a hook or rule that asked on this call, a plugin's included (seen on the call's own verdict)", async () => {
    for (const extra of [{ hook: 'PreToolUse' }, { rule: 'Bash(rm *)' }, { plugin: 'safety-net' }]) {
      expect(await removalPrompt({ variable: '1', verdict: { ...RM_ASK, ...extra } })).toEqual(BENEATH)
    }
  })

  test('settings the mod cannot read', async () => {
    expect(await removalPrompt({ variable: '1', settingsThrows: true })).toEqual(BENEATH)
    expect(personGuardsRemovals(null)).toBe(true)
    expect(personGuardsRemovals({ hooks: { PreToolUse: 'not a list' } })).toBe(true)
    expect(personGuardsRemovals({ permissions: { ask: [42] } })).toBe(true)
  })
})

describe('the removal asks it recognizes', () => {
  test("Claude Code's removal-check wordings, and nothing else", () => {
    expect(isBareRemovalAsk(RM_ASK)).toBe(true)
    expect(isBareRemovalAsk({ decision: 'ask', reason: "Dangerous rmdir operation detected: '~'" })).toBe(true)
    expect(isBareRemovalAsk({ decision: 'ask', reason: 'This shell -c script runs rm and could not be checked' })).toBe(true)
    expect(isBareRemovalAsk({ decision: 'ask', reason: 'The permission check for this command did not finish, so its safety checks did not run.' })).toBe(false)
    expect(isBareRemovalAsk({ decision: 'deny', reason: RM_ASK.reason })).toBe(false)
  })
})

describe('plan review is untouched', () => {
  test('the ExitPlanMode prompt with no approval still goes to the hooks beneath', async () => {
    const hooks = await freshHooks(`skip-rm-plan-${fresh++}`)
    const $ = engine({ env: { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' } })
    for (const { hook } of hooks('session.start', {})) await hook($, { isInteractive: true }, async () => ({ cwd: '/w/proj' }))
    const prompt = { tool_name: 'ExitPlanMode', tool_input: { plan: '# Plan' }, permission_mode: 'plan' }
    const selected = hooks('classic.PermissionRequest', prompt)
    expect(selected).toHaveLength(1)
    expect(await selected[0]!.hook($, prompt, async () => BENEATH)).toEqual(BENEATH)
  })
})
