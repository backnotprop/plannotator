/**
 * The Claude Code connection to the Plannotator Inbox (plan step 6): the
 * `plannotator_inbox` tool and the reply wake. One `InboxLink` per session,
 * owned by that session's `PlannotatorMod`.
 *
 * Registered wherever the inbox tool switch allows it
 * (`resolveInboxToolEnabled`, on by default), also before this computer ever
 * ran the Inbox. The tool's actions are the Inbox's own MCP tools, read from
 * its `/mcp` once at session start (`discoverInboxTools`): from a running
 * Inbox, else the list one last answered with, else the list bundled with the
 * mod (`INBOX_DEFAULT_TOOLS`, generated from a real Inbox). An older Inbox
 * offers fewer, and the tool simply has fewer actions. The tool list never
 * changes under a running session. With no `inbox/inbox.json` the link stays
 * silent (no HTTP, no files) until a call starts the Inbox.
 *
 * The tool: each call re-reads the registry (never caching the port or
 * token), starts a stopped Inbox with `plannotator inbox --background` (it
 * detaches into its own session and never opens a browser), and proxies the
 * call to the Inbox's `/mcp` with `project_path` the session's working folder
 * (or the folder the agent named, resolved against it and checked to exist)
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
 * Send now (the person pressed it in the Inbox; the command's `now`) does not
 * wait for idle: while a turn runs the reply goes INTO it as a user row
 * (`$.session.append`, which the turn's next model request carries; a
 * plugin's `$.prompt.submit` never folds into a running turn), else as a turn
 * at once. A row that landed as the turn made its last request is pointed at
 * by one short turn after (`inboxSentNowFollowUpText`). The poll says the
 * engine can (`send_now`), so the window offers Send now only then.
 * A New message the person addressed to this session (plan step 8) arrives
 * on the same poll and takes the same path. Each poll also tells the Inbox
 * where the session works and whether a turn runs, and a `state` event tells
 * it when a turn starts or ends: the Inbox lists live sessions from these.
 *
 * Two Claude Code processes on one session (`claude --continue` while the
 * first still runs): one of them polls and delivers, the holder of the
 * session's inbox lease (`watcher.json`, the person's last process wins, as
 * for reviews); a delivery is also claimed once per reply (mkdir), so a lease
 * race can never deliver twice. A reply another process claimed and never
 * delivered (it quit while the turn waited) is said once, with a toast.
 */

import type { Host, HttpResult, LoadedPluginInfo } from './host'
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  inboxReminderFor,
  inboxToolCall,
  inboxToolCallParams,
  inboxToolResultText,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_TAGS_POLL_FIELD,
  inboxSentNowFollowUpText,
  inboxHealthPeeks,
  inboxSessionThreadsParams,
  inboxSessionThreadsText,
  inboxWakeText,
  mcpAnswerOfResponse,
  parseInboxBridgeCommands,
  parseInboxRegistry,
  parseInboxToolList,
  type InboxRegistryView,
  type InboxReplyCommand,
  type InboxToolInfo,
} from './inbox-contract'
import { INBOX_DEFAULT_TOOLS } from './inbox-default-tools'
import { privateDirArgv } from './launch'

/**
 * The first Claude Code whose published hooks-module API documents
 * `$.session.append` (the 2.1.301 plugin-authoring types): the oldest engine
 * Send now is offered on. A module cannot test for the noun itself
 * (`claude plugin validate` refuses reading `$.session.append` as a value),
 * so the engine's version decides; an older or unknown one never advertises
 * Send now.
 */
export const SESSION_APPEND_MIN_ENGINE = '2.1.301'

/** Whether an engine version (`$.session.version()`'s `base`, else `version`) is at least SESSION_APPEND_MIN_ENGINE. */
export function engineHasSessionAppend(version: string | null | undefined): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version.trim() : '')
  if (!parts) return false
  const min = SESSION_APPEND_MIN_ENGINE.split('.').map(Number)
  const have = parts.slice(1, 4).map(Number)
  for (let i = 0; i < 3; i++) {
    if (have[i]! !== min[i]!) return have[i]! > min[i]!
  }
  return true
}

