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
 *  - no main-loop turn and no subagent runs, no prompt is on its way in (seen
 *    at `prompt.submit`, its turn not started yet), and the mod has no
 *    Plannotator work in flight (an open review, a decision waiting to go in,
 *    an Inbox reply being delivered, an Ask question): `busyReason`, plus
 *    `agentsBusy` (`$.agent.list()`, which also sees agents started before
 *    this module loaded);
 *  - the prompt box is empty (`$.prompt.read()`), so typed text is never in
 *    the way;
 *  - this session has not tried that installed version yet. The record is
 *    in `$.store` (it outlives the reload), per session id, with the last
 *    `AUTO_RELOAD_TRIED_KEEP` versions tried, so a reload that loads the same
 *    old code is never tried again (and neither is a version the Inbox names
 *    again after another one): the Inbox then keeps showing the manual
 *    `/reload-plugins` notice (the fallback, no retry). Nothing runs until
 *    the store has kept the pending record (written, then read back): a store
 *    that refuses or fails means no reload, never a loop. In memory, the
 *    module also keeps the versions it ran for, so even a store that loses
 *    the record later never lets it run twice for one version.
 * Every gate is checked again after the store calls, with no await between
 * that last check and the run; when one fails then, the record is put back.
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
 * when it is a plain success of `/reload-plugins plannotator`: the row carries
 * no origin, so the same command typed by the person is hidden too.
 *
 * After the reload the NEW module checks in (`checkIn`, at its first
 * instance): it records that it loaded, with its version (`checked_in`, or
 * `did_not_take` when the reload loaded another version than the one asked
 * for); the Inbox link's first answered poll (`notePolled`) and the tools
 * registering (`noteTools`) are added to the record. A module still running
 * `AUTO_RELOAD_CHECK_IN_MS` after its own run resolved was not replaced: it
 * records `did_not_take`. Every step is a line in the mod's debug log.
 */

import type { LoadedPluginInfo } from './host'

/** The built-in command run, without its slash. */
export const AUTO_RELOAD_COMMAND = 'reload-plugins'
/**
 * The argument the run passes, so the echo reads `/reload-plugins plannotator`
 * and the output row is told apart from a plain `/reload-plugins`.
 * `/reload-plugins` reads only `--force` / `force` and ignores other words
 * (read in the 2.1.319 binary).
 */
export const AUTO_RELOAD_ARGS = 'plannotator'
/** `$.store` key: session id to its last AutoReloadRecord. */
export const STORE_AUTO_RELOAD = 'autoReloads'
/** Sessions kept in the record, newest first. */
export const AUTO_RELOAD_KEEP = 50
/** Versions a session's record remembers as tried, newest last. */
export const AUTO_RELOAD_TRIED_KEEP = 10
/** How long the new module has to check in before the old one says the reload did not take. */
export const AUTO_RELOAD_CHECK_IN_MS = 30_000
/** The longest a queued run may wait for the session to go idle and still be the reason a module loaded. */
export const AUTO_RELOAD_QUEUE_MAX_MS = 30 * 60_000
/** Refused runs (the engine never ran the command) tried again per version, each after the next turn start. */
export const AUTO_RELOAD_MAX_REFUSALS = 3
/** After the store did not keep a record, how long before it is tried again. */
export const AUTO_RELOAD_STORE_RETRY_MS = 60_000
/**
 * Ticks a prompt seen at `prompt.submit` counts as on its way in without a
 * turn start or a drop (a slash command that starts no turn): then it is let go.
 */
export const AUTO_RELOAD_PROMPT_GAP_TICKS = 30

export type AutoReloadOutcome = 'pending' | 'checked_in' | 'did_not_take' | 'refused'

