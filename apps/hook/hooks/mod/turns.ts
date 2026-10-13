/**
 * The session's turns as the mod sees them (`turn.start` / `turn.step` /
 * `turn.complete`), and the one "Ask this session" question that may be
 * running as a turn of its own.
 *
 * A question is submitted with `$.prompt.submit`, which waits for the session
 * to be idle; the turn that starts with its text is the question's turn. Its
 * streamed text goes back to Plannotator as deltas and its final answer as
 * `done`. A question cancelled while still queued is confirmed at once and its
 * turn is aborted the moment it starts.
 *
 * Take-over: a prompt a PERSON put into the question's turn while it ran
 * (`prompt.submit` carrying that turn's id, from an origin in
 * TAKEOVER_ORIGINS) makes the rest of the turn theirs. Streaming stops when
 * the prompt reaches the mod's hook (`onPromptSubmitting`, before the hooks
 * beneath run), and the take-over is confirmed once it entered
 * (`onPromptEntered`); a prompt a hook beneath dropped releases the hold
 * (`onPromptDropped`). The step in flight was requested before their prompt
 * existed, so what it says is still the question's answer: it is held and
 * released when the ask settles. The ask settles at the turn's next step (the
 * engine folds a prompt typed mid-turn into the next model request, so from
 * there on the output answers THEM): as `done` when the response before it
 * ended the answer (`end_turn`, no tool call) with text shown, else as `taken_over` with the
 * note. When the turn ends first (their prompt then runs as a turn of its
 * own), it settles with the turn's answer as `done`. Either way Plannotator
 * never aborts that turn again: a Stop only closes the question, and
 * "Interrupt and ask now" refuses.
 */

export interface AskSink {
  delta(text: string): void
  tool(name: string): void
  done(answer: string): void
  error(code: AskErrorCode, message?: string): void
}

export type AskErrorCode = 'busy' | 'blocked' | 'gone' | 'aborted' | 'failed' | 'taken_over'

/**
 * Sent with `taken_over`, so a server older than that code still shows why the
 * answer stopped. Same texts as `SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT` and
 * `SESSION_ASK_TAKEN_OVER_TEXT` in packages/ai/session-bridge.ts (a hooks
 * module imports only its own files; turns.test.ts holds them equal).
 */
export const TAKEN_OVER_BY_PERSON_TEXT =
  'You typed into this session while it was answering, so the rest of the reply went to your prompt.'
export const TAKEN_OVER_TEXT =
  'Another message entered this session while it was answering, so the rest of the reply went to that message.'

/** What `prompt.submit` reported for a prompt that entered the session. */
export interface EnteredPrompt {
  text: string
  /** Its origin is this plugin. */
  fromUs: boolean
  /** The turn it was typed over or delivered into (`e.turnId`); absent when the session was idle. */
  turnId?: string
  /** `origin.kind` (`composer`, `task-notification`, `plugin`, ...). */
  originKind?: string
}

/**
 * Origins whose prompt, delivered into a running turn, takes that turn over:
 * something a person (or another person-driven session) says that the model
 * must now answer. An allowlist, so an origin the engine adds later, or one
 * that is the agent's own work, takes nothing over:
 * - `composer`: the person's Enter in the terminal. `bridge`: the person
 *   through Remote Control. `slack-ping`: the session's owner from Slack.
 *   `channel`: a message an MCP channel relays (Slack, Telegram), a person on
 *   the other end.
 * Not listed, so never a take-over: `peer` (another Claude session's message:
 * the owner's call is that losing the reviewer's answer is worse than a peer's
 * reply streaming into the panel), `task-notification` and
 * `peer-send-message` (notifications framed for the agent: a background task
 * or another session's SendMessage finishing), `scheduled-trigger`,
 * `observer`, `observer-activity`, `coordinator`, `projects-relay`,
 * `auto-continuation`, `unclassified` (the engine's idle notices and delivery
 * receipts), `sdk`, `plugin` (a plugin's prompt runs once idle and carries no
 * turn id).
 */
const TAKEOVER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping', 'channel'])
/** Of those, the person typing into this session: the note says "You typed". */
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

/** The turn a prompt would take over, or null. */
function takeoverTurn(prompt: Omit<EnteredPrompt, 'text'>): string | null {
  if (prompt.fromUs || !prompt.turnId || !prompt.originKind) return null
  return TAKEOVER_ORIGINS.has(prompt.originKind) ? prompt.turnId : null
}

interface ActiveAsk {
  askId: string
  text: string
  sink: AskSink
  turnId: string | null
  cancelled: boolean
  finished: boolean
  /** Someone else's prompt entered this turn: nothing more is streamed. */
  takenOver: boolean
  /** The take-over came from the person typing (note wording). */
  byPerson: boolean
  /** Prompts on their way into this turn (between our prompt.submit hook and next(e) resolving). */
  pending: number
  /** Output held while a prompt is pending or after a take-over, released when it settles. */
  held: { kind: 'text' | 'tool'; value: string }[]
  /** Text sent to Plannotator so far. */
  streamed: string
  /** How the turn's last finished model response stopped (`end_turn`: the answer was complete). */
  lastStop: string | null
}

