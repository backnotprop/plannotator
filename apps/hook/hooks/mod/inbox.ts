/**
 * The Claude Code connection to the Plannotator Inbox (plan step 6): the
 * `plannotator_inbox` tool and the reply wake. One `InboxLink` per session,
 * owned by that session's `PlannotatorMod`.
 *
 * Found or not: only where `inbox/inbox.json` exists at session start (the
 * person ran the Inbox once) and the inbox tool switch allows it
 * (`resolveInboxToolEnabled`); otherwise nothing is registered and nothing
 * polls. The tool's actions are the Inbox's own MCP tools, read from its
 * `/mcp` once at session start (`discoverInboxTools`); an older Inbox offers
 * fewer, and the tool simply has fewer actions. The tool list never changes
 * under a running session.
 *
 * The tool: each call re-reads the registry (never caching the port or
 * token), starts a stopped Inbox with `plannotator inbox --background` (it
 * detaches into its own session and never opens a browser), and proxies the
 * call to the Inbox's `/mcp` with `project_path` the session's working folder
 * and `agent_session` the host's real session id.
 *
 * The wake: a 1 s tick long-polls `POST /api/inbox/bridge/poll` (bearer token,
 * no Origin) for the person's replies to this session's messages, with a 5 to
 * 60 s backoff that never gives up for good. A reply waits HERE until the
 * session has been idle for a tick (a pending `$.prompt.submit` cannot be
 * withdrawn, and a prompt the person typed, or a `/clear`, queued during a
 * turn goes first), is checked once more with the Inbox, claimed once across
 * processes, submitted as a turn (`inboxWakeText`), and acknowledged
 * (`delivered`), which the thread shows as "Delivered to Claude Code, <time>".
 *
 * Two Claude Code processes on one session (`claude --continue` while the
 * first still runs): one of them polls and delivers, the holder of the
 * session's inbox lease (`watcher.json`, the person's last process wins, as
 * for reviews); a delivery is also claimed once per reply (mkdir), so a lease
 * race can never deliver twice. A reply another process claimed and never
 * delivered (it quit while the turn waited) is said once, with a toast.
 */

import type { Host, HttpResult } from './host'
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  inboxToolCall,
  inboxToolResultText,
  inboxWakeText,
  parseInboxBridgeCommands,
  parseInboxRegistry,
  parseInboxToolList,
  type InboxRegistryView,
  type InboxReplyCommand,
  type InboxToolInfo,
} from './inbox-contract'
import { privateDirArgv } from './launch'

/** The host this connection names on its messages and deliveries. */
export const INBOX_HOST = 'claude-code'
/** How the person sees this agent in the Inbox. */
export const INBOX_AGENT_NAME = 'Claude Code'
/** `$.store` key: the Inbox tool list last read live, used when the Inbox is stopped at session start. */
export const STORE_INBOX_TOOLS = 'inboxTools'

/** Poll wait we ask for: under the server's 25 s hold and `$.http.fetch`'s 30 s. */
export const INBOX_POLL_WAIT_MS = 20_000
/** After a failed poll: 5 s, doubling to 60 s while the Inbox stays away, never giving up. */
export const INBOX_RETRY_MS = { first: 5_000, max: 60_000 } as const
/**
 * wait_for_reply's longest hold through this tool: `$.http.fetch` gives up at
 * 30 s, so the call asks the Inbox for at most 25 s (the Inbox's own default
 * is 50 s, for MCP hosts with a 60 s tool timeout).
 */
