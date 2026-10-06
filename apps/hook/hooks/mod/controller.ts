/**
 * The Plannotator mod's state for one Claude Code session: the reviews it has
 * open, the plan approval waiting for Claude's next ExitPlanMode, delivery of
 * decisions as plugin turns, and the "Ask this session" bridges.
 *
 * Every engine call goes through `Host` (built from `$` in register.ts), so
 * bun tests drive this class with a host made of memory.
 */

import { BRIDGE_HOST, BRIDGE_MODES, bridgeBaseUrl, createBridge, type BridgeEnd, type BridgeHandle } from './bridge'
import { deliveryFor, legacyResult, parseHostResult, type HostResultRecord, type SessionKind } from './delivery'
import type { Host, HttpResult } from './host'
import {
  aliveArgv,
  CLAIM_EXIT,
  claimArgv,
  cleanupArgv,
  stopArgv,
  STOP_EXIT,
  cliArgvFor,
  failedText,
  fileIn,
  isSeveralFilePaths,
  launchArgv,
  launchDirOf,
  modTargetFor,
  openedText,
  parseReadyFile,
  pickerFile,
  privateDirArgv,
  pruneArgv,
  RECENT_MESSAGES_SUBJECT,
  recentAssistantTexts,
  SETTLED_BY,
  SETTLED_DIR,
  subjectFor,
  wordsOf,
} from './launch'
import {
  approvedPermissionDecision,
  CLASSIC_PLAN_RETRY_TEXT,
  CLASSIC_PLAN_REVIEW_TEXT,
  cliLacksModPlan,
  decidingDenyText,
  isTrustablePlanPath,
  MAX_PLAN_FILE_BYTES,
  normalizePlanForHash,
  planCallAction,
  planWaitingStatus,
  revisedDenyText,
  revisionPendingDenyText,
  unchangedDenyText,
  waitingDenyText,
  type OpenPlanReview,
  type PendingApproval,
} from './plan'
import {
  isOlderCliBundleRefusal,
  parsePlannotatorToolInput,
  plannotatorDistinctSubjects,
  plannotatorSameTarget,
  plannotatorBundleSubject,
  plannotatorSessionId,
  plannotatorToolArgs,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorToolOpenedText,
  plannotatorToolTargets,
  plannotatorUnknownSessionText,
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  scriptOnlyAnnotateFlag,
  scriptOnlyAnnotateFlagText,
  type PlannotatorCloseOutcome,
  type PlannotatorSessionSummary,
  type PlannotatorTarget,
} from './tool'
import { TurnTracker, type EnteredPrompt } from './turns'

/** Persisted in `$.store` so open reviews reattach after a restart or `--resume`. */
export interface LaunchRecord {
  id: string
  sessionId: string
  kind: SessionKind
  dir: string
  /** How the launch is named now: `baseSubject`, told apart from same-named open launches. */
  subject: string
  /** The subject before same-named launches were told apart (`plannotatorDistinctSubjects`). */
  baseSubject?: string
  /**
   * What the launch shows, in full. From the ready file when the CLI names it
   * (`targetFromServer`), else the mod's own resolution of the words: the
   * fallback a decision from an older CLI (no `target` in its record) is named by.
   */
  target?: string | string[]
  /** `target` came from the server's ready file, not the mod's guess. */
  targetFromServer?: boolean
  startedAt: number
  url?: string
  port?: number
  /** Plan: the version shown in the copy. */
  version?: number
  /** Plan: the last revision sequence written to revision.json. */
  revisionSeq?: number
  /** The pull-bridge token this launch's server was started with. */
  bridgeToken?: string
  /**
   * Opened by Claude's `plannotator` tool with `gate: true`: Claude was told
   * to wait for the sign-off, so a bare approval is delivered as a turn (the
   * slash command's bare approval only logs).
   */
  deliverApproval?: boolean
  /**
   * Claude closed this review (the `plannotator` tool's `close`): nothing is
   * delivered for it, and it is gone from `list` and the status line while
   * the server shuts down.
   */
  closedByAgent?: boolean
}

/** The `pn-` session id of a launch: the six hex digits that end its launch id. */
export function sessionIdOf(launch: { id: string }): string {
  const hex = /([0-9a-f]{6})$/i.exec(launch.id)?.[1] ?? '000000'
  return plannotatorSessionId(hex)
}

/** The host-only endpoints of the CLI's server (packages/shared/host-control.ts). */
export const HOST_STATUS_PATH = '/api/host/status'
export const HOST_CLOSE_PATH = '/api/host/close'
/** The code a current CLI's 404 carries while host control is off (packages/shared/host-control.ts). */
export const HOST_CONTROL_DISABLED_CODE = 'host_control_disabled'