export interface AutoReloadRecord {
  /** The installed version the run was for: tried once per session. */
  version: string
  /** When the run was queued, ms. */
  at: number
  /** The module that ran it. */
  from: { version: string | null; loadedAt: number | null }
  outcome: AutoReloadOutcome
  /** Every version this session ran for (this one included), newest last, at most AUTO_RELOAD_TRIED_KEEP. */
  tried?: string[]
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

/** One version's runs in this module: how many, and whether the engine refused the last. */
export interface AutoReloadAttempt {
  runs: number
  refused: boolean
}

/**
 * The versions this module ran `/reload-plugins` for, in memory: a backstop
 * to the store, shared by every instance of the module (a `/clear` moves the
 * session id but not the module).
 */
const moduleAttempts = new Map<string, AutoReloadAttempt>()

export interface AutoReloadDeps {
  now(): Promise<number>
  sessionId: string
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  /** What this module loaded; null when the host cannot say (then nothing runs). */
  loaded(): Promise<LoadedPluginInfo | null>
  /** The prompt box's text now (`$.prompt.read()`); absent: the host has no box, nothing runs. */
  promptText?: () => Promise<string>
  /** Why not now, or null when nothing runs: main or subagent turn, Plannotator work in flight. Synchronous. */
  busyReason(): string | null
  /**
   * Why not now by the engine's agent list (`$.agent.list()`: an agent
   * pending, running or waiting, started before this module or after), or
   * null. Absent: only the turns this module saw count.
   */
  agentsBusy?: () => Promise<string | null>
  /** `$.command.run({ command: 'reload-plugins', args: 'plannotator' })`; absent: nothing runs. */
  run?: () => Promise<unknown>
  /** Calls `fn` once after `ms` (a `$.clock` timer, which a reload cancels with this module). */
  after(ms: number, fn: () => void): void
  debug(text: string): void
  /** The in-memory runs per version; the module's own map unless a test gives one. */
  attempts?: Map<string, AutoReloadAttempt>
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

/** The versions a record says this session already ran for. */
function triedOf(record: AutoReloadRecord | null): string[] {
  if (!record) return []
  const tried = Array.isArray(record.tried) ? record.tried.filter((v): v is string => typeof v === 'string') : []
  return tried.includes(record.version) ? tried : [...tried, record.version]
}

/**
 * Whether the store's record lets this session run for `target`: a version
 * never tried, or this one's refused run under the refusal limit.
 */
function storeAllows(previous: AutoReloadRecord | null, target: string): boolean {
  if (!previous) return true
  if (previous.version === target) return previous.outcome === 'refused' && (previous.refusals ?? 0) < AUTO_RELOAD_MAX_REFUSALS
  return !triedOf(previous).includes(target)
}

/**
 * Whether the CommandOutput row is a plain success of `/reload-plugins
 * plannotator`, the only row the mod hides: our argument, not an error,
 * starting `Reloaded:` and saying nothing went wrong. A warning (the
 * prompt-cache one, "installed but not applied", errors during load, a
 * marketplace that could not be reached) is shown, so the person sees why
 * Plannotator did not reload. The row carries no origin: the same command
 * typed by the person is hidden the same way.
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
  private readonly attempts: Map<string, AutoReloadAttempt>
  /** The store did not keep a record: no try before this time. */
  private storeRetryAt = 0
  /** Ticks seen, the clock of the prompt gap below. */
  private ticks = 0
  /** Prompts seen at prompt.submit whose turn has not started (nor were they dropped), and the tick of the last. */
  private promptsEntering = 0
  private promptEnteringTick = 0

  constructor(private readonly deps: AutoReloadDeps) {
    this.attempts = deps.attempts ?? moduleAttempts
  }

  /** Every answered poll: the Inbox's current word (null: up to date, or an older Inbox). */
  setOffer(offer: InboxReloadOfferView | null): void {
    const target = reloadTarget(offer)
    if (target !== this.offer) this.deps.debug(`auto-reload: the Inbox says ${target ? `a reload loads ${target}` : 'no reload is needed'}`)
    this.offer = target
  }

  /** A main-loop turn started: a refused run may be tried again, and the prompts on their way in have arrived. */
  onInputMoved(): void {
    this.heldForInput = false
    this.promptsEntering = 0
  }

  /** A prompt reached prompt.submit: the session counts as busy until its turn starts, it is dropped, or it went into a running turn. */
  notePromptEntering(): void {
    this.promptsEntering += 1
    this.promptEnteringTick = this.ticks
  }

