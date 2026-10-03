/**
 * A `Host` made of memory for the mod's bun tests: a file map, a manual clock
 * and timers, recorded process runs, submits, logs and fetches.
 */

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
  /** Answer a process run (the detached launcher, the liveness probe). */
  onRun: (call: RunCall) => ProcessResult | void
  /** Answer a fetch (the bridge). */
  onFetch: (url: string, body: unknown) => Promise<HttpResult> | HttpResult
  /** Called whenever the code under test waits; tests create files here. */
  onWait: (paths: readonly string[]) => void
  /** Run every timer once (one tick). */
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
      // Let the async work the timers started settle.
      for (let index = 0; index < 50; index += 1) await Promise.resolve()
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
      return host.onRun(call) ?? { exitCode: 0, stdout: '', stderr: '' }
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
    fetch: async (url, init) => host.onFetch(url, JSON.parse(init.body)),
    abortTurn: async (turnId) => {
      host.aborted.push(turnId)
    },
    randomHex: (bytes) => 'ab'.repeat(bytes),
    debug: () => undefined,
    sha256: async (text) => {
      // Not SHA-256; a stable digest is all the tests need.
      let hash = 0
      for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
      return `h${hash.toString(16)}-${text.length}`
    },
  }
  return host
}
