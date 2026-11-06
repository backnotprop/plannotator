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
import { disposesOnSessionEnd, healAction } from '../self-heal'
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
  /** User rows `$.session.append` put into the conversation (Send now), in order. */
  appended: string[]
  /** Notices `$.session.append` put into the transcript, in order. */
  notices: string[]
  toasts: string[]
  logs: string[]
  aborted: string[]
  fetches: string[]
  timers: Set<ReturnType<typeof setInterval>>
  /** Set by the session: `$.prompt.submit`'s turn. */
  onSubmit: (text: string) => Promise<void>
  /** Called as `$.session.append` stores a user row (a test ends the turn here). */
  onAppend: (text: string) => Promise<void>
  /** Called before every `$.process.run` (a test acts at a given step, e.g. the delivery claim). */
  onRun: (argv: readonly string[]) => void
}

export function realHost(options: RealHostOptions): RealHost {
  const host: RealHost = {
    submits: [],
    appended: [],
    notices: [],
    toasts: [],
    logs: [],
    aborted: [],
    fetches: [],
    timers: new Set(),
    onSubmit: async () => undefined,
    onAppend: async () => undefined,
    onRun: () => undefined,
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
      host.onRun(argv)
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
    appendUserRow: async (text) => {
      host.appended.push(text)
      await host.onAppend(text)
    },
    sessionAppendAvailable: async () => true,
    appendNotice: async (text) => {
      host.notices.push(text)
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
  private idleWaiters: ((discarded: boolean) => void)[] = []
  private discarding = false
  private sequence = 0

  private constructor(host: RealHost, mod: PlannotatorMod, inboxTools: readonly InboxToolInfo[] | null, private readonly dataDir: string, private readonly cwd: string) {
    this.host = host
    this.mod = mod
    this.inboxTools = inboxTools
    host.onSubmit = (text) => this.pluginTurn(text)
  }

  /** `session.start`: decide the Inbox connection once (inbox.ts), then make the session's mod. */
  static async start(options: RealHostOptions & { sessionId: string; dataDir: string }): Promise<ClaudeSession> {
    const host = realHost(options)
    const inboxTools = await discoverInboxTools(host, options.dataDir)
    const mod = new PlannotatorMod(host, {
      sessionId: options.sessionId,
      dataDir: options.dataDir,
      interactive: true,
      ...(inboxTools ? { inboxTools, cwd: async () => options.cwd } : {}),
    })
    return new ClaudeSession(host, mod, inboxTools, options.dataDir, options.cwd)
  }

  get sessionId(): string {
    return this.mod.session.sessionId
  }

  /** `/clear`: `session.end` disposes the instance; the next hook makes one for the new id (register.ts `currentMod`). */
  clear(newSessionId: string): void {
    const previous = this.mod
    previous.dispose()
    this.mod = new PlannotatorMod(this.host, {
      sessionId: newSessionId,
      dataDir: this.dataDir,
      interactive: true,
      ...(this.inboxTools ? { inboxTools: this.inboxTools, cwd: async () => this.cwd } : {}),
    })
    this.mod.carryQueued(previous)
  }

  /**
   * An engine that discards the plugin prompts still waiting for idle (a build
   * that does so at `/clear`): their `$.prompt.submit` rejects when the running
   * turn ends, and no turn starts for them.
   */
  discardQueuedPrompts(): void {
    this.discarding = true
  }

  /** The process quits (or the session ends for good). */
  quit(): void {
    this.mod.dispose()
    for (const timer of this.host.timers) clearInterval(timer)
    this.host.timers.clear()
  }

  /** When this session's own `endSession` disposed the instance (self-heal.ts `healAction`). */
  private endedAt: number | null = null

  /**
   * `session.end` raised with `sessionId` (and `agentId` for a subagent's): the
   * instance is disposed only when register.ts would (`disposesOnSessionEnd`).
   * The process goes on either way. Returns whether it disposed.
   */
  endSession(sessionId: string, agentId?: string): boolean {
    const current = this.mod.isDisposed ? null : this.mod
    const disposes = disposesOnSessionEnd(current ? current.session : null, { sessionId, ...(agentId ? { agentId } : {}) })
    if (current && disposes) {
      current.dispose()
      this.endedAt = Date.now()
    }
    return disposes
  }

  /**
   * A stand-in for register.ts's self-heal (whose wiring
   * register-self-heal.test.ts proves on the real hooks), every `everyMs`
   * (MOD_HEAL_EVERY_MS there), for proofs against a real Inbox: a
   * disposed instance is made again for the same session id, quietly (no
   * touch), and a live one's Inbox tick is looked at.
   */
  startSelfHeal(everyMs: number): void {
    let healing = false
    this.host.every(everyMs, () => {
      if (healing) return
      healing = true
      void (async () => {
        const action = healAction(this.mod, this.endedAt, Date.now(), everyMs)
        if (action === 'check') return await this.mod.inbox?.ensureTicking()
        if (action === 'wait') return
        const previous = this.mod
        this.mod = new PlannotatorMod(this.host, {
          sessionId: previous.session.sessionId,
          dataDir: this.dataDir,
          interactive: true,
          healed: true,
          ...(this.inboxTools ? { inboxTools: this.inboxTools, cwd: async () => this.cwd } : {}),
        })
        this.mod.carryQueued(previous)
      })().finally(() => {
        healing = false
      })
    })
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

  /** A main-loop model request of the running turn goes out (`turn.step`). */
  step(): void {
    if (this.running) this.mod.onMainStep(this.running.id)
  }

  /** The running turn completes; `aborted` as the engine reports a turn `$.turn.abort` stopped. */
  endTurn(answer = 'Done.', aborted = false): void {
    const turn = this.running
    if (!turn) return
    this.running = null
    this.mod.onTurnComplete(turn.id, answer, aborted)
    const discarded = this.discarding
    this.discarding = false
    for (const wake of this.idleWaiters.splice(0)) wake(discarded)
  }

  /** The person presses Enter: at idle it starts a turn; mid-turn it joins the running one (take-over). */
  async type(text: string): Promise<void> {
    const ref = { fromUs: false, originKind: 'composer', ...(this.running ? { turnId: this.running.id } : {}) }
    this.mod.onPromptSubmitting(ref)
    this.mod.onPromptEntered({ ...ref, text })
    if (!this.running) await this.startTurn(text)
  }

  /**
   * Another plugin's `$.prompt.submit` (a connector delivering its own message), at idle: our
   * prompt.submit hook sees it bare with origin `plugin`, then its turn starts under that plugin's frame.
   */
  async otherPluginPrompt(name: string, text: string): Promise<string> {
    if (this.running) throw new Error('another plugin prompts at idle')
    const ref = { fromUs: false, originKind: 'plugin' }
    this.mod.onPromptSubmitting(ref)
    this.mod.onPromptEntered({ ...ref, text })
    return this.startTurn(`The ${name} plugin sent a message: ${text}`)
  }

  /** `$.prompt.submit`: waits for idle, then its turn starts under the plugin's frame. */
  private async pluginTurn(text: string): Promise<void> {
    while (this.running) {
      const discarded = await new Promise<boolean>((resolve) => this.idleWaiters.push(resolve))
      if (discarded) throw new Error('The engine discarded the prompt.')
    }
    await this.startTurn(`${PLUGIN_FRAME}${text}`)
    if (!this.holdPluginTurns) setTimeout(() => this.endTurn('Thanks, on it.'), 20)
  }
}