export class TurnTracker {
  /** The main-loop turn running now, if any. */
  runningTurnId: string | null = null
  private ask: ActiveAsk | null = null
  /** A question cancelled while still queued: its turn is aborted when it starts. */
  private dropText: string | null = null
  /**
   * Prompts that entered the session from anyone but this plugin (the user's
   * Enter, a notification, another plugin), as `prompt.submit` saw them. The
   * engine never raises our own hooks for a prompt our code submitted, so the
   * hook only ever reports these; and when it does see one of ours (origin
   * plugin `plannotator`) it is not recorded. A turn whose text IS one of these
   * prompts is that prompt's turn, never the question's, whatever it says: a
   * prompt the user typed can neither be streamed to Plannotator nor aborted
   * by a cancel.
   */
  private foreign: string[] = []
  /** Turns that started as a question's and were taken over: Plannotator never aborts them. */
  private takenOverTurns = new Set<string>()

  /**
   * A prompt reached the mod's prompt.submit hook, before the hooks beneath it
   * run: when it would take the question's turn over, stop streaming now, so a
   * slow hook beneath cannot let more of the turn through.
   */
  onPromptSubmitting(prompt: Omit<EnteredPrompt, 'text'>): void {
    const ask = this.askOn(takeoverTurn(prompt))
    if (ask) ask.pending += 1
  }

  /** A prompt entered (prompt.submit resolved with it). */
  onPromptEntered(prompt: EnteredPrompt): void {
    if (prompt.fromUs) return
    const value = prompt.text.trim()
    if (value) {
      this.foreign.push(value)
      if (this.foreign.length > 16) this.foreign.shift()
    }
    const ask = this.askOn(takeoverTurn(prompt))
    if (!ask) return
    if (ask.pending > 0) ask.pending -= 1
    if (ask.takenOver) return
    ask.takenOver = true
    ask.byPerson = !!prompt.originKind && PERSON_ORIGINS.has(prompt.originKind)
    this.takenOverTurns.add(ask.turnId!)
  }

  /** A prompt announced by onPromptSubmitting did not enter (a hook beneath dropped it). */
  onPromptDropped(prompt: Omit<EnteredPrompt, 'text'>): void {
    const ask = this.askOn(takeoverTurn(prompt))
    if (!ask || ask.pending === 0) return
    ask.pending -= 1
    if (!ask.takenOver && ask.pending === 0) this.releaseHeld(ask)
  }

  /** The unfinished question running as `turnId`, if any. */
  private askOn(turnId: string | null): ActiveAsk | null {
    const ask = this.ask
    return turnId && ask && !ask.finished && ask.turnId === turnId ? ask : null
  }

  private holding(ask: ActiveAsk): boolean {
    return ask.takenOver || ask.pending > 0
  }

  /** Whether the turn is a prompt someone else submitted (consumed). */
  private takeForeign(turnText: string): boolean {
    const value = turnText.trim()
    // Another plugin's prompt reaches turn.start inside the engine's frame
    // ("The <name> plugin sent a message: ..."), while prompt.submit saw it bare.
    const unframed = value.replace(PLUGIN_FRAME, '').trim()
    let index = this.foreign.lastIndexOf(value)
    if (index < 0 && unframed !== value) index = this.foreign.lastIndexOf(unframed)
    if (index < 0) return false
    this.foreign.splice(index, 1)
    return true
  }

  /**
   * Whether a turn started as a question's and is now someone else's (or a
   * person's prompt is on its way into it): Plannotator never aborts it.
   */
  isTakenOver(turnId: string): boolean {
    return this.takenOverTurns.has(turnId) || (this.askOn(turnId)?.pending ?? 0) > 0
  }

  get busy(): boolean {
    return this.runningTurnId !== null || (this.ask !== null && !this.ask.finished)
  }

  get askInFlight(): boolean {
    return this.ask !== null && !this.ask.finished
  }

  /** Register a question about to be submitted. False when one is already in flight. */
  beginAsk(askId: string, text: string, sink: AskSink): boolean {
    if (this.askInFlight) return false
    this.ask = {
      askId,
      text,
      sink,
      turnId: null,
      cancelled: false,
      finished: false,
      takenOver: false,
      byPerson: false,
      pending: 0,
      held: [],
      streamed: '',
      lastStop: null,
    }
    return true
  }

  isActiveAsk(askId: string): boolean {
    return this.ask?.askId === askId && !this.ask.finished
  }

  /** A turn started. Returns the turn to abort at once (a cancelled question's). */
  onTurnStart(turnId: string, text: string): string | null {
    this.runningTurnId = turnId
    if (this.takeForeign(text)) return null
    if (this.dropText !== null && sameQuestion(text, this.dropText)) {
      this.dropText = null
      return turnId
    }
    const ask = this.ask
    if (ask && !ask.finished && ask.turnId === null && sameQuestion(text, ask.text)) {
      ask.turnId = turnId
    }
    return null
  }