  /** A prompt noted by notePromptEntering was dropped, or went into a turn already running. */
  notePromptSettled(): void {
    if (this.promptsEntering > 0) this.promptsEntering -= 1
  }

  dispose(): void {
    this.disposed = true
  }

  /** Every record, or null when the store could not be read. */
  private async readAll(): Promise<Record<string, AutoReloadRecord> | null> {
    try {
      return readAutoReloads(await this.deps.storeGet(STORE_AUTO_RELOAD))
    } catch {
      return null
    }
  }

  /**
   * Reads every record again (another session's process may have written its
   * own), changes this session's (`undefined`: leave it, nothing is written;
   * `null`: remove it) and writes. True when the store took a write.
   */
  private async update(change: (current: AutoReloadRecord | null) => AutoReloadRecord | null | undefined): Promise<boolean> {
    const all = await this.readAll()
    if (!all) return false
    const next = change(all[this.deps.sessionId] ?? null)
    if (next === undefined) return false
    if (next === null) delete all[this.deps.sessionId]
    else all[this.deps.sessionId] = next
    const kept = Object.entries(all)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, AUTO_RELOAD_KEEP)
    try {
      await this.deps.storeSet(STORE_AUTO_RELOAD, Object.fromEntries(kept))
      return true
    } catch {
      return false
    }
  }

  /** This session's record, or null (none, or the store could not be read). */
  async record(): Promise<AutoReloadRecord | null> {
    return (await this.readAll())?.[this.deps.sessionId] ?? null
  }

  /** Why not now, from the synchronous gates alone: what is checked last, right before the run. */
  private busyNow(target: string): string | null {
    if (this.disposed) return 'the instance was disposed'
    if (this.offer !== target) return 'the Inbox changed its word'
    if (this.promptsEntering > 0) return 'a prompt is on its way in'
    return this.deps.busyReason()
  }

  /** One look, from the Inbox tick. Never throws; runs at most one reload at a time. */
  async tick(): Promise<void> {
    this.ticks += 1
    if (this.promptsEntering > 0 && this.ticks - this.promptEnteringTick > AUTO_RELOAD_PROMPT_GAP_TICKS) this.promptsEntering = 0
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
    if (this.busyNow(target) !== null) return
    const attempt = this.attempts.get(target)
    // In memory first: this module ran for that version already (unless the engine refused it, within the limit).
    if (attempt && !(attempt.refused && attempt.runs < AUTO_RELOAD_MAX_REFUSALS)) return
    const loaded = await this.deps.loaded()
    if (!loaded || loaded.version === null) return
    const start = await this.deps.now()
    if (start < this.storeRetryAt) return
    const all = await this.readAll()
    if (!all) {
      this.storeRetryAt = start + AUTO_RELOAD_STORE_RETRY_MS
      this.deps.debug('auto-reload: the store could not be read; nothing runs')
      return
    }
    const previous = all[this.deps.sessionId] ?? null
    if (!storeAllows(previous, target)) return
    if ((await this.deps.promptText!()).trim() !== '') return
    if (this.deps.agentsBusy && (await this.deps.agentsBusy()) !== null) return
    if (this.busyNow(target) !== null) return

    // The pending record first, read back: nothing runs unless the store kept it.
    const at = await this.deps.now()
    const refusals = previous && previous.version === target ? (previous.refusals ?? 0) : 0
    const tried = [...triedOf(previous).filter((v) => v !== target), target].slice(-AUTO_RELOAD_TRIED_KEEP)
    const record: AutoReloadRecord = {
      version: target,
      at,
      from: { version: loaded.version, loadedAt: loaded.loaded_at },
      outcome: 'pending',
      tried,
      ...(refusals ? { refusals } : {}),
    }
    const wrote = await this.update(() => record)
    const kept = wrote ? await this.record() : null
    if (!kept || kept.at !== at || kept.version !== target || kept.outcome !== 'pending') {
      this.storeRetryAt = at + AUTO_RELOAD_STORE_RETRY_MS
      this.deps.debug(`auto-reload: the store did not keep the record (${wrote ? 'it read back otherwise' : 'the write failed'}); nothing runs`)
      return
    }

    // The last look, after the store calls: the box and the agent list, then every
    // synchronous gate with no await between it and the run.
    const box = await this.deps.promptText!()
    const agents = this.deps.agentsBusy ? await this.deps.agentsBusy() : null
    const busy = box.trim() !== '' ? 'text is in the prompt box' : (agents ?? this.busyNow(target))
    if (busy !== null) {
      // Put the record back as it was: this run never happened.
      await this.update((current) => (current && current.at === at && current.outcome === 'pending' ? previous : undefined))
      this.deps.debug(`auto-reload: not now (${busy})`)
      return
    }
    const runs = (attempt?.runs ?? 0) + 1
    this.attempts.set(target, { runs, refused: false })
    this.deps.debug(`auto-reload: running /${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS} (loaded ${loaded.version}, installed ${target})`)
    try {
      // Queued by the engine and run once the session is idle. When the reload
      // replaces this module, nothing below runs: the new module checks in.
      await this.deps.run!()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.attempts.set(target, { runs, refused: true })
      this.heldForInput = true
      // Only over this run's own pending record: never over what a newer module wrote.
      await this.update((current) =>
        current && current.at === at && current.outcome === 'pending' ? { ...current, outcome: 'refused', refusals: refusals + 1, reason } : undefined,
      )
      this.deps.debug(`auto-reload: refused before it ran (${reason}); ${refusals + 1 >= AUTO_RELOAD_MAX_REFUSALS ? 'not tried again for this version' : 'tried again after the next turn starts'}`)
      return
    }
    this.deps.debug('auto-reload: the command ran; waiting for the new module to check in')
    this.deps.after(AUTO_RELOAD_CHECK_IN_MS, () => {
      void this.notReplaced(record).catch(() => undefined)
    })
  }

