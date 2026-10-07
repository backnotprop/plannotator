/**
 * "Ask this session" for Claude Code: the host half of the pull bridge
 * (protocol: packages/ai/session-bridge-pull.ts; the OpenCode plugin's client
 * is packages/ai/session-bridge-pull-client.ts, which this mirrors over
 * `$.http.fetch` because a mod has no Node `fetch`, timers or AbortSignal).
 *
 * The mod generates a token per launched server and hands it to the detached
 * CLI in `PLANNOTATOR_SESSION_BRIDGE_TOKEN` (the CLI takes it out of its env at
 * startup). Once the server is listening, this loop long-polls
 * `POST /api/ai/bridge/poll` and posts progress to `/api/ai/bridge/event`, both
 * to the loopback port with the bearer token and no Origin header.
 *
 * A question runs as a real turn: `$.prompt.submit` puts it in the session
 * (it waits for idle), the turn's streamed text goes back as deltas, and
 * `turn.complete`'s answer as `done`. Busy = Claude is mid-turn: reported as
 * `busy`, so the reviewer chooses wait or interrupt; an interrupt aborts the
 * running turn with `$.turn.abort`, except a question's turn the person typed
 * into (turns.ts, take-over), which is theirs. Plan review does not block the session
 * under the mod, so the status is never `blocked`.
 */

import type { Host } from './host'
import type { AskSink, TurnTracker } from './turns'

export const BRIDGE_POLL_PATH = '/api/ai/bridge/poll'
export const BRIDGE_EVENT_PATH = '/api/ai/bridge/event'
export const BRIDGE_HOST = 'claude-code'
export const BRIDGE_MODES = 'turn'
/** Long-poll wait we ask for; below the server's 25 s cap and any fetch timeout. */
export const BRIDGE_POLL_WAIT_MS = 15_000
/**
 * How long to stay away after the server answered `superseded` (another
 * client, e.g. a second Claude Code process on the same session, polled
 * after us): 10 s plus up to 5 s of jitter. Polling again at once made the
 * two clients supersede each other in a busy loop.
 */
export const BRIDGE_SUPERSEDED_WAIT_MS = { min: 10_000, jitter: 5_000 } as const
/** Statuses that mean the server will never take this client: stop for good. */
export const BRIDGE_REFUSED_STATUSES: readonly number[] = [401, 403, 404, 405, 503]
/**
 * Why "Interrupt and ask now" refuses a turn another message took over. Same
 * text as `SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT` (packages/ai/session-bridge.ts).
 */
export const TAKEN_OVER_INTERRUPT_TEXT =
  'The session is now answering another message, so Plannotator will not stop it. Ask when it finishes instead.'

/** Used when a `taken_over` comes without a message. */
const TAKEN_OVER_FALLBACK_NOTE =
  'Another message entered this session while it was answering, so the rest of the reply went to that message.'

/**
 * A server that does not advertise `taken_over` (poll `features`) reads it as
 * `failed`, and its UI then replaces the partial answer with the error. Settle
 * as an answer instead: what streamed, plus the note as its last paragraph.
 * Mirrors `takenOverFallback` in packages/ai/session-bridge-pull-client.ts.
 */
export function takenOverFallback(streamed: string, message: string | undefined): { delta: string; answer: string } {
  const note = `_${(message || TAKEN_OVER_FALLBACK_NOTE).trim()}_`
  const delta = streamed ? `\n\n${note}` : note
  return { delta, answer: `${streamed}${delta}` }
}

type BridgeCommand =
  | { type: 'ask'; askId: string; text: string; mode: string }
  | { type: 'cancel'; askId: string }
  | { type: 'interrupt'; interruptId: string }

type BridgeEvent =
  | { type: 'status'; status: 'ready' | 'busy' | 'blocked' | 'gone' }
  | { type: 'started'; askId: string }
  | { type: 'delta'; askId: string; text: string }
  | { type: 'tool'; askId: string; name: string }
  | { type: 'done'; askId: string; answer: string }
  | { type: 'error'; askId: string; code: string; message?: string }
  | { type: 'interrupted'; interruptId: string; ok: boolean; message?: string }

export interface BridgeOptions {
  host: Host
  /** e.g. `http://127.0.0.1:4321`; always the loopback literal. */
  baseUrl: string
  token: string
  turns: TurnTracker
  /** False once the review settled or the session ended: the loop stops. */
  isLive: () => boolean
  maxFailures?: number
  /** The poll and event paths; default the review server's `/api/ai/bridge/*` (the Shots hub serves one pair per connection). */
  pollPath?: string
  eventPath?: string
  /** Commands this loop does not know (the Shots hub's `deliver`). */
  onCommand?: (command: { type: string } & Record<string, unknown>) => void
  /** Extra fields every poll carries (the Shots hub routes on the last human input). */
  pollExtras?: () => Record<string, unknown>
}