  ownsTurn(turnId: string): boolean {
    return !!this.ask && !this.ask.finished && this.ask.turnId === turnId
  }

  onText(turnId: string, text: string): void {
    const ask = this.ask
    if (!ask || !this.ownsTurn(turnId) || !text) return
    if (this.holding(ask)) ask.held.push({ kind: 'text', value: text })
    else this.forward(ask, text)
  }

  onTool(turnId: string, name: string): void {
    const ask = this.ask
    if (!ask || !this.ownsTurn(turnId) || !name) return
    if (this.holding(ask)) ask.held.push({ kind: 'tool', value: name })
    else ask.sink.tool(name)
  }

  /**
   * A model request of `turnId` is about to go out (turn.step). After a
   * take-over it carries the other prompt, so the question settles here.
   */
  onStep(turnId: string): void {
    const ask = this.askOn(turnId)
    if (!ask) return
    const lastStop = ask.lastStop
    ask.lastStop = null
    if (!ask.takenOver) return
    ask.finished = true
    this.releaseHeld(ask)
    // The response before this request ended the answer (no tool call): the
    // engine runs on only for their prompt, and the question was answered whole.
    // A thinking-only final response streamed nothing: an empty `done` would
    // show nothing at all, so that case reads as taken over (as on Pi / OpenCode).
    if (lastStop === 'end_turn' && ask.streamed.trim()) ask.sink.done(ask.streamed)
    else ask.sink.error('taken_over', ask.byPerson ? TAKEN_OVER_BY_PERSON_TEXT : TAKEN_OVER_TEXT)
  }

  /** A model response of `turnId` finished (the turn.step `stop` chunk). */
  onStepStop(turnId: string, stopReason: string | null): void {
    const ask = this.askOn(turnId)
    if (ask) ask.lastStop = stopReason
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    if (this.runningTurnId === turnId) this.runningTurnId = null
    this.takenOverTurns.delete(turnId)
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId) return
    ask.finished = true
    if (ask.takenOver) {
      // No step ran after the other prompt entered: everything the turn said
      // answered the question (their prompt runs as a turn of its own).
      this.releaseHeld(ask)
      if (aborted || !answer.trim()) ask.sink.error('taken_over', ask.byPerson ? TAKEN_OVER_BY_PERSON_TEXT : TAKEN_OVER_TEXT)
      else ask.sink.done(answer)
      return
    }
    // A prompt still on its way never entered this turn: what was held is the answer.
    this.releaseHeld(ask)
    if (aborted || ask.cancelled) ask.sink.error('aborted')
    else if (answer.trim()) ask.sink.done(answer)
    else ask.sink.error('failed', 'Claude finished the turn without a text answer.')
  }

  private releaseHeld(ask: ActiveAsk): void {
    const held = ask.held
    ask.held = []
    for (const item of held) {
      if (item.kind === 'text') this.forward(ask, item.value)
      else ask.sink.tool(item.value)
    }
  }

  private forward(ask: ActiveAsk, text: string): void {
    ask.streamed += text
    ask.sink.delta(text)
  }

  /**
   * Cancel OUR question. Returns the turn id to abort when its turn is
   * running; a question still queued is dropped when its turn starts.
   */
  cancelAsk(askId: string): string | null {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return null
    ask.cancelled = true
    if (ask.takenOver || ask.pending > 0) {
      // The turn carries someone else's prompt now (or is about to): close the question, never the turn.
      ask.finished = true
      ask.held = []
      ask.sink.error('aborted')
      return null
    }
    if (ask.turnId) return ask.turnId
    // Still queued behind another turn: confirm now, abort its turn when it starts.
    ask.finished = true
    this.dropText = ask.text
    ask.sink.error('aborted')
    return null
  }

  /** The submit failed: the question never reached the session. */
  failAsk(askId: string, message: string): void {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return
    ask.finished = true
    ask.sink.error('failed', message)
  }
}

/** The engine's frame around a plugin's prompt at turn.start. */
const PLUGIN_FRAME = /^The [^\n]{1,200}? plugin sent a message:\s*/

/**
 * Whether a turn's text is our question. The engine may wrap a plugin's
 * prompt in a "sent a message" frame, expand pastes or trim, so the question's
 * first and last lines are what identify it.
 */
export function sameQuestion(turnText: string, askText: string): boolean {
  const turn = turnText.trim()
  const ask = askText.trim()
  if (!ask) return false
  if (turn.includes(ask)) return true
  const firstLine = ask.split('\n', 1)[0] ?? ''
  const lastLine = ask.slice(ask.lastIndexOf('\n') + 1)
  return firstLine.length > 0 && turn.includes(firstLine) && turn.includes(lastLine)
}
