/**
 * A Claude Code session for the mod's proofs that talk to a REAL Plannotator
 * process (the Inbox binary): the mod's `Host` made of real processes, real
 * HTTP and real files (`$.process.run`, `$.http.fetch`, `$.fs` as the engine
 * runs them), with the conversation simulated the way register.ts feeds it:
 * turns start and complete, the person types at idle or into a running turn,
 * and `$.prompt.submit` waits for the session to be idle before its turn
 * starts (a pending submit cannot be withdrawn).
 *
 * `claude plugin test` (the engine harness, apps/hook/tests/) has no process,
 * network or file access, so it covers register.ts's wiring with the engine's
 * own `$`; these sessions cover what the mod does against the real Inbox.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PlannotatorMod } from '../controller'
import type { Host, HttpResult, ProcessResult } from '../host'
import { discoverInboxTools } from '../inbox'
import type { InboxToolInfo } from '../inbox-contract'

/** The engine's frame around a plugin's prompt at `turn.start`. */
export const PLUGIN_FRAME = 'The plannotator plugin sent a message: '

export interface RealHostOptions {
  /** The environment every process the session starts gets (PATH, HOME, PLANNOTATOR_DATA_DIR, ...). */
  env: Record<string, string>
  /** The session's working folder (`$.process.run`'s default cwd). */
  cwd: string
  /** `$.store`, shared by the processes of one plugin. */
  store: Map<string, unknown>
}

export interface RealHost extends Host {
  /** What `$.prompt.submit` was asked to send, in order. */
  submits: string[]
  toasts: string[]
  logs: string[]
  aborted: string[]
  fetches: string[]
  timers: Set<ReturnType<typeof setInterval>>
  /** Set by the session: `$.prompt.submit`'s turn. */
  onSubmit: (text: string) => Promise<void>
}

export function realHost(options: RealHostOptions): RealHost {
  const host: RealHost = {
    submits: [],
    toasts: [],
    logs: [],
    aborted: [],
    fetches: [],
    timers: new Set(),
    onSubmit: async () => undefined,
    now: async () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          },
          { once: true },
        )
      }),
    waitForAny: async (paths, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !paths.some((path) => existsSync(path))) await new Promise((resolve) => setTimeout(resolve, 50))
    },
    every: (ms, fn) => {
      const timer = setInterval(fn, ms)
      host.timers.add(timer)
      return {
        cancel: () => {
          clearInterval(timer)
          host.timers.delete(timer)
        },
      }
    },
    run: async (argv, init) => {
      const proc = Bun.spawn([...argv], {
        cwd: init?.cwd ?? options.cwd,
        env: { ...options.env, ...init?.env },
        stdin: init?.stdin !== undefined ? new TextEncoder().encode(init.stdin) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timeout = setTimeout(() => proc.kill('SIGKILL'), init?.timeoutMs ?? 600_000)
      try {
        const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { exitCode, stdout, stderr } satisfies ProcessResult
      } finally {
        clearTimeout(timeout)
      }
    },
    readFile: async (path) => readFileSync(path, 'utf8'),
    writeFile: async (path, text) => writeFileSync(path, text),
    exists: async (path) => existsSync(path),
    fileSize: async (path) => (existsSync(path) ? readFileSync(path).length : null),
    storeGet: async (key) => options.store.get(key),
    storeSet: async (key, value) => {
      options.store.set(key, JSON.parse(JSON.stringify(value)))
    },
    submit: async (text) => {
      host.submits.push(text)
      await host.onSubmit(text)
    },
    suggest: async () => undefined,
    status: () => undefined,
    log: (text) => host.logs.push(text),
    toast: (text) => host.toasts.push(text),
    messages: async () => [],
    fetch: async (url, init) => {
      host.fetches.push(`${init.method} ${url}`)
      const response = await fetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) })
      return { status: response.status, ok: response.ok, text: await response.text() } satisfies HttpResult
    },
    abortTurn: async (turnId) => {
      host.aborted.push(turnId)
    },
    randomHex: (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    debug: () => undefined,
    sha256: async (text) => new Bun.CryptoHasher('sha256').update(text).digest('hex'),
  }
  return host
}