/** plugin.json's `version` (the plugin this process loaded); null when unreadable. */
export function pluginVersionOf(text: string | null): string | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed?.version === 'string' && parsed.version.trim() && parsed.version.length <= 64 ? parsed.version.trim() : null
  } catch {
    return null
  }
}

/** The host this connection names on its messages and deliveries. */
export const INBOX_HOST = 'claude-code'
/** How the person sees this agent in the Inbox. */
export const INBOX_AGENT_NAME = 'Claude Code'
/** The `prompt.context` block that carries the Inbox reminder. */
export const INBOX_REMINDER_BLOCK = 'plannotatorInbox'

/**
 * The first message's context blocks with the Inbox reminder last
 * (`inboxReminderFor(custom, toolName)`: the person's own text from
 * config.json, else the fixed line, naming the tool as the engine registered
 * it, so tool search finds the deferred tool). Never twice: a block of that
 * name already there (a hook above added it) is left as it is.
 */
export function withInboxReminder<T extends { name: string; text: string }>(blocks: readonly T[], toolName: string, custom: string | null = null): Array<T | { name: string; text: string }> {
  if (blocks.some((block) => block?.name === INBOX_REMINDER_BLOCK)) return [...blocks]
  return [...blocks, { name: INBOX_REMINDER_BLOCK, text: inboxReminderFor(custom, toolName) }]
}

/**
 * `$.store` key: whether this machine's Claude Code runs the mod's
 * `prompt.context` hook. `true`: seen running (the block reaches the model);
 * `false`: a conversation's first turn completed without it (a guard plugin
 * seated above the mod, Claude Code's `cc-plugin-sec-default` on
 * Team/Enterprise accounts, sent the event past it, #2159); absent: not
 * learned yet. Read once per process.
 */
export const STORE_INBOX_REMINDER_CONTEXT_WORKS = 'inboxReminderContextWorks'

/**
 * The variable the mod sets to the reminder text (with the tool's full
 * registered name) at session start, for the plugin's `SessionStart` command
 * hook matched on `compact` (hooks.json): after a compaction that hook prints
 * it, and the engine adds the line to the conversation. Unset when the
 * reminder is off. Set again before each compaction installs, to the reminder
 * plus the session's open threads (`inboxReminderWithThreads`). `$.env.set` needs the name spelled as a literal in
 * register.ts; register.test.ts keeps that spelling equal to this constant.
 */
export const INBOX_REMINDER_ENV = 'PLANNOTATOR_INBOX_REMINDER'

/**
 * A session whose `$.session.usage().startedAt` is this much older than the
 * process's first `session.start` was started by an earlier process (a
 * `--resume` / `--continue`, an in-process `/resume`): its first turn here is
 * not the conversation's first, so it teaches nothing about `prompt.context`.
 */
export const INBOX_REMINDER_RESUMED_SLACK_MS = 60_000

/** The stored `inboxReminderContextWorks`: a boolean, or undefined for anything else. */
export function readReminderContextWorks(value: unknown): boolean | undefined {
  return value === true || value === false ? value : undefined
}

/**
 * Whether a `prompt.submit` carries the reminder as `context` (the learned
 * fallback for a machine where `prompt.context` is skipped). Only on a
 * conversation that has not had it by either path, only while this machine
 * has no evidence that `prompt.context` runs, and never on a meta prompt or a
 * slash command (a command may run no model turn, and the copy would be
 * marked delivered for nothing).
 */
export function inboxReminderSubmitCopy(input: {
  delivered: boolean
  contextWorks: boolean | undefined
  isMeta: boolean
  command: boolean
}): boolean {
  return !input.delivered && input.contextWorks !== true && !input.isMeta && !input.command
}

