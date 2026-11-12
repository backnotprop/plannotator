import type { Host, HttpResult, ProcessResult, TranscriptMessage } from '../host'

export interface RunCall {
  argv: readonly string[]
  env?: Record<string, string>
}

export interface FakeHost extends Host {
  files: Map<string, string>
  store: Map<string, unknown>
  runs: RunCall[]
  submits: string[]
  suggests: string[]
  logs: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  aborted: string[]
  transcript: TranscriptMessage[]
  onRun: (call: RunCall) => ProcessResult | void
  onFetch: (url: string, body: unknown) => Promise<HttpResult> | HttpResult
  onWait: (paths: readonly string[]) => void
  tick(): Promise<void>
  clock: number
}

export function fakeHost(): FakeHost {
  const timers = new Set<() => void>()
  const host: FakeHost = {
    files: new Map(),
    store: new Map(),
    runs: [],
    submits: [],
    suggests: [],
    logs: [],
    toasts: [],
    statuses: [],
    aborted: [],
    transcript: [],
    clock: 1_000_000,
    onRun: () => undefined,
    onFetch: () => ({ status: 404, ok: false, text: '' }),
    onWait: () => undefined,
    async tick() {
      for (const fn of [...timers]) fn()
      for (let index = 0; index < 500; index += 1) await Promise.resolve()
    },
    now: async () => host.clock,
    sleep: async (ms) => {
      host.clock += ms
    },
    waitForAny: async (paths, ms) => {
      if (paths.some((path) => host.files.has(path))) return
      host.onWait(paths)
      if (!paths.some((path) => host.files.has(path))) host.clock += ms
    },
    every: (_ms, fn) => {
      timers.add(fn)
      return { cancel: () => timers.delete(fn) }
    },
    run: async (argv, init) => {
      const call: RunCall = { argv, env: init?.env }
      host.runs.push(call)
      const answered = host.onRun(call)
      if (answered) return answered
      if (argv[3] === 'plannotator-launch') {
        const dir = argv[4] as string
        if (!host.files.has(`${dir}/pid`)) host.files.set(`${dir}/pid`, '4242\n')
      } else if (argv[3] === 'plannotator-rm') {
        host.files.delete(argv[4] as string)
      } else if (argv[3] === 'plannotator-claim') {
        const dir = argv[4] as string
        const me = argv[5] as string
        const by = host.files.get(`${dir}/settled/by`)
        if (by !== undefined) return { exitCode: by === me ? 0 : 3, stdout: '', stderr: '' }
        host.files.set(`${dir}/settled`, '')
        host.files.set(`${dir}/settled/by`, me)
        return { exitCode: host.files.has(`${dir}/stdin`) ? 0 : 3, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    readFile: async (path) => {
      const text = host.files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    writeFile: async (path, text) => {
      host.files.set(path, text)
    },
    exists: async (path) => host.files.has(path),
    fileSize: async (path) => {
      const text = host.files.get(path)
      return text === undefined ? null : new TextEncoder().encode(text).length
    },
    storeGet: async (key) => host.store.get(key),
    storeSet: async (key, value) => {
      host.store.set(key, JSON.parse(JSON.stringify(value)))
    },
    submit: async (text) => {
      host.submits.push(text)
    },
    suggest: async (text) => {
      host.suggests.push(text)
    },
    status: (text) => host.statuses.push(text),
    log: (text) => host.logs.push(text),
    toast: (text) => host.toasts.push(text),
    messages: async () => host.transcript,
    fetch: async (url, init) => host.onFetch(url, init.body === undefined ? undefined : JSON.parse(init.body)),
    abortTurn: async (turnId) => {
      host.aborted.push(turnId)
    },
    randomHex: (bytes) => 'ab'.repeat(bytes),
    debug: () => undefined,
    sha256: async (text) => {
      let hash = 0
      for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
      return `h${hash.toString(16)}-${text.length}`
    },
  }
  return host
}
