/**
 * PLANNOTATOR_SESSION_PROJECT, which the mod exports beside
 * PLANNOTATOR_SESSION_TAG so the session's shell commands (`plannotator inbox
 * call`, `plannotator card`) file where its `plannotator_inbox` tool does.
 * What can regress: the value following the shell's `cd` (the split the audit
 * found, D1), not following a `/cd`, naming a folder that is gone, or a write
 * on every Bash call. Where it lands is proved end to end in
 * packages/server/inbox-project.model.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { PlannotatorMod } from './controller'
import { fakeHost } from './testing/fake-host'

function session(where: { root: string; cwd: string }, inbox: boolean) {
  const host = fakeHost()
  const exported: string[] = []
  host.setSessionProject = async (value) => void exported.push(value)
  for (const folder of ['/w/top', '/w/top/repo', '/w/top/repo/src']) host.files.set(folder, '')
  const mod = new PlannotatorMod(host, {
    sessionId: 's1',
    dataDir: '/data',
    interactive: true,
    root: async () => where.root,
    cwd: async () => where.cwd,
    ...(inbox ? { inboxTools: [] } : {}),
  })
  return { host, mod, exported }
}

describe('the session project its shell inherits', () => {
  for (const inbox of [true, false]) {
    test(`names the root, never the shell's folder; a /cd moves it; written once per change (${inbox ? 'with' : 'without'} the Inbox tool)`, async () => {
      const where = { root: '/w/top', cwd: '/w/top' }
      const { mod, exported } = session(where, inbox)
      try {
        await mod.exportSessionProject()
        where.cwd = '/w/top/repo/src' // a shell cd
        await mod.exportSessionProject()
        await mod.exportSessionProject()
        where.root = where.cwd = '/w/top/repo' // Claude Code's /cd
        await mod.exportSessionProject()
        expect(exported).toEqual(['claude-code:s1:/w/top', 'claude-code:s1:/w/top/repo'])
      } finally {
        mod.dispose()
      }
    })
  }

  test('a start folder that is gone gives way to the working folder, as the tool does', async () => {
    const where = { root: '/w/deleted-scratch', cwd: '/w/top/repo' }
    const { mod, exported } = session(where, true)
    try {
      await mod.exportSessionProject()
      expect(exported).toEqual(['claude-code:s1:/w/top/repo'])
      expect(await mod.inbox!.projectFolder()).toBe('/w/top/repo')
    } finally {
      mod.dispose()
    }
  })

  test('a failed write is tried again on the next call', async () => {
    const where = { root: '/w/top', cwd: '/w/top' }
    const { host, mod, exported } = session(where, false)
    let refuse = true
    host.setSessionProject = async (value) => {
      if (refuse) throw new Error('env.set refused')
      exported.push(value)
    }
    try {
      await mod.exportSessionProject()
      refuse = false
      await mod.exportSessionProject()
      expect(exported).toEqual(['claude-code:s1:/w/top'])
    } finally {
      mod.dispose()
    }
  })
})

// The three places register.ts exports it (review of #2528): the instance switch, the main loop's turn start and
// each Bash call. Each step below moves the root where only that trigger can see it, so removing any one fails.
// And a hung write never holds a Bash call.
type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  register(((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string) => held.get(event)!
}

const realSleep = (ms: number, options?: { signal?: AbortSignal }) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    options?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })

function engine() {
  const files = new Set(['/bin/sh', '/w/top', '/w/top/repo', '/w/top/repo/src', '/w/other'])
  const env = new Map<string, string>([
    ['HOME', '/home/me'],
    ['PLANNOTATOR_DATA_DIR', '/data'],
  ])
  const store = new Map<string, unknown>()
  const world = {
    root: '/w/top',
    env,
    /** Set to hold every PLANNOTATOR_SESSION_PROJECT write until released. */
    hold: null as Promise<void> | null,
    $: {
      env: {
        get: async (name: string) => env.get(name),
        set: async (name: string, value: string) => {
          if (name === 'PLANNOTATOR_SESSION_PROJECT' && world.hold) await world.hold
          env.set(name, value)
        },
      },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async () => {
          throw new Error('ENOENT')
        },
        write: async () => undefined,
        stat: async () => null,
      },
      session: {
        id: async () => 'sess-wire',
        cwd: async () => '/w/top/repo/src',
        root: async () => world.root,
        messages: async () => [],
        version: async () => ({ version: '2.1.316', base: '2.1.316' }),
      },
      clock: { now: async () => 1_000_000, sleep: realSleep, every: () => ({ cancel: () => undefined }) },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      http: { fetch: async () => ({ status: 200, ok: true, text: '{}' }) },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

async function settle() {
  for (let spin = 0; spin < 50; spin += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the hooks that export it', () => {
  test('the session start, a main-loop turn start and a Bash call each export the root; a subagent turn does not', async () => {
    const hook = await freshHooks('session-project-wiring')
    const world = engine()
    const { $ } = world
    const pass = (e: unknown) => e
    await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/w/top/repo/src' }))
    await settle()
    // The instance switch alone (no turn yet).
    expect(world.env.get('PLANNOTATOR_SESSION_PROJECT')).toBe('claude-code:sess-wire:/w/top')

    // A /cd between turns: the main loop's next turn start names it; a subagent's does not.
    world.root = '/w/top/repo'
    await hook('turn.start')($, { turnId: 'turn-sub', text: '', agentId: 'agent-1' }, pass)
    expect(world.env.get('PLANNOTATOR_SESSION_PROJECT')).toBe('claude-code:sess-wire:/w/top')
    await hook('turn.start')($, { turnId: 'turn-1', text: '' }, pass)
    expect(world.env.get('PLANNOTATOR_SESSION_PROJECT')).toBe('claude-code:sess-wire:/w/top/repo')

    // A worktree move inside the turn: the next Bash call names it before the command runs.
    world.root = '/w/other'
    let seenByCommand: string | undefined
    await hook('tool.call')($, { tool: 'Bash', command: 'plannotator card list' }, (e: unknown) => ((seenByCommand = world.env.get('PLANNOTATOR_SESSION_PROJECT')), e))
    expect(seenByCommand).toBe('claude-code:sess-wire:/w/other')
  })

  test('a hung write holds neither the session start nor a Bash call, and lands once it is let go', async () => {
    const hook = await freshHooks('session-project-hung')
    const world = engine()
    let release = () => {}
    world.hold = new Promise<void>((resolve) => (release = resolve))
    const started = performance.now()
    await hook('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: '/w/top/repo/src' }))
    // A worktree move: the Bash call has a new value to write, and that write hangs too.
    world.root = '/w/other'
    let ran = false
    await hook('tool.call')(world.$, { tool: 'Bash', command: 'ls' }, (e: unknown) => ((ran = true), e))
    expect(ran).toBe(true)
    // Bounded (250 ms per wait), never held until the write lands.
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(world.env.get('PLANNOTATOR_SESSION_PROJECT')).toBeUndefined()
    world.hold = null
    release()
    await settle()
    expect(world.env.get('PLANNOTATOR_SESSION_PROJECT')).toBe('claude-code:sess-wire:/w/other')
  })
})
