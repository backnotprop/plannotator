import { describe, expect, test } from 'bun:test'

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, Hook>()
  register(((event: string, ...args: unknown[]) => {
    if (!held.has(event)) held.set(event, args.at(-1) as Hook)
  }) as Parameters<typeof import('./register').register>[0])
  return (event: string) => held.get(event)!
}

async function settle() {
  for (let spin = 0; spin < 50; spin += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function engine() {
  const files = new Map<string, string>([['/bin/sh', '']])
  const env = new Map<string, string>([
    ['HOME', '/home/me'],
    ['PLANNOTATOR_DATA_DIR', '/data'],
  ])
  const store = new Map<string, unknown>()
  const timers = new Set<() => void>()
  const world = {
    files,
    runs: [] as string[][],
    submits: [] as string[],
    logs: [] as string[],
    answer: { drop: 'the session was stopped and nobody has sent input since' } as unknown,
    async tick() {
      for (const fn of [...timers]) fn()
      await settle()
    },
    $: {
      env: { get: async (name: string) => env.get(name), set: async (name: string, value: string) => void env.set(name, value) },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const text = files.get(path)
          if (text === undefined) throw new Error(`ENOENT: ${path}`)
          return text
        },
        write: async (path: string, text: string) => void files.set(path, text),
        stat: async (path: string) => (files.has(path) ? { kind: 'file', size: files.get(path)!.length } : null),
      },
      session: {
        id: async () => 'sess-submit',
        cwd: async () => '/w',
        root: async () => '/w',
        messages: async () => [],
        version: async () => ({ version: '2.1.316', base: '2.1.316' }),
      },
      clock: {
        now: async () => Date.now(),
        sleep: (ms: number, options?: { signal?: AbortSignal }) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms)
            options?.signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              resolve()
            })
          }),
        every: (_ms: number, fn: () => void) => {
          timers.add(fn)
          return { cancel: () => timers.delete(fn) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      process: {
        run: async (argv: string[]) => {
          world.runs.push(argv)
          if (argv[3] === 'plannotator-launch') {
            const dir = argv[4]!
            files.set(`${dir}/pid`, '4242\n')
            files.set(`${dir}/ready`, `${JSON.stringify({ url: 'http://localhost:4321', isRemote: false, port: 4321 })}\n`)
          } else if (argv[3] === 'plannotator-claim') {
            const dir = argv[4]!
            const by = files.get(`${dir}/settled/by`)
            if (by !== undefined) return { exitCode: by === argv[5] ? 0 : 3, stdout: '', stderr: '' }
            files.set(`${dir}/settled/by`, argv[5]!)
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      http: { fetch: async () => ({ status: 404, ok: false, text: '' }) },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: (text: string) => void world.logs.push(text), status: () => undefined, toast: () => undefined },
      prompt: {
        submit: async ({ text }: { text: string }) => {
          world.submits.push(text)
          return world.answer
        },
        suggest: async () => undefined,
      },
      turn: { abort: async () => undefined },
    },
  }
  return world
}

describe("register.ts's submit reads $.prompt.submit's answer", () => {
  test('a decision whose turn Claude Code drops is not marked delivered; after the person types it goes in once', async () => {
    const hook = await freshHooks('submit-drop')
    const world = engine()
    const { $ } = world
    const pass = (e: unknown) => e
    await hook('session.start')($, { isInteractive: true }, async () => ({ cwd: '/w' }))
    await settle()
    await hook('command.run')($, { command: 'plannotator-annotate', args: 'a.md' }, pass)
    const launch = world.runs.find((argv) => argv[3] === 'plannotator-launch')
    expect(launch).toBeDefined()
    const dir = launch![4]!

    world.files.set(`${dir}/result.json`, JSON.stringify({ v: 1, surface: 'annotate', decision: 'annotated', message: '# Markdown Annotations\n\nfix it', noop: false, annotationCount: 1 }))
    await world.tick()
    await world.tick()

    expect(world.submits).toHaveLength(1)
    expect(world.files.has(`${dir}/settled/delivered`)).toBe(false)
    expect(world.logs.some((line) => line.startsWith('Could not send'))).toBe(false)

    world.answer = undefined
    await hook('prompt.submit')($, { text: 'carry on', origin: { kind: 'composer' } }, async () => ({ text: 'carry on' }))
    await hook('turn.start')($, { turnId: 'turn-1', text: 'carry on' }, pass)
    await settle()

    expect(world.submits).toHaveLength(2)
    expect(world.submits[1]).toContain('fix it')
    expect(world.files.has(`${dir}/settled/delivered`)).toBe(true)
  })
})
