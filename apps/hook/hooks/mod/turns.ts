export interface AskSink {
  delta(text: string): void
  tool(name: string): void
  done(answer: string): void
  error(code: AskErrorCode, message?: string): void
}

export type AskErrorCode = 'busy' | 'blocked' | 'gone' | 'aborted' | 'failed' | 'taken_over'

export const TAKEN_OVER_BY_PERSON_TEXT =
  'You typed into this session while it was answering, so the rest of the reply went to your prompt.'
export const TAKEN_OVER_TEXT =
  'Another message entered this session while it was answering, so the rest of the reply went to that message.'

export interface EnteredPrompt {
  text: string
  fromUs: boolean
  turnId?: string
  originKind?: string
}

const TAKEOVER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'slack-ping', 'channel'])
const OTHER_PLUGIN_ORIGIN = 'plugin'
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge'])

function takeoverTurn(prompt: Omit<EnteredPrompt, 'text'>): string | null {
  if (prompt.fromUs || !prompt.turnId || !prompt.originKind) return null
  return TAKEOVER_ORIGINS.has(prompt.originKind) ? prompt.turnId : null
}

export class QueuedPrompt {
  state: 'waiting' | 'taken' | 'failed' = 'waiting'
  takenAt = 0
  constructor(readonly text: string) {}

  follow(submit: Promise<unknown>): void {
    submit.then(
      () => {
        if (this.state !== 'waiting') return
        this.state = 'taken'
        this.takenAt = mainTurnStarts
      },
      () => {
        this.state = 'failed'
      },
    )
  }
}

let mainTurnStarts = 0

const MAX_DROPS = 16

interface ActiveAsk {
  askId: string
  text: string
  prompt: QueuedPrompt
  sink: AskSink
  turnId: string | null
  cancelled: boolean
  finished: boolean
  takenOver: boolean
  byPerson: boolean
  pending: number
  held: { kind: 'text' | 'tool'; value: string }[]
  streamed: string
  lastStop: string | null
}

export class TurnTracker {
  runningTurnId: string | null = null
  private ask: ActiveAsk | null = null
  private drops: QueuedPrompt[] = []
  private startedAt = new Map<string, number>()
  private foreign: { text: string; originKind?: string }[] = []
  private takenOverTurns = new Set<string>()
  private otherPluginTurns = new Set<string>()

  onPromptSubmitting(prompt: Omit<EnteredPrompt, 'text'>): void {
    const ask = this.askOn(takeoverTurn(prompt))
    if (ask) ask.pending += 1
  }

  onPromptEntered(prompt: EnteredPrompt): void {
    if (prompt.fromUs) return
    const value = prompt.text.trim()
    if (value) {
      this.foreign.push({ text: value, ...(prompt.originKind ? { originKind: prompt.originKind } : {}) })
      if (this.foreign.length > 16) this.foreign.shift()
    }
    if (prompt.turnId && prompt.originKind === OTHER_PLUGIN_ORIGIN) this.otherPluginTurns.add(prompt.turnId)
    const ask = this.askOn(takeoverTurn(prompt))
    if (!ask) return
    if (ask.pending > 0) ask.pending -= 1
    if (ask.takenOver) return
    ask.takenOver = true
    ask.byPerson = !!prompt.originKind && PERSON_ORIGINS.has(prompt.originKind)
    this.takenOverTurns.add(ask.turnId!)
  }

  onPromptDropped(prompt: Omit<EnteredPrompt, 'text'>): void {
    const ask = this.askOn(takeoverTurn(prompt))
    if (!ask || ask.pending === 0) return
    ask.pending -= 1
    if (!ask.takenOver && ask.pending === 0) this.releaseHeld(ask)
  }

  private askOn(turnId: string | null): ActiveAsk | null {
    const ask = this.ask
    return turnId && ask && !ask.finished && ask.turnId === turnId ? ask : null
  }

  private holding(ask: ActiveAsk): boolean {
    return ask.takenOver || ask.pending > 0
  }

  private takeForeign(turnText: string): { text: string; originKind?: string } | null {
    const value = turnText.trim()
    const unframed = value.replace(PLUGIN_FRAME, '').trim()
    const find = (text: string) => this.foreign.findLastIndex((entry) => entry.text === text)
    let index = find(value)
    if (index < 0 && unframed !== value) index = find(unframed)
    if (index < 0) return null
    return this.foreign.splice(index, 1)[0]!
  }

  isOtherPluginTurn(turnId: string): boolean {
    return this.otherPluginTurns.has(turnId)
  }

  isTakenOver(turnId: string): boolean {
    return this.takenOverTurns.has(turnId) || (this.askOn(turnId)?.pending ?? 0) > 0
  }

  get runningTurn(): string | null {
    return this.runningTurnId
  }

  get busy(): boolean {
    return this.runningTurnId !== null || (this.ask !== null && !this.ask.finished)
  }