  /** Still here after the check-in window: the reload did not load new code into this module. */
  private async notReplaced(record: AutoReloadRecord): Promise<void> {
    if (this.disposed) return
    const wrote = await this.update((current) =>
      current && current.at === record.at && current.outcome === 'pending' ? { ...current, outcome: 'did_not_take' } : undefined,
    )
    if (!wrote) return
    this.deps.debug(
      `auto-reload: this module was not replaced within ${AUTO_RELOAD_CHECK_IN_MS / 1000} s; not tried again for ${record.version} (the Inbox keeps the manual /reload-plugins notice)`,
    )
  }

  /**
   * The module's first instance in this session: if this session's reload is
   * pending and this module loaded after it was queued (and checks in soon
   * after it loaded), this module is its result: `checked_in` when it loaded
   * the version asked for, `did_not_take` when it is still another. Returns
   * the record written, or null.
   */
  async checkIn(): Promise<AutoReloadRecord | null> {
    const record = await this.record()
    if (!record || record.outcome !== 'pending') return null
    const loaded = await this.deps.loaded()
    const now = await this.deps.now()
    const loadedAt = loaded?.loaded_at ?? null
    if (loadedAt === null || loadedAt < record.at || loadedAt - record.at > AUTO_RELOAD_QUEUE_MAX_MS || now - loadedAt > 2 * AUTO_RELOAD_CHECK_IN_MS) return null
    const version = loaded?.version ?? null
    const took = version !== null && version.trim() === record.version
    const checked: AutoReloadRecord = { ...record, outcome: took ? 'checked_in' : 'did_not_take', checkedIn: { at: now, version, loadedAt } }
    const wrote = await this.update((current) => (current && current.at === record.at && current.outcome === 'pending' ? checked : undefined))
    if (!wrote) return null
    this.checkedIn = took
    this.deps.debug(
      `auto-reload: ${took ? 'checked in' : 'the reload did not take'} after /${AUTO_RELOAD_COMMAND}: loaded ${version ?? 'unknown'} (wanted ${record.version}) ${Math.round((now - record.at) / 100) / 10} s after the run was queued`,
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
    const wrote = await this.update((current) => (current && current.outcome === 'checked_in' ? { ...current, ...change } : undefined))
    if (wrote) this.deps.debug(`auto-reload: after the reload, ${line}`)
  }
}