export const INBOX_WAIT_MAX_SECONDS = 25
/** The tick: one per second, as the mod's review watcher. */
export const INBOX_TICK_MS = 1_000
/** How often the lease is renewed or re-read. */
const LEASE_EVERY_MS = 5_000
/** A lease not renewed for this long belongs to a process that exited, slept or hung. */
export const INBOX_LEASE_STALE_MS = 20_000
/** A claimed reply whose claimant stopped saying it is alive for this long is reported as undelivered. */
export const INBOX_UNDELIVERED_AFTER_MS = 60_000
/**
 * The longest session start waits for a running Inbox's `tools/list`. The
 * person's first prompt waits for session.start, and `$.http.fetch` gives up
 * only after 30 s, so an Inbox that accepts and never answers (stopped with
 * Ctrl-Z, or a port another server reused and holds) would hold that prompt
 * for 30 s; past this bound the remembered list stands.
 */
export const INBOX_DISCOVER_TIMEOUT_MS = 2_000
/** `plannotator inbox --background` waits up to 20 s for the Inbox to answer. */
const START_TIMEOUT_MS = 30_000

export function inboxRegistryPathOf(dataDir: string): string {
  return `${dataDir}/inbox/inbox.json`
}

/** This session's inbox folder in the mod's data: the lease and the delivery claims. */
export function inboxSessionDirOf(dataDir: string, sessionId: string): string {
  return `${dataDir}/claude-code-mod/${sessionId}/inbox`
}

/** Exit codes of `INBOX_CLAIM_SCRIPT`. */
export const INBOX_CLAIM_EXIT = { won: 0, lost: 3, failed: 4 } as const

/**
 * Claims one reply's delivery across processes: mkdir is atomic, so exactly
 * one process makes `$1`; the winner writes its id (`$2`) to `by`, so the same
 * instance whose process call lost its answer wins again on retry.
 */
export const INBOX_CLAIM_SCRIPT = [
  'd=$1; me=$2',
  'umask 077',
  'mkdir -p "$(dirname "$d")" || exit 4',
  `if mkdir "$d" 2>/dev/null; then printf '%s' "$me" > "$d/by"; exit 0; fi`,
  '[ "$(cat "$d/by" 2>/dev/null)" = "$me" ] && exit 0',
  '[ -d "$d" ] && exit 3',
  'exit 4',
].join('\n')

export function inboxClaimArgv(dir: string, claimant: string): string[] {
  return ['/bin/sh', '-c', INBOX_CLAIM_SCRIPT, 'plannotator-inbox-claim', dir, claimant]
}

/** The JSON-RPC message in an MCP answer: a JSON body, or the `data:` lines of an SSE body. */
export function mcpAnswerOf(text: string): { result?: unknown; error?: { message?: string } } | null {
  const candidates = /^\s*(event:|data:|:)/m.test(text)
    ? text
        .split(/\r?\n\r?\n/)
        .map((block) =>
          block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n'),
        )
        .filter((data) => data.trim())
    : [text]
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as { result?: unknown; error?: { message?: string } }
      if (value && typeof value === 'object' && ('result' in value || 'error' in value)) return value
    } catch {
      // The next block.
    }
  }
  return null
}

async function mcpCall(host: Host, port: number, method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const response = await host.fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return mcpAnswerOf(response.text)
}

/** `work`'s answer, or null once `ms` passed first; the bounding sleep is aborted as soon as `work` settles. */
async function within<T>(host: Host, ms: number, work: Promise<T>): Promise<T | null> {
  const stop = new AbortController()
  const late = host.sleep(ms, stop.signal).then(
    () => null,
    () => null,
  )
  try {
    return await Promise.race([work, late])
  } finally {
    stop.abort()
  }
}

/**
 * The Inbox tools this session's `plannotator_inbox` tool carries, decided
 * once at session start; null: no tool (no registry, or nothing known about
 * the Inbox's tools). A running Inbox is asked (`tools/list`) and its answer
 * remembered; a stopped one is described by the list it last answered with,
 * and is started by the first call.
 */