function jsonObjectOf(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What `POST /api/host/close` told the mod. */
export type HostCloseAnswer =
  | { kind: 'closed'; unsent: number }
  | { kind: 'decided' }
  /** A Plannotator without the endpoint answered: a JSON 404 (0.24+) or its app page (0.19.24–0.23.x). */
  | { kind: 'older' }
  /** A Plannotator WITH the endpoint, turned off (remote mode): `404 { code: "host_control_disabled" }`. */
  | { kind: 'disabled' }
  | { kind: 'refused'; status: number }
  /** Nothing answered on the port. */
  | { kind: 'unreachable' }

/**
 * Reads the close answer. Only a JSON body with a numeric `unsentAnnotations`
 * is a close: a CLI before the `/api/*` 404 guard (#748) serves its app page
 * with 200 for any path, which must not read as closed (the reviewer's later
 * decision would be swallowed as the agent's close).
 */
export function classifyHostCloseAnswer(response: HttpResult | null): HostCloseAnswer {
  if (!response) return { kind: 'unreachable' }
  const body = jsonObjectOf(response.text)
  if (body) {
    if (response.ok && typeof body.unsentAnnotations === 'number') return { kind: 'closed', unsent: body.unsentAnnotations }
    if (response.status === 409 && body.code === 'already_decided') return { kind: 'decided' }
    if (response.status === 404 && body.code === HOST_CONTROL_DISABLED_CODE) return { kind: 'disabled' }
    if (response.status === 404 && typeof body.error === 'string') return { kind: 'older' }
    return { kind: 'refused', status: response.status }
  }
  if (response.status === 200 && /<html|<!doctype html/i.test(response.text)) return { kind: 'older' }
  return { kind: 'refused', status: response.status }
}

export const STORE_LAUNCHES = 'launches'
export const STORE_APPROVALS = 'approvals'

const TICK_MS = 1_000
/** Liveness check of a launch whose server has not decided yet. */
const PID_CHECK_EVERY_TICKS = 15
const PID_MISSES_BEFORE_STOPPED = 3
const READY_WAIT_MS = { review: 45_000, other: 15_000 }
const REVISION_ACK_WAIT_MS = 4_000
/**
 * A bridge loop that ended because the server stopped answering is started
 * again after `first`, doubling up to `max` while it keeps failing. A loop
 * that got through at least once starts the next wait at `first` again.
 */
export const BRIDGE_RETRY_MS = { first: 5_000, max: 60_000 } as const
/**
 * The watcher lease (`watcher.json` in the launch directory): when two Claude
 * Code processes hold the same session (`claude --continue` while the first
 * still runs), one of them watches a launch, runs its bridge and delivers its
 * decision. The process the person last acted in wins it (`touchedAt`:
 * restore, a typed prompt, a command, the tool, ExitPlanMode); the holder
 * renews it every `LEASE_EVERY_TICKS`, and anyone takes it over once it is
 * `LEASE_STALE_MS` old (the holder exited, slept, or hung). Delivery is also
 * claimed once per launch (`claimArgv`), so a lease race can never deliver
 * twice.
 */
const LEASE_EVERY_TICKS = 5
export const LEASE_STALE_MS = 20_000
/**
 * The minimum age of a stored record `pruneStoredLaunches` looks at: a
 * younger one's wrapper may not have written its pid yet.
 */
export const LAUNCH_SETTLED_AGE_MS = 60_000
/** Another session's launch this old whose server is gone is pruned even with a decision waiting. */
export const LAUNCH_EXPIRED_MS = 14 * 24 * 60 * 60_000
/**
 * A claimed decision whose claimant has not renewed its watcher lease for
 * this long (or released it at `session.end`) and never marked it delivered
 * is reported as undelivered: the claimant quit (or crashed) while
 * `$.prompt.submit` waited for Claude to go idle.
 */
export const UNDELIVERED_AFTER_MS = 60_000
export const SETTLED_DELIVERED = `${SETTLED_DIR}/delivered`
export const SETTLED_REPORTED = `${SETTLED_DIR}/reported`

/** A stored record minus the in-memory watch state. */
function recordOf(launch: LiveLaunch): LaunchRecord {
  const {
    pidMisses: _misses,
    ticks: _ticks,
    settling: _settling,
    starting: _starting,
    bridge: _bridge,
    bridgeRetryAt: _retryAt,
    bridgeBackoffMs: _backoff,
    bridgeOff: _off,
    leader: _leader,
    leaseTick: _leaseTick,
    touchedAt: _touchedAt,
    checking: _checking,
    ...record
  } = launch
  return record
}

interface LiveLaunch extends LaunchRecord {
  pidMisses: number
  ticks: number
  settling: boolean
  /**
   * A hook is still waiting in `awaitReady` for this launch to come up or
   * fail: that hook reports the outcome, so the timer leaves the launch alone.
   */
  starting: boolean
  /** A tick is checking this launch now: the next tick skips it (ticks are not awaited). */
  checking: boolean
  bridge: BridgeHandle | null
  /** No new bridge before this time (after a loop gave up on a silent server). */
  bridgeRetryAt: number
  /** The last retry wait, doubled while loops keep failing. */
  bridgeBackoffMs: number
  /** The server refused the bridge (an older CLI, a wrong token, AI off) or is closing: never again. */
  bridgeOff: boolean
  /** This instance holds the watcher lease: it runs the bridge and delivers. */
  leader: boolean
  /** The tick the lease was last looked at; null: never. */
  leaseTick: number | null
  /**
   * When the person last acted on this launch from this process (restored it,
   * typed here, ran a command or tool, ExitPlanMode); 0: never. The more
   * recent touch wins the watcher lease.
   */
  touchedAt: number
}

interface WatcherLease {
  owner: string | null
  /** Heartbeat. */
  at: number
  /** The holder's `touchedAt` for this launch. */
  touchedAt: number
}

function parseWatcherLease(text: string): WatcherLease | null {
  const body = jsonObjectOf(text)
  if (!body || typeof body.at !== 'number') return null
  return {
    owner: typeof body.owner === 'string' && body.owner ? body.owner : null,
    at: body.at,
    touchedAt: typeof body.touchedAt === 'number' ? body.touchedAt : 0,
  }
}

export interface SessionInfo {
  sessionId: string
  dataDir: string
  interactive: boolean
}

export class PlannotatorMod {
  readonly turns = new TurnTracker()
  private launches = new Map<string, LiveLaunch>()
  private approval: PendingApproval | null = null
  /** ExitPlanMode calls passed through as the approved plan, by tool_use_id. */
  private passing = new Map<string, PendingApproval>()
  private planVersion = 0
  /**
   * The CLI has no `claude-mod-plan` (it is older than the plugin): every
   * ExitPlanMode of this session takes Claude Code's own flow, and the
   * plugin's classic hook reviews it, blocking, as before the mod.
   */
  private classicPlanReview = false
  private timer: { cancel: () => void } | null = null
  private delivering: Promise<void> = Promise.resolve()
  private sequence = 0
  private disposed = false
  /** Launch ids this instance settled or dropped: kept out of the store even if another process re-adds them. */
  private forgotten = new Set<string>()
  /** Names this instance in a launch's watcher lease and settlement claim. */
  private readonly instanceId: string
  /** The store housekeeping started at restore (awaited by tests only). */
  pruning: Promise<void> = Promise.resolve()
  /**
   * Launches this instance claimed whose decision waits for Claude to go idle
   * (`$.prompt.submit`): their records stay in the store and their lease is
   * renewed until `settled/delivered` is written, so another process can tell
   * a claimant still waiting from one that quit.
   */
  private awaitingIdle = new Map<string, LaunchRecord>()
  /** Launches another process claimed: watched until delivered, or reported once its claimant is gone. */
  private claimedElsewhere = new Map<string, LaunchRecord>()
  private tickCount = 0

  constructor(
    private readonly host: Host,
    readonly session: SessionInfo,
  ) {
    this.instanceId = host.randomHex(8)
  }

  // --- Lifecycle -----------------------------------------------------------

  /**
   * Reattach the reviews this session left open (restart, `--resume`,
   * `--continue`). Restoring is the strongest sign the person now works in
   * THIS process, so its launches are touched: when another process still
   * runs on the same session, this one takes over watching them
   * (`holdLease`), and their decisions land in the conversation in use.
   */
  async restore(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const records = (Array.isArray(stored) ? (stored as LaunchRecord[]) : []).filter(
      (record) => record && record.sessionId === this.session.sessionId && typeof record.dir === 'string',
    )
    const now = await this.host.now()
    const mine: LaunchRecord[] = []
    for (const record of records) {
      // Already settled: delivered, still on its way, or stranded (reported).
      if (await this.host.exists(`${record.dir}/${SETTLED_DIR}`)) {
        await this.watchClaimedElsewhere(record)
        continue
      }
      // Cleaned up: nothing to reattach.
      if (!(await this.host.exists(fileIn(record.dir, 'stdin')))) continue
      mine.push(record)
    }
    // Watched from here from now on (the lease is written at once, so a
    // decision arriving before the first tick lands here too).
    for (const record of mine) await this.holdLease(this.adopt(record, now), true).catch(() => false)
    this.refreshSubjects()
    await this.loadApproval()
    for (const launch of this.launches.values()) {
      if (launch.kind === 'plan') this.planVersion = Math.max(this.planVersion, launch.version ?? 0)
    }
    if (mine.length > 0) {
      const names = mine.map((record) => record.subject).join(', ')
      this.host.log(`Reattached ${mine.length} open ${mine.length === 1 ? 'session' : 'sessions'} (${names}).`)
      this.refreshStatus()
    }
    this.ensureTimer()
    // Housekeeping off the session-start path.
    this.pruning = this.pruneStoredLaunches().catch(() => undefined)
  }

  /**
   * The approval waiting for this session's next ExitPlanMode, from the store:
   * another Claude Code process on the session may have received it, or
   * already used it.
   */
  private async loadApproval(): Promise<void> {
    const approvals = await this.host.storeGet(STORE_APPROVALS)
    const approval = approvals && typeof approvals === 'object' ? (approvals as Record<string, PendingApproval>)[this.session.sessionId] : undefined
    this.approval = approval && typeof approval.hash === 'string' ? approval : null
  }

  /**
   * Adopt this session's launches another Claude Code process on the same
   * session started after this one restored, so a plan review, `list` and
   * `close` see them here too.
   */
  private async adoptNewStoredLaunches(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const records = Array.isArray(stored) ? (stored as LaunchRecord[]) : []
    const now = await this.host.now()
    let adopted = 0
    for (const record of records) {
      if (!record || record.sessionId !== this.session.sessionId || typeof record.dir !== 'string') continue
      if (this.launches.has(record.id) || this.forgotten.has(record.id) || this.claimedElsewhere.has(record.id)) continue
      if (await this.host.exists(`${record.dir}/${SETTLED_DIR}`)) {
        await this.watchClaimedElsewhere(record)
        continue
      }
      if (!(await this.host.exists(fileIn(record.dir, 'stdin')))) continue
      const live = this.adopt(record, now)
      if (live.kind === 'plan') this.planVersion = Math.max(this.planVersion, live.version ?? 0)
      adopted += 1
    }
    if (adopted > 0) this.refreshStatus()
    this.ensureTimer()
  }

  /**
   * Where a claimed launch's decision stands: delivered (or nothing to
   * deliver), on its way (its claimant renews its lease, or it is this
   * instance's own), or stranded (its claimant quit while waiting for Claude to
   * go idle), with the file holding the decision.
   */
  private async claimedState(record: LaunchRecord): Promise<'done' | 'waiting' | { stranded: string }> {
    const dir = record.dir
    if (!(await this.host.exists(`${dir}/${SETTLED_DIR}`))) return 'done'
    if (await this.host.exists(`${dir}/${SETTLED_DELIVERED}`)) return 'done'
    if (await this.host.exists(`${dir}/${SETTLED_REPORTED}`)) return 'done'
    if (!(await this.host.exists(fileIn(dir, 'stdin')))) return 'done'
    let decision: string | null = null
    if (await this.host.exists(fileIn(dir, 'result'))) decision = fileIn(dir, 'result')
    else if ((await this.host.readFile(fileIn(dir, 'exit')).catch(() => '')).trim() === '0') decision = fileIn(dir, 'stdout')
    // A claim on a server that stopped without a decision: nothing was lost.
    if (!decision) return 'done'
    const by = (await this.host.readFile(`${dir}/${SETTLED_BY}`).catch(() => '')).trim()
    if (by === this.instanceId) return this.awaitingIdle.has(record.id) ? 'waiting' : 'done'
    const lease = parseWatcherLease(await this.host.readFile(fileIn(dir, 'watcher')).catch(() => ''))
    const now = await this.host.now()
    if (lease?.owner && lease.owner === by && now - lease.at < UNDELIVERED_AFTER_MS) return 'waiting'
    return { stranded: decision }
  }

  /**
   * A launch another process claimed: report it now if its decision was
   * stranded, else watch it until it is delivered or stranded. Never
   * delivered from here: the claimant may still be waiting to deliver it, so
   * only a report is strictly at most once.
   */
  private async watchClaimedElsewhere(record: LaunchRecord): Promise<void> {
    const state = await this.claimedState(record)
    if (state === 'done') {
      this.claimedElsewhere.delete(record.id)
      return
    }
    if (state === 'waiting') {
      this.claimedElsewhere.set(record.id, record)
      this.ensureTimer()
      return
    }
    this.claimedElsewhere.delete(record.id)
    await this.host.writeFile(`${record.dir}/${SETTLED_REPORTED}`, String(await this.host.now())).catch(() => undefined)
    this.host.log(`A decision for ${record.subject} arrived but wasn't delivered — it's saved in ${state.stranded}.`)
    this.host.toast(`${record.subject}: a decision wasn't delivered; it is saved on disk`)
  }

  /**
   * The person acts in this process (a prompt typed here, a slash command,
   * Claude's tool, ExitPlanMode): its launches should be watched from here,
   * so the lease is taken at once.
   */
  private async touchLaunches(): Promise<void> {
    if (this.launches.size === 0) return
    const now = await this.host.now()
    for (const launch of [...this.launches.values()]) {
      launch.touchedAt = now
      if (!launch.settling) await this.holdLease(launch, true).catch(() => false)
    }
  }

  /**
   * The session this instance serves ended (`/clear`, an in-process resume,
   * exit). Stop watching and polling so nothing is delivered into whatever
   * session the process goes on with; open reviews stay in the store under
   * this session id and reattach when it is resumed.
   */
  dispose(): void {
    this.disposed = true
    this.timer?.cancel()
    this.timer = null
    this.host.status(undefined)
    // Hand the launches this instance watched to any other process on the session at once.
    for (const launch of this.launches.values()) {
      if (!launch.leader) continue
      launch.leader = false
      void this.host.writeFile(fileIn(launch.dir, 'watcher'), JSON.stringify({ owner: null, at: 0, touchedAt: 0 })).catch(() => undefined)
    }
    // A decision still waiting for Claude to go idle: say at once that nobody waits for it any more.
    for (const record of this.awaitingIdle.values()) {
      void this.host.writeFile(fileIn(record.dir, 'watcher'), JSON.stringify({ owner: null, at: 0, touchedAt: 0 })).catch(() => undefined)
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private adopt(record: LaunchRecord, touchedAt = 0): LiveLaunch {
    const live: LiveLaunch = {
      ...record,
      pidMisses: 0,
      ticks: 0,
      settling: false,
      starting: false,
      checking: false,
      bridge: null,
      bridgeRetryAt: 0,
      bridgeBackoffMs: 0,
      bridgeOff: false,
      leader: false,
      leaseTick: null,
      touchedAt,
    }
    this.launches.set(record.id, live)
    return live
  }

  /**
   * Drops stored records nothing is left of (all sessions older than a
   * minute, whose wrapper has surely written its pid):
   * - settled or cleaned-up launches (a `settled/` claim, no `stdin`);
   * - other sessions' servers that died without a decision;
   * - other sessions' launches older than `LAUNCH_EXPIRED_MS` whose server is
   *   gone, decision or not (a session nobody resumed).
   * A live server always keeps its record; this session's dead servers are
   * left to the timer, which reports them. The store is read again before the
   * write, so a record another process added meanwhile is kept.
   */
  private async pruneStoredLaunches(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const records = (Array.isArray(stored) ? (stored as LaunchRecord[]) : []).filter(
      (record) => record && typeof record.dir === 'string' && typeof record.sessionId === 'string',
    )
    const now = await this.host.now()
    const age = (record: LaunchRecord) => now - (Number(record.startedAt) || 0)
    const old = records.filter((record) => age(record) > LAUNCH_SETTLED_AGE_MS)
    if (old.length === 0) return
    const mine = (record: LaunchRecord) => record.sessionId === this.session.sessionId
    const groups = {
      cleaned: old.filter(mine).map((record) => record.dir),
      dead: old.filter((record) => !mine(record) && age(record) <= LAUNCH_EXPIRED_MS).map((record) => record.dir),
      expired: old.filter((record) => !mine(record) && age(record) > LAUNCH_EXPIRED_MS).map((record) => record.dir),
    }
    const probe = await this.host.run(pruneArgv(groups), { timeoutMs: 5_000 }).catch(() => null)
    if (!probe || probe.exitCode !== 0) return
    const gone = new Set(probe.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
    if (gone.size === 0) return
    const current = await this.host.storeGet(STORE_LAUNCHES)
    const all = Array.isArray(current) ? (current as LaunchRecord[]) : []
    const kept = all.filter((record) => !record || typeof record.dir !== 'string' || !gone.has(record.dir) || this.launches.has(record.id))
    this.host.debug(`pruned ${all.length - kept.length} stored launch record(s)`)
    await this.host.storeSet(STORE_LAUNCHES, kept)
  }

  /**
   * Writes this instance's launches for this session. Records of this session
   * this instance does not know (another Claude Code process on the same
   * session launched them) are kept, unless this instance settled them.
   */
  private async persist(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const all = (Array.isArray(stored) ? (stored as LaunchRecord[]) : []).filter((record) => !!record)
    const others = all.filter(
      (record) =>
        record.sessionId !== this.session.sessionId ||
        (!this.launches.has(record.id) && !this.awaitingIdle.has(record.id) && !this.forgotten.has(record.id)),
    )
    // A decision waiting for Claude to go idle keeps its record: if this
    // process quits first, the next restore finds and reports it.
    const mine: LaunchRecord[] = [...[...this.launches.values()].map(recordOf), ...this.awaitingIdle.values()]
    await this.host.storeSet(STORE_LAUNCHES, [...others, ...mine])
  }

  private async persistApproval(): Promise<void> {
    const stored = await this.host.storeGet(STORE_APPROVALS)
    const all = stored && typeof stored === 'object' ? { ...(stored as Record<string, PendingApproval>) } : {}
    if (this.approval) all[this.session.sessionId] = this.approval
    else delete all[this.session.sessionId]
    await this.host.storeSet(STORE_APPROVALS, all)
  }

  private hasWork(): boolean {
    return this.launches.size > 0 || this.awaitingIdle.size > 0 || this.claimedElsewhere.size > 0
  }

  private ensureTimer(): void {
    if (this.disposed || this.timer || !this.hasWork()) return
    this.timer = this.host.every(TICK_MS, () => {
      void this.tick()
    })
  }

  private stopTimerIfIdle(): void {
    if (!this.hasWork() && this.timer) {
      this.timer.cancel()
      this.timer = null
    }
  }

  /** A launch id whose last six hex digits (its `pn-` session id) no open launch of this session uses. */
  private async newLaunchId(): Promise<string> {
    this.sequence += 1
    const used = new Set([...this.launches.values()].map((launch) => sessionIdOf(launch)))
    let value = Number.parseInt(this.host.randomHex(3), 16) || 0
    let hex = value.toString(16).padStart(6, '0')
    while (used.has(plannotatorSessionId(hex))) {
      value = (value + 1) % 0x1000000
      hex = value.toString(16).padStart(6, '0')
    }
    return `${await this.host.now()}-${this.sequence}-${hex}`
  }

  // --- Launch --------------------------------------------------------------

  private async launch(
    kind: SessionKind,
    cliArgv: string[],
    subject: string,
    stdin: string | ((dir: string) => string),
    extra: Partial<LaunchRecord> = {},
    side: { messages?: string } = {},
  ): Promise<LiveLaunch | { error: string }> {
    const id = await this.newLaunchId()
    const dir = launchDirOf(this.session.dataDir, this.session.sessionId, id)
    const bridgeToken = this.host.randomHex(32)
    let cwd: string | undefined
    try {
      // Owner-only before anything lands in it (stdin holds the plan or message).
      const made = await this.host.run(privateDirArgv(dir), { timeoutMs: 5_000 })
      if (made.exitCode !== 0) return { error: made.stderr.trim() || `could not create ${dir}` }
      // The session's working directory (the CLI runs there too): what the
      // mod's fallback target resolves relative words against.
      cwd = made.stdout.trim().split('\n').pop()?.trim() || undefined
      await this.host.writeFile(fileIn(dir, 'stdin'), typeof stdin === 'function' ? stdin(dir) : stdin)
      // `last`'s picker list. A CLI that predates the variable ignores it and
      // opens the newest message from stdin, as before.
      if (side.messages !== undefined) await this.host.writeFile(fileIn(dir, 'messages'), side.messages)
      const result = await this.host.run(launchArgv(dir, cliArgv), {
        env: {
          PLANNOTATOR_READY_FILE: fileIn(dir, 'ready'),
          PLANNOTATOR_HOST_RESULT_FILE: fileIn(dir, 'result'),
          ...(side.messages !== undefined ? { PLANNOTATOR_HOST_MESSAGES_FILE: fileIn(dir, 'messages') } : {}),
          PLANNOTATOR_SESSION_BRIDGE_TOKEN: bridgeToken,
          PLANNOTATOR_SESSION_BRIDGE_HOST: BRIDGE_HOST,
          PLANNOTATOR_SESSION_BRIDGE_MODES: BRIDGE_MODES,
          // The review's pn- id, for the `sessions/` registry (`plannotator sessions`).
          PLANNOTATOR_HOST_REVIEW_ID: sessionIdOf({ id }),
        },
        timeoutMs: 15_000,
      })
      if (result.exitCode !== 0) return { error: result.stderr.trim() || `launcher exited ${result.exitCode}` }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    const target = extra.target ?? modTargetFor(kind, cliArgv.slice(2), cwd)
    const record: LaunchRecord = {
      id,
      sessionId: this.session.sessionId,
      kind,
      dir,
      subject,
      baseSubject: subject,
      startedAt: await this.host.now(),
      bridgeToken,
      ...extra,
      ...(target !== undefined ? { target } : {}),
    }
    // Launched from here: the person is in this process.
    const live = this.adopt(record, record.startedAt)
    this.refreshSubjects()
    this.host.debug(`launched ${kind} ${id}: ${cliArgv.join(' ')}`)
    await this.persist()
    this.ensureTimer()
    return live
  }

  /**
   * Wait until the server is listening or the CLI exited, up to `ms`. Called
   * from hooks, so the waiting happens in `waitForAny` (a process call), never
   * in a `$.clock` wait that would spend the hook's budget.
   */
  private async awaitReady(launch: LiveLaunch, ms: number): Promise<'ready' | 'exited' | 'timeout'> {
    launch.starting = true
    try {
      return await this.waitReadyOrExit(launch, ms)
    } finally {
      launch.starting = false
    }
  }

  private async waitReadyOrExit(launch: LiveLaunch, ms: number): Promise<'ready' | 'exited' | 'timeout'> {
    const ready = fileIn(launch.dir, 'ready')
    const exit = fileIn(launch.dir, 'exit')
    const deadline = (await this.host.now()) + ms
    for (;;) {
      if (await this.readReady(launch)) return 'ready'
      if (await this.host.exists(exit)) {
        // A last look: the CLI may have become ready and exited at once.
        return (await this.readReady(launch)) ? 'ready' : 'exited'
      }
      const left = deadline - (await this.host.now())
      if (left <= 0) return 'timeout'
      // The ready file appears before its JSON line is complete; re-check shortly.
      await this.host.waitForAny([ready, exit], (await this.host.exists(ready)) ? 200 : left)
    }
  }

  private async readReady(launch: LiveLaunch): Promise<boolean> {
    if (launch.url) return true
    const path = fileIn(launch.dir, 'ready')
    if (!(await this.host.exists(path))) return false
    const ready = parseReadyFile(await this.host.readFile(path).catch(() => ''))
    if (!ready) return false
    launch.url = ready.url
    launch.port = ready.port
    if (ready.target !== undefined) {
      // The server's own answer: it may have found a bare name elsewhere in the project.
      if (launch.target !== undefined && !plannotatorSameTarget(launch.target, ready.target)) {
        this.host.debug(`ready ${launch.id}: the server opened ${JSON.stringify(ready.target)}, not ${JSON.stringify(launch.target)}`)
      }
      launch.target = ready.target
      launch.targetFromServer = true
      this.refreshSubjects()
    }
    await this.persist()
    this.refreshStatus()
    return true
  }

  private async startupFailure(launch: LiveLaunch): Promise<string> {
    const read = (name: 'stderr' | 'stdout' | 'exit') => this.host.readFile(fileIn(launch.dir, name)).catch(() => '')
    const code = Number.parseInt((await read('exit')).trim(), 10)
    const text = failedText(launch.subject, await read('stderr'), await read('stdout'), Number.isFinite(code) ? code : null)
    await this.forget(launch)
    return text
  }

  /**
   * Not a failure to report each time: an older CLI. Say so once, and leave
   * this instance's plans to the classic review (a resumed session probes
   * once more, so a CLI updated in between is picked up).
   */
  private async fallBackToClassicPlans(launch: LiveLaunch): Promise<void> {
    this.classicPlanReview = true
    await this.forget(launch)
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
    this.host.log(CLASSIC_PLAN_REVIEW_TEXT)
  }

  /** The plan launch exited because the CLI has no `claude-mod-plan`. */
  private async lacksModPlan(launch: LiveLaunch): Promise<boolean> {
    const stderr = await this.host.readFile(fileIn(launch.dir, 'stderr')).catch(() => '')
    return cliLacksModPlan(stderr)
  }

  // --- Commands ------------------------------------------------------------

  /** `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`: open and return at once. */
  async runCommand(kind: Exclude<SessionKind, 'plan'>, rawArgs: string): Promise<string> {
    await this.touchLaunches()
    const opened = await this.open(kind, rawArgs, subjectFor(kind, rawArgs))
    switch (opened.state) {
      case 'error':
        // Several file paths given to a CLI that predates reviews of several
        // files: say to update instead of showing its "pick one" error.
        if (kind === 'annotate' && isOlderCliBundleRefusal(opened.text) && isSeveralFilePaths(wordsOf(rawArgs))) {
          return PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT
        }
        return opened.text
      case 'starting':
        return `Starting Plannotator for ${opened.subject}… it opens in your browser when ready, and your feedback comes back here as a message.`
      case 'ready':
        return openedText(kind, opened.subject, opened.url, opened.extra)
    }
  }

  /**
   * Claude's `plannotator` tool: the same launch as the slash command, with
   * the call's validated arguments (never re-split). `{ deny }` is an error
   * result for Claude (a bad call, or the CLI's startup error); `{ text }`
   * tells Claude the page is open and to end its turn and wait.
   */
  async runTool(input: unknown): Promise<{ text: string } | { deny: string }> {
    await this.adoptNewStoredLaunches()
    await this.touchLaunches()
    const parsed = parsePlannotatorToolInput(input)
    if (!parsed.ok) return { deny: parsed.error }
    const call = parsed.input
    switch (call.action) {
      case 'list':
        return { text: await this.listText() }
      case 'close':
        return this.closeSessions(call.session as string)
      case 'annotate':
      case 'review':
      case 'last':
        break
    }
    const action = call.action
    const gate = call.gate === true
    const targets = plannotatorToolTargets(call)
    // A list of files is one review of all of them (a bundle), named as such.
    const bundle = Array.isArray(call.target)
    const subject = bundle ? plannotatorBundleSubject(targets) : subjectFor(action, targets)
    const opened = await this.open(action, plannotatorToolArgs(call), subject, gate ? { deliverApproval: true } : {})
    switch (opened.state) {
      case 'error':
        // An older CLI answers several paths with its ambiguity error.
        if (bundle && isOlderCliBundleRefusal(opened.text)) return { deny: PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT }
        return { deny: opened.text }
      case 'starting':
        return { text: plannotatorToolOpenedText(opened.subject, undefined, gate, opened.sessionId, opened.target) }
      case 'ready':
        return { text: plannotatorToolOpenedText(opened.subject, opened.url, gate, opened.sessionId, opened.target) }
    }
  }

  // --- The agent's own sessions (list, close) ------------------------------

  /** The reviews this Claude session opened that are still open (not settling, not closed by Claude). */
  private openLaunches(): LiveLaunch[] {
    return [...this.launches.values()].filter((launch) => !launch.settling && !launch.closedByAgent)
  }

  private hostHeaders(launch: LiveLaunch): Record<string, string> {
    return { authorization: `Bearer ${launch.bridgeToken ?? ''}` }
  }

  /** `GET /api/host/status`, or null when the server cannot say (not up yet, an older CLI). */
  private async hostStatus(launch: LiveLaunch): Promise<{ unsent: number; decided: boolean } | null> {
    if (!launch.port || !launch.bridgeToken) return null
    try {
      const response = await this.host.fetch(`${bridgeBaseUrl(launch.port)}${HOST_STATUS_PATH}`, {
        method: 'GET',
        headers: this.hostHeaders(launch),
      })
      if (!response.ok) return null
      // An older CLI answers its app page (200 text/html) or a JSON 404: no count.
      const body = jsonObjectOf(response.text)
      if (!body || typeof body.unsentAnnotations !== 'number') return null
      return { unsent: body.unsentAnnotations, decided: body.decided === true }
    } catch {
      return null
    }
  }

  /** The tool's `list`: every open review of THIS Claude session (the launch store is per session). */
  async listText(): Promise<string> {
    const now = await this.host.now()
    const sessions: PlannotatorSessionSummary[] = []
    for (const launch of this.openLaunches()) {
      if (!launch.url) await this.readReady(launch).catch(() => false)
      const status = launch.url ? await this.hostStatus(launch) : null
      sessions.push({
        id: sessionIdOf(launch),
        kind: launch.kind,
        subject: launch.subject,
        ...(launch.url ? { url: launch.url } : {}),
        ageMs: now - launch.startedAt,
        state: !launch.url ? 'starting' : status?.decided ? 'decided' : 'open',
        unsent: status ? status.unsent : null,
      })
    }
    return plannotatorToolListText(sessions)
  }

  /** The tool's `close`: one id or "all", only among this Claude session's reviews. */
  private async closeSessions(session: string): Promise<{ text: string } | { deny: string }> {
    if (session === 'all') {
      const outcomes: PlannotatorCloseOutcome[] = []
      for (const launch of this.openLaunches()) outcomes.push(await this.closeLaunch(launch))
      return { text: plannotatorToolCloseText(outcomes) }
    }
    const launch = this.openLaunches().find((candidate) => sessionIdOf(candidate) === session)
    if (!launch) return { deny: plannotatorUnknownSessionText(session) }
    const outcome = await this.closeLaunch(launch)
    const text = plannotatorToolCloseText([outcome])
    return outcome.closed ? { text } : { deny: text }
  }

  /**
   * Close one review: the server's host close (the reviewer's Close, draft
   * kept, the tab told), or for a CLI without it a TERM to the process (which
   * never deletes a draft). Plan reviews end only with a decision.
   */
  private async closeLaunch(launch: LiveLaunch): Promise<PlannotatorCloseOutcome> {
    const id = sessionIdOf(launch)
    const subject = launch.subject
    if (launch.kind === 'plan') return { id, subject, closed: false, reason: 'plan' }
    if (!launch.port) {
      return { id, subject, closed: false, reason: 'failed', detail: 'its server has not started yet; try again in a moment' }
    }
    const response = await this.host
      .fetch(`${bridgeBaseUrl(launch.port)}${HOST_CLOSE_PATH}`, {
        method: 'POST',
        headers: { ...this.hostHeaders(launch), 'content-type': 'application/json' },
        body: '{}',
      })
      .catch(() => null)
    const answer = classifyHostCloseAnswer(response)
    switch (answer.kind) {
      case 'closed':
        await this.markClosedByAgent(launch)
        return { id, subject, closed: true, unsent: answer.unsent }
      case 'decided':
        // The reviewer decided first: that decision is on its way.
        return { id, subject, closed: false, reason: 'decided' }
      case 'unreachable':
        // Nothing answers on its port: the server is gone (the timer reports
        // that) or the pid is stale. Never signal a pid on a guess.
        return { id, subject, closed: false, reason: 'failed', detail: 'its server is not answering' }
      case 'refused':
        return { id, subject, closed: false, reason: 'failed', detail: `its server refused the close (HTTP ${answer.status})` }
      case 'disabled':
        // A current CLI that turned host control off (remote mode): its
        // process is not ours to signal.
        return {
          id,
          subject,
          closed: false,
          reason: 'failed',
          detail: 'it runs in remote mode, where Plannotator turns host close off; close it from the tab',
        }
      case 'older':
        return this.stopOlderCli(launch, id, subject)
    }
  }

  /**
   * An older Plannotator (no host close) answered on the launch's port: TERM
   * its process, unless the reviewer's decision is already on disk or the pid
   * no longer names a plannotator process (`STOP_SCRIPT`). A decision such a
   * CLI is still publishing (it waits 1.5 s after the reviewer decides) cannot
   * be seen and is lost; see "Version skew" in AGENTS.md.
   */
  private async stopOlderCli(launch: LiveLaunch, id: string, subject: string): Promise<PlannotatorCloseOutcome> {
    const pid = (await this.host.readFile(fileIn(launch.dir, 'pid')).catch(() => '')).trim()
    if (!/^\d+$/.test(pid)) return { id, subject, closed: false, reason: 'failed', detail: 'its server has not started yet; try again in a moment' }
    const stopped = await this.host
      .run(stopArgv(pid, [fileIn(launch.dir, 'result'), fileIn(launch.dir, 'exit')]), { timeoutMs: 5_000 })
      .catch(() => null)
    switch (stopped?.exitCode) {
      case STOP_EXIT.stopped:
        await this.markClosedByAgent(launch)
        return { id, subject, closed: true, unsent: null }
      case STOP_EXIT.decided:
        return { id, subject, closed: false, reason: 'decided' }
      case STOP_EXIT.notPlannotator:
        return { id, subject, closed: false, reason: 'failed', detail: 'its server process is gone' }
      case STOP_EXIT.cannotVerify:
        return {
          id,
          subject,
          closed: false,
          reason: 'failed',
          detail: "this system's ps could not verify the review's process, so it was left running; close it from the tab",
        }
      default:
        return { id, subject, closed: false, reason: 'failed', detail: 'its server could not be stopped' }
    }
  }

  private async markClosedByAgent(launch: LiveLaunch): Promise<void> {
    launch.closedByAgent = true
    await this.persist()
    this.refreshStatus()
    this.ensureTimer()
  }

  /** A review Claude closed has exited (or published its dismissal): forget it, log one line, deliver nothing. */
  private async finishAgentClose(launch: LiveLaunch, record: HostResultRecord | null): Promise<void> {
    launch.settling = true
    await this.forget(launch)
    const unsent = record?.unsentAnnotations
    const saved = typeof unsent === 'number' && unsent > 0 ? ` ${unsent} unsent ${unsent === 1 ? 'comment' : 'comments'} kept in the draft.` : ''
    this.host.log(`Claude closed ${launch.subject} (${sessionIdOf(launch)}).${saved} Nothing was sent to Claude.`)
    await this.markDelivered(launch.dir)
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
  }

  /** The launch both entry points share: detached CLI, result later as a plugin turn, bridge, cleanup. */
  private async open(
    kind: Exclude<SessionKind, 'plan'>,
    args: string | readonly string[],
    subject: string,
    record: Partial<LaunchRecord> = {},
  ): Promise<
    | { state: 'error'; text: string }
    | { state: 'starting'; subject: string; sessionId: string; target?: PlannotatorTarget }
    | { state: 'ready'; subject: string; url: string; sessionId: string; extra?: string; target?: PlannotatorTarget }
  > {
    if (kind === 'annotate') {
      // Strict gates and --hook answer on the CLI's exit code, stdout or result
      // file, which nothing reads under a detached launch: refuse up front.
      const flag = scriptOnlyAnnotateFlag(wordsOf(args))
      if (flag) return { state: 'error', text: scriptOnlyAnnotateFlagText(flag) }
    }
    let stdin = ''
    let extra: string | undefined
    const side: { messages?: string } = {}
    if (kind === 'last') {
      const texts = recentAssistantTexts(await this.host.messages())
      const text = texts[0]
      if (!text) return { state: 'error', text: 'There is no assistant message to annotate yet.' }
      // stdin always carries the newest text: all an older CLI reads.
      stdin = text
      const picker = await pickerFile(texts, (value) => this.host.sha256(value))
      if (picker.messages.length > 1) {
        side.messages = picker.json
        subject = RECENT_MESSAGES_SUBJECT
        extra = `${picker.messages.length} messages, newest first`
      } else {
        const words = text.trim().split(/\s+/).length
        extra = `${words} ${words === 1 ? 'word' : 'words'}`
      }
    }
    const started = await this.launch(kind, cliArgvFor(kind, args), subject, stdin, record, side)
    if ('error' in started) return { state: 'error', text: `Plannotator could not start: ${started.error}` }

    const outcome = await this.awaitReady(started, kind === 'review' ? READY_WAIT_MS.review : READY_WAIT_MS.other)
    if (outcome === 'exited') return { state: 'error', text: await this.startupFailure(started) }
    const sessionId = sessionIdOf(started)
    // The launch's subject, told apart from a same-named open review, and its full target.
    const named = { subject: started.subject, ...(started.target !== undefined ? { target: started.target } : {}) }
    if (outcome === 'timeout') return { state: 'starting', sessionId, ...named }
    return { state: 'ready', url: started.url as string, sessionId, ...named, ...(extra ? { extra } : {}) }
  }

  // --- Plan review -------------------------------------------------------------

  /** Resolve the plan an ExitPlanMode call carries: the plan file when trustworthy (#1667), else the inline plan. */
  async resolvePlan(input: { plan?: unknown; planFilePath?: unknown }): Promise<string> {
    const inline = typeof input.plan === 'string' ? input.plan : ''
    const path = input.planFilePath
    if (!isTrustablePlanPath(path)) return inline
    try {
      const size = await this.host.fileSize(path)
      if (size === null || size > MAX_PLAN_FILE_BYTES) return inline
      return (await this.host.readFile(path)) || inline
    } catch {
      return inline
    }
  }

  private openPlanReview(): (LiveLaunch & { version: number }) | null {
    for (const launch of this.launches.values()) {
      if (launch.kind === 'plan' && !launch.settling) return launch as LiveLaunch & { version: number }
    }
    return null
  }

  /**
   * The `tool.call` hook on ExitPlanMode. `pass` lets the call through (the
   * approved plan, or a fallback to Claude Code's own flow); otherwise the
   * call is answered with `deny` text Claude reads.
   */
  async onPlanCall(input: { tool_use_id: string; plan?: unknown; planFilePath?: unknown }): Promise<{ pass: true } | { deny: string }> {
    // Another Claude Code process on this session may have received the
    // approval (or used it), or opened the plan review this call revises.
    await this.loadApproval()
    await this.adoptNewStoredLaunches()
    await this.touchLaunches()
    const plan = await this.resolvePlan(input)
    if (!plan.trim()) return { pass: true }
    const hash = await this.host.sha256(normalizePlanForHash(plan))
    const open = this.openPlanReview()
    const openState: OpenPlanReview | null = open
      ? { launchId: open.id, dir: open.dir, version: open.version, revisionSeq: open.revisionSeq ?? 0, url: open.url }
      : null
    const action = planCallAction(hash, { approval: this.approval, open: openState })

    if (action.kind === 'pass-approved') {
      this.passing.set(input.tool_use_id, action.approval)
      this.approval = null
      await this.persistApproval()
      return { pass: true }
    }

    // A different plan than the approved one needs its own review.
    if (this.approval) {
      this.approval = null
      await this.persistApproval()
    }

    if (action.kind === 'revise' && open) return this.revisePlan(open, plan)
    return this.startPlanReview(plan, typeof input.planFilePath === 'string' ? input.planFilePath : undefined)
  }

  private async startPlanReview(plan: string, planFilePath?: string): Promise<{ pass: true } | { deny: string }> {
    if (this.classicPlanReview) return { pass: true }
    const version = this.planVersion + 1
    const subject = subjectFor('plan', '', version)
    const stdin = (dir: string) => JSON.stringify({ plan, planFilePath, revisionFile: fileIn(dir, 'revision') })
    const started = await this.launch('plan', ['plannotator', 'claude-mod-plan'], subject, stdin, {
      version,
      revisionSeq: 0,
      ...(planFilePath ? { target: planFilePath } : {}),
    })
    if ('error' in started) {
      // Fall back to Claude Code's own flow (and the classic hook) rather than strand the plan.
      this.host.log(`Could not open the plan review (${started.error}).`)
      return { pass: true }
    }
    this.planVersion = version
    const outcome = await this.awaitReady(started, READY_WAIT_MS.other)
    if (outcome === 'exited') {
      if (await this.lacksModPlan(started)) {
        this.planVersion = version - 1
        await this.fallBackToClassicPlans(started)
        return { pass: true }
      }
      this.host.log(await this.startupFailure(started))
      return { pass: true }
    }
    this.host.toast(planWaitingStatus(version))
    return { deny: waitingDenyText(version, started.url) }
  }

  private async revisePlan(open: LiveLaunch & { version: number }, plan: string): Promise<{ deny: string }> {
    const seq = (open.revisionSeq ?? 0) + 1
    open.revisionSeq = seq
    await this.host.writeFile(fileIn(open.dir, 'revision'), JSON.stringify({ seq, plan }))
    await this.persist()
    const ackPath = `${fileIn(open.dir, 'revision')}.ack`
    const deadline = (await this.host.now()) + REVISION_ACK_WAIT_MS
    while ((await this.host.now()) < deadline) {
      await this.host.waitForAny([ackPath], 250)
      if (await this.host.exists(ackPath)) {
        try {
          const ack = JSON.parse(await this.host.readFile(ackPath)) as { seq?: number; accepted?: boolean; unchanged?: boolean }
          if (ack.seq === seq) {
            if (!ack.accepted) return { deny: decidingDenyText() }
            if (ack.unchanged) return { deny: unchangedDenyText(open.version) }
            const version = this.planVersion + 1
            this.planVersion = version
            open.version = version
            open.subject = subjectFor('plan', '', version)
            open.baseSubject = open.subject
            this.refreshSubjects()
            await this.persist()
            this.refreshStatus()
            this.host.toast(`Plan v${version} replaced v${version - 1} in the open tab`)
            return { deny: revisedDenyText(version) }
          }
        } catch {
          // An older ack or one being written; look again.
        }
      }
    }
    return { deny: revisionPendingDenyText(open.version) }
  }

  /** `classic.PermissionRequest` for ExitPlanMode: the decision, or null to defer. */
  onPlanPermission(toolUseId: string | undefined, toolInput: unknown): ReturnType<typeof approvedPermissionDecision> | null {
    const approval = toolUseId ? this.passing.get(toolUseId) : undefined
    if (!approval) {
      // The PermissionRequest input may not carry tool_use_id: take the one
      // approved call in flight, if exactly one.
      if (this.passing.size !== 1) return null
      const [only] = this.passing.values()
      return only ? approvedPermissionDecision(toolInput, only) : null
    }
    return approvedPermissionDecision(toolInput, approval)
  }

  /** The approved ExitPlanMode call finished (allowed or not). */
  onPlanCallSettled(toolUseId: string): void {
    this.passing.delete(toolUseId)
  }

  // --- Watching and delivery -------------------------------------------------

  private async tick(): Promise<void> {
    if (this.disposed) return
    this.tickCount += 1
    if (this.tickCount % LEASE_EVERY_TICKS === 0) {
      const now = await this.host.now()
      // Still waiting for Claude to go idle: keep saying so.
      for (const record of this.awaitingIdle.values()) {
        await this.host.writeFile(fileIn(record.dir, 'watcher'), JSON.stringify({ owner: this.instanceId, at: now, touchedAt: 0 })).catch(() => undefined)
      }
      for (const record of [...this.claimedElsewhere.values()]) await this.watchClaimedElsewhere(record).catch(() => undefined)
    }
    for (const launch of [...this.launches.values()]) {
      if (launch.settling || launch.starting || launch.checking) continue
      launch.ticks += 1
      launch.checking = true
      try {
        await this.check(launch)
      } catch {
        // A transient read failure: next tick.
      } finally {
        launch.checking = false
      }
    }
    this.stopTimerIfIdle()
  }

  private async check(launch: LiveLaunch): Promise<void> {
    if (!launch.url) await this.readReady(launch)
    // Another Claude Code process on this session settled it (claimed, or delivered and cleaned up).
    if (await this.settledElsewhere(launch)) {
      await this.forgetSettledElsewhere(launch)
      return
    }
    // Another process watches it: that one runs the bridge and delivers.
    if (!(await this.holdLease(launch))) return
    // Started from the timer, never from inside a hook: the loop outlives any one dispatch.
    if (launch.port && !launch.bridge && !launch.bridgeOff && (await this.host.now()) >= launch.bridgeRetryAt) this.startBridge(launch)
    const resultPath = fileIn(launch.dir, 'result')
    if (launch.closedByAgent) {
      // Only a record marked closedBy "agent" (or an exit with no decision) is
      // Claude's close. A record without it, or an older CLI that exited 0, is
      // the reviewer's decision that won the race against a TERM: deliver it.
      const record = (await this.host.exists(resultPath)) ? parseHostResult(await this.host.readFile(resultPath)) : null
      if (record) {
        if (!(await this.claimSettlement(launch))) return
        if (record.closedBy === 'agent') {
          await this.finishAgentClose(launch, record)
          return
        }
        this.host.debug(`result ${launch.id}: ${record.surface} ${record.decision} after Claude's close; delivering it`)
        launch.closedByAgent = false
        await this.settle(launch, record)
        return
      }
      const exitPath = fileIn(launch.dir, 'exit')
      if (await this.host.exists(exitPath)) {
        const code = (await this.host.readFile(exitPath).catch(() => '')).trim()
        if (code !== '0' || launch.kind === 'plan') {
          if (!(await this.claimSettlement(launch))) return
          await this.finishAgentClose(launch, null)
          return
        }
        // Exit 0 with no record: fall through to the legacy stdout path below.
        launch.closedByAgent = false
      } else {
        if (launch.ticks % PID_CHECK_EVERY_TICKS === 0) await this.checkAlive(launch)
        return
      }
    }
    if (await this.host.exists(resultPath)) {
      const record = parseHostResult(await this.host.readFile(resultPath))
      if (record) {
        if (!(await this.claimSettlement(launch))) return
        this.host.debug(`result ${launch.id}: ${record.surface} ${record.decision}${record.noop ? ' (no-op)' : ''}`)
        // Claude closed it from another process on this session: nothing to deliver.
        if (record.closedBy === 'agent') {
          await this.finishAgentClose(launch, record)
          return
        }
        await this.settle(launch, record)
        return
      }
    }
    if (await this.host.exists(fileIn(launch.dir, 'exit'))) {
      const code = (await this.host.readFile(fileIn(launch.dir, 'exit')).catch(() => '')).trim()
      if (!(await this.claimSettlement(launch))) return
      // A CLI older than the host result file still prints the decision the
      // skill would have shown Claude. (A plan never exits 0 without a record.)
      if (code === '0' && launch.kind !== 'plan') {
        const printed = (await this.host.readFile(fileIn(launch.dir, 'stdout')).catch(() => '')).trim()
        await this.settle(launch, legacyResult(launch.kind, printed))
        return
      }
      // An old CLI that took longer to refuse claude-mod-plan than the hook
      // waited: Claude was told a review is open and is waiting on nothing.
      if (launch.kind === 'plan' && (await this.lacksModPlan(launch))) {
        await this.fallBackToClassicPlans(launch)
        this.delivering = this.delivering
          .then(() => this.host.submit(`Plannotator: ${launch.subject} — not opened.\n\n${CLASSIC_PLAN_RETRY_TEXT}`))
          .catch(() => undefined)
        await this.delivering
        return
      }
      // Exited without a decision: a crash, a kill, or a startup failure we did not wait for.
      this.host.log(`The review server for ${launch.subject} stopped${code ? ` (exit ${code})` : ''} without a decision. Your draft is saved.`)
      await this.forget(launch)
      return
    }
    if (launch.ticks % PID_CHECK_EVERY_TICKS === 0) await this.checkAlive(launch)
  }

  private async checkAlive(launch: LiveLaunch): Promise<void> {
    const pid = (await this.host.readFile(fileIn(launch.dir, 'pid')).catch(() => '')).trim()
    if (!/^\d+$/.test(pid)) return
    const probe = await this.host.run(aliveArgv(pid), { timeoutMs: 5_000 }).catch(() => null)
    if (!probe) return
    if (probe.exitCode === 0) {
      launch.pidMisses = 0
      return
    }
    launch.pidMisses += 1
    // Gone and never wrote an exit code: the whole process group was killed.
    if (launch.pidMisses >= PID_MISSES_BEFORE_STOPPED && !(await this.host.exists(fileIn(launch.dir, 'exit')))) {
      if (!(await this.claimSettlement(launch))) return
      if (launch.closedByAgent) {
        await this.finishAgentClose(launch, null)
        return
      }
      this.host.log(`The review server for ${launch.subject} is no longer running. Your draft is saved.`)
      await this.forget(launch)
    }
  }

  // --- Several Claude Code processes on one session ---------------------------

  /**
   * Claims the right to settle a launch: ONE claim per launch (`claimArgv`,
   * the `settled/` directory) whichever file settles it, so one process can
   * never deliver the result record while another delivers the exit code's
   * stdout copy. True: this instance settles it (marked settling). False:
   * another process got there first (the launch is forgotten here, nothing
   * said), or the claim could not be made or its answer was lost (tried again
   * next tick; the claim names this instance, so a claim it already made wins
   * again). A process that quits or dies between the claim and the delivery
   * takes the delivery with it (the claim stays, nobody else delivers it), and
   * `$.prompt.submit` waits for Claude to be idle, so that window is the whole
   * of Claude's current turn. Such a decision is reported, never re-delivered:
   * see `watchClaimedElsewhere`.
   */
  private async claimSettlement(launch: LiveLaunch): Promise<boolean> {
    // The lease read every few ticks may be stale by now: the person may have
    // moved to another process on this session, which then delivers.
    if (!(await this.holdLease(launch, true))) return false
    launch.settling = true
    const claimed = await this.host.run(claimArgv(launch.dir, this.instanceId), { timeoutMs: 5_000 }).catch(() => null)
    if (claimed?.exitCode === CLAIM_EXIT.won) return true
    if (claimed?.exitCode === CLAIM_EXIT.lost) {
      await this.forgetSettledElsewhere(launch)
      return false
    }
    launch.settling = false
    return false
  }

  /**
   * Another process claimed it (a `settled/` claim not naming this instance),
   * or delivered it and cleaned the launch directory up: `stdin` is written by
   * the mod before the launch is recorded and removed only by `cleanupArgv`.
   */
  private async settledElsewhere(launch: LiveLaunch): Promise<boolean> {
    if (await this.host.exists(`${launch.dir}/${SETTLED_DIR}`)) {
      const by = (await this.host.readFile(`${launch.dir}/${SETTLED_BY}`).catch(() => '')).trim()
      // Our own claim whose answer was lost: settle it now.
      return by !== this.instanceId
    }
    return !(await this.host.exists(fileIn(launch.dir, 'stdin')))
  }

  private async forgetSettledElsewhere(launch: LiveLaunch): Promise<void> {
    launch.settling = true
    this.host.debug(`launch ${launch.id}: settled by another Claude Code process on this session`)
    await this.forget(launch)
    // Watched (quietly) until delivered; reported if its claimant quits first.
    await this.watchClaimedElsewhere(recordOf(launch))
  }

  /** `settled/delivered`: this claim's decision reached Claude (or there was none to send). */
  private async markDelivered(dir: string): Promise<void> {
    await this.host.writeFile(`${dir}/${SETTLED_DELIVERED}`, String(await this.host.now())).catch(() => undefined)
  }

  /**
   * Whether this instance watches the launch (runs its bridge, delivers its
   * decision): it holds the watcher lease, renewed every few ticks, unless
   * another live process holds it. See `LEASE_STALE_MS`.
   */
  private async holdLease(launch: LiveLaunch, fresh = false): Promise<boolean> {
    if (!fresh && launch.leaseTick !== null && launch.ticks - launch.leaseTick < LEASE_EVERY_TICKS) return launch.leader
    launch.leaseTick = launch.ticks
    const path = fileIn(launch.dir, 'watcher')
    const now = await this.host.now()
    const lease = parseWatcherLease(await this.host.readFile(path).catch(() => ''))
    const foreign = !!lease?.owner && lease.owner !== this.instanceId && Math.abs(now - lease.at) < LEASE_STALE_MS
    // A live holder keeps it unless the person touched the launch here more recently.
    if (foreign && lease && lease.touchedAt >= launch.touchedAt) {
      if (launch.leader) this.host.debug(`launch ${launch.id}: another Claude Code process watches it now`)
      launch.leader = false
      return false
    }
    await this.host.writeFile(path, JSON.stringify({ owner: this.instanceId, at: now, touchedAt: launch.touchedAt })).catch(() => undefined)
    if (!launch.leader) this.host.debug(`launch ${launch.id}: watching it (lease ${this.instanceId})`)
    launch.leader = true
    return true
  }


  private async settle(launch: LiveLaunch, record: HostResultRecord): Promise<void> {
    if (record.surface === 'plan' && record.decision === 'approved' && typeof record.approvedPlan === 'string') {
      this.approval = {
        hash: await this.host.sha256(normalizePlanForHash(record.approvedPlan)),
        plan: record.approvedPlan,
        permissionMode: record.permissionMode,
        version: launch.version ?? this.planVersion,
      }
      await this.persistApproval()
    }
    if (record.target !== undefined && launch.target !== undefined && !plannotatorSameTarget(record.target, launch.target)) {
      // The decision's own server names the target, and its message says so.
      // A difference means the mod's idea of this review was wrong: say it.
      const text = (target: PlannotatorTarget) => (typeof target === 'string' ? target : target.join(', '))
      this.host.log(
        `The decision for ${launch.subject} (${sessionIdOf(launch)}) is about ${text(record.target)}, not ${text(launch.target)} as recorded when it opened. The message to Claude names ${text(record.target)}.`,
      )
    }
    const stored = recordOf(launch)
    this.awaitingIdle.set(launch.id, stored)
    await this.forget(launch)
    await this.host
      .writeFile(fileIn(launch.dir, 'watcher'), JSON.stringify({ owner: this.instanceId, at: await this.host.now(), touchedAt: 0 }))
      .catch(() => undefined)
    const delivery = deliveryFor(record, {
      subject: launch.subject,
      sessionId: sessionIdOf(launch),
      overflowPath: fileIn(launch.dir, 'overflow'),
      deliverApproval: launch.deliverApproval === true,
      ...(launch.target !== undefined ? { target: launch.target } : {}),
    })
    // Several decisions are delivered one by one, in the order they arrived.
    this.delivering = this.delivering.then(async () => {
      if (delivery.action === 'log') {
        this.host.log(delivery.text)
        if (delivery.suggest) await this.host.suggest(delivery.suggest).catch(() => undefined)
        return
      }
      if (delivery.overflow) await this.host.writeFile(delivery.overflow.path, delivery.overflow.text)
      this.host.toast(`${launch.subject} — feedback received`)
      await this.host.submit(delivery.text).catch((error: unknown) => {
        this.host.log(`Could not send the ${launch.subject} decision to Claude (${error instanceof Error ? error.message : String(error)}).`)
      })
    }).catch(() => undefined)
    // `$.prompt.submit` resolves once Claude was idle and took the turn: a long
    // turn means a long wait, which this process may not survive (quit, crash).
    await this.delivering
    await this.markDelivered(launch.dir)
    this.awaitingIdle.delete(launch.id)
    await this.persist()
    this.stopTimerIfIdle()
    // The launch's copies of the plan/message and feedback are not kept once
    // delivered (feedback.md stays: Claude reads it after this turn).
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
  }

  private async forget(launch: LiveLaunch): Promise<void> {
    this.launches.delete(launch.id)
    this.forgotten.add(launch.id)
    await this.persist()
    this.refreshStatus()
    this.stopTimerIfIdle()
  }

  // --- Ask this session ------------------------------------------------------

  private startBridge(launch: LiveLaunch): void {
    if (launch.bridge || !launch.port || !launch.bridgeToken) return
    const bridge = createBridge({
      host: this.host,
      baseUrl: bridgeBaseUrl(launch.port),
      token: launch.bridgeToken,
      turns: this.turns,
      isLive: () =>
        !this.disposed && this.launches.get(launch.id) === launch && !launch.settling && !launch.closedByAgent && launch.leader,
    })
    launch.bridge = bridge
    this.host.debug(`bridge ${launch.id}: started`)
    void bridge.run().then((end) => this.bridgeEnded(launch, bridge, end))
  }

  /**
   * A bridge loop ended. The handle is cleared so the timer can start another:
   * after a wait when the server stopped answering (a sleeping laptop, a
   * paused server), never when it refused the bridge or is closing.
   */
  private async bridgeEnded(launch: LiveLaunch, bridge: BridgeHandle, end: BridgeEnd): Promise<void> {
    if (launch.bridge !== bridge) return
    launch.bridge = null
    switch (end.reason) {
      case 'failures': {
        const wait =
          end.connected || !launch.bridgeBackoffMs ? BRIDGE_RETRY_MS.first : Math.min(BRIDGE_RETRY_MS.max, launch.bridgeBackoffMs * 2)
        launch.bridgeBackoffMs = wait
        launch.bridgeRetryAt = (await this.host.now()) + wait
        this.host.debug(`bridge ${launch.id}: the server stopped answering; starting again in ${wait} ms`)
        return
      }
      case 'refused':
      case 'closing':
        launch.bridgeOff = true
        this.host.debug(`bridge ${launch.id}: ${end.reason}${end.status ? ` (HTTP ${end.status})` : ''}; not started again`)
        return
      case 'ended':
        return
    }
  }

  /** A prompt entered the session (prompt.submit), from register.ts. */
  onPromptEntered(prompt: EnteredPrompt): void {
    const { text, fromUs, turnId, originKind } = prompt
    this.host.debug(
      `prompt.submit${fromUs ? ' (ours)' : ''}${originKind ? ` [${originKind}]` : ''}${turnId ? ` into ${turnId}` : ''}: ${JSON.stringify(text.slice(0, 160))}`,
    )
    const wasOurs = !!turnId && this.turns.ownsTurn(turnId)
    this.turns.onPromptEntered(prompt)
    if (wasOurs && turnId && this.turns.isTakenOver(turnId)) this.host.debug(`ask turn ${turnId} taken over`)
    // The person typed here: decisions should arrive in this conversation.
    if (originKind === 'composer') void this.touchLaunches()
  }

  /** A prompt reached prompt.submit, before the hooks beneath it ran, from register.ts. */
  onPromptSubmitting(prompt: Omit<EnteredPrompt, 'text'>): void {
    this.turns.onPromptSubmitting(prompt)
  }

  /** A prompt announced by onPromptSubmitting did not enter, from register.ts. */
  onPromptDropped(prompt: Omit<EnteredPrompt, 'text'>): void {
    this.turns.onPromptDropped(prompt)
  }

  /** A model request of a turn is about to go out (turn.step), from register.ts. */
  onTurnStep(turnId: string): void {
    this.turns.onStep(turnId)
  }

  /** A model response of a turn finished (turn.step's `stop` chunk), from register.ts. */
  onTurnStepStop(turnId: string, stopReason: string | null): void {
    this.turns.onStepStop(turnId, stopReason)
  }

  /** Turn events, from register.ts. */
  async onTurnStart(turnId: string, text: string): Promise<void> {
    this.host.debug(`turn.start ${turnId}: ${JSON.stringify(text.slice(0, 160))}`)
    const drop = this.turns.onTurnStart(turnId, text)
    if (drop) await this.host.abortTurn(drop).catch(() => undefined)
    this.pushBridgeStatus()
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    this.host.debug(`turn.complete ${turnId}${aborted ? ' (aborted)' : ''}: ${answer.length} chars`)
    this.turns.onTurnComplete(turnId, answer, aborted)
    this.pushBridgeStatus()
  }

  private pushBridgeStatus(): void {
    for (const launch of this.launches.values()) launch.bridge?.pushStatus()
  }

  // --- Names ----------------------------------------------------------------------

  /**
   * Tell same-named open reviews apart (two `QUESTIONS.md` in different
   * folders become `a/QUESTIONS.md` and `b/QUESTIONS.md`) in the status line,
   * toasts and decision headings. Recomputed whenever a launch opens, learns
   * its server's target, or is renamed; the full path is always in the
   * message's Target line.
   */
  private refreshSubjects(): void {
    const launches = [...this.launches.values()].filter((launch) => !launch.closedByAgent)
    const subjects = plannotatorDistinctSubjects(
      launches.map((launch) => ({ subject: launch.baseSubject ?? launch.subject, ...(launch.target !== undefined ? { target: launch.target } : {}) })),
    )
    launches.forEach((launch, index) => {
      launch.baseSubject ??= launch.subject
      launch.subject = subjects[index] ?? launch.subject
    })
  }

  // --- Status line ---------------------------------------------------------------

  private refreshStatus(): void {
    const open = this.openLaunches()
    if (open.length === 0) {
      this.host.status(undefined)
      return
    }
    if (open.length === 1) {
      const [only] = open
      const state = !only?.url ? 'starting review server…' : only.kind === 'plan' ? 'waiting for your review' : 'waiting for you'
      this.host.status(`${only?.subject} · ${state}`)
      return
    }
    this.host.status(`${open.length} open · ${open.map((launch) => launch.subject).join(' · ')}`)
  }
}