  get askInFlight(): boolean {
    return this.ask !== null && !this.ask.finished
  }

  beginAsk(askId: string, text: string, sink: AskSink): boolean {
    if (this.askInFlight) return false
    this.ask = {
      askId,
      text,
      prompt: new QueuedPrompt(text),
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

  followSubmit(askId: string, submit: Promise<unknown>): void {
    if (this.ask?.askId === askId) this.ask.prompt.follow(submit)
  }

  queuedPrompts(): QueuedPrompt[] {
    this.prune('failed')
    const ask = this.ask
    const live = ask && !ask.finished && ask.turnId === null && !this.drops.includes(ask.prompt) ? [ask.prompt] : []
    return [...this.drops, ...live]
  }

  dropQueued(prompts: readonly QueuedPrompt[]): void {
    for (const prompt of prompts) this.addDrop(prompt)
  }

  private addDrop(prompt: QueuedPrompt): void {
    if (prompt.state === 'failed' || this.drops.includes(prompt)) return
    this.drops.push(prompt)
    if (this.drops.length > MAX_DROPS) this.drops.shift()
  }

  private prune(...states: QueuedPrompt['state'][]): void {
    this.drops = this.drops.filter((prompt) => !states.includes(prompt.state))
  }

  isActiveAsk(askId: string): boolean {
    return this.ask?.askId === askId && !this.ask.finished
  }

  onTurnStart(turnId: string, text: string): string | null {
    this.runningTurnId = turnId
    mainTurnStarts += 1
    this.startedAt.set(turnId, mainTurnStarts)
    if (this.startedAt.size > MAX_DROPS) this.startedAt.delete(this.startedAt.keys().next().value!)
    const foreign = this.takeForeign(text)
    if (foreign) {
      if (foreign.originKind === OTHER_PLUGIN_ORIGIN) this.otherPluginTurns.add(turnId)
      return null
    }
    this.prune('failed')
    const drop = this.drops.findIndex((prompt) => sameQuestion(text, prompt.text))
    if (drop >= 0) {
      this.drops.splice(drop, 1)
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

  onStep(turnId: string): void {
    const ask = this.askOn(turnId)
    if (!ask) return
    const lastStop = ask.lastStop
    ask.lastStop = null
    if (!ask.takenOver) return
    ask.finished = true
    this.releaseHeld(ask)
    if (lastStop === 'end_turn' && ask.streamed.trim()) ask.sink.done(ask.streamed)
    else ask.sink.error('taken_over', ask.byPerson ? TAKEN_OVER_BY_PERSON_TEXT : TAKEN_OVER_TEXT)
  }

  onStepStop(turnId: string, stopReason: string | null): void {
    const ask = this.askOn(turnId)
    if (ask) ask.lastStop = stopReason
  }

  onTurnComplete(turnId: string, answer: string, aborted: boolean): void {
    if (this.runningTurnId === turnId) this.runningTurnId = null
    this.takenOverTurns.delete(turnId)
    this.otherPluginTurns.delete(turnId)
    const started = this.startedAt.get(turnId)
    this.startedAt.delete(turnId)
    this.prune('failed')
    if (started !== undefined) this.drops = this.drops.filter((prompt) => !(prompt.state === 'taken' && prompt.takenAt < started))
    const ask = this.ask
    if (!ask || ask.finished || ask.turnId !== turnId) return
    ask.finished = true
    if (ask.takenOver) {
      this.releaseHeld(ask)
      if (aborted || !answer.trim()) ask.sink.error('taken_over', ask.byPerson ? TAKEN_OVER_BY_PERSON_TEXT : TAKEN_OVER_TEXT)
      else ask.sink.done(answer)
      return
    }
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

  cancelAsk(askId: string): string | null {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return null
    ask.cancelled = true
    if (ask.takenOver || ask.pending > 0 || (ask.turnId !== null && this.otherPluginTurns.has(ask.turnId))) {
      ask.finished = true
      ask.held = []
      ask.sink.error('aborted')
      return null
    }
    if (ask.turnId) return ask.turnId
    ask.finished = true
    this.addDrop(ask.prompt)
    ask.sink.error('aborted')
    return null
  }

  failAsk(askId: string, message: string): void {
    const ask = this.ask
    if (!ask || ask.askId !== askId || ask.finished) return
    ask.finished = true
    ask.sink.error('failed', message)
  }
}

const PLUGIN_FRAME = /^The [^\n]{1,200}? plugin sent a message:\s*/

export function sameQuestion(turnText: string, askText: string): boolean {
  const turn = turnText.trim()
  const ask = askText.trim()
  if (!ask) return false
  if (turn.includes(ask)) return true
  const firstLine = ask.split('\n', 1)[0] ?? ''
  const lastLine = ask.slice(ask.lastIndexOf('\n') + 1)
  return firstLine.length > 0 && turn.includes(firstLine) && turn.includes(lastLine)
}