/** One Claude Code process on one session, wired to the mod as register.ts wires it. */
export class ClaudeSession {
  readonly host: RealHost
  mod: PlannotatorMod
  readonly inboxTools: readonly InboxToolInfo[] | null
  /** The main-loop turn running now. */
  running: { id: string; text: string } | null = null
  /** Turns that started, with their text as `turn.start` saw it. */
  turns: { id: string; text: string }[] = []
  /** Keep the plugin's turns running until `endTurn` (default: they answer at once). */
  holdPluginTurns = false
  private idleWaiters: (() => void)[] = []
  private sequence = 0

  private constructor(host: RealHost, mod: PlannotatorMod, inboxTools: readonly InboxToolInfo[] | null, private readonly dataDir: string, private readonly cwd: string) {
    this.host = host
    this.mod = mod
    this.inboxTools = inboxTools
    host.onSubmit = (text) => this.pluginTurn(text)
  }

  /** `session.start`: decide the Inbox connection once (inbox.ts), then make the session's mod. */
  static async start(options: RealHostOptions & { sessionId: string; dataDir: string; snapshots?: { processId: string } }): Promise<ClaudeSession> {
    const host = realHost(options)
    const inboxTools = await discoverInboxTools(host, options.dataDir)
    const mod = new PlannotatorMod(host, {
      sessionId: options.sessionId,
      dataDir: options.dataDir,
      interactive: true,
      ...(inboxTools ? { inboxTools, cwd: async () => options.cwd } : {}),
      // Snapshots switched on (register.ts passes it when PLANNOTATOR_SNAPSHOTS resolves on).
      ...(options.snapshots ? { snapshots: options.snapshots } : {}),
    })
    return new ClaudeSession(host, mod, inboxTools, options.dataDir, options.cwd)
  }

  get sessionId(): string {
    return this.mod.session.sessionId
  }

  /** `/clear`: `session.end` disposes the instance; the next hook makes one for the new id (register.ts `currentMod`). */
  clear(newSessionId: string): void {
    this.mod.dispose()
    this.mod = new PlannotatorMod(this.host, {
      sessionId: newSessionId,
      dataDir: this.dataDir,
      interactive: true,
      ...(this.inboxTools ? { inboxTools: this.inboxTools, cwd: async () => this.cwd } : {}),
    })
  }

  /** The process quits (or the session ends for good). */
  quit(): void {
    this.mod.dispose()
    for (const timer of this.host.timers) clearInterval(timer)
    this.host.timers.clear()
  }

  /** The tool call register.ts answers for `mcp__plannotator__plannotator_inbox`. */
  callInbox(input: Record<string, unknown>, cwd: string): Promise<{ text: string } | { deny: string }> {
    if (!this.mod.inbox) throw new Error('no Inbox connection in this session')
    return this.mod.inbox.callTool(input, cwd)
  }

  async startTurn(text: string): Promise<string> {
    const id = `turn-${++this.sequence}`
    this.running = { id, text }
    this.turns.push({ id, text })
    await this.mod.onTurnStart(id, text)
    return id
  }

  endTurn(answer = 'Done.'): void {
    const turn = this.running
    if (!turn) return
    this.running = null
    this.mod.onTurnComplete(turn.id, answer, false)
    for (const wake of this.idleWaiters.splice(0)) wake()
  }

  /** The person presses Enter: at idle it starts a turn; mid-turn it joins the running one (take-over). */
  async type(text: string): Promise<void> {
    const ref = { fromUs: false, originKind: 'composer', ...(this.running ? { turnId: this.running.id } : {}) }
    this.mod.onPromptSubmitting(ref)
    this.mod.onPromptEntered({ ...ref, text })
    if (!this.running) await this.startTurn(text)
  }

  /** `$.prompt.submit`: waits for idle, then its turn starts under the plugin's frame. */
  private async pluginTurn(text: string): Promise<void> {
    while (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
    await this.startTurn(`${PLUGIN_FRAME}${text}`)
    if (!this.holdPluginTurns) setTimeout(() => this.endTurn('Thanks, on it.'), 20)
  }
}
