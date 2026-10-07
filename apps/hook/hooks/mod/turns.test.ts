import { describe, expect, test } from 'bun:test'
import {
  formatSessionAskText,
  SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT,
  SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT,
  SESSION_ASK_TAKEN_OVER_TEXT,
} from '../../../../packages/ai/session-bridge.ts'
import { TAKEN_OVER_INTERRUPT_TEXT } from './bridge'
import { TAKEN_OVER_BY_PERSON_TEXT, TAKEN_OVER_TEXT, TurnTracker, type AskSink } from './turns'

function sink(): AskSink & { deltas: string[]; errors: string[]; messages: (string | undefined)[]; answers: string[] } {
  const deltas: string[] = []
  const errors: string[] = []
  const messages: (string | undefined)[] = []
  const answers: string[] = []
  return {
    deltas,
    errors,
    messages,
    answers,
    delta: (t) => deltas.push(t),
    tool: () => undefined,
    done: (answer) => answers.push(answer),
    error: (c, m) => {
      errors.push(c)
      messages.push(m)
    },
  }
}

// The failure these guard: a prompt the USER typed that happens to contain the
// question's text was claimed as the question's turn, so the user's turn was
// streamed into Plannotator, or aborted by a Plannotator cancel.
describe('TurnTracker claims only its own prompt', () => {
  test("a user's prompt quoting the queued question is not claimed", () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onPromptEntered({ text: 'why? explain the parser', fromUs: false })
    turns.onTurnStart('user-turn', 'why? explain the parser')
    turns.onText('user-turn', 'secret user answer')
    expect(turns.ownsTurn('user-turn')).toBe(false)
    expect(s.deltas).toEqual([])
  })

  test("a cancelled queued question never aborts the user's matching turn", () => {
    const turns = new TurnTracker()
    turns.beginAsk('a1', 'why?', sink())
    expect(turns.cancelAsk('a1')).toBeNull()
    turns.onPromptEntered({ text: 'why?', fromUs: false })
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
    turns.onPromptEntered({ text: 'why?', fromUs: true })
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})

// #1748 put the reviewer's draft list between the surface line and the
// question. The failure this guards: the mod no longer recognizing its own
// question turn, so the answer never streams back to Plannotator. The turn is
// matched by the question's first and last line, so it must still be claimed
// when the engine frames it, and even when it rewrites the middle.
describe('TurnTracker claims a question carrying a draft list', () => {
  const text = formatSessionAskText(
    { mode: 'annotate', annotate: { content: '', filePath: 'last-message' } },
    'Is draft 1 right?',
    'turn',
    'Draft 1 (line 3): comment on "Open issues" — create these\nDraft 2 (line 6): suggests removing "Update the docs"',
  )

  test('framed by the engine', () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', text, s)
    turns.onTurnStart('t1', `The plannotator plugin sent a message: ${text}`)
    expect(turns.ownsTurn('t1')).toBe(true)
    turns.onText('t1', 'yes')
    expect(s.deltas).toEqual(['yes'])
  })

  test('with the draft lines rewritten', () => {
    const turns = new TurnTracker()
    turns.beginAsk('a1', text, sink())
    const lines = text.split('\n')
    const collapsed = [lines[0], '[Pasted text #1 +6 lines]', lines[lines.length - 1]].join('\n')
    turns.onTurnStart('t1', collapsed)
    expect(turns.ownsTurn('t1')).toBe(true)
  })
})

/** A question that is running as turn `t1`, with some answer already streamed. */
function running() {
  const turns = new TurnTracker()
  const s = sink()
  turns.beginAsk('a1', '[Plannotator Ask AI] Why step 2?', s)
  turns.onTurnStart('t1', 'The plannotator plugin sent a message:\n[Plannotator Ask AI] Why step 2?')
  turns.onStep('t1')
  turns.onText('t1', 'Because ')
  return { turns, s }
}

