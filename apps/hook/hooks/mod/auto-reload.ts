/**
 * Plannotator reloads itself after an update (owner approval
 * "cc-auto-reload", 2026-11-07, and its 19:00Z addendum).
 *
 * The Inbox is the one judge of "outdated" (`claudeSessionOutdated` in
 * packages/server/inbox-restart.ts, from the `plugin` this session's poll
 * reports and Claude Code's plugin registry). A poll answer carries
 * `reload: { installed }` while a `/reload-plugins` would load a newer
 * plugin (fix `restart`) and this connection said it can reload itself
 * (`auto_reload` on the poll). Then, from the Inbox tick (a `$.clock` timer,
 * never a hook a turn waits on), this runs `/reload-plugins plannotator`
 * once, when:
 *  - no main-loop turn and no subagent turn runs, and the mod has no
 *    Plannotator work in flight (an open review, a decision waiting to go in,
 *    an Inbox reply being delivered, an Ask question): `busyReason`;
 *  - the prompt box is empty (`$.prompt.read()`), so typed text is never in
 *    the way;
 *  - this session has not tried that installed version yet. The record is
 *    in `$.store` (it outlives the reload), per session id, so a reload that
 *    loads the same old code is never tried again: the Inbox then keeps
 *    showing the manual `/reload-plugins` notice (the fallback, no retry).
 * A run the engine refused before it ran (the person stopped the session
 * and has not typed since, a host limit) is tried again only after the next
 * main-loop turn starts, at most `AUTO_RELOAD_MAX_REFUSALS` times per version.
 *
 * Never `--force`: Plannotator's plugin declares no MCP or LSP servers, so
 * Claude Code's prompt-cache warning (which makes a plain `/reload-plugins`
 * stop and say "Run /reload-plugins --force") comes only from another
 * plugin's pending change, and forcing would apply that change and re-read
 * the whole conversation uncached. That warning lands in the output row,
 * which is then shown, and the session falls back to the manual notice.
 *
 * In the chat: the engine's echo row, `/reload-plugins plannotator`, stays
 * (Claude Code skips a plugin's render hook on rows its own code raised; the
 * owner accepted that line). The output row is hidden by `hidesReloadOutput`
 * only when it is our run's plain success.
 *
 * After the reload the NEW module checks in (`checkIn`, at its first
 * instance): it records that it loaded, with its version; the Inbox link's
 * first answered poll (`notePolled`) and the tools registering
 * (`noteTools`) are added to the record. A module still running
 * `AUTO_RELOAD_CHECK_IN_MS` after its own run resolved was not replaced: it
 * records `did_not_take`. Every step is a line in the mod's debug log.
 */

import type { LoadedPluginInfo } from './host'

/** The built-in command run, without its slash. */
export const AUTO_RELOAD_COMMAND = 'reload-plugins'
/**
 * The argument the run passes, so the echo reads `/reload-plugins plannotator`
 * and the output row is told apart from a reload the person typed.
 * `/reload-plugins` reads only `--force` / `force` and ignores other words
 * (read in the 2.1.319 binary).
 */
export const AUTO_RELOAD_ARGS = 'plannotator'
/** `$.store` key: session id to its last AutoReloadRecord. */
export const STORE_AUTO_RELOAD = 'autoReloads'
/** Sessions kept in the record, newest first. */
export const AUTO_RELOAD_KEEP = 50
/** How long the new module has to check in before the old one says the reload did not take. */
export const AUTO_RELOAD_CHECK_IN_MS = 30_000
/** Refused runs (the engine never ran the command) tried again per version, each after the next turn start. */
export const AUTO_RELOAD_MAX_REFUSALS = 3

export type AutoReloadOutcome = 'pending' | 'checked_in' | 'did_not_take' | 'refused'

export interface AutoReloadRecord {
  /** The installed version the run was for: tried once per session. */
  version: string
  /** When the run was queued, ms. */
  at: number
  /** The module that ran it. */
  from: { version: string | null; loadedAt: number | null }
  outcome: AutoReloadOutcome
  /** Runs the engine refused before they ran (outcome `refused`). */
  refusals?: number
  /** The engine's words, for `refused`. */
  reason?: string
  /** Set by the new module at check-in. */
  checkedIn?: { at: number; version: string | null; loadedAt: number | null }
  /** The new module's tools registered (`plannotator`, `plannotator_inbox` where on). */
  tools?: boolean
  /** The new module's Inbox link had a poll answered. */
  inbox?: boolean
}

