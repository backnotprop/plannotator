/**
 * Plannotator Snapshots for Claude Code: this session's link to the Snapshots hub.
 *
 * The hub (`plannotator snapshot hub`, registry `<data dir>/snapshots/hub.json`)
 * is where the capture HUD meets agent sessions. A hooks module cannot
 * listen, so the session dials out: it says hello, then long-polls its own
 * pull bridge on the hub (the same protocol as "Ask this session" on a review
 * server, bridge.ts, pointed at `/api/connections/<id>/poll`). Over that link:
 *  - `deliver`: a send from the HUD. It is submitted as one plugin turn
 *    (`$.prompt.submit`, which waits for Claude to go idle) and acknowledged
 *    with `delivered`. The hub stops re-sending once the link answers
 *    `deliver_accepted`, and hands the send out again after a hello.
 *  - `ask` / `cancel` / `interrupt`: "Ask this session" from the HUD, a real
 *    turn of this session (the same TurnTracker as the reviews' bridges).
 * Every poll carries when a person last typed here (`prompt.submit` with origin
 * `composer`), which is how a hotkey-started collection picks this session.
 *
 * Two Claude Code processes on one session (`claude --continue` while the
 * first still runs) share one hub connection, so the Inbox link's rules apply
 * (inbox.ts): ONE process links, the holder of the session's snapshots lease
 * (`claude-code-mod/<session>/snapshots/watcher.json`; the process the person
 * used last wins, 20 s stale), and every send is claimed once across processes
 * (mkdir of `snapshots/claims/<sendId>`, the claimant's id in `by`, then
 * `alive` while it waits for its turn and `delivered` once submitted), so a
 * lease race or a re-sent `deliver` is never a second turn.
 *
 * No hub: the registry is looked for every few seconds (a file check, no
 * process). Off unless Snapshots is switched on (enabled.ts).
 */

import { createBridge, type BridgeHandle } from './bridge'
import type { Host } from './host'
import { INBOX_CLAIM_EXIT, INBOX_CLAIM_SCRIPT } from './inbox'
import { privateDirArgv } from './launch'
import type { TurnTracker } from './turns'

/** Delivered send ids, kept per session so a re-sent `deliver` is never a second turn. */
export const STORE_SNAPSHOTS_DELIVERED = 'plannotator-snapshots-delivered'
const DELIVERED_KEEP = 200
const NO_HUB_RETRY_MS = 5_000
const TITLE_MAX = 60
/** How often the lease is renewed or re-read, and claims taken elsewhere are checked. */
export const SNAPSHOTS_LEASE_EVERY_MS = 5_000
/** A lease not renewed for this long belongs to a process that exited, slept or hung. */
export const SNAPSHOTS_LEASE_STALE_MS = 20_000
/** A send claimed by a process that stopped saying it is alive for this long is reported as not delivered. */
export const SNAPSHOTS_UNDELIVERED_AFTER_MS = 60_000
/** Send ids as the hub makes and checks them (packages/shared/snapshots/validate.ts). */
const SEND_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** This session's snapshots folder in the mod's data: the lease and the delivery claims. */
export function snapshotsSessionDirOf(dataDir: string, sessionId: string): string {
  return `${dataDir}/claude-code-mod/${sessionId}/snapshots`
}

/** Claims one send's delivery across processes (the Inbox's claim script: one mkdir winner, its id in `by`). */
export function snapshotsClaimArgv(dir: string, claimant: string): string[] {
  return ['/bin/sh', '-c', INBOX_CLAIM_SCRIPT, 'plannotator-snapshots-claim', dir, claimant]
}

interface HubEntry {
  url: string
  token: string
}

function parseHubEntry(text: string): HubEntry | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value.v !== 1 || typeof value.url !== 'string' || typeof value.token !== 'string') return null
    // Loopback only: the token goes nowhere else.
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)) return null
    return { url: value.url, token: value.token }
  } catch {
    return null
  }
}

interface Lease {
  owner: string | null
  at: number
  touchedAt: number
}

function parseLease(text: string): Lease | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (typeof value.at !== 'number') return null
    return { owner: typeof value.owner === 'string' && value.owner ? value.owner : null, at: value.at, touchedAt: typeof value.touchedAt === 'number' ? value.touchedAt : 0 }
  } catch {
    return null
  }
}

function titleOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

export interface SnapshotsDeliverCommand {
  type: 'deliver'
  sendId: string
  text: string
}

export interface SnapshotsLinkOptions {
  host: Host
  dataDir: string
  sessionId: string
  /** One per Claude Code process (what the hub shows). */
  processId: string
  /** Names this mod instance in the lease and the claims. */
  instanceId: string
  turns: TurnTracker
  /** The session id this one replaced in this process (`/clear`). */
  replaces?: string
}

