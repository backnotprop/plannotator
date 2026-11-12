import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isBareRemovalAsk, personGuardsRemovals, REMOVAL_ASK_TTL_MS, removalAskKey, removalAskParts, RemovalAsks } from './skip-rm-prompts'

type Hook = ($: unknown, e: any, next: (e: unknown) => unknown) => unknown

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

const TEMP = mkdtempSync(join(tmpdir(), 'plannotator-skip-rm-'))
afterAll(() => rmSync(TEMP, { recursive: true, force: true }))

const inTemp = (path: string) => path.startsWith(`${TEMP}/`)

function engine(options: { env?: Record<string, string>; settings?: unknown; settingsThrows?: boolean; ran?: string[]; partVerdict?: (command: string) => unknown } = {}) {
  const env = new Map<string, string>(Object.entries({ HOME: '/home/me', PLANNOTATOR_DATA_DIR: '/data', ...options.env }))
  const store = new Map<string, unknown>()
  return {
    env: { get: async (name: string) => env.get(name), set: async (name: string, value: string) => void env.set(name, value) },
    fs: {
      exists: async (path: string) => path === '/bin/sh' || (inTemp(path) && existsSync(path)),
      read: async (path: string) => {
        if (inTemp(path)) return readFileSync(path, 'utf8')
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
    process: {
      run: async (_argv: unknown, init?: { stdin?: string }) => {
        if (typeof init?.stdin === 'string') options.ran?.push(init.stdin)
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    },
    http: { fetch: async () => ({ status: 404, ok: false, text: '' }) },
    tool: {
      register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }),
      check: async (query: { tool: string; input: { command: string } }) => {
        if (!options.partVerdict) throw new Error('no tool.check here')
        return options.partVerdict(query.input.command)
      },
    },
    command: { list: async () => [], register: async () => undefined },
    ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
    prompt: { submit: async () => undefined, suggest: async () => undefined },
    turn: { abort: async () => undefined },
  }
}

let fresh = 0

async function removalPrompt(options: {
  variable?: string
  mode?: string
  agentId?: string
  verdict?: Record<string, unknown>
  settings?: unknown
  settingsThrows?: boolean
  env?: Record<string, string>
  skipCheck?: boolean
  ran?: string[]
  partVerdict?: (command: string) => unknown
}) {
  const hooks = await freshHooks(`skip-rm-${fresh++}`)
  const env = { ...(options.variable === undefined ? {} : { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: options.variable }), ...options.env }
  const $ = engine({ env, settings: options.settings, settingsThrows: options.settingsThrows, ran: options.ran, partVerdict: options.partVerdict })
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
    for (const permissions of [{ ask: ['Bash(rm *)'] }, { ask: ['Bash'] }, { deny: ['Bash(rm -rf:*)'] }, { ask: ['PowerShell(Remove-Item *)'] }, { deny: ['Monitor'] }, { ask: ['mcp__shell__exec(rm -rf *)'] }, { blockReadsOutsideWorkingDirectories: true }]) {
      expect(await removalPrompt({ variable: '1', settings: { permissions } })).toEqual(BENEATH)
    }
  })

  test('a PreToolUse hook on Bash that asked keeps its prompt (the "ask before rm" hook): its ask is on the verdict', async () => {
    const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'ask-before-rm.sh' }] }] } }
    const verdict = { ...RM_ASK, hook: 'PreToolUse' }
    expect(await removalPrompt({ variable: '1', settings, verdict })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', settings, verdict, agentId: 'agent-7' })).toEqual(BENEATH)
  })

  test('a PreToolUse hook that could run for Bash and did not ask leaves the waiver on, as in Claude Code itself', async () => {
    for (const matcher of ['Bash', '*', '', undefined, 'Bash|Monitor', 'Ba.*', '(unclosed']) {
      const settings = { hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'log-commands.sh' }] }] } }
      expect(await removalPrompt({ variable: '1', settings })).toEqual(ALLOWED)
      expect(await removalPrompt({ variable: '1', settings, agentId: 'agent-7' })).toEqual(ALLOWED)
    }
  })

  test('a PermissionRequest hook of their own that could run for Bash', async () => {
    for (const matcher of ['Bash', '*', '', undefined, 'Bash|Monitor', 'Ba.*', '(unclosed']) {
      const settings = { hooks: { PermissionRequest: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: 'command', command: 'notify' }] }] } }
      expect(await removalPrompt({ variable: '1', settings })).toEqual(BENEATH)
      expect(await removalPrompt({ variable: '1', settings, agentId: 'agent-7' })).toEqual(BENEATH)
    }
  })

  test("a hook or rule that asked on this call, a plugin's included (seen on the call's own verdict)", async () => {
    for (const extra of [{ hook: 'PreToolUse' }, { rule: 'Bash(rm *)' }, { plugin: 'safety-net' }, { setting: 'permissions.blockReadsOutsideWorkingDirectories' }]) {
      expect(await removalPrompt({ variable: '1', verdict: { ...RM_ASK, ...extra } })).toEqual(BENEATH)
    }
  })

  test('settings the mod cannot read', async () => {
    expect(await removalPrompt({ variable: '1', settingsThrows: true })).toEqual(BENEATH)
    expect(personGuardsRemovals(null)).toBe(true)
    expect(personGuardsRemovals({ hooks: { PermissionRequest: 'not a list' } })).toBe(true)
    expect(personGuardsRemovals({ permissions: { ask: [42] } })).toBe(true)
  })
})