export interface InboxReloadOfferView {
  installed: string | null
}

export interface AutoReloadDeps {
  now(): Promise<number>
  sessionId: string
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  /** What this module loaded; null when the host cannot say (then nothing runs). */
  loaded(): Promise<LoadedPluginInfo | null>
  /** The prompt box's text now (`$.prompt.read()`); absent: the host has no box, nothing runs. */
  promptText?: () => Promise<string>
  /** Why not now, or null when nothing runs: main or subagent turn, Plannotator work in flight. */
  busyReason(): string | null
  /** `$.command.run({ command: 'reload-plugins', args: 'plannotator' })`; absent: nothing runs. */
  run?: () => Promise<unknown>
  /** Calls `fn` once after `ms` (a `$.clock` timer, which a reload cancels with this module). */
  after(ms: number, fn: () => void): void
  debug(text: string): void
}

/** The records, read whole (anything else reads as none). */
export function readAutoReloads(value: unknown): Record<string, AutoReloadRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, AutoReloadRecord> = {}
  for (const [session, record] of Object.entries(value as Record<string, unknown>)) {
    if (!record || typeof record !== 'object') continue
    const r = record as Partial<AutoReloadRecord>
    if (typeof r.version !== 'string' || typeof r.at !== 'number' || typeof r.outcome !== 'string') continue
    out[session] = r as AutoReloadRecord
  }
  return out
}

/** The poll answer's `reload` read: an offer with a version a reload would load, else null. */
export function reloadTarget(offer: InboxReloadOfferView | null): string | null {
  return offer && typeof offer.installed === 'string' && offer.installed.trim() ? offer.installed.trim() : null
}

/**
 * Whether the CommandOutput row is our own run's plain success, the only row
 * the mod hides: our argument, not an error, starting `Reloaded:` and saying
 * nothing went wrong. A warning (the prompt-cache one, "installed but not
 * applied", errors during load, a marketplace that could not be reached) is
 * shown, so the person sees why Plannotator did not reload.
 */
export function hidesReloadOutput(props: { command?: unknown; args?: unknown; text?: unknown; isErrored?: unknown }): boolean {
  if (props.command !== AUTO_RELOAD_COMMAND || props.isErrored === true) return false
  if (typeof props.args !== 'string' || props.args.trim() !== AUTO_RELOAD_ARGS) return false
  if (typeof props.text !== 'string' || !props.text.trimStart().startsWith('Reloaded:')) return false
  return !/error|could not|not applied|--force|isn't available|failed/i.test(props.text)
}

export class AutoReload {
  /** The Inbox's last word: the version a reload loads, null for none; undefined before the first answer. */
  private offer: string | null | undefined = undefined
  private running = false
  /** A refused run waits for the next main-loop turn start (input moved). */
  private heldForInput = false
  private disposed = false
  /** This module checked in after a reload: what is noted next goes on its record, once each. */
  private checkedIn = false
  private noted = new Set<string>()

  constructor(private readonly deps: AutoReloadDeps) {}

  /** Every answered poll: the Inbox's current word (null: up to date, or an older Inbox). */
  setOffer(offer: InboxReloadOfferView | null): void {
    const target = reloadTarget(offer)
    if (target !== this.offer) this.deps.debug(`auto-reload: the Inbox says ${target ? `a reload loads ${target}` : 'no reload is needed'}`)
    this.offer = target
  }

  /** A main-loop turn started: a refused run may be tried again. */
  onInputMoved(): void {
    this.heldForInput = false
  }

  dispose(): void {
    this.disposed = true
  }

  private async records(): Promise<Record<string, AutoReloadRecord>> {
    return readAutoReloads(await this.deps.storeGet(STORE_AUTO_RELOAD).catch(() => null))
  }

