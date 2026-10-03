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
 */

export interface AskSink {
  delta(text: string): void
  tool(name: string): void
  done(answer: string): void
  error(code: 'busy' | 'blocked' | 'gone' | 'aborted' | 'failed', message?: string): void
}

interface ActiveAsk {
  askId: string
  text: string
  sink: AskSink
  turnId: string | null
  cancelled: boolean
  finished: boolean
}

export class TurnTracker {
  /** The main-loop turn running now, if any. */
  runningTurnId: string | null = null
  private ask: ActiveAsk | null = null
  /** A question cancelled while still queued: its turn is aborted when it starts. */
  private dropText: string | null = null
  /**
   * Set when THIS plugin's own `$.prompt.submit` of the question (or of a
   * cancelled one) enters the session (`prompt.submit` with origin plugin
   * `plannotator`); the next `turn.start` is that prompt's turn. Text alone
   * never claims a turn, so a prompt the user typed can neither be streamed to
   * Plannotator nor aborted as "ours", whatever it says.
   */
  private armed: 'ask' | 'drop' | null = null

  /**
   * A prompt entered the session. `fromUs`: its origin is this plugin. Arms
   * the next turn when it is the question in flight (or a cancelled one).
   */
  onPromptEntered(text: string, fromUs: boolean): void {
    if (!fromUs) {
      this.armed = null
      return
    }
    if (this.dropText !== null && sameQuestion(text, this.dropText)) {
      this.armed = 'drop'
      return
    }
    const ask = this.ask
    this.armed = ask && !ask.finished && ask.turnId === null && sameQuestion(text, ask.text) ? 'ask' : null
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
    this.ask = { askId, text, sink, turnId: null, cancelled: false, finished: false }
    return true
  }

  isActiveAsk(askId: string): boolean {
    return this.ask?.askId === askId && !this.ask.finished
  }

  /** A turn started. Returns the turn to abort at once (a cancelled question's). */
  onTurnStart(turnId: string, _text: string): string | null {
    this.runningTurnId = turnId
    const armed = this.armed
    this.armed = null
    if (armed === 'drop') {
      this.dropText = null
      return turnId
    }
    const ask = this.ask
    if (armed === 'ask' && ask && !ask.finished && ask.turnId === null) {
      ask.turnId = turnId
    }
    return null
  }

  ownsTurn(turnId: string): boolean {
    return !!this.ask && !this.ask.finished && this.ask.turnId === turnId
  }

  onText(turnId: string, text: string): void {
    if (this.ownsTurn(turnId) && text) this.ask?.sink.delta(text)
  }

  onTool(turnId: string, name: string): void {
    if (this.ownsTurn(turnId) && name) this.ask?.sink.tool(name)
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    if (this.runningTurnId === turnId) this.runningTurnId = null
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId) return
    ask.finished = true
    if (aborted || ask.cancelled) ask.sink.error('aborted')
    else if (answer.trim()) ask.sink.done(answer)
    else ask.sink.error('failed', 'Claude finished the turn without a text answer.')
  }

  /**
   * Cancel OUR question. Returns the turn id to abort when its turn is
   * running; a question still queued is dropped when its turn starts.
   */
  cancelAsk(askId: string): string | null {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return null
    ask.cancelled = true
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
