import { describe, expect, test } from 'bun:test'
import { grillMeNoteText } from './grill-me'
import { inboxRegistryPathOf } from './inbox'

// The grill-me note through the real registered hooks. The failures this
// catches: a typed `/grill-me` (any author's, namespaced too) or a grill-me
// skill the model runs through the Skill tool no longer carrying the note; Matt
// Pocock's `/grill-me`, which calls the Skill tool with `grilling` in the same
// turn, getting it twice; and the note reaching a session it should not: an
// unrelated skill, a subagent, a computer where the Inbox never ran, or a
// person who turned the Inbox reminder off.

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const TOOL = 'mcp__plugin_plannotator__plannotator_inbox'
const NOTE = grillMeNoteText(TOOL)

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

/** A fresh copy of register.ts (its module state is per process), and its first hook for each event. */
async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  register(((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string) => held.get(event)!
}

/** The `$` the module runs on, in memory; `inboxRan`: the Inbox's registry file exists. */
function engineOver(options: { inboxRan?: boolean; config?: Record<string, unknown> } = {}) {
  const files = new Map<string, string>([['/bin/sh', '']])
  if (options.inboxRan !== false) files.set(inboxRegistryPathOf(DATA), REGISTRY)
  if (options.config) files.set(`${DATA}/config.json`, JSON.stringify(options.config))
  const store = new Map<string, unknown>()
  return {
    plugin: { root: '/plugins/plannotator' },
    env: { get: async (name: string) => (name === 'HOME' ? '/home/me' : name === 'PLANNOTATOR_DATA_DIR' ? DATA : undefined), set: async () => undefined },
    fs: {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`ENOENT: ${path}`)
        return text
      },
      write: async (path: string, text: string) => void files.set(path, text),
      stat: async () => null,
    },
    session: {
      id: async () => 'sess-grill',
      cwd: async () => '/home/me/src/app',
      root: async () => '/home/me/src/app',
      messages: async () => [],
      version: async () => ({ version: '2.1.319', base: '2.1.319' }),
    },
    clock: {
      now: async () => 1_000_000,
      sleep: (ms: number, opts?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(ms, 5))
          opts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        }),
      every: () => ({ cancel: () => undefined }),
    },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
    process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
    http: { fetch: async () => ({ status: 200, ok: true, text: JSON.stringify({ commands: [] }) }) },
    tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
    command: { list: async () => [], register: async () => undefined, run: async () => ({}) },
    agent: { list: async () => [] },
    ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
    prompt: { submit: async () => undefined, suggest: async () => undefined, read: async () => ({ text: '', cursor: 0 }) },
    turn: { abort: async () => undefined },
  }
}

const composer = { kind: 'composer' }

/** What the engine beneath hands back for a prompt: it entered, with the context it was given. */
const entered = (e: any) => ({ text: e.text, context: e.context, origin: e.origin })
/** What the engine beneath hands back for a Skill call. */
const skillRan = () => ({ ref: 1, result: { success: true, commandName: 'grill-me' }, text: 'Launching skill' })

async function started(name: string, options?: Parameters<typeof engineOver>[0]) {
  const hook = await freshHooks(name)
  const $ = engineOver(options)
  await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/home/me/src/app' }))
  /** The context a typed command's prompt entered with. */
  const typed = async (command: string) => {
    let seen: any = null
    await hook('prompt.submit')($, { text: `/${command}`, command: { name: command, args: '' }, origin: composer, wait: false }, (e: any) => {
      seen = e
      return entered(e)
    })
    return (seen?.context ?? []) as string[]
  }
  /** The context a Skill call's result came back with. */
  const skill = async (skillName: string, extra: Record<string, unknown> = {}) => {
    const result = (await hook('tool.call')($, { tool: 'Skill', skill: skillName, tool_use_id: 'tu', ...extra }, skillRan)) as any
    return (result?.context ?? []) as string[]
  }
  const turnEnds = () => hook('turn.complete')($, { turnId: 't1', answer: '' }, (e: unknown) => e)
  const end = () => hook('session.end')($, {}, (e: unknown) => e)
  return { typed, skill, turnEnds, end }
}

describe('the grill-me note through the registered hooks', () => {
  test('a typed grill-me command carries it; the Skill call it makes in that turn does not add it again; a later run does', async () => {
    const s = await started('grill-typed')
    expect(await s.typed('grill-me')).toEqual([NOTE])
    expect(await s.skill('grilling')).toEqual([])
    await s.turnEnds()
    expect(await s.skill('team:grill_me')).toEqual([NOTE])
    await s.turnEnds()
    expect(await s.typed('mattpocock:grill-me')).toEqual([NOTE])
    await s.end()
  })

  test('never for another skill or command, nor a subagent\'s grill-me', async () => {
    const s = await started('grill-others')
    expect(await s.typed('grilled-cheese')).toEqual([])
    expect(await s.typed('review')).toEqual([])
    expect(await s.skill('grill-menu')).toEqual([])
    expect(await s.skill('grill-me', { agentId: 'agent-1' })).toEqual([])
    await s.end()
  })

  test('only where the Inbox has run on this computer', async () => {
    const s = await started('grill-no-inbox', { inboxRan: false })
    expect(await s.typed('grill-me')).toEqual([])
    expect(await s.skill('grill-me')).toEqual([])
    await s.end()
  })

  test('the Inbox reminder switch turns it off too', async () => {
    const s = await started('grill-reminder-off', { config: { inboxReminder: false } })
    expect(await s.typed('grill-me')).toEqual([])
    expect(await s.skill('grill-me')).toEqual([])
    await s.end()
  })
})