describe('the removal asks it recognizes', () => {
  test("Claude Code's removal-check wordings, and nothing else", () => {
    expect(isBareRemovalAsk(RM_ASK)).toBe(true)
    expect(isBareRemovalAsk({ decision: 'ask', reason: "Dangerous rmdir operation detected: '~'" })).toBe(true)
    expect(
      isBareRemovalAsk({
        decision: 'ask',
        reason: 'This command passes a shell -c script that runs rm, and Claude Code could not check the script for dangerous removals. Approve only if you have read the script.',
      }),
    ).toBe(true)
    expect(isBareRemovalAsk({ decision: 'ask', reason: 'The permission check for this command did not finish, so its safety checks did not run.' })).toBe(false)
    expect(isBareRemovalAsk({ decision: 'deny', reason: RM_ASK.reason })).toBe(false)
  })
})

describe('a removal inside a command of several parts', () => {
  const DANGEROUS = (target: string) => ({ decision: 'ask', reason: `Dangerous rm operation detected: '${target}'\n\nThis command's glob pattern traverses directories that cannot be statically enumerated.` })
  const parts = (...list: string[]) => ({ decision: 'ask', reason: `This Bash command contains multiple operations. The following ${list.length === 1 ? 'part requires' : 'parts require'} approval: ${list.join(', ')}` })
  const CD_RM = parts('cd /tmp/scratch', 'rm -rf build/*/*')
  const perPart = (command: string) => (/\*\/\*/.test(command) ? DANGEROUS(command) : { decision: 'allow' })

  test('is answered with allow when each part, asked by itself, is allowed or a removal-check ask', async () => {
    for (const verdict of [CD_RM, parts('mkdir -p /tmp/s/a/b', 'rm -rf /tmp/s/*/*'), parts('rm -rf t/logs/a/*', 'rm -rf t/logs/*/*'), parts('ls /tmp/s', 'head -3; rm -rf /tmp/s/*/* || true')]) {
      expect(await removalPrompt({ variable: '1', verdict, partVerdict: perPart })).toEqual(ALLOWED)
      expect(await removalPrompt({ variable: '1', verdict, partVerdict: perPart, agentId: 'agent-7' })).toEqual(ALLOWED)
    }
    expect(await removalPrompt({ variable: '1', verdict: parts('cd /tmp/scratch', 'rm -rf build/*'), partVerdict: () => ({ decision: 'allow' }) })).toEqual(ALLOWED)
  })

  test('keeps its prompt when a part asks for any other reason, or cannot be checked', async () => {
    const other = (command: string) => (command.startsWith('cd') ? { decision: 'ask', reason: 'The permission check for this command did not finish, so its safety checks did not run.' } : perPart(command))
    expect(await removalPrompt({ variable: '1', verdict: CD_RM, partVerdict: other })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: CD_RM, partVerdict: (command) => ({ ...perPart(command), ...(command.startsWith('rm') ? { rule: 'Bash(rm *)' } : {}) }) })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: CD_RM, partVerdict: () => ({ decision: 'deny', reason: 'no' }) })).toEqual(BENEATH)
    expect(
      await removalPrompt({
        variable: '1',
        verdict: CD_RM,
        partVerdict: () => {
          throw new Error('tool.check failed')
        },
      }),
    ).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: CD_RM })).toEqual(BENEATH)
  })

  test('keeps its prompt when no part runs rm or rmdir, or a rule, hook, setting or plugin stands on the verdict', async () => {
    const allowAll = () => ({ decision: 'allow' })
    expect(await removalPrompt({ variable: '1', verdict: parts('cd /tmp/scratch', 'git clean -fdx'), partVerdict: allowAll })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: parts('echo rm', 'confirm-rm.sh'), partVerdict: allowAll })).toEqual(BENEATH)
    for (const extra of [{ hook: 'PreToolUse' }, { rule: 'Bash(rm *)' }, { plugin: 'safety-net' }, { setting: 'permissions.blockReadsOutsideWorkingDirectories' }]) {
      expect(await removalPrompt({ variable: '1', verdict: { ...CD_RM, ...extra }, partVerdict: perPart })).toEqual(BENEATH)
    }
    expect(removalAskParts({ decision: 'ask', reason: 'This Bash command contains multiple operations that require approval' })).toBeNull()
    expect(removalAskParts({ decision: 'deny', reason: CD_RM.reason })).toBeNull()
  })

  test('changes nothing without the variable, outside bypass mode, or beside a rule or a PermissionRequest hook', async () => {
    let asked = 0
    const counting = (command: string) => {
      asked++
      return perPart(command)
    }
    expect(await removalPrompt({ verdict: CD_RM, partVerdict: counting })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', mode: 'default', verdict: CD_RM, partVerdict: counting })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: CD_RM, partVerdict: counting, settings: { permissions: { ask: ['Bash(rm *)'] } } })).toEqual(BENEATH)
    expect(await removalPrompt({ variable: '1', verdict: CD_RM, partVerdict: counting, settings: { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'notify' }] }] } } })).toEqual(BENEATH)
    expect(asked).toBe(0)
  })
})