export function bridgeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function parseBridgeCommands(text: string): { commands: BridgeCommand[]; closing: boolean; superseded: boolean; features: string[] } {
  try {
    const body = JSON.parse(text) as { commands?: unknown; closing?: unknown; superseded?: unknown; features?: unknown }
    const commands = Array.isArray(body.commands)
      ? body.commands.filter((command): command is BridgeCommand =>
          !!command && typeof command === 'object' && typeof (command as { type?: unknown }).type === 'string')
      : []
    const features = Array.isArray(body.features) ? body.features.filter((feature): feature is string => typeof feature === 'string') : []
    return { commands, closing: body.closing === true, superseded: body.superseded === true, features }
  } catch {
    return { commands: [], closing: false, superseded: false, features: [] }
  }
}

/**
 * Why a bridge loop ended, so the controller knows whether to start another:
 * - `failures`: the server stopped answering (`maxFailures` in a row; each
 *   `$.http.fetch` gives up after 30 s, so a sleeping laptop or a paused
 *   server gets here in about three minutes). Worth a new loop later.
 * - `refused`: 401/403 (token, not loopback), 404/405 (a CLI without the
 *   bridge), 503 (AI off). Never retried.
 * - `closing`: the server is shutting down. Not retried.
 * - `ended`: the launch is no longer live for this client (settled, closed,
 *   the session ended, or another Claude Code process watches it now).
 */
export interface BridgeEnd {
  reason: 'failures' | 'refused' | 'closing' | 'ended'
  status?: number
  /** At least one poll was answered with 200 during this loop. */
  connected: boolean
}

export interface BridgeHandle {
  /** Runs until the server closes, refuses, stops answering, or the review is no longer live. Never throws. */
  run(): Promise<BridgeEnd>
  /** Push a busy/ready change now (from `turn.start` / `turn.complete`), not at the next poll. */
  pushStatus(): void
  /** Post an event of the caller's own (e.g. `delivered`), batched with the loop's. */
  postEvent(event: { type: string } & Record<string, unknown>): void
}