  private async write(record: AutoReloadRecord): Promise<void> {
    // Read again right before the write: another session's process may have written its own entry.
    const all = await this.records()
    all[this.deps.sessionId] = record
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, AUTO_RELOAD_KEEP)
    await this.deps.storeSet(STORE_AUTO_RELOAD, Object.fromEntries(kept)).catch(() => undefined)
  }

  /** This session's record, or null. */
  async record(): Promise<AutoReloadRecord | null> {
    return (await this.records())[this.deps.sessionId] ?? null
  }

  /** One look, from the Inbox tick. Never throws; runs at most one reload at a time. */
  async tick(): Promise<void> {
    const target = this.offer
    if (this.running || this.disposed || this.heldForInput || !target || !this.deps.run || !this.deps.promptText) return
    this.running = true
    try {
      await this.consider(target)
    } catch (error) {
      this.deps.debug(`auto-reload: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async consider(target: string): Promise<void> {
    if (this.deps.busyReason() !== null) return
    const loaded = await this.deps.loaded()
    if (!loaded || loaded.version === null) return
    const previous = await this.record()
    if (previous && previous.version === target) {
      if (previous.outcome !== 'refused' || (previous.refusals ?? 0) >= AUTO_RELOAD_MAX_REFUSALS) return
    }
    const box = await this.deps.promptText!().catch(() => null)
    if (box === null || box.trim() !== '') return
    // State may have moved during the reads: the last word before the run.
    const busy = this.deps.busyReason()
    if (busy !== null || this.disposed || this.offer !== target) return
    const at = await this.deps.now()
    const refusals = previous && previous.version === target ? (previous.refusals ?? 0) : 0
    const record: AutoReloadRecord = { version: target, at, from: { version: loaded.version, loadedAt: loaded.loaded_at }, outcome: 'pending', ...(refusals ? { refusals } : {}) }
    await this.write(record)
    this.deps.debug(`auto-reload: running /${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS} (loaded ${loaded.version}, installed ${target})`)
    try {
      // Queued by the engine and run once the session is idle. When the reload
      // replaces this module, nothing below runs: the new module checks in.
      await this.deps.run!()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.heldForInput = true
      await this.write({ ...record, outcome: 'refused', refusals: refusals + 1, reason })
      this.deps.debug(`auto-reload: refused before it ran (${reason}); ${refusals + 1 >= AUTO_RELOAD_MAX_REFUSALS ? 'not tried again for this version' : 'tried again after the next turn starts'}`)
      return
    }
    this.deps.debug('auto-reload: the command ran; waiting for the new module to check in')
    this.deps.after(AUTO_RELOAD_CHECK_IN_MS, () => {
      void this.notReplaced(record)
    })
  }

  /** Still here after the check-in window: the reload did not load new code into this module. */
  private async notReplaced(record: AutoReloadRecord): Promise<void> {
    if (this.disposed) return
    const now = await this.record()
    if (!now || now.at !== record.at || now.outcome !== 'pending') return
    await this.write({ ...now, outcome: 'did_not_take' })
    this.deps.debug(
      `auto-reload: this module was not replaced within ${AUTO_RELOAD_CHECK_IN_MS / 1000} s; not tried again for ${record.version} (the Inbox keeps the manual /reload-plugins notice)`,
    )
  }

  /**
   * The module's first instance in this session: if this session's reload is
   * pending and this module loaded after it was queued, this module is its
   * result. Returns the record when it checked in.
   */
  async checkIn(): Promise<AutoReloadRecord | null> {
    const record = await this.record()
    if (!record || record.outcome !== 'pending') return null
    const loaded = await this.deps.loaded()
    const now = await this.deps.now()
    const loadedAt = loaded?.loaded_at ?? null
    if (loadedAt === null || loadedAt < record.at || now - record.at > 2 * AUTO_RELOAD_CHECK_IN_MS) return null
    const checked: AutoReloadRecord = { ...record, outcome: 'checked_in', checkedIn: { at: now, version: loaded?.version ?? null, loadedAt } }
    await this.write(checked)
    this.checkedIn = true
    this.deps.debug(
      `auto-reload: checked in after /${AUTO_RELOAD_COMMAND}: loaded ${loaded?.version ?? 'unknown'} (wanted ${record.version}) ${Math.round((now - record.at) / 100) / 10} s after the run`,
    )
    return checked
  }

  /** The new module's tools registered (or not). Recorded on a checked-in record only. */
  async noteTools(registered: boolean): Promise<void> {
    await this.amend({ tools: registered }, `the plannotator tools ${registered ? 'are registered' : 'did NOT register'}`)
  }

  /** The new module's Inbox link had a poll answered: the link runs, with the new version on it. */
  async notePolled(): Promise<void> {
    await this.amend({ inbox: true }, 'the Inbox link polls again')
  }

  private async amend(change: Partial<AutoReloadRecord>, line: string): Promise<void> {
    const key = Object.keys(change)[0] as keyof AutoReloadRecord
    if (!this.checkedIn || this.noted.has(key)) return
    this.noted.add(key)
    const record = await this.record()
    if (!record || record.outcome !== 'checked_in') return
    await this.write({ ...record, ...change })
    this.deps.debug(`auto-reload: after the reload, ${line}`)
  }
}