const PLANNOTATOR_HOOKS = JSON.parse(readFileSync(join(import.meta.dir, '..', 'hooks.json'), 'utf8'))

function writeFile(path: string, content: string | object) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
}

let worlds = 0

function pluginWorld(plugins: Record<string, { files?: Record<string, string | object>; registered?: boolean }>, options: { registry?: string | null } = {}) {
  const root = join(TEMP, `world-${worlds++}`)
  const configDir = join(root, 'config')
  const table: Record<string, unknown[]> = {}
  for (const [id, plugin] of Object.entries(plugins)) {
    const folder = join(root, 'cache', id.replace('@', '-'), '1.0.0')
    mkdirSync(folder, { recursive: true })
    for (const [name, content] of Object.entries(plugin.files ?? {})) writeFile(join(folder, name), content)
    if (plugin.registered !== false) table[id] = [{ scope: 'user', installPath: folder, version: '1.0.0' }]
  }
  if (options.registry !== null) writeFile(join(configDir, 'plugins', 'installed_plugins.json'), options.registry ?? { version: 2, plugins: table })
  return { root, configDir }
}

const enabling = (...ids: string[]) => ({ enabledPlugins: Object.fromEntries(ids.map((id) => [id, true])) })
const PLANNOTATOR = { files: { 'hooks/hooks.json': PLANNOTATOR_HOOKS } }
const command = (name: string) => [{ type: 'command', command: name }]