export async function discoverInboxTools(host: Host, dataDir: string): Promise<InboxToolInfo[] | null> {
  const path = inboxRegistryPathOf(dataDir)
  if (!(await host.exists(path))) return null
  const registry = parseInboxRegistry(await host.readFile(path).catch(() => null))
  if (registry) {
    const answer = await within(host, INBOX_DISCOVER_TIMEOUT_MS, mcpCall(host, registry.port, 'tools/list', {})).catch(() => null)
    const tools = answer && 'result' in answer ? parseInboxToolList(answer.result) : []
    if (tools.length > 0) {
      await host.storeSet(STORE_INBOX_TOOLS, { tools }).catch(() => undefined)
      return tools
    }
  }
  const remembered = parseInboxToolList(await host.storeGet(STORE_INBOX_TOOLS).catch(() => null))
  return remembered.length > 0 ? remembered : null
}

interface InboxLease {
  owner: string | null
  at: number
  touchedAt: number
}

function parseLease(text: string): InboxLease | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value.at !== 'number') return null
    return { owner: typeof value.owner === 'string' && value.owner ? value.owner : null, at: value.at, touchedAt: typeof value.touchedAt === 'number' ? value.touchedAt : 0 }
  } catch {
    return null
  }
}

export interface InboxLinkOptions {
  host: Host
  dataDir: string
  sessionId: string
  tools: readonly InboxToolInfo[]
  /** A turn is running (or a question of Ask this session is in flight). */
  isBusy: () => boolean
  /** Names this process in the lease and the claims. */
  instanceId: string
}

export class InboxLink {
  readonly tools: readonly InboxToolInfo[]
  private readonly host: Host
  private readonly dir: string
  private timer: { cancel: () => void } | null = null
  private disposed = false
  private ticking = false
  private polling = false
  private retryAt = 0
  private backoffMs = 0
  private madeDir = false
  private leader = false
  private leaseCheckedAt = Number.NEGATIVE_INFINITY
  /** When the person last acted in this process (created, typed, called the tool); the most recent touch wins the lease. */
  private touchedAt = 0
  /** Ticks in a row the session was idle; a reply goes in once it is idle for a whole tick. */
  private idleTicks = 0
  /** Replies handed out by the Inbox and not yet settled here, in arrival order. */
  private pending = new Map<string, InboxReplyCommand>()
  /** Replies settled here (delivered, dropped, claimed elsewhere, reported). */
  private settled = new Set<string>()
  /** Delivered here (or by a claimant that quit), not yet acknowledged to the Inbox. */
  private unacked = new Set<string>()
  /** Claimed by another process, watched until delivered or reported. */
  private elsewhere = new Map<string, { command: InboxReplyCommand; since: number }>()
  /** The reply whose turn this process is submitting, kept alive in its claim. */
  private submitting: string | null = null
  private delivering = false

