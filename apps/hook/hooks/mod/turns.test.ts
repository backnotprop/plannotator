import { describe, expect, test } from 'bun:test'
import { TurnTracker, type AskSink } from './turns'

function sink(): AskSink & { deltas: string[]; errors: string[] } {
  const deltas: string[] = []
  const errors: string[] = []
  return { deltas, errors, delta: (t) => deltas.push(t), tool: () => undefined, done: () => undefined, error: (c) => errors.push(c) }
}

// The failure these guard: a prompt the USER typed that happens to contain the
// question's text was claimed as the question's turn, so the user's turn was
// streamed into Plannotator, or aborted by a Plannotator cancel.
describe('TurnTracker claims only its own prompt', () => {
  test("a user's prompt quoting the queued question is not claimed", () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onPromptEntered('why? explain the parser', false)
    turns.onTurnStart('user-turn', 'why? explain the parser')
    turns.onText('user-turn', 'secret user answer')
    expect(turns.ownsTurn('user-turn')).toBe(false)
    expect(s.deltas).toEqual([])
  })

  test("a cancelled queued question never aborts the user's matching turn", () => {
    const turns = new TurnTracker()
    turns.beginAsk('a1', 'why?', sink())
    expect(turns.cancelAsk('a1')).toBeNull()
    turns.onPromptEntered('why?', false)
    expect(turns.onTurnStart('user-turn', 'why?')).toBeNull()
    // Our own submission still gets dropped when it arrives.
    // Our own submission never reaches our prompt.submit hook (the engine
    // skips a plugin's hooks for events its own code raised).
    expect(turns.onTurnStart('our-turn', 'The plannotator plugin sent a message:\nwhy?')).toBe('our-turn')
  })

  test('our own submission claims its turn (the engine never shows it to our prompt.submit hook)', () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    // If an engine ever does show it, with our origin, it is still ours.
    turns.onPromptEntered('why?', true)
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})