/**
 * What the first main-loop `turn.complete` of a conversation teaches.
 * `done: false`: not decided yet, look again at the next one (an aborted turn
 * may end before the first request was built, before `prompt.context` had its
 * chance). `write: false`: store `inboxReminderContextWorks = false` (the
 * conversation's first request went out without the mod's `prompt.context`).
 */
export function inboxReminderFirstTurnLesson(input: {
  contextRan: boolean
  aborted: boolean
  resumed: boolean
  contextWorks: boolean | undefined
}): { done: boolean; write: false | null } {
  if (input.aborted) return { done: false, write: null }
  if (input.contextRan || input.resumed || input.contextWorks === false) return { done: true, write: null }
  return { done: true, write: false }
}

/**
 * Whether the session was started by an earlier process: `startedAt` is the
 * session's first launch (`$.session.usage()`), `processStartedAt` this
 * process's first `session.start`, both in `$.clock.now()` milliseconds. An
 * unreadable `startedAt` counts as not resumed.
 */
export function reminderSessionResumed(startedAt: unknown, processStartedAt: number | null): boolean {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || processStartedAt === null) return false
  return startedAt < processStartedAt - INBOX_REMINDER_RESUMED_SLACK_MS
}

/**
 * The value of `PLANNOTATOR_INBOX_REMINDER`: the reminder naming the tool by
 * its registered full name while the reminder is on, else undefined (unset,
 * which also clears a value inherited from a parent Claude Code). The hook
 * prints it with `printf "%s\n"` (hooks.json), so every byte comes out as it
 * is, a custom text's backslashes, leading `-`, `%`, quotes and `$(...)`
 * included, and nothing in it runs.
 */
export function inboxReminderEnvValue(on: boolean, toolName: string | null, custom: string | null = null): string | undefined {
  if (!on || !toolName) return undefined
  return inboxReminderFor(custom, toolName)
}

/**
 * The longest the session's thread list may take (the registry, the health
 * check and one read_thread list on a running Inbox; a local Inbox answers in
 * milliseconds). Past it there is no list, never an error.
 */
export const INBOX_SESSION_THREADS_TIMEOUT_MS = 1_500

/**
 * The session's open Inbox threads as a few short lines
 * (`inboxSessionThreadsText`), or null: no Inbox has run here, it is not
 * running (it is never started for this), it did not answer within
 * INBOX_SESSION_THREADS_TIMEOUT_MS, the session has no open thread, or the
 * Inbox is older than the peek mark (its health has no `peek: true`: it would
 * make a project for the folder). Read with the peek mark, so the Inbox makes
 * no project and the rows do not count as the session having read the
 * threads. Never throws.
 */
export async function readSessionThreads(host: Host, dataDir: string, sessionId: string, cwd: string, toolName: string): Promise<string | null> {
  if (!sessionId || !cwd.startsWith('/')) return null
  const work = (async () => {
    const path = inboxRegistryPathOf(dataDir)
    if (!(await host.exists(path))) return null
    const registry = parseInboxRegistry(await host.readFile(path).catch(() => null))
    if (!registry) return null
    // Only the Inbox the registry names (its serverSession), never whatever else holds the port now,
    // and only one that honours the peek mark.
    const health = await host.fetch(`http://127.0.0.1:${registry.port}/api/inbox/health`, { method: 'GET', headers: {} }).catch(() => null)
    if (!health || health.status !== 200) return null
    try {
      if (!inboxHealthPeeks(JSON.parse(health.text), registry.serverSession)) return null
    } catch {
      return null
    }
    const answer = await mcpCall(host, registry.port, 'tools/call', inboxSessionThreadsParams(cwd, sessionId)).catch(() => null)
    if (!answer || !('result' in answer)) return null
    const result = answer.result as { isError?: unknown } | undefined
    return result?.isError === true ? null : inboxSessionThreadsText(result, toolName)
  })().catch(() => null)
  return (await within(host, INBOX_SESSION_THREADS_TIMEOUT_MS, work).catch(() => null)) ?? null
}