describe("another enabled plugin's permission hooks win (the mod answers above them, so they would never run)", () => {
  test('a PermissionRequest hook that could run for Bash, in hooks/hooks.json or plugin.json', async () => {
    const shapes: Record<string, string | object>[] = [
      { 'hooks/hooks.json': { hooks: { PermissionRequest: [{ hooks: command('notify-phone') }] } } },
      { '.claude-plugin/plugin.json': { name: 'guard', hooks: { PermissionRequest: [{ matcher: '*', hooks: command('approve') }] } } },
      { '.claude-plugin/plugin.json': { name: 'guard', hooks: './more-hooks.json' }, 'more-hooks.json': { hooks: { PermissionRequest: [{ matcher: 'Bash|Write', hooks: command('scan') }] } } },
      { '.claude-plugin/plugin.json': { name: 'guard', hooks: ['${CLAUDE_PLUGIN_ROOT}/h.json'] }, 'h.json': { hooks: { PermissionRequest: [{ matcher: 'Ba.*', hooks: command('scan') }] } } },
    ]
    for (const files of shapes) {
      const world = pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files } })
      const settings = enabling('plannotator@plannotator', 'guard@tools')
      expect(await removalPrompt({ variable: '1', settings, env: { CLAUDE_CONFIG_DIR: world.configDir } })).toEqual(BENEATH)
      expect(await removalPrompt({ variable: '1', settings, env: { CLAUDE_CONFIG_DIR: world.configDir }, agentId: 'agent-7' })).toEqual(BENEATH)
    }
  })

  test("a plugin's PreToolUse hook on Bash: the waiver stays on while it does not ask, and its ask (on the verdict) keeps the prompt", async () => {
    const shapes: Record<string, string | object>[] = [
      { 'hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: command('scan') }] } } },
      { 'hooks/hooks.json': { hooks: { PreToolUse: [{ hooks: command('log') }] } } },
      { '.claude-plugin/plugin.json': { name: 'guard', hooks: './more-hooks.json' }, 'more-hooks.json': { hooks: { PreToolUse: [{ matcher: 'Bash|Write', hooks: command('scan') }] } } },
    ]
    for (const files of shapes) {
      const world = pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files } })
      const settings = enabling('plannotator@plannotator', 'guard@tools')
      const env = { CLAUDE_CONFIG_DIR: world.configDir }
      expect(await removalPrompt({ variable: '1', settings, env })).toEqual(ALLOWED)
      expect(await removalPrompt({ variable: '1', settings, env, agentId: 'agent-7' })).toEqual(ALLOWED)
      expect(await removalPrompt({ variable: '1', settings, env, verdict: { ...RM_ASK, hook: 'PreToolUse' } })).toEqual(BENEATH)
    }
  })

  test("Plannotator's own plan hooks, hooks on other tools or events, and a disabled plugin's hooks leave the waiver on", async () => {
    const world = pluginWorld({
      'plannotator@plannotator': PLANNOTATOR,
      'fmt@tools': { files: { 'hooks/hooks.json': { hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: command('fmt') }], PostToolUse: [{ matcher: '*', hooks: command('log') }] } } } },
      'skills@tools': { files: { '.claude-plugin/plugin.json': { name: 'skills' } } },
      'bare@tools': {},
      'notify@tools': { files: { 'hooks/hooks.json': { hooks: { PermissionRequest: [{ hooks: command('notify-phone') }] } } } },
    })
    const settings = { enabledPlugins: { 'plannotator@plannotator': true, 'fmt@tools': true, 'skills@tools': ['1.0.0'], 'bare@tools': true, 'notify@tools': false } }
    expect(await removalPrompt({ variable: '1', settings, env: { CLAUDE_CONFIG_DIR: world.configDir } })).toEqual(ALLOWED)
  })

  test('the registry is found under ~/.claude when CLAUDE_CONFIG_DIR is unset', async () => {
    const world = pluginWorld({ 'guard@tools': { files: { 'hooks/hooks.json': { hooks: { PermissionRequest: [{ hooks: command('notify-phone') }] } } } } })
    writeFile(join(world.root, '.claude', 'plugins', 'installed_plugins.json'), readFileSync(join(world.configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    expect(await removalPrompt({ variable: '1', settings: enabling('guard@tools'), env: { HOME: world.root } })).toEqual(BENEATH)
    const quiet = pluginWorld({ 'plannotator@plannotator': PLANNOTATOR })
    writeFile(join(quiet.root, '.claude', 'plugins', 'installed_plugins.json'), readFileSync(join(quiet.configDir, 'plugins', 'installed_plugins.json'), 'utf8'))
    expect(await removalPrompt({ variable: '1', settings: enabling('plannotator@plannotator'), env: { HOME: quiet.root } })).toEqual(ALLOWED)
  })

  test('a plugin whose hooks the mod cannot read steps aside', async () => {
    const worlds = [
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files: { 'hooks/hooks.json': '{ not json' } } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files: { '.claude-plugin/plugin.json': '{ not json' } } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files: { '.claude-plugin/plugin.json': { name: 'guard', hooks: './missing.json' } } } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files: { '.claude-plugin/plugin.json': { name: 'guard', hooks: '${OTHER_ROOT}/h.json' } } } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { files: { 'hooks/hooks.json': { hooks: { PermissionRequest: 'not a list' } } } } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': { registered: false } }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': {} }, { registry: null }),
      pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'guard@tools': {} }, { registry: '{ not json' }),
    ]
    for (const world of worlds) {
      const settings = enabling('plannotator@plannotator', 'guard@tools')
      expect(await removalPrompt({ variable: '1', settings, env: { CLAUDE_CONFIG_DIR: world.configDir } })).toEqual(BENEATH)
    }
  })
})

