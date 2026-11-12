import type { LoadedPluginInfo } from './host'

export const AUTO_RELOAD_COMMAND = 'reload-plugins'
export const AUTO_RELOAD_ARGS = 'plannotator'
export const STORE_AUTO_RELOAD = 'autoReloads'
export const AUTO_RELOAD_KEEP = 50
export const AUTO_RELOAD_TRIED_KEEP = 10
export const AUTO_RELOAD_CHECK_IN_MS = 30_000
export const AUTO_RELOAD_QUEUE_MAX_MS = 30 * 60_000
export const AUTO_RELOAD_MAX_REFUSALS = 3
export const AUTO_RELOAD_STORE_RETRY_MS = 60_000
export const AUTO_RELOAD_PROMPT_GAP_TICKS = 30

export type AutoReloadOutcome = 'pending' | 'checked_in' | 'did_not_take' | 'refused'

export interface AutoReloadRecord {
  version: string
  at: number
  from: { version: string | null; loadedAt: number | null }
  outcome: AutoReloadOutcome
  tried?: string[]
  refusals?: number
  reason?: string
  checkedIn?: { at: number; version: string | null; loadedAt: number | null }
  tools?: boolean
  inbox?: boolean
}

export interface InboxReloadOfferView {
  installed: string | null
}

export interface AutoReloadAttempt {
  runs: number
  refused: boolean
}

const moduleAttempts = new Map<string, AutoReloadAttempt>()

export interface AutoReloadDeps {
  now(): Promise<number>
  sessionId: string
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  loaded(): Promise<LoadedPluginInfo | null>
  promptText?: () => Promise<string>
  busyReason(): string | null
  run?: () => Promise<unknown>
  after(ms: number, fn: () => void): void
  debug(text: string): void
  attempts?: Map<string, AutoReloadAttempt>
}

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

export function reloadTarget(offer: InboxReloadOfferView | null): string | null {
  return offer && typeof offer.installed === 'string' && offer.installed.trim() ? offer.installed.trim() : null
}

function triedOf(record: AutoReloadRecord | null): string[] {
  if (!record) return []
  const tried = Array.isArray(record.tried) ? record.tried.filter((v): v is string => typeof v === 'string') : []
  return tried.includes(record.version) ? tried : [...tried, record.version]
}

function storeAllows(previous: AutoReloadRecord | null, target: string): boolean {
  if (!previous) return true
  if (previous.version === target) return previous.outcome === 'refused' && (previous.refusals ?? 0) < AUTO_RELOAD_MAX_REFUSALS
  return !triedOf(previous).includes(target)
}

export function hidesReloadOutput(props: { command?: unknown; args?: unknown; text?: unknown; isErrored?: unknown }): boolean {
  if (props.command !== AUTO_RELOAD_COMMAND || props.isErrored === true) return false
  if (typeof props.args !== 'string' || props.args.trim() !== AUTO_RELOAD_ARGS) return false
  if (typeof props.text !== 'string' || !props.text.trimStart().startsWith('Reloaded:')) return false
  return !/error|could not|not applied|--force|isn't available|failed/i.test(props.text)
}

export class AutoReload {
  private offer: string | null | undefined = undefined
  private running = false
  private heldForInput = false
  private disposed = false
  private checkedIn = false
  private noted = new Set<string>()
  private readonly attempts: Map<string, AutoReloadAttempt>
  private storeRetryAt = 0
  private ticks = 0
  private promptsSubmitting = 0
  private promptsAwaitingTurn = 0
  private promptAwaitingTick = 0
  private lastHeld: string | null = null

  constructor(private readonly deps: AutoReloadDeps) {
    this.attempts = deps.attempts ?? moduleAttempts
  }

  setOffer(offer: InboxReloadOfferView | null): void {
    const target = reloadTarget(offer)
    if (target !== this.offer) this.deps.debug(`auto-reload: the Inbox says ${target ? `a reload loads ${target}` : 'no reload is needed'}`)
    this.offer = target
  }

  onInputMoved(): void {
    this.heldForInput = false
    this.promptsAwaitingTurn = 0
  }

  notePromptSubmitting(): void {
    this.promptsSubmitting += 1
  }

  notePromptLeft(how: 'dropped' | 'into-turn' | 'new-turn'): void {
    if (this.promptsSubmitting > 0) this.promptsSubmitting -= 1
    if (how !== 'new-turn') return
    this.promptsAwaitingTurn += 1
    this.promptAwaitingTick = this.ticks
  }

  private held(reason: string): void {
    if (reason === this.lastHeld) return
    this.lastHeld = reason
    this.deps.debug(`auto-reload: not now (${reason})`)
  }

  dispose(): void {
    this.disposed = true
  }

  private async readAll(): Promise<Record<string, AutoReloadRecord> | null> {
    try {
      return readAutoReloads(await this.deps.storeGet(STORE_AUTO_RELOAD))
    } catch {
      return null
    }
  }

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

  async record(): Promise<AutoReloadRecord | null> {
    return (await this.readAll())?.[this.deps.sessionId] ?? null
  }

  private busyNow(target: string): string | null {
    if (this.disposed) return 'the instance was disposed'
    if (this.offer !== target) return 'the Inbox changed its word'
    if (this.promptsSubmitting > 0) return 'a prompt is being submitted'
    if (this.promptsAwaitingTurn > 0) return 'a prompt waits for its turn to start'
    return this.deps.busyReason()
  }

  async tick(): Promise<void> {
    this.ticks += 1
    if (this.promptsAwaitingTurn > 0 && this.ticks - this.promptAwaitingTick > AUTO_RELOAD_PROMPT_GAP_TICKS) this.promptsAwaitingTurn = 0
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
    const early = this.busyNow(target)
    if (early !== null) return this.held(early)
    const attempt = this.attempts.get(target)
    if (attempt && !(attempt.refused && attempt.runs < AUTO_RELOAD_MAX_REFUSALS)) return this.held(`this module already ran for ${target}`)
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
    if (!storeAllows(previous, target)) return this.held(`this session already tried ${target} (${previous?.outcome ?? 'no record'})`)
    if ((await this.deps.promptText!()).trim() !== '') return this.held('text is in the prompt box')
    const beforeWrite = this.busyNow(target)
    if (beforeWrite !== null) return this.held(beforeWrite)

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

    const box = await this.deps.promptText!()
    const busy = box.trim() !== '' ? 'text is in the prompt box' : this.busyNow(target)
    if (busy !== null) {
      const putBack = await this.update((current) => (current && current.at === at && current.outcome === 'pending' ? previous : undefined))
      this.held(busy)
      if (!putBack) this.deps.debug(`auto-reload: the record could not be put back; ${target} stays pending and is not tried again in this session (the manual notice stays)`)
      return
    }
    this.lastHeld = null
    const runs = (attempt?.runs ?? 0) + 1
    this.attempts.set(target, { runs, refused: false })
    this.deps.debug(`auto-reload: running /${AUTO_RELOAD_COMMAND} ${AUTO_RELOAD_ARGS} (loaded ${loaded.version}, installed ${target})`)
    try {
      await this.deps.run!()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.attempts.set(target, { runs, refused: true })
      this.heldForInput = true
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

  async noteTools(registered: boolean): Promise<void> {
    await this.amend({ tools: registered }, `the plannotator tools ${registered ? 'are registered' : 'did NOT register'}`)
  }

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