/**
 * What the plugin's SessionStart `compact` command hook prints after a
 * compaction: the reminder, then the session's open threads when it has any
 * (a blank line between), so the thread ids the conversation needs come from
 * the Inbox, not from the summary the model wrote for itself.
 */
export function inboxReminderWithThreads(reminder: string, threads: string | null): string {
  return threads ? `${reminder}\n\n${threads}` : reminder
}

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

/**
 * Gives back a claim nothing was submitted under (the turn it was to go into
 * is busy, or Send now's row was refused): removes `$1` only while it is
 * still `$2`'s and neither delivered nor reported, so whichever process the
 * person works in can claim it again (exactly once still holds: mkdir has one
 * winner, and nothing went in under the claim given back).
 */
export const INBOX_RELEASE_SCRIPT = [
  'd=$1; me=$2',
  '[ "$(cat "$d/by" 2>/dev/null)" = "$me" ] || exit 0',
  '[ -e "$d/delivered" ] || [ -e "$d/reported" ] && exit 0',
  'rm -rf "$d"',
].join('\n')

export function inboxReleaseArgv(dir: string, claimant: string): string[] {
  return ['/bin/sh', '-c', INBOX_RELEASE_SCRIPT, 'plannotator-inbox-release', dir, claimant]
}

/**
 * An agent's `project_path` as an existing folder: `$2` as given when
 * absolute, else under the working folder `$1` (never through CDPATH, and
 * `./` first so a name starting with `-` is a name). Prints the physical
 * path; exit 3 when it is not a folder this process can enter.
 */
export const INBOX_PROJECT_DIR_SCRIPT = [
  'CDPATH=',
  'case "$2" in /*) cd -- "$2" ;; *) cd -- "$1" && cd -- "./$2" ;; esac 2>/dev/null || exit 3',
  'pwd -P',
].join('\n')

export function inboxProjectDirArgv(cwd: string, given: string): string[] {
  return ['/bin/sh', '-c', INBOX_PROJECT_DIR_SCRIPT, 'plannotator-inbox-project', cwd, given]
}

