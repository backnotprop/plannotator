/**
 * Plannotator Shots for Claude Code: this session's link to the Shots hub.
 *
 * The hub (`plannotator screenshot hub`, registry `<data dir>/shots/hub.json`)
 * is where the screenshot HUD meets agent sessions. A hooks module cannot
 * listen, so the session dials out: it says hello, then long-polls its own
 * pull bridge on the hub (the same protocol as "Ask this session" on a review
 * server, bridge.ts, pointed at `/api/connections/<id>/poll`). Over that link:
 *  - `deliver`: a send from the HUD. It is submitted as one plugin turn
 *    (`$.prompt.submit`, which waits for Claude to go idle) and acknowledged
 *    with `delivered`; the hub re-sends until then, and the ids already
 *    delivered are kept in `$.store`, so a send is never submitted twice.
 *  - `ask` / `cancel` / `interrupt`: "Ask this session" from the HUD, a real
 *    turn of this session (the same TurnTracker as the reviews' bridges).
 * Every poll carries when a person last typed here (`prompt.submit` with origin
 * `composer`), which is how a hotkey-started collection picks this session.
 *
 * No hub: the registry is looked for every few seconds (a file check, no
 * process). Off unless Shots is switched on (enabled.ts).
 */

import { createBridge, type BridgeHandle } from './bridge'
import type { Host } from './host'
import type { TurnTracker } from './turns'

/** Delivered send ids, kept per session so a re-sent `deliver` is never a second turn. */
export const STORE_SHOTS_DELIVERED = 'plannotator-shots-delivered'
const DELIVERED_KEEP = 200
const NO_HUB_RETRY_MS = 5_000
const TITLE_MAX = 60

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

function titleOf(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

export interface ShotsLinkOptions {
  host: Host
  dataDir: string
  sessionId: string
  /** One per Claude Code process. */
  processId: string
  turns: TurnTracker
  /** The session id this one replaced in this process (`/clear`). */
  replaces?: string
}

export class ShotsLink {
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

  constructor(private readonly options: ShotsLinkOptions) {}

  get registryPath(): string {
    return `${this.options.dataDir}/shots/hub.json`
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.loop()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const { hub, connectionId } = this
    if (hub && connectionId) {
      void this.options.host
        .fetch(`${hub.url}/api/connections/${connectionId}/bye`, { method: 'POST', headers: this.headers(hub), body: '{}' })
        .catch(() => undefined)
    }
  }

  /** A person typed into this session. */
  noteHumanInput(text: string): void {
    this.lastHumanInputAt = Date.now()
    if (!this.title && text.trim() && !text.startsWith('/')) this.title = titleOf(text)
  }

  pushStatus(): void {
    this.bridge?.pushStatus()
  }

  /**
   * `/plannotator-screenshot`: start the hub and the app, latch this session
   * as the destination, open the capture overlay. Returns at once.
   */
  async summon(args: string): Promise<string> {
    const extra = args.split(/\s+/).filter((word) => word === '--app')
    const result = await this.options.host
      .run(['plannotator', 'screenshot', '--session', `claude-code:${this.options.sessionId}`, ...extra], { timeoutMs: 30_000 })
      .catch((error: unknown) => ({ exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
    // The hub may have just started: connect now rather than at the next registry check.
    this.start()
    if (result.exitCode !== 0) return `Plannotator Shots could not start: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`
    return result.stdout.trim()
  }

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
    const stored = await this.options.host.storeGet(STORE_SHOTS_DELIVERED).catch(() => null)
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
    while (!this.disposed) {
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
      host.debug(`shots: connected to ${hub.url} as ${connectionId}`)
      const bridge = createBridge({
        host,
        baseUrl: hub.url,
        token: hub.token,
        turns: this.options.turns,
        isLive: () => !this.disposed,
        pollPath: `/api/connections/${connectionId}/poll`,
        eventPath: `/api/connections/${connectionId}/event`,
        pollExtras: () => ({ lastHumanInputAt: this.lastHumanInputAt, ...(this.title ? { title: this.title } : {}) }),
        onCommand: (command) => this.onCommand(command),
      })
      this.bridge = bridge
      const end = await bridge.run()
      this.bridge = null
      host.debug(`shots: link ended (${end.reason}${end.status ? ` ${end.status}` : ''})`)
      // A hub that restarted (new token) or forgot us answers 401/404: say hello again soon.
      if (!this.disposed) await host.sleep(end.reason === 'refused' || end.reason === 'closing' ? 1_000 : NO_HUB_RETRY_MS)
    }
  }

  private onCommand(command: { type: string } & Record<string, unknown>): void {
    if (command.type !== 'deliver' || typeof command.sendId !== 'string' || typeof command.text !== 'string') return
    const { sendId, text } = command
    const post = (event: { type: string } & Record<string, unknown>) => this.bridge?.postEvent(event)
    if (this.delivered.includes(sendId)) {
      post({ type: 'delivered', sendId })
      return
    }
    if (this.delivering.has(sendId)) return
    this.delivering.add(sendId)
    post({ type: 'deliver_accepted', sendId, queued: this.options.turns.busy })
    this.options.host.debug(`shots: delivering ${sendId}${this.options.turns.busy ? ' (queued behind a running turn)' : ''}`)
    void this.options.host
      .submit(text)
      .then(async () => {
        this.delivered = [...this.delivered, sendId].slice(-DELIVERED_KEEP)
        await this.options.host.storeSet(STORE_SHOTS_DELIVERED, this.delivered).catch(() => undefined)
        post({ type: 'delivered', sendId })
        this.options.host.debug(`shots: delivered ${sendId}`)
      })
      .catch((error: unknown) => {
        post({ type: 'deliver_failed', sendId, reason: error instanceof Error ? error.message : String(error) })
      })
      .finally(() => this.delivering.delete(sendId))
  }
}