  constructor(private readonly options: InboxLinkOptions) {
    this.host = options.host
    this.tools = options.tools
    this.dir = inboxSessionDirOf(options.dataDir, options.sessionId)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Start the tick. The person is in this process now. */
  start(): void {
    if (this.timer || this.disposed) return
    void this.touch()
    this.timer = this.host.every(INBOX_TICK_MS, () => {
      if (this.ticking) return
      this.ticking = true
      void this.tick()
        .catch((error: unknown) => this.host.debug(`inbox tick: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.ticking = false
        })
    })
  }

  /** The session ended (`session.end`, `/clear`): stop, and let another process take the lease at once. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.timer?.cancel()
    this.timer = null
    if (this.leader) void this.host.writeFile(this.leasePath, JSON.stringify({ owner: null, at: 0, touchedAt: 0 })).catch(() => undefined)
    this.leader = false
  }

  /** The person acted in this process: replies should land here, from now on. */
  async touch(): Promise<void> {
    this.touchedAt = await this.host.now()
    if (this.disposed) return
    if (await this.ensureDir()) await this.holdLease(this.touchedAt)
    else this.leaseCheckedAt = Number.NEGATIVE_INFINITY
  }

  /** This session's inbox folder, owner-only, made once. */
  private async ensureDir(): Promise<boolean> {
    if (this.madeDir) return true
    const made = await this.host.run(privateDirArgv(this.dir), { timeoutMs: 5_000 }).catch(() => null)
    this.madeDir = made?.exitCode === 0
    return this.madeDir
  }

  /**
   * Someone else's prompt entered the session. At idle (no turn id) its turn
   * is about to start, so the idle count starts over; the person typing here
   * also pulls the lease to this process.
   */
  onForeignPrompt(prompt: { turnId?: string; originKind?: string }): void {
    if (!prompt.turnId) this.idleTicks = 0
    if (prompt.originKind === 'composer') void this.touch()
  }

  // --- The tool --------------------------------------------------------------

  /** A `plannotator_inbox` call: the Inbox tool it stands for, through the Inbox's `/mcp`. */
  async callTool(input: unknown, cwd: string): Promise<{ text: string } | { deny: string }> {
    await this.touch()
    const call = inboxToolCall(input, this.tools, {
      project_path: cwd,
      agent_session: this.options.sessionId,
      agent_host: INBOX_HOST,
      agent_name: INBOX_AGENT_NAME,
    })
    if ('error' in call) return { deny: call.error }
    if (call.name === 'wait_for_reply') {
      const asked = typeof call.arguments.timeout_seconds === 'number' ? call.arguments.timeout_seconds : INBOX_WAIT_MAX_SECONDS
      call.arguments.timeout_seconds = Math.max(1, Math.min(asked, INBOX_WAIT_MAX_SECONDS))
    }
    const running = await this.ensureRunning()
    if ('error' in running) return { deny: running.error }
    let answer: Awaited<ReturnType<typeof mcpCall>>
    try {
      answer = await mcpCall(this.host, running.port, 'tools/call', { name: call.name, arguments: call.arguments })
    } catch (error) {
      return { deny: `The Plannotator Inbox did not answer (${error instanceof Error ? error.message : String(error)}).` }
    }
    if (!answer) return { deny: 'The Plannotator Inbox gave an answer this session could not read.' }
    if (answer.error) {
      const message = answer.error.message ?? 'unknown error'
      // An action this Inbox lost (a downgrade since session start).
      if (/not found|unknown tool/i.test(message)) return { deny: `This Plannotator Inbox has no ${call.name}; update Plannotator. (${message})` }
      return { deny: `The Plannotator Inbox refused the call: ${message}` }
    }
    const result = inboxToolResultText(answer.result)
    return result.isError ? { deny: result.text } : { text: result.text }
  }

  private get registryPath(): string {
    return inboxRegistryPathOf(this.options.dataDir)
  }

  private async registry(): Promise<InboxRegistryView | null> {
    return parseInboxRegistry(await this.host.readFile(this.registryPath).catch(() => null))
  }

  /** Running: the registry's port answers health with the registry's serverSession. */
  private async isRunning(registry: InboxRegistryView): Promise<boolean> {
    const response = await this.host
      .fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`, { method: 'GET', headers: {} })
      .catch(() => null)
    if (!response || response.status !== 200) return false
    try {
      return (JSON.parse(response.text) as { serverSession?: unknown }).serverSession === registry.serverSession
    } catch {
      return false
    }
  }

  /** The running Inbox, starting a stopped one detached (no browser) first. */
  private async ensureRunning(): Promise<InboxRegistryView | { error: string }> {
    const known = await this.registry()
    if (known && (await this.isRunning(known))) return known
    const started = await this.host
      .run(['plannotator', 'inbox', '--background'], { env: { PLANNOTATOR_DATA_DIR: this.options.dataDir }, timeoutMs: START_TIMEOUT_MS })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
    if (started.exitCode !== 0) {
      const why = started.stderr.trim() || started.stdout.trim() || `exit ${started.exitCode}`
      if (/unknown command/i.test(why)) return { error: 'The plannotator on PATH has no Inbox (an older version); update Plannotator.' }
      return { error: `The Plannotator Inbox did not start: ${why}` }
    }
    this.host.debug(`inbox: started with --background (${started.stdout.trim()})`)
    const now = await this.registry()
    return now ?? { error: 'The Plannotator Inbox started but wrote no registry.' }
  }

  // --- The wake --------------------------------------------------------------

  private get leasePath(): string {
    return `${this.dir}/watcher.json`
  }

  private claimDir(replyId: string): string {
    return `${this.dir}/claims/${replyId}`
  }

  private async tick(): Promise<void> {
    if (this.disposed || !(await this.ensureDir())) return
    this.idleTicks = this.options.isBusy() ? 0 : this.idleTicks + 1
    const now = await this.host.now()
    if (now - this.leaseCheckedAt >= LEASE_EVERY_MS) {
      await this.holdLease(now)
      if (this.submitting) await this.host.writeFile(`${this.claimDir(this.submitting)}/alive`, String(now)).catch(() => undefined)
      for (const id of [...this.elsewhere.keys()]) await this.watchElsewhere(id, now)
    }
    for (const id of [...this.unacked]) await this.acknowledge(id)
    if (!this.leader) return
    if (!this.polling && now >= this.retryAt) void this.poll()
    if (!this.delivering && this.pending.size > 0 && this.idleTicks >= 2) {
      this.delivering = true
      void this.deliverNext().finally(() => {
        this.delivering = false
      })
    }
  }

  /**
   * Whether this process polls and delivers: it holds the session's inbox
   * lease unless another live process does and the person touched that one
   * at least as recently.
   */
  private async holdLease(now: number): Promise<boolean> {
    this.leaseCheckedAt = now
    const lease = parseLease(await this.host.readFile(this.leasePath).catch(() => ''))
    const foreign = !!lease?.owner && lease.owner !== this.options.instanceId && Math.abs(now - lease.at) < INBOX_LEASE_STALE_MS
    if (foreign && lease && lease.touchedAt >= this.touchedAt) {
      if (this.leader) this.host.debug('inbox: another Claude Code process on this session delivers replies now')
      this.leader = false
      return false
    }
    await this.host
      .writeFile(this.leasePath, JSON.stringify({ owner: this.options.instanceId, at: now, touchedAt: this.touchedAt }))
      .catch(() => undefined)
    this.leader = true
    return true
  }

  private async bridge(path: string, body: Record<string, unknown>): Promise<HttpResult | null> {
    const registry = await this.registry()
    if (!registry) return null
    return this.host
      .fetch(`http://127.0.0.1:${registry.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${registry.token}` },
        body: JSON.stringify({ session: this.options.sessionId, host: INBOX_HOST, ...body }),
      })
      .catch(() => null)
  }

  /** The replies the Inbox has for this session now (waitMs 0), or null when it did not answer. */
  private async pendingNow(waitMs: number): Promise<InboxReplyCommand[] | null> {
    const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, { waitMs })
    return response && response.status === 200 ? parseInboxBridgeCommands(response.text) : null
  }

  private async poll(): Promise<void> {
    this.polling = true
    try {
      const commands = await this.pendingNow(INBOX_POLL_WAIT_MS)
      if (this.disposed) return
      if (commands === null) {
        // No registry, a stopped Inbox, an older one without the route, a
        // rotated token: wait and try again, longer each time, never for good.
        this.backoffMs = this.backoffMs ? Math.min(this.backoffMs * 2, INBOX_RETRY_MS.max) : INBOX_RETRY_MS.first
        this.retryAt = (await this.host.now()) + this.backoffMs
        return
      }
      this.backoffMs = 0
      this.retryAt = 0
      for (const command of commands) {
        if (this.settled.has(command.id) || this.pending.has(command.id) || this.elsewhere.has(command.id)) continue
        this.host.debug(`inbox: reply ${command.id} for this session`)
        this.pending.set(command.id, command)
      }
    } finally {
      this.polling = false
    }
  }

  private settle(id: string): void {
    this.pending.delete(id)
    this.settled.add(id)
  }

  /** Deliver the oldest waiting reply as a turn, once. */
  private async deliverNext(): Promise<void> {
    const command = this.pending.values().next().value as InboxReplyCommand | undefined
    if (!command) return
    // Still waiting? An agent may have read it through the tool meanwhile, or
    // another process delivered it.
    const fresh = await this.pendingNow(0)
    if (fresh === null) return
    if (!fresh.some((candidate) => candidate.id === command.id)) {
      this.settle(command.id)
      return
    }
    if (this.disposed || !(await this.holdLease(await this.host.now()))) return
    const dir = this.claimDir(command.id)
    const claim = await this.host.run(inboxClaimArgv(dir, this.options.instanceId), { timeoutMs: 5_000 }).catch(() => null)
    if (claim?.exitCode === INBOX_CLAIM_EXIT.lost) {
      this.pending.delete(command.id)
      this.elsewhere.set(command.id, { command, since: await this.host.now() })
      return
    }
    if (claim?.exitCode !== INBOX_CLAIM_EXIT.won) return
    this.submitting = command.id
    await this.host.writeFile(`${dir}/alive`, String(await this.host.now())).catch(() => undefined)
    this.host.debug(`inbox: delivering reply ${command.id}`)
    try {
      // Resolves once Claude is idle and took the turn.
      await this.host.submit(inboxWakeText(command))
    } catch (error) {
      this.submitting = null
      this.settle(command.id)
      await this.host.writeFile(`${dir}/reported`, '1').catch(() => undefined)
      this.host.toast(
        `A reply in the Plannotator Inbox (${command.subject ?? 'a thread'}) could not be delivered to this session (${error instanceof Error ? error.message : String(error)}). Read it in the Inbox: ${command.url}`,
      )
      return
    }
    this.submitting = null
    await this.host.writeFile(`${dir}/delivered`, String(await this.host.now())).catch(() => undefined)
    this.settle(command.id)
    this.unacked.add(command.id)
    await this.acknowledge(command.id)
  }

  /** Tell the Inbox a reply was delivered (retried every tick until it answers). */
  private async acknowledge(id: string): Promise<void> {
    const response = await this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'delivered', id })
    if (!response) return
    // 200, or a refusal that will not change (the reply is gone or not ours): done.
    if (response.status === 200 || (response.status >= 400 && response.status < 500 && response.status !== 401)) this.unacked.delete(id)
  }

  /**
   * A reply another process claimed: acknowledged on its behalf once it says
   * delivered (its own acknowledgement may have been lost), and reported once,
   * with a toast, when its claimant stopped saying it is alive before it did.
   */
  private async watchElsewhere(id: string, now: number): Promise<void> {
    const entry = this.elsewhere.get(id)
    if (!entry) return
    const dir = this.claimDir(id)
    if (await this.host.exists(`${dir}/delivered`)) {
      this.elsewhere.delete(id)
      this.settled.add(id)
      this.unacked.add(id)
      return
    }
    if (await this.host.exists(`${dir}/reported`)) {
      this.elsewhere.delete(id)
      this.settled.add(id)
      return
    }
    const alive = Number((await this.host.readFile(`${dir}/alive`).catch(() => '')).trim())
    const last = Number.isFinite(alive) && alive > 0 ? alive : entry.since
    if (now - last < INBOX_UNDELIVERED_AFTER_MS || !this.leader) return
    this.elsewhere.delete(id)
    this.settled.add(id)
    await this.host.writeFile(`${dir}/reported`, '1').catch(() => undefined)
    this.host.toast(
      `A reply in the Plannotator Inbox (${entry.command.subject ?? 'a thread'}) arrived for this session but was not delivered (the Claude Code process that took it quit). Read it in the Inbox: ${entry.command.url}`,
    )
  }
}