async function mcpCall(host: Host, port: number, method: string, params: Record<string, unknown>): Promise<{ result?: unknown; error?: { message?: string } } | null> {
  const response = await host.fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return mcpAnswerOfResponse(response.status, response.text)
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
 * once at session start. A running Inbox is asked (`tools/list`) and its
 * answer remembered; a stopped one is described by the list it last answered
 * with; with neither (this computer never ran the Inbox, or nothing was
 * remembered), the list bundled with the mod. The first call starts a stopped
 * Inbox (`plannotator inbox --background`).
 */
export async function discoverInboxTools(host: Host, dataDir: string): Promise<InboxToolInfo[]> {
  const path = inboxRegistryPathOf(dataDir)
  const registry = (await host.exists(path)) ? parseInboxRegistry(await host.readFile(path).catch(() => null)) : null
  if (registry) {
    const answer = await within(host, INBOX_DISCOVER_TIMEOUT_MS, mcpCall(host, registry.port, 'tools/list', {})).catch(() => null)
    const tools = answer && 'result' in answer ? parseInboxToolList(answer.result) : []
    if (tools.length > 0) {
      await host.storeSet(STORE_INBOX_TOOLS, { tools }).catch(() => undefined)
      return tools
    }
  }
  const remembered = parseInboxToolList(await host.storeGet(STORE_INBOX_TOOLS).catch(() => null))
  return remembered.length > 0 ? remembered : INBOX_DEFAULT_TOOLS.map((tool) => ({ ...tool }))
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
  /**
   * The name the engine registered the tool under (`mcp__<server>__plannotator_inbox`),
   * named in the wake's closing line so the model can find the tool. Absent: `plannotator_inbox`.
   */
  toolName?: string
  /** A turn is running (or a question of Ask this session is in flight). */
  isBusy: () => boolean
  /**
   * The main-loop turn running now when a Send now reply may go into it, else
   * null: never the turn of this session's own "Ask this session" question
   * (its answer streams to Plannotator), and null while that question is
   * queued with no turn running. Absent: Send now is never advertised.
   */
  steerableTurn?: () => string | null
  /** The session's working folder, sent with each poll so New message can find the session by project. */
  cwd?: () => Promise<string>
  /**
   * The session's root (`$.session.root()`), read once when the link starts
   * (a later /cd moves it) and sent as `session_folder`: the folder
   * `claude --resume` runs in, for the Inbox's restart command.
   */
  root?: () => Promise<string>
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
  /**
   * Every claim this process won and is submitting under (never one it waits
   * on: a claim it cannot use at once is given back, `release`). Each one's
   * `alive` is refreshed with the lease, so another process never reports a
   * reply this one is still delivering.
   */
  private readonly held = new Set<string>()
  /** The `alive` refresh in flight, which `release` waits for so no write lands in a claim it removed. */
  private aliveRefresh: Promise<void> = Promise.resolve()
  private delivering = false
  /** When this link started (the session, near enough), and the turn state last told the Inbox (step 8). */
  private startedAt = 0
  private busy: boolean | null = null
  private idleSince = 0
  /**
   * A reply Send now put into the running turn (`appendUserRow`), until that
   * turn ends: `stepped` once a main-loop model request went out after it
   * (that request carries it). A turn that ends with none read it, so a short
   * turn points Claude at it.
   */
  private sentNow: { command: InboxReplyCommand; turnId: string; stepped: boolean }[] = []
  /** Whether this engine has `$.session.append` (decided once, `Host.sessionAppendAvailable`). */
  private appendOk: boolean | null = null
  /** What the Inbox was last told about Send now (`send_now` on the poll and the state events). */
  private lastSendNow: boolean | null = null
  /** Send now could not go into the running turn (the engine refused the row): these wait for idle, as before. */
  private noSteer = new Set<string>()
  /** The engine refused a row once (an engine without `$.session.append`): stop offering Send now. */
  private steerRefused = false
  /** What this process loaded, read once (`loadedNow`). */
  private loaded: Promise<{ plugin: LoadedPluginInfo | null; engine: string | null }> | null = null
  /** Where the session started, read once (`folderNow`). */
  private folder: Promise<string | null> | null = null

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
    void this.host.now().then((now) => {
      this.startedAt ||= now
      this.idleSince ||= now
    })
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
    // No Inbox has ever run here: nothing to deliver, so nothing is written;
    // the lease is taken on the first tick after a call starts the Inbox.
    if (!(await this.host.exists(this.registryPath))) this.leaseCheckedAt = Number.NEGATIVE_INFINITY
    else if (await this.ensureDir()) await this.holdLease(this.touchedAt)
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
    if (call.projectPath !== undefined) {
      // The agent named the project: an existing folder, relative to the working folder, or nothing reaches the Inbox.
      const dir = await this.host.run(inboxProjectDirArgv(cwd, call.projectPath), { timeoutMs: 5_000 }).catch(() => null)
      const resolved = dir?.exitCode === 0 ? dir.stdout.replace(/\n$/, '') : ''
      if (!resolved.startsWith('/')) return { deny: `Invalid plannotator_inbox call: project_path ${call.projectPath} is not an existing folder.` }
      call.arguments.project_path = resolved
    }
    if (call.name === 'wait_for_reply') {
      const asked = typeof call.arguments.timeout_seconds === 'number' ? call.arguments.timeout_seconds : INBOX_WAIT_MAX_SECONDS
      call.arguments.timeout_seconds = Math.max(1, Math.min(asked, INBOX_WAIT_MAX_SECONDS))
    }
    const running = await this.ensureRunning()
    if ('error' in running) return { deny: running.error }
    let answer: Awaited<ReturnType<typeof mcpCall>>
    try {
      // This session's wake delivers the reply as a turn: the send tools say to end the turn.
      answer = await mcpCall(this.host, running.port, 'tools/call', inboxToolCallParams(call, { wakes: true }))
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
    // Silent until an Inbox exists (the first plannotator_inbox call starts one): no HTTP, no files.
    if (this.disposed || !(await this.host.exists(this.registryPath)) || !(await this.ensureDir())) return
    const busy = this.options.isBusy()
    this.idleTicks = busy ? 0 : this.idleTicks + 1
    const now = await this.host.now()
    // Whether a Send now reply could go in right now: never while this session's own Ask question holds it.
    const sendNow = await this.sendNowNow()
    if (busy !== this.busy || sendNow !== this.lastSendNow) {
      const known = this.busy !== null
      if (busy !== this.busy && !busy) this.idleSince = now
      this.busy = busy
      this.lastSendNow = sendNow
      // A turn started or ended: the Inbox's live sessions say so (step 8), and whether Send now can go in.
      if (known && this.leader) void this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'state', busy, idle_since: this.idleSince, [INBOX_SEND_NOW_POLL_FIELD]: sendNow })
    }
    if (now - this.leaseCheckedAt >= LEASE_EVERY_MS) {
      await this.holdLease(now)
      this.aliveRefresh = (async () => {
        for (const id of this.held) await this.host.writeFile(`${this.claimDir(id)}/alive`, String(now)).catch(() => undefined)
      })()
      await this.aliveRefresh
      for (const id of [...this.elsewhere.keys()]) await this.watchElsewhere(id, now)
    }
    for (const id of [...this.unacked]) await this.acknowledge(id)
    if (!this.leader) return
    if (!this.polling && now >= this.retryAt) void this.poll()
    // Send now (the person pressed it in the Inbox): the waiting replies go in without waiting for two
    // idle ticks, oldest first (an urgent reply never overtakes an older one), but only when there is a
    // turn they may go into or the session is idle: never into this session's own Ask question.
    const urgent =
      this.idleTicks < 2 &&
      [...this.pending.values()].some((command) => command.now === true && !this.noSteer.has(command.id)) &&
      (this.steerableTurn() !== null || !this.options.isBusy())
    if (!this.delivering && this.pending.size > 0 && (this.idleTicks >= 2 || urgent)) {
      this.delivering = true
      void this.deliverNext(urgent).finally(() => {
        this.delivering = false
      })
    }
  }

  private steerableTurn(): string | null {
    return this.options.steerableTurn?.() ?? null
  }

  /** Where the session started, asked once (the first answer stands; a later /cd moves `$.session.root()`). */
  private async folderNow(): Promise<string | null> {
    this.folder ??= (async () => {
      if (!this.options.root) return this.options.cwd ? await this.options.cwd().catch(() => null) : null
      return (await this.options.root().catch(() => null)) ?? (this.options.cwd ? await this.options.cwd().catch(() => null) : null)
    })()
    return this.folder
  }

  /** What this process loaded (plugin and engine), asked once and remembered: it never changes while the process runs. */
  private async loadedNow(): Promise<{ plugin: LoadedPluginInfo | null; engine: string | null }> {
    this.loaded ??= (async () => ({
      plugin: this.host.loadedPlugin ? await this.host.loadedPlugin().catch(() => null) : null,
      engine: this.host.engineVersion ? await this.host.engineVersion().catch(() => null) : null,
    }))()
    return this.loaded
  }

  /** A main-loop model request of `turnId` is going out: the replies put into that turn are in it. */
  onMainStep(turnId: string): void {
    for (const entry of this.sentNow) if (entry.turnId === turnId) entry.stepped = true
  }

  /**
   * A main-loop turn ended. A reply Send now put into it that no request
   * carried (the turn was making its last request when the row landed) has
   * not been read: a short turn of its own points Claude at it.
   */
  onMainTurnComplete(turnId: string): void {
    const ended = this.sentNow.filter((entry) => entry.turnId === turnId)
    this.sentNow = this.sentNow.filter((entry) => entry.turnId !== turnId)
    if (this.disposed) return
    for (const entry of ended) if (!entry.stepped) this.followUp(entry.command)
  }

  /** One short turn pointing Claude at a reply that went into the conversation but no request carried. */
  private followUp(command: InboxReplyCommand): void {
    this.host.debug(`inbox: ${command.id} landed as the turn ended; pointing Claude at it`)
    void this.host.submit(inboxSentNowFollowUpText(command)).catch(() => undefined)
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

  /**
   * The replies and messages the Inbox has for this session now (waitMs 0),
   * or null when it did not answer. The poll says where the session works and
   * whether a turn runs, for New message's live sessions (step 8).
   */
  private async pendingNow(waitMs: number): Promise<InboxReplyCommand[] | null> {
    const cwd = this.options.cwd ? await this.options.cwd().catch(() => '') : ''
    const loaded = await this.loadedNow()
    const folder = await this.folderNow()
    const response = await this.bridge(INBOX_BRIDGE_POLL_PATH, {
      waitMs,
      ...(cwd ? { project_path: cwd } : {}),
      ...(this.startedAt ? { started_at: this.startedAt } : {}),
      ...(this.busy === null ? {} : { busy: this.busy, idle_since: this.idleSince }),
      // Send now: this engine can put a reply into a running turn (`$.session.append`).
      ...((await this.sendNowNow()) ? { [INBOX_SEND_NOW_POLL_FIELD]: true } : {}),
      // Tags (approval "inbox-tag-agents"): this connection words a reply it was tagged in truthfully.
      [INBOX_TAGS_POLL_FIELD]: true,
      // What this process loaded (additive): the Inbox says when a restart would load a newer plugin.
      ...(loaded.plugin ? { plugin: loaded.plugin } : {}),
      ...(loaded.engine ? { engine: loaded.engine } : {}),
      ...(folder ? { session_folder: folder } : {}),
    })
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
        if (this.settled.has(command.id) || this.elsewhere.has(command.id)) continue
        const known = this.pending.get(command.id)
        // A later poll carries `now` once the person pressed Send now: the newest command wins.
        if (known && known.now === command.now) continue
        this.host.debug(`inbox: ${command.type} ${command.id} for this session${command.now ? ' (send now)' : ''}`)
        this.pending.set(command.id, command)
      }
    } finally {
      this.polling = false
    }
  }

  private settle(id: string): void {
    this.pending.delete(id)
    this.settled.add(id)
    this.held.delete(id)
  }

  /**
   * Whether a Send now reply could go in right now: the engine can, and the
   * session is idle or runs a turn it may go into (not while this session's
   * own Ask question holds it, running or queued). What the poll and the
   * state events say, so the window offers Send now, and reads a pressed one
   * as "Sending now", only then.
   */
  private async sendNowNow(): Promise<boolean> {
    if (!(await this.canAppend())) return false
    return this.steerableTurn() !== null || !this.options.isBusy()
  }

  /** Whether Send now can work here: the engine has `$.session.append`, it never refused a row, and the session tells its turns apart. */
  private async canAppend(): Promise<boolean> {
    if (!this.host.appendUserRow || !this.options.steerableTurn || this.steerRefused) return false
    if (this.appendOk === null) this.appendOk = (await this.host.sessionAppendAvailable?.().catch(() => false)) ?? false
    return this.appendOk
  }

  /**
   * Deliver the oldest waiting reply as a turn, once; `urgent` (the person
   * pressed Send now, the session not idle for two ticks yet): at once, into
   * the running turn while one runs (`appendUserRow`), else as a turn.
   */
  private async deliverNext(urgent = false): Promise<void> {
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
    this.held.add(command.id)
    await this.host.writeFile(`${dir}/alive`, String(await this.host.now())).catch(() => undefined)
    // Decided HERE, after every await above: the turn may have ended (or one started) meanwhile. Into the
    // running turn only when the person asked, one runs that may take it, and the engine can; else as a
    // turn when idle; else (this session's own Ask question holds it) it waits, its claim given back.
    const turn = urgent && (await this.canAppend()) ? this.steerableTurn() : null
    if (!turn && this.options.isBusy()) {
      // Nothing went in: give the claim back, so the process the person works in delivers it (this one
      // may lose the lease while the turn runs, and a claim it kept would leave the reply with nobody).
      this.submitting = null
      await this.release(command.id)
      return
    }
    this.host.debug(`inbox: delivering ${command.type} ${command.id}${turn ? ` into the running turn ${turn}` : ''}`)
    try {
      if (turn) {
        // Send now while Claude works: a user row in the running turn, read at its next model request.
        try {
          await this.host.appendUserRow!(inboxWakeText(command, this.options.toolName))
        } catch (error) {
          // Refused: nothing entered, so the claim is given back and it is delivered when the session is idle
          // (here or in the process the person moves to), the window reads it as queued again, and Send now
          // is no longer offered here.
          this.submitting = null
          await this.release(command.id)
          this.noSteer.add(command.id)
          this.steerRefused = true
          void this.bridge(INBOX_BRIDGE_EVENT_PATH, { type: 'send_now_failed', id: command.id })
          this.host.debug(`inbox: ${command.id} could not go into the running turn (${error instanceof Error ? error.message : String(error)}); it waits for idle`)
          return
        }
        // The turn ended (or another began) while the row went in: no request of it will carry the row,
        // so point Claude at it now. Otherwise the turn's next request does, or its end sends the pointer.
        if (this.steerableTurn() === turn) this.sentNow.push({ command, turnId: turn, stepped: false })
        else this.followUp(command)
        await this.host
          .appendNotice?.(`Plannotator Inbox: the person's ${command.type === 'message' ? 'message' : 'reply'} (${command.subject ?? 'a thread'}) went into this turn.`)
          .catch(() => undefined)
      } else {
        // Resolves once Claude is idle and took the turn.
        await this.host.submit(inboxWakeText(command, this.options.toolName))
      }
    } catch (error) {
      this.submitting = null
      this.settle(command.id)
      await this.host.writeFile(`${dir}/reported`, '1').catch(() => undefined)
      this.host.toast(
        `${command.type === 'message' ? 'A message' : 'A reply'} in the Plannotator Inbox (${command.subject ?? 'a thread'}) could not be delivered to this session (${error instanceof Error ? error.message : String(error)}). Read it in the Inbox: ${command.url}`,
      )
      return
    }
    this.submitting = null
    await this.host.writeFile(`${dir}/delivered`, String(await this.host.now())).catch(() => undefined)
    this.settle(command.id)
    this.unacked.add(command.id)
    await this.acknowledge(command.id)
  }

  /** Give back a claim nothing was submitted under; it stays pending here, for a later claim. */
  private async release(id: string): Promise<void> {
    this.held.delete(id)
    await this.aliveRefresh
    await this.host.run(inboxReleaseArgv(this.claimDir(id), this.options.instanceId), { timeoutMs: 5_000 }).catch(() => null)
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
    if (!(await this.host.exists(dir))) {
      // Its claimant gave it back without delivering it (`release`): it is pending here again.
      this.elsewhere.delete(id)
      if (!this.settled.has(id)) this.pending.set(id, entry.command)
      return
    }
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
      `${entry.command.type === 'message' ? 'A message' : 'A reply'} in the Plannotator Inbox (${entry.command.subject ?? 'a thread'}) arrived for this session but was not delivered (the Claude Code process that took it quit). Read it in the Inbox: ${entry.command.url}`,
    )
  }
}
