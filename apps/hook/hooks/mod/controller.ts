/**
 * The Plannotator mod's state for one Claude Code session: the reviews it has
 * open, the plan approval waiting for Claude's next ExitPlanMode, delivery of
 * decisions as plugin turns, and the "Ask this session" bridges.
 *
 * Every engine call goes through `Host` (built from `$` in register.ts), so
 * bun tests drive this class with a host made of memory.
 */

import { BRIDGE_HOST, BRIDGE_MODES, bridgeBaseUrl, createBridge, type BridgeHandle } from './bridge'
import { deliveryFor, legacyResult, parseHostResult, type HostResultRecord, type SessionKind } from './delivery'
import type { Host } from './host'
import {
  aliveArgv,
  cleanupArgv,
  cliArgvFor,
  failedText,
  fileIn,
  lastAssistantText,
  launchArgv,
  launchDirOf,
  openedText,
  parseReadyFile,
  privateDirArgv,
  subjectFor,
} from './launch'
import {
  approvedPermissionDecision,
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
import { TurnTracker } from './turns'

/** Persisted in `$.store` so open reviews reattach after a restart or `--resume`. */
export interface LaunchRecord {
  id: string
  sessionId: string
  kind: SessionKind
  dir: string
  subject: string
  startedAt: number
  url?: string
  port?: number
  /** Plan: the version shown in the copy. */
  version?: number
  /** Plan: the last revision sequence written to revision.json. */
  revisionSeq?: number
  /** The pull-bridge token this launch's server was started with. */
  bridgeToken?: string
}

export const STORE_LAUNCHES = 'launches'
export const STORE_APPROVALS = 'approvals'

const TICK_MS = 1_000
/** Liveness check of a launch whose server has not decided yet. */
const PID_CHECK_EVERY_TICKS = 15
const PID_MISSES_BEFORE_STOPPED = 3
const READY_WAIT_MS = { review: 45_000, other: 15_000 }
const REVISION_ACK_WAIT_MS = 4_000

interface LiveLaunch extends LaunchRecord {
  pidMisses: number
  ticks: number
  settling: boolean
  bridge: BridgeHandle | null
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
  private timer: { cancel: () => void } | null = null
  private delivering: Promise<void> = Promise.resolve()
  private sequence = 0
  private disposed = false

  constructor(
    private readonly host: Host,
    readonly session: SessionInfo,
  ) {}

  // --- Lifecycle -----------------------------------------------------------

  /** Reattach the reviews this session left open (restart, `--resume`). */
  async restore(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const records = Array.isArray(stored) ? (stored as LaunchRecord[]) : []
    const mine = records.filter((record) => record && record.sessionId === this.session.sessionId && typeof record.dir === 'string')
    for (const record of mine) this.adopt(record)
    const approvals = await this.host.storeGet(STORE_APPROVALS)
    const approval = approvals && typeof approvals === 'object' ? (approvals as Record<string, PendingApproval>)[this.session.sessionId] : undefined
    if (approval && typeof approval.hash === 'string') this.approval = approval
    for (const launch of this.launches.values()) {
      if (launch.kind === 'plan') this.planVersion = Math.max(this.planVersion, launch.version ?? 0)
    }
    if (mine.length > 0) {
      const names = mine.map((record) => record.subject).join(', ')
      this.host.log(`Reattached ${mine.length} open ${mine.length === 1 ? 'session' : 'sessions'} (${names}).`)
      this.ensureTimer()
      this.refreshStatus()
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
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  private adopt(record: LaunchRecord): LiveLaunch {
    const live: LiveLaunch = { ...record, pidMisses: 0, ticks: 0, settling: false, bridge: null }
    this.launches.set(record.id, live)
    return live
  }

  private async persist(): Promise<void> {
    const stored = await this.host.storeGet(STORE_LAUNCHES)
    const others = (Array.isArray(stored) ? (stored as LaunchRecord[]) : []).filter(
      (record) => record && record.sessionId !== this.session.sessionId,
    )
    const mine: LaunchRecord[] = [...this.launches.values()].map(
      ({ pidMisses: _misses, ticks: _ticks, settling: _settling, bridge: _bridge, ...record }) => record,
    )
    await this.host.storeSet(STORE_LAUNCHES, [...others, ...mine])
  }

  private async persistApproval(): Promise<void> {
    const stored = await this.host.storeGet(STORE_APPROVALS)
    const all = stored && typeof stored === 'object' ? { ...(stored as Record<string, PendingApproval>) } : {}
    if (this.approval) all[this.session.sessionId] = this.approval
    else delete all[this.session.sessionId]
    await this.host.storeSet(STORE_APPROVALS, all)
  }

  private ensureTimer(): void {
    if (this.disposed || this.timer || this.launches.size === 0) return
    this.timer = this.host.every(TICK_MS, () => {
      void this.tick()
    })
  }

  private stopTimerIfIdle(): void {
    if (this.launches.size === 0 && this.timer) {
      this.timer.cancel()
      this.timer = null
    }
  }

  private async newLaunchId(): Promise<string> {
    this.sequence += 1
    return `${await this.host.now()}-${this.sequence}-${this.host.randomHex(3)}`
  }

  // --- Launch --------------------------------------------------------------

  private async launch(
    kind: SessionKind,
    cliArgv: string[],
    subject: string,
    stdin: string | ((dir: string) => string),
    extra: Partial<LaunchRecord> = {},
  ): Promise<LiveLaunch | { error: string }> {
    const id = await this.newLaunchId()
    const dir = launchDirOf(this.session.dataDir, this.session.sessionId, id)
    const bridgeToken = this.host.randomHex(32)
    try {
      // Owner-only before anything lands in it (stdin holds the plan or message).
      const made = await this.host.run(privateDirArgv(dir), { timeoutMs: 5_000 })
      if (made.exitCode !== 0) return { error: made.stderr.trim() || `could not create ${dir}` }
      await this.host.writeFile(fileIn(dir, 'stdin'), typeof stdin === 'function' ? stdin(dir) : stdin)
      const result = await this.host.run(launchArgv(dir, cliArgv), {
        env: {
          PLANNOTATOR_READY_FILE: fileIn(dir, 'ready'),
          PLANNOTATOR_HOST_RESULT_FILE: fileIn(dir, 'result'),
          PLANNOTATOR_SESSION_BRIDGE_TOKEN: bridgeToken,
          PLANNOTATOR_SESSION_BRIDGE_HOST: BRIDGE_HOST,
          PLANNOTATOR_SESSION_BRIDGE_MODES: BRIDGE_MODES,
        },
        timeoutMs: 15_000,
      })
      if (result.exitCode !== 0) return { error: result.stderr.trim() || `launcher exited ${result.exitCode}` }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
    const record: LaunchRecord = { id, sessionId: this.session.sessionId, kind, dir, subject, startedAt: await this.host.now(), bridgeToken, ...extra }
    const live = this.adopt(record)
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

  // --- Commands ------------------------------------------------------------

  /** `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`: open and return at once. */
  async runCommand(kind: Exclude<SessionKind, 'plan'>, rawArgs: string): Promise<string> {
    let stdin = ''
    let extra: string | undefined
    if (kind === 'last') {
      const text = lastAssistantText(await this.host.messages())
      if (!text) return 'There is no assistant message to annotate yet.'
      stdin = text
      const words = text.trim().split(/\s+/).length
      extra = `${words} ${words === 1 ? 'word' : 'words'}`
    }
    const subject = subjectFor(kind, rawArgs)
    const started = await this.launch(kind, cliArgvFor(kind, rawArgs), subject, stdin)
    if ('error' in started) return `Plannotator could not start: ${started.error}`

    const outcome = await this.awaitReady(started, kind === 'review' ? READY_WAIT_MS.review : READY_WAIT_MS.other)
    if (outcome === 'exited') return this.startupFailure(started)
    if (outcome === 'timeout') return `Starting Plannotator for ${subject}… it opens in your browser when ready, and your feedback comes back here as a message.`
    return openedText(kind, subject, started.url as string, extra)
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
    const version = this.planVersion + 1
    const subject = subjectFor('plan', '', version)
    const stdin = (dir: string) => JSON.stringify({ plan, planFilePath, revisionFile: fileIn(dir, 'revision') })
    const started = await this.launch('plan', ['plannotator', 'claude-mod-plan'], subject, stdin, { version, revisionSeq: 0 })
    if ('error' in started) {
      // Fall back to Claude Code's own flow (and the classic hook) rather than strand the plan.
      this.host.log(`Could not open the plan review (${started.error}).`)
      return { pass: true }
    }
    this.planVersion = version
    const outcome = await this.awaitReady(started, READY_WAIT_MS.other)
    if (outcome === 'exited') {
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
    for (const launch of [...this.launches.values()]) {
      if (launch.settling) continue
      launch.ticks += 1
      try {
        await this.check(launch)
      } catch {
        // A transient read failure: next tick.
      }
    }
    this.stopTimerIfIdle()
  }

  private async check(launch: LiveLaunch): Promise<void> {
    if (!launch.url) await this.readReady(launch)
    // Started from the timer, never from inside a hook: the loop outlives any one dispatch.
    if (launch.port && !launch.bridge) this.startBridge(launch)
    const resultPath = fileIn(launch.dir, 'result')
    if (await this.host.exists(resultPath)) {
      const record = parseHostResult(await this.host.readFile(resultPath))
      if (record) {
        this.host.debug(`result ${launch.id}: ${record.surface} ${record.decision}${record.noop ? ' (no-op)' : ''}`)
        launch.settling = true
        await this.settle(launch, record)
        return
      }
    }
    if (await this.host.exists(fileIn(launch.dir, 'exit'))) {
      launch.settling = true
      const code = (await this.host.readFile(fileIn(launch.dir, 'exit')).catch(() => '')).trim()
      // A CLI older than the host result file still prints the decision the
      // skill would have shown Claude; a plan never gets here (an old CLI has
      // no claude-mod-plan and the call fell back to the classic flow).
      if (code === '0' && launch.kind !== 'plan') {
        const printed = (await this.host.readFile(fileIn(launch.dir, 'stdout')).catch(() => '')).trim()
        await this.settle(launch, legacyResult(launch.kind, printed))
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
      launch.settling = true
      this.host.log(`The review server for ${launch.subject} is no longer running. Your draft is saved.`)
      await this.forget(launch)
    }
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
    await this.forget(launch)
    const delivery = deliveryFor(record, { subject: launch.subject, overflowPath: fileIn(launch.dir, 'overflow') })
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
    await this.delivering
    // The launch's copies of the plan/message and feedback are not kept once
    // delivered (feedback.md stays: Claude reads it after this turn).
    await this.host.run(cleanupArgv(launch.dir), { timeoutMs: 5_000 }).catch(() => undefined)
  }

  private async forget(launch: LiveLaunch): Promise<void> {
    this.launches.delete(launch.id)
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
      isLive: () => !this.disposed && this.launches.get(launch.id) === launch && !launch.settling,
    })
    launch.bridge = bridge
    void bridge.run()
  }

  /** A prompt entered the session (prompt.submit), from register.ts. */
  onPromptEntered(text: string, fromUs: boolean): void {
    this.host.debug(`prompt.submit${fromUs ? ' (ours)' : ''}: ${JSON.stringify(text.slice(0, 160))}`)
    this.turns.onPromptEntered(text, fromUs)
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

  // --- Status line ---------------------------------------------------------------

  private refreshStatus(): void {
    const open = [...this.launches.values()].filter((launch) => !launch.settling)
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
