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
 * running turn with `$.turn.abort`. Plan review does not block the session
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
}

export function bridgeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function parseBridgeCommands(text: string): { commands: BridgeCommand[]; closing: boolean } {
  try {
    const body = JSON.parse(text) as { commands?: unknown; closing?: unknown }
    const commands = Array.isArray(body.commands)
      ? body.commands.filter((command): command is BridgeCommand =>
          !!command && typeof command === 'object' && typeof (command as { type?: unknown }).type === 'string')
      : []
    return { commands, closing: body.closing === true }
  } catch {
    return { commands: [], closing: false }
  }
}

export interface BridgeHandle {
  /** Runs until the server closes, refuses, stops answering, or the review is no longer live. Never throws. */
  run(): Promise<void>
  /** Push a busy/ready change now (from `turn.start` / `turn.complete`), not at the next poll. */
  pushStatus(): void
}

export function createBridge(options: BridgeOptions): BridgeHandle {
  const { host, turns, token } = options
  const base = options.baseUrl.replace(/\/+$/, '')
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const maxFailures = options.maxFailures ?? 6
  const seenAsks = new Set<string>()
  const seenInterrupts = new Set<string>()
  let outbox: BridgeEvent[] = []
  let sending: Promise<void> = Promise.resolve()
  let lastStatus: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'

  const post = async (events: BridgeEvent[]): Promise<void> => {
    if (events.length === 0) return
    try {
      const response = await host.fetch(`${base}${BRIDGE_EVENT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(events.length === 1 ? events[0] : { events }),
      })
      if (response.status === 409) {
        // The server no longer runs a question we are answering: stop ours.
        for (const event of events) {
          if ('askId' in event) void stopAsk(event.askId)
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

  const emit = (event: BridgeEvent, immediate = true) => {
    const last = outbox[outbox.length - 1]
    if (event.type === 'delta' && last?.type === 'delta' && last.askId === event.askId) {
      last.text += event.text
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
    const sink: AskSink = {
      delta: (text) => emit({ type: 'delta', askId, text }, false),
      tool: (name) => emit({ type: 'tool', askId, name }),
      done: (answer) => emit({ type: 'done', askId, answer }),
      error: (code, message) => emit({ type: 'error', askId, code, ...(message ? { message } : {}) }),
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
    }
  }

  const pushStatus = () => {
    const status: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'
    if (status === lastStatus) return
    lastStatus = status
    emit({ type: 'status', status })
  }

  const run = async (): Promise<void> => {
    let failures = 0
    while (options.isLive()) {
      // Deltas are batched per poll round.
      if (outbox.length > 0) await flush()
      const status: 'ready' | 'busy' = turns.busy ? 'busy' : 'ready'
      lastStatus = status
      let response
      try {
        response = await host.fetch(`${base}${BRIDGE_POLL_PATH}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ status, modes: { turn: true, transient: false }, waitMs: pollWaitFor(turns) }),
        })
      } catch {
        failures += 1
        if (failures >= maxFailures) break
        await host.sleep(Math.min(4_000, 500 * 2 ** (failures - 1)))
        continue
      }
      if ([401, 403, 404, 405, 503].includes(response.status)) break
      if (!response.ok) {
        failures += 1
        if (failures >= maxFailures) break
        await host.sleep(Math.min(4_000, 500 * 2 ** (failures - 1)))
        continue
      }
      failures = 0
      const { commands, closing } = parseBridgeCommands(response.text)
      for (const command of commands) {
        host.debug(`bridge ${base}: ${command.type}`)
        handle(command)
      }
      if (closing) break
    }
    await flush()
  }

  return { run, pushStatus }
}

/**
 * While our question streams, poll briefly so deltas and status go out
 * promptly (a mod has no timer that can interrupt a pending fetch); otherwise
 * wait long.
 */
function pollWaitFor(turns: TurnTracker): number {
  return turns.askInFlight ? 750 : BRIDGE_POLL_WAIT_MS
}