export class SnapshotsLink {
  private disposed = false
  private started = false
  private bridge: BridgeHandle | null = null
  private hub: HubEntry | null = null
  private connectionId: string | null = null
  private lastHumanInputAt = 0
  private title = ''
  private cwd = ''
  private project = ''
  private delivered: string[] = []
  private delivering = new Set<string>()
  /** Sends another process claimed, watched until it says delivered or stops saying it is alive. */
  private elsewhere = new Map<string, number>()
  /** The send this process is submitting, kept alive in its claim. */
  private submitting: string | null = null
  private readonly dir: string
  private madeDir = false
  private leader = false
  private touchedAt = 0
  private timer: { cancel: () => void } | null = null
  private ticking = false
  private leadershipWaiters: Array<() => void> = []

  constructor(private readonly options: SnapshotsLinkOptions) {
    this.dir = snapshotsSessionDirOf(options.dataDir, options.sessionId)
  }

  get registryPath(): string {
    return `${this.options.dataDir}/snapshots/hub.json`
  }

  /** This process holds the session's snapshots lease: it links to the hub and delivers. */
  get isLeader(): boolean {
    return this.leader
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.timer = this.options.host.every(SNAPSHOTS_LEASE_EVERY_MS, () => {
      if (this.ticking) return
      this.ticking = true
      void this.tick()
        .catch((error: unknown) => this.options.host.debug(`snapshots tick: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.ticking = false
        })
    })
    void this.loop()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.timer?.cancel()
    this.timer = null
    this.wakeLoop()
    const { hub, connectionId } = this
    // Only the process that links says goodbye: the connection is the session's, shared with any other process on it.
    if (this.leader && hub && connectionId) {
      void this.options.host
        .fetch(`${hub.url}/api/connections/${connectionId}/bye`, { method: 'POST', headers: this.headers(hub), body: '{}' })
        .catch(() => undefined)
    }
    // Let another process on this session take the lease at once.
    if (this.leader) void this.options.host.writeFile(this.leasePath, JSON.stringify({ owner: null, at: 0, touchedAt: 0 })).catch(() => undefined)
    this.leader = false
  }

  /** A person typed into this session (in this process). */
  noteHumanInput(text: string): void {
    this.lastHumanInputAt = Date.now()
    if (!this.title && text.trim() && !text.startsWith('/')) this.title = titleOf(text)
    void this.touch()
  }

  pushStatus(): void {
    this.bridge?.pushStatus()
  }

  /**
   * `/plannotator-snapshot`: start the hub and the app, latch this session
   * as the destination, open the capture overlay. Returns at once.
   */
  async summon(args: string): Promise<string> {
    const extra = args.split(/\s+/).filter((word) => word === '--app')
    // The person is here: this process links and delivers.
    await this.touch()
    const result = await this.options.host
      .run(['plannotator', 'snapshot', '--session', `claude-code:${this.options.sessionId}`, ...extra], { timeoutMs: 30_000 })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
    // The hub may have just started: connect now rather than at the next registry check.
    this.start()
    if (result.exitCode !== 0) return `Plannotator Snapshots could not start: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`
    return result.stdout.trim()
  }

  // --- The lease ------------------------------------------------------------------

  private get leasePath(): string {
    return `${this.dir}/watcher.json`
  }

  private claimDir(sendId: string): string {
    return `${this.dir}/claims/${sendId}`
  }

  private async ensureDir(): Promise<boolean> {
    if (this.madeDir) return true
    const made = await this.options.host.run(privateDirArgv(this.dir), { timeoutMs: 5_000 }).catch(() => null)
    this.madeDir = made?.exitCode === 0
    return this.madeDir
  }

  /** The person acted in this process: it links and delivers from now on. */
  async touch(): Promise<void> {
    this.touchedAt = await this.options.host.now()
    if (this.disposed || !(await this.ensureDir())) return
    await this.holdLease(this.touchedAt)
  }

  /**
   * Whether this process links: it holds the session's snapshots lease unless
   * another live process does and the person touched that one at least as recently.
   */
  private async holdLease(now: number): Promise<boolean> {
    if (this.disposed) return false
    const lease = parseLease(await this.options.host.readFile(this.leasePath).catch(() => ''))
    const foreign = !!lease?.owner && lease.owner !== this.options.instanceId && Math.abs(now - lease.at) < SNAPSHOTS_LEASE_STALE_MS
    if (foreign && lease && lease.touchedAt >= this.touchedAt) {
      if (this.leader) this.options.host.debug('snapshots: another Claude Code process on this session links to the hub now')
      this.leader = false
      return false
    }
    await this.options.host
      .writeFile(this.leasePath, JSON.stringify({ owner: this.options.instanceId, at: now, touchedAt: this.touchedAt }))
      .catch(() => undefined)
    const was = this.leader
    this.leader = true
    if (!was) this.wakeLoop()
    return true
  }

  private wakeLoop(): void {
    for (const wake of this.leadershipWaiters.splice(0)) wake()
  }

  /** Until this process holds the lease (or the link ends). */
  private waitForLeadership(): Promise<void> {
    if (this.leader || this.disposed) return Promise.resolve()
    return new Promise((resolve) => this.leadershipWaiters.push(resolve))
  }

  private async tick(): Promise<void> {
    if (this.disposed || !(await this.ensureDir())) return
    const now = await this.options.host.now()
    await this.holdLease(now)
    if (this.submitting) await this.options.host.writeFile(`${this.claimDir(this.submitting)}/alive`, String(now)).catch(() => undefined)
    if (this.leader) for (const sendId of [...this.elsewhere.keys()]) await this.watchElsewhere(sendId, now)
  }

  // --- The link -------------------------------------------------------------------

  private headers(hub: HubEntry): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${hub.token}` }
  }

  private async identify(): Promise<void> {
    const result = await this.options.host
      .run(['/bin/sh', '-c', 'pwd; git rev-parse --show-toplevel 2>/dev/null || true'], { timeoutMs: 5_000 })
      .catch(() => null)
    const [cwd = '', top = ''] = (result?.stdout ?? '').split('\n')
    this.cwd = cwd.trim()
    const root = top.trim() || this.cwd
    this.project = root.split('/').filter(Boolean).pop() ?? ''
    if (!this.title) {
      const messages = await this.options.host.messages().catch(() => [])
      const first = messages.find((message) => message.role === 'user' && message.text.trim() && !message.text.startsWith('<'))
      if (first) this.title = titleOf(first.text)
    }
    const stored = await this.options.host.storeGet(STORE_SNAPSHOTS_DELIVERED).catch(() => null)
    if (Array.isArray(stored)) this.delivered = stored.filter((id): id is string => typeof id === 'string')
  }

  private async readHub(): Promise<HubEntry | null> {
    if (!(await this.options.host.exists(this.registryPath).catch(() => false))) return null
    const text = await this.options.host.readFile(this.registryPath).catch(() => '')
    return parseHubEntry(text)
  }

  private async loop(): Promise<void> {
    const { host } = this.options
    await this.identify()
    // Starting here is the person being here (session start, a summon).
    await this.touch()
    while (!this.disposed) {
      if (!this.leader) {
        await this.waitForLeadership()
        continue
      }
      const hub = await this.readHub()
      if (!hub) {
        await host.sleep(NO_HUB_RETRY_MS)
        continue
      }
      const hello = await host
        .fetch(`${hub.url}/api/connections/hello`, {
          method: 'POST',
          headers: this.headers(hub),
          body: JSON.stringify({
            host: 'claude-code',
            sessionId: this.options.sessionId,
            processId: this.options.processId,
            cwd: this.cwd,
            project: this.project,
            title: this.title,
            lastHumanInputAt: this.lastHumanInputAt,
            ...(this.options.replaces ? { replaces: this.options.replaces } : {}),
            capabilities: { deliver: true, ask: { turn: true, transient: false } },
            protocol: 1,
          }),
        })
        .catch(() => null)
      if (!hello || !hello.ok) {
        await host.sleep(NO_HUB_RETRY_MS)
        continue
      }
      let connectionId: string
      try {
        connectionId = (JSON.parse(hello.text) as { connectionId: string }).connectionId
      } catch {
        await host.sleep(NO_HUB_RETRY_MS)
        continue
      }
      this.hub = hub
      this.connectionId = connectionId
      host.debug(`snapshots: connected to ${hub.url} as ${connectionId}`)
      const bridge = createBridge({
        host,
        baseUrl: hub.url,
        token: hub.token,
        turns: this.options.turns,
        // Another process on this session took the lease: it links now.
        isLive: () => !this.disposed && this.leader,
        pollPath: `/api/connections/${connectionId}/poll`,
        eventPath: `/api/connections/${connectionId}/event`,
        pollExtras: () => ({ lastHumanInputAt: this.lastHumanInputAt, ...(this.title ? { title: this.title } : {}) }),
        onCommand: (command) => {
          if (command.type === 'deliver' && typeof command.sendId === 'string' && typeof command.text === 'string') {
            void this.deliver({ type: 'deliver', sendId: command.sendId, text: command.text })
          }
        },
      })
      this.bridge = bridge
      const end = await bridge.run()
      this.bridge = null
      host.debug(`snapshots: link ended (${end.reason}${end.status ? ` ${end.status}` : ''})`)
      // A hub that restarted (new token) or forgot us answers 401/404: say hello again soon.
      if (!this.disposed && this.leader) await host.sleep(end.reason === 'refused' || end.reason === 'closing' ? 1_000 : NO_HUB_RETRY_MS)
    }
  }

  private post(event: { type: string } & Record<string, unknown>): void {
    this.bridge?.postEvent(event)
  }

  /**
   * A `deliver` from the hub: one plugin turn, once across every process on
   * this session. Whoever claims the send submits it; a process that finds it
   * claimed tells the hub it is taken (so the hub stops re-sending) and, once
   * the claimant wrote `delivered`, that it is delivered.
   */
  async deliver(command: SnapshotsDeliverCommand): Promise<void> {
    const { sendId, text } = command
    const { host } = this.options
    if (!SEND_ID.test(sendId)) return
    if (this.delivered.includes(sendId)) {
      this.post({ type: 'delivered', sendId })
      return
    }
    if (this.delivering.has(sendId)) {
      // The hub handed it out again (a hello): it is ours and on its way.
      this.post({ type: 'deliver_accepted', sendId, queued: this.options.turns.busy })
      return
    }
    if (this.disposed || !(await this.ensureDir())) return
    this.delivering.add(sendId)
    try {
      const dir = this.claimDir(sendId)
      const claim = await host.run(snapshotsClaimArgv(dir, this.options.instanceId), { timeoutMs: 5_000 }).catch(() => null)
      if (claim?.exitCode === INBOX_CLAIM_EXIT.lost) {
        if (await host.exists(`${dir}/delivered`)) {
          await this.rememberDelivered(sendId)
          this.post({ type: 'delivered', sendId })
        } else if (await host.exists(`${dir}/reported`)) {
          // Its claimant failed or quit before its turn ran (said once; this repeats it for a hub that missed it).
          this.post({ type: 'deliver_failed', sendId, reason: 'It was not delivered to this session.' })
        } else {
          // Another process on this session is delivering it: taken, so the hub stops re-sending.
          this.post({ type: 'deliver_accepted', sendId, queued: true })
          if (!this.elsewhere.has(sendId)) this.elsewhere.set(sendId, await host.now())
        }
        return
      }
      // Failed to claim (the folder could not be made): the hub re-sends in a few seconds.
      if (claim?.exitCode !== INBOX_CLAIM_EXIT.won) return
      this.post({ type: 'deliver_accepted', sendId, queued: this.options.turns.busy })
      host.debug(`snapshots: delivering ${sendId}${this.options.turns.busy ? ' (queued behind a running turn)' : ''}`)
      this.submitting = sendId
      await host.writeFile(`${dir}/alive`, String(await host.now())).catch(() => undefined)
      try {
        // Resolves once Claude is idle and took the turn.
        await host.submit(text)
      } catch (error) {
        await host.writeFile(`${dir}/reported`, '1').catch(() => undefined)
        this.post({ type: 'deliver_failed', sendId, reason: error instanceof Error ? error.message : String(error) })
        return
      } finally {
        this.submitting = null
      }
      await host.writeFile(`${dir}/delivered`, String(await host.now())).catch(() => undefined)
      await this.rememberDelivered(sendId)
      this.post({ type: 'delivered', sendId })
      host.debug(`snapshots: delivered ${sendId}`)
    } finally {
      this.delivering.delete(sendId)
    }
  }

  private async rememberDelivered(sendId: string): Promise<void> {
    this.elsewhere.delete(sendId)
    if (this.delivered.includes(sendId)) return
    this.delivered = [...this.delivered, sendId].slice(-DELIVERED_KEEP)
    await this.options.host.storeSet(STORE_SNAPSHOTS_DELIVERED, this.delivered).catch(() => undefined)
  }

  /**
   * A send another process claimed: reported delivered once its claimant says
   * so (its own acknowledgement may have been lost), or not delivered when its
   * claimant stopped saying it is alive (it quit before its turn ran).
   */
  private async watchElsewhere(sendId: string, now: number): Promise<void> {
    const since = this.elsewhere.get(sendId)
    if (since === undefined) return
    const { host } = this.options
    const dir = this.claimDir(sendId)
    if (await host.exists(`${dir}/delivered`)) {
      await this.rememberDelivered(sendId)
      this.post({ type: 'delivered', sendId })
      return
    }
    if (await host.exists(`${dir}/reported`)) {
      this.elsewhere.delete(sendId)
      return
    }
    const alive = Number((await host.readFile(`${dir}/alive`).catch(() => '')).trim())
    const last = Number.isFinite(alive) && alive > 0 ? alive : since
    if (now - last < SNAPSHOTS_UNDELIVERED_AFTER_MS) return
    this.elsewhere.delete(sendId)
    await host.writeFile(`${dir}/reported`, '1').catch(() => undefined)
    this.post({ type: 'deliver_failed', sendId, reason: 'The Claude Code process that took it quit before delivering it.' })
  }
}