export function createBridge(options: BridgeOptions): BridgeHandle {
  const { host, turns, token } = options
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const maxFailures = options.maxFailures ?? 6
  const pollPath = options.pollPath ?? BRIDGE_POLL_PATH
  const eventPath = options.eventPath ?? BRIDGE_EVENT_PATH
  const seenAsks = new Set<string>()
  const seenInterrupts = new Set<string>()
  let outbox: Array<BridgeEvent | ({ type: string } & Record<string, unknown>)> = []
  let sending: Promise<void> = Promise.resolve()
  let lastStatus: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'
  /** The server knows the `taken_over` code (poll `features`). */
  let serverTakesTakenOver = false

  const post = async (events: typeof outbox): Promise<void> => {
    if (events.length === 0) return
    try {
      const response = await host.fetch(`${base}${eventPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(events.length === 1 ? events[0] : { events }),
      })
      if (response.status === 409) {
        // The server no longer runs a question we are answering: stop ours.
        for (const event of events) {
          if ('askId' in event && typeof event.askId === 'string') void stopAsk(event.askId)
        }
      }
    } catch {
      // Best effort; the server re-sends what it needs.
    }
  }

  const flush = (): Promise<void> => {
    const batch = outbox
    outbox = []
    sending = sending.then(() => post(batch))
    return sending
  }

  const emit = (event: BridgeEvent | ({ type: string } & Record<string, unknown>), immediate = true) => {
    const last = outbox[outbox.length - 1]
    if (event.type === 'delta' && last?.type === 'delta' && last.askId === event.askId) {
      ;(last as { text: string }).text += (event as { text: string }).text
    } else {
      outbox.push(event.type === 'delta' ? { ...event } : event)
    }
    if (immediate) void flush()
  }

  const stopAsk = async (askId: string) => {
    const turnId = turns.cancelAsk(askId)
    if (turnId) await host.abortTurn(turnId).catch(() => undefined)
  }

  const runAsk = (command: Extract<BridgeCommand, { type: 'ask' }>) => {
    if (seenAsks.has(command.askId)) return
    seenAsks.add(command.askId)
    const askId = command.askId
    let streamed = ''
    const sink: AskSink = {
      delta: (text) => {
        streamed += text
        emit({ type: 'delta', askId, text }, false)
      },
      tool: (name) => emit({ type: 'tool', askId, name }),
      done: (answer) => emit({ type: 'done', askId, answer }),
      error: (code, message) => {
        if (code === 'taken_over' && !serverTakesTakenOver) {
          const fallback = takenOverFallback(streamed, message)
          emit({ type: 'delta', askId, text: fallback.delta }, false)
          emit({ type: 'done', askId, answer: fallback.answer })
          return
        }
        emit({ type: 'error', askId, code, ...(message ? { message } : {}) })
      },
    }
    if (!turns.beginAsk(askId, command.text, sink)) {
      emit({ type: 'error', askId, code: 'busy', message: 'Another question is already running in this session.' })
      return
    }
    emit({ type: 'started', askId })
    host.submit(command.text).catch((error: unknown) => {
      turns.failAsk(askId, error instanceof Error ? error.message : String(error))
    })
  }

  const runInterrupt = async (interruptId: string) => {
    if (seenInterrupts.has(interruptId)) return
    seenInterrupts.add(interruptId)
    const running = turns.runningTurnId
    if (!running) {
      emit({ type: 'interrupted', interruptId, ok: true })
      return
    }
    // A question's turn that the person typed into is theirs now: never stopped from Plannotator.
    if (turns.isTakenOver(running)) {
      emit({ type: 'interrupted', interruptId, ok: false, message: TAKEN_OVER_INTERRUPT_TEXT })
      return
    }
    try {
      await host.abortTurn(running)
      emit({ type: 'interrupted', interruptId, ok: true })
    } catch (error) {
      emit({ type: 'interrupted', interruptId, ok: false, message: error instanceof Error ? error.message : String(error) })
    }
  }

  const handle = (command: BridgeCommand) => {
    switch (command.type) {
      case 'ask':
        runAsk(command)
        break
      case 'cancel':
        if (turns.isActiveAsk(command.askId)) void stopAsk(command.askId)
        else emit({ type: 'error', askId: command.askId, code: 'aborted' })
        break
      case 'interrupt':
        void runInterrupt(command.interruptId)
        break
      default:
        options.onCommand?.(command as { type: string } & Record<string, unknown>)
    }
  }

  const pushStatus = () => {
    const status: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'
    if (status === lastStatus) return
    lastStatus = status
    emit({ type: 'status', status })
  }

  const supersededWait = () => {
    const jitter = Number.parseInt(host.randomHex(1), 16) / 255
    return BRIDGE_SUPERSEDED_WAIT_MS.min + Math.round(jitter * BRIDGE_SUPERSEDED_WAIT_MS.jitter)
  }

  const loop = async (): Promise<BridgeEnd> => {
    let failures = 0
    let connected = false
    while (options.isLive()) {
      // Deltas are batched per poll round.
      if (outbox.length > 0) await flush()
      const status: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'
      lastStatus = status
      let response
      try {
        response = await host.fetch(`${base}${pollPath}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status, modes: { turn: true, transient: false }, waitMs: pollWaitFor(turns), ...(options.pollExtras?.() ?? {}) }),
        })
      } catch {
        failures += 1
        if (failures >= maxFailures) return { reason: 'failures', connected }
        await host.sleep(Math.min(4_000, 500 * 2 ** (failures - 1)))
        continue
      }
      if (BRIDGE_REFUSED_STATUSES.includes(response.status)) return { reason: 'refused', status: response.status, connected }
      if (!response.ok) {
        failures += 1
        if (failures >= maxFailures) return { reason: 'failures', status: response.status, connected }
        await host.sleep(Math.min(4_000, 500 * 2 ** (failures - 1)))
        continue
      }
      failures = 0
      connected = true
      const { commands, closing, superseded, features } = parseBridgeCommands(response.text)
      serverTakesTakenOver = features.includes('taken_over')
      for (const command of commands) {
        host.debug(`bridge ${base}: ${command.type}`)
        handle(command)
      }
      if (closing) return { reason: 'closing', connected }
      if (superseded) {
        // Someone else polls this server now. Stay away a while instead of
        // taking it back at once, which only starts a ping-pong.
        const wait = supersededWait()
        host.debug(`bridge ${base}: superseded, polling again in ${wait} ms`)
        await host.sleep(wait)
      }
    }
    return { reason: 'ended', connected }
  }

  const run = async (): Promise<BridgeEnd> => {
    try {
      return await loop()
    } catch {
      return { reason: 'failures', connected: false }
    } finally {
      await flush()
    }
  }

  return { run, pushStatus, postEvent: (event) => emit(event) }
}

/**
 * While our question streams, poll briefly so deltas and status go out
 * promptly (a mod has no timer that can interrupt a pending fetch); otherwise
 * wait long.
 */
function pollWaitFor(turns: TurnTracker): number {
  return turns.askInFlight ? 750 : BRIDGE_POLL_WAIT_MS
}