describe("a call's verdict is read by its own prompt only", () => {
  const input = { command: COMMAND }

  test('once', () => {
    const asks = new RemovalAsks()
    asks.note(removalAskKey(undefined, input), RM_ASK)
    expect(asks.take(removalAskKey(undefined, input))).toBe(true)
    expect(asks.take(removalAskKey(undefined, input))).toBe(false)
  })

  test("in its own loop: a subagent's verdict never answers the main loop's prompt or another subagent's", () => {
    const asks = new RemovalAsks()
    asks.note(removalAskKey('agent-7', input), RM_ASK)
    expect(asks.take(removalAskKey(undefined, input))).toBe(false)
    expect(asks.take(removalAskKey('agent-8', input)), 'another subagent').toBe(false)
    expect(asks.take(removalAskKey('agent-7', input))).toBe(true)
  })

  test('within a few seconds', () => {
    let now = 0
    const asks = new RemovalAsks(() => now)
    asks.note(removalAskKey(undefined, input), RM_ASK)
    now = REMOVAL_ASK_TTL_MS + 1
    expect(asks.take(removalAskKey(undefined, input))).toBe(false)
    now = 0
    asks.note(removalAskKey(undefined, input), RM_ASK)
    now = REMOVAL_ASK_TTL_MS - 1
    expect(asks.take(removalAskKey(undefined, input))).toBe(true)
  })
})

describe('the debug log', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  const lines = (ran: string[]) => ran.join('').split('\n').filter((line) => / (Bash ask|removal prompt) \(/.test(line))

  test('with the variable off, Bash asks and their prompts write no line', async () => {
    const ran: string[] = []
    expect(await removalPrompt({ env: { PLANNOTATOR_MOD_DEBUG: '1' }, ran })).toEqual(BENEATH)
    await settle()
    expect(lines(ran)).toEqual([])
  })

  test('with the variable on, both are logged', async () => {
    const ran: string[] = []
    expect(await removalPrompt({ variable: '1', env: { PLANNOTATOR_MOD_DEBUG: '1' }, ran })).toEqual(ALLOWED)
    await settle()
    expect(lines(ran)).toHaveLength(2)
  })

  test('a prompt left to the dialog says what kept it', async () => {
    const world = pluginWorld({ 'plannotator@plannotator': PLANNOTATOR, 'notify@tools': { files: { 'hooks/hooks.json': { hooks: { PermissionRequest: [{ hooks: command('notify-phone') }] } } } } })
    const cases: [Parameters<typeof removalPrompt>[0], RegExp][] = [
      [{ settings: { permissions: { deny: ['Bash(git push --force*)'] } } }, /left to the dialog: a permissions\.deny rule on Bash/],
      [{ settings: { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: command('notify') }] } } }, /left to the dialog: a PermissionRequest hook in the settings/],
      [{ settings: enabling('plannotator@plannotator', 'notify@tools'), env: { CLAUDE_CONFIG_DIR: world.configDir } }, /left to the dialog: the enabled plugin notify@tools has a PermissionRequest hook/],
      [{ settings: enabling('ghost@builtin'), env: { CLAUDE_CONFIG_DIR: world.configDir } }, /left to the dialog: the enabled plugin ghost@builtin is not in the plugin registry/],
      [{ mode: 'default' }, /left to the dialog: not in bypass permissions mode/],
      [{ verdict: { ...RM_ASK, hook: 'PreToolUse' } }, /left to the dialog: not a removal-check ask alone/],
    ]
    for (const [options, expected] of cases) {
      const ran: string[] = []
      expect(await removalPrompt({ variable: '1', ...options, env: { PLANNOTATOR_MOD_DEBUG: '1', ...options.env }, ran })).toEqual(BENEATH)
      await settle()
      expect(lines(ran).at(-1)).toMatch(expected)
    }
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