const typed = (originKind: string, text = 'also fix the tests') => ({ text, fromUs: false, turnId: 't1', originKind })

// The failure these guard: the person typed into the turn Plannotator's
// question started, and the reply to THEIR prompt was streamed into
// Plannotator as the answer, and a Plannotator Stop aborted their work.
describe("TurnTracker: a prompt typed into the question's turn takes it over", () => {
  test('streaming stops at once and the question settles at the next step with the note', () => {
    const { turns, s } = running()
    turns.onPromptEntered(typed('composer'))
    // The step in flight was requested before their prompt: held, not streamed.
    turns.onText('t1', 'it is needed.')
    expect(s.deltas).toEqual(['Because '])
    expect(turns.isTakenOver('t1')).toBe(true)

    // The next request carries their prompt: the question settles here.
    turns.onStepStop('t1', 'tool_use')
    turns.onStep('t1')
    expect(s.deltas).toEqual(['Because ', 'it is needed.'])
    expect(s.errors).toEqual(['taken_over'])
    expect(s.messages).toEqual([TAKEN_OVER_BY_PERSON_TEXT])
    expect(turns.ownsTurn('t1')).toBe(false)

    // Their reply is never streamed, and a late cancel aborts nothing.
    turns.onText('t1', 'Fixed the tests.')
    expect(s.deltas).toEqual(['Because ', 'it is needed.'])
    expect(turns.cancelAsk('a1')).toBeNull()
    expect(turns.isTakenOver('t1')).toBe(true)
    turns.onTurnComplete('t1', 'Fixed the tests.', false)
    expect(turns.isTakenOver('t1')).toBe(false)
    expect(s.answers).toEqual([])
  })

  test('streaming stops when the prompt reaches our hook, before the hooks beneath it settle', () => {
    const { turns, s } = running()
    turns.onPromptSubmitting(typed('composer'))
    turns.onText('t1', 'it is needed.')
    expect(s.deltas).toEqual(['Because '])
    // A Stop while it is on its way closes only the question.
    expect(turns.isTakenOver('t1')).toBe(true)
    expect(turns.cancelAsk('a1')).toBeNull()
    expect(s.errors).toEqual(['aborted'])
  })

  test('a prompt a hook beneath dropped releases the hold and the answer streams on', () => {
    const { turns, s } = running()
    turns.onPromptSubmitting(typed('composer'))
    turns.onText('t1', 'it is ')
    turns.onPromptDropped(typed('composer'))
    turns.onText('t1', 'needed.')
    expect(s.deltas).toEqual(['Because ', 'it is ', 'needed.'])
    expect(turns.isTakenOver('t1')).toBe(false)
    turns.onTurnComplete('t1', 'Because it is needed.', false)
    expect(s.answers).toEqual(['Because it is needed.'])
  })

  test('when the response before their prompt ended the answer, the question settles as done', () => {
    const { turns, s } = running()
    turns.onText('t1', 'it is needed.')
    turns.onPromptEntered(typed('composer', 'thanks'))
    turns.onStepStop('t1', 'end_turn')
    turns.onStep('t1')
    expect(s.answers).toEqual(['Because it is needed.'])
    expect(s.errors).toEqual([])
  })

  test('a thinking-only final response (nothing streamed) settles as taken over, not an empty done', () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onStep('t1')
    turns.onPromptEntered(typed('composer'))
    turns.onStepStop('t1', 'end_turn')
    turns.onStep('t1')
    expect(s.answers).toEqual([])
    expect(s.errors).toEqual(['taken_over'])
  })

  test('a Stop between the take-over and the next step closes the question, never the turn', () => {
    const { turns, s } = running()
    turns.onPromptEntered(typed('composer'))
    expect(turns.cancelAsk('a1')).toBeNull()
    expect(s.errors).toEqual(['aborted'])
    turns.onStep('t1')
    expect(s.errors).toEqual(['aborted'])
  })

  test('when the turn ends before another step, everything it said answered the question', () => {
    const { turns, s } = running()
    turns.onPromptEntered(typed('composer', 'thanks'))
    turns.onText('t1', 'it is needed.')
    turns.onTurnComplete('t1', 'Because it is needed.', false)
    expect(s.deltas).toEqual(['Because ', 'it is needed.'])
    expect(s.answers).toEqual(['Because it is needed.'])
    expect(s.errors).toEqual([])
    // Their prompt then runs as a turn of its own, which is not claimed.
    expect(turns.onTurnStart('t2', 'thanks')).toBeNull()
    expect(turns.ownsTurn('t2')).toBe(false)
  })

  test('the person (prompt box, Remote Control) gets "You typed"; a channel or Slack ping the neutral note', () => {
    for (const [originKind, note] of [
      ['composer', TAKEN_OVER_BY_PERSON_TEXT],
      ['bridge', TAKEN_OVER_BY_PERSON_TEXT],
      ['channel', TAKEN_OVER_TEXT],
      ['slack-ping', TAKEN_OVER_TEXT],
    ] as const) {
      const { turns, s } = running()
      turns.onPromptEntered(typed(originKind))
      turns.onStep('t1')
      expect([originKind, s.errors, s.messages]).toEqual([originKind, ['taken_over'], [note]])
    }
  })

  test("the agent's own work and engine notices never take the turn over", () => {
    for (const originKind of [
      // The owner's call: a peer session's reply streaming into the panel is
      // better than losing the reviewer's answer.
      'peer',
      'task-notification',
      'peer-send-message',
      'scheduled-trigger',
      'observer',
      'observer-activity',
      'coordinator',
      'projects-relay',
      'auto-continuation',
      'unclassified',
      'some-future-kind',
    ]) {
      const { turns, s } = running()
      turns.onPromptSubmitting(typed(originKind))
      turns.onPromptEntered(typed(originKind))
      turns.onStep('t1')
      turns.onText('t1', 'it is needed.')
      expect([originKind, turns.isTakenOver('t1')]).toEqual([originKind, false])
      expect(s.deltas).toEqual(['Because ', 'it is needed.'])
      turns.onTurnComplete('t1', 'Because it is needed.', false)
      expect(s.answers).toEqual(['Because it is needed.'])
      expect(s.errors).toEqual([])
    }
  })

  test("a prompt typed over someone else's turn changes nothing for a queued question", () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.onTurnStart('user-turn', 'refactor the parser')
    turns.beginAsk('a1', 'why?', s)
    turns.onPromptEntered({ text: 'and the lexer', fromUs: false, turnId: 'user-turn', originKind: 'composer' })
    expect(turns.isTakenOver('user-turn')).toBe(false)
    turns.onTurnComplete('user-turn', 'done', false)
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})

describe("TurnTracker never claims another plugin's turn", () => {
  test("another plugin's prompt, framed at turn.start, is not the question's turn", () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    // prompt.submit sees the other plugin's text bare; turn.start sees it framed.
    turns.onPromptEntered({ text: 'why? summarize the diff', fromUs: false, originKind: 'plugin' })
    expect(turns.onTurnStart('ws-turn', 'The workspaces plugin sent a message:\nwhy? summarize the diff')).toBeNull()
    turns.onText('ws-turn', 'the diff adds a parser')
    expect(turns.ownsTurn('ws-turn')).toBe(false)
    expect(s.deltas).toEqual([])
    turns.onTurnComplete('ws-turn', 'the diff adds a parser', false)
    // Our own question still claims its turn afterwards.
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})

test('the mod sends the same take-over notes the provider would', () => {
  // A hooks module imports only its own files, so the texts are copies.
  expect(TAKEN_OVER_TEXT).toBe(SESSION_ASK_TAKEN_OVER_TEXT)
  expect(TAKEN_OVER_BY_PERSON_TEXT).toBe(SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT)
  expect(TAKEN_OVER_INTERRUPT_TEXT).toBe(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT)
})
