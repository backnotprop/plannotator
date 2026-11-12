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
    expect(turns.onTurnStart('our-turn', 'The plannotator plugin sent a message:\nwhy?')).toBe('our-turn')
  })

  test('our own submission claims its turn (the engine never shows it to our prompt.submit hook)', () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onPromptEntered({ text: 'why?', fromUs: true })
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})

describe('TurnTracker: question prompts carried to the next session', () => {
  const OUR_TURN = 'The plannotator plugin sent a message:\nwhy?'

  test('a question Stopped while still queued is carried, and its turn is aborted in the next session', () => {
    const before = new TurnTracker()
    before.beginAsk('a1', 'why?', sink())
    expect(before.cancelAsk('a1')).toBeNull()
    const after = new TurnTracker()
    after.dropQueued(before.queuedPrompts())
    expect(after.onTurnStart('t1', OUR_TURN)).toBe('t1')
  })

  test('a second switch before the turn starts still carries it', () => {
    const a = new TurnTracker()
    a.beginAsk('a1', 'why?', sink())
    const b = new TurnTracker()
    b.dropQueued(a.queuedPrompts())
    const c = new TurnTracker()
    c.dropQueued(b.queuedPrompts())
    expect(c.onTurnStart('t1', OUR_TURN)).toBe('t1')
  })

  test('a carried prompt whose submit failed is forgotten: the same words asked again are answered', async () => {
    const before = new TurnTracker()
    before.beginAsk('a1', 'why?', sink())
    let reject!: (error: Error) => void
    const submit = new Promise((_resolve, fail) => (reject = fail))
    submit.catch(() => undefined)
    before.followSubmit('a1', submit)
    const after = new TurnTracker()
    after.dropQueued(before.queuedPrompts())
    reject(new Error('discarded'))
    await Bun.sleep(0)

    const s = sink()
    expect(after.beginAsk('a2', 'why?', s)).toBe(true)
    expect(after.onTurnStart('t2', OUR_TURN)).toBeNull()
    after.onTurnComplete('t2', 'because', false)
    expect(s.answers).toEqual(['because'])
    expect(after.busy).toBe(false)
  })

  test('a carried prompt the engine took is forgotten once a turn ended after it', async () => {
    const before = new TurnTracker()
    before.beginAsk('a1', 'why?', sink())
    let taken!: () => void
    before.followSubmit('a1', new Promise<void>((resolve) => (taken = resolve)))
    const after = new TurnTracker()
    after.dropQueued(before.queuedPrompts())
    taken()
    await Bun.sleep(0)
    after.onTurnStart('t1', 'something else')
    after.onTurnComplete('t1', 'ok', false)

    const s = sink()
    after.beginAsk('a2', 'why?', s)
    expect(after.onTurnStart('t2', OUR_TURN)).toBeNull()
    after.onTurnComplete('t2', 'because', false)
    expect(s.answers).toEqual(['because'])
  })

  test('a prompt taken before the turn it waited behind completes is still aborted when its turn starts', async () => {
    const turns = new TurnTracker()
    turns.onTurnStart('person', 'My own work.')
    turns.beginAsk('a1', 'why?', sink())
    let taken!: () => void
    turns.followSubmit('a1', new Promise<void>((resolve) => (taken = resolve)))
    expect(turns.cancelAsk('a1')).toBeNull()
    taken()
    await Bun.sleep(0)
    turns.onTurnComplete('person', 'Done.', false)
    expect(turns.onTurnStart('t2', OUR_TURN)).toBe('t2')

    const before = new TurnTracker()
    before.onTurnStart('person-2', 'My own work.')
    before.beginAsk('a2', 'why?', sink())
    let takenToo!: () => void
    before.followSubmit('a2', new Promise<void>((resolve) => (takenToo = resolve)))
    const after = new TurnTracker()
    after.dropQueued(before.queuedPrompts())
    takenToo()
    await Bun.sleep(0)
    after.onTurnComplete('person-2', 'Done.', false)
    expect(after.onTurnStart('t3', OUR_TURN)).toBe('t3')
  })

  test('a prompt still waiting is dropped before the same words asked again claim their own turn', () => {
    const before = new TurnTracker()
    before.beginAsk('a1', 'why?', sink())
    const after = new TurnTracker()
    after.dropQueued(before.queuedPrompts())
    const s = sink()
    after.beginAsk('a2', 'why?', s)
    expect(after.onTurnStart('t1', OUR_TURN)).toBe('t1')
    after.onTurnComplete('t1', '', true)
    expect(after.onTurnStart('t2', OUR_TURN)).toBeNull()
    after.onTurnComplete('t2', 'because', false)
    expect(s.answers).toEqual(['because'])
  })
})

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

describe("TurnTracker: a prompt typed into the question's turn takes it over", () => {
  test('streaming stops at once and the question settles at the next step with the note', () => {
    const { turns, s } = running()
    turns.onPromptEntered(typed('composer'))
    turns.onText('t1', 'it is needed.')
    expect(s.deltas).toEqual(['Because '])
    expect(turns.isTakenOver('t1')).toBe(true)

    turns.onStepStop('t1', 'tool_use')
    turns.onStep('t1')
    expect(s.deltas).toEqual(['Because ', 'it is needed.'])
    expect(s.errors).toEqual(['taken_over'])
    expect(s.messages).toEqual([TAKEN_OVER_BY_PERSON_TEXT])
    expect(turns.ownsTurn('t1')).toBe(false)

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
    turns.onPromptEntered({ text: 'why? summarize the diff', fromUs: false, originKind: 'plugin' })
    expect(turns.onTurnStart('ws-turn', 'The workspaces plugin sent a message:\nwhy? summarize the diff')).toBeNull()
    turns.onText('ws-turn', 'the diff adds a parser')
    expect(turns.ownsTurn('ws-turn')).toBe(false)
    expect(s.deltas).toEqual([])
    turns.onTurnComplete('ws-turn', 'the diff adds a parser', false)
    turns.onTurnStart('t1', 'The plannotator plugin sent a message:\nwhy?')
    turns.onText('t1', 'because')
    expect(s.deltas).toEqual(['because'])
  })
})

test('the mod sends the same take-over notes the provider would', () => {
  expect(TAKEN_OVER_TEXT).toBe(SESSION_ASK_TAKEN_OVER_TEXT)
  expect(TAKEN_OVER_BY_PERSON_TEXT).toBe(SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT)
  expect(TAKEN_OVER_INTERRUPT_TEXT).toBe(SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT)
})

describe("TurnTracker knows another plugin's turns", () => {
  test("a turn another plugin's prompt started is that plugin's until it ends", () => {
    const turns = new TurnTracker()
    turns.onPromptEntered({ text: 'Review PR 12.', fromUs: false, originKind: 'plugin' })
    expect(turns.onTurnStart('plugin-turn', 'The workspaces plugin sent a message: Review PR 12.')).toBeNull()
    expect(turns.isOtherPluginTurn('plugin-turn')).toBe(true)
    turns.onTurnComplete('plugin-turn', 'Done.', false)
    expect(turns.isOtherPluginTurn('plugin-turn')).toBe(false)
  })

  test("the person's turns, engine-started turns and our own turns are not another plugin's", () => {
    const turns = new TurnTracker()
    turns.onPromptEntered({ text: 'fix the parser', fromUs: false, originKind: 'composer' })
    turns.onTurnStart('person', 'fix the parser')
    expect(turns.isOtherPluginTurn('person')).toBe(false)
    turns.onTurnComplete('person', 'Done.', false)
    turns.onPromptEntered({ text: 'Task finished.', fromUs: false, originKind: 'task-notification' })
    turns.onTurnStart('note', 'Task finished.')
    expect(turns.isOtherPluginTurn('note')).toBe(false)
    turns.onTurnComplete('note', 'Ok.', false)
    turns.onPromptEntered({ text: 'Plannotator Inbox: x', fromUs: true, originKind: 'plugin' })
    turns.onTurnStart('ours', 'The plannotator plugin sent a message: Plannotator Inbox: x')
    expect(turns.isOtherPluginTurn('ours')).toBe(false)
    turns.onTurnComplete('ours', 'Ok.', false)
    turns.onTurnStart('unknown', 'The workspaces plugin sent a message: hello')
    expect(turns.isOtherPluginTurn('unknown')).toBe(false)
  })

  test("another plugin's prompt delivered into a running turn makes it that plugin's too; our Ask question is still claimed", () => {
    const turns = new TurnTracker()
    turns.onTurnStart('person', 'refactor')
    turns.onPromptEntered({ text: 'Also look at PR 12.', fromUs: false, originKind: 'plugin', turnId: 'person' })
    expect(turns.isOtherPluginTurn('person')).toBe(true)
    turns.onTurnComplete('person', 'Done.', false)
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onTurnStart('ask', 'The plannotator plugin sent a message:\nwhy?')
    expect(turns.ownsTurn('ask')).toBe(true)
    expect(turns.isOtherPluginTurn('ask')).toBe(false)
  })
})

describe("cancelling our question never aborts a turn another plugin's prompt joined", () => {
  test('alone, a cancel aborts the question\'s own turn (as before)', () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onTurnStart('ask', 'The plannotator plugin sent a message:\nwhy?')
    expect(turns.cancelAsk('a1')).toBe('ask')
  })

  test("joined by another plugin's prompt, a cancel closes the question and returns no turn to abort", () => {
    const turns = new TurnTracker()
    const s = sink()
    turns.beginAsk('a1', 'why?', s)
    turns.onTurnStart('ask', 'The plannotator plugin sent a message:\nwhy?')
    turns.onPromptEntered({ text: 'Review PR 12.', fromUs: false, originKind: 'plugin', turnId: 'ask' })
    expect(turns.cancelAsk('a1')).toBeNull()
    expect(s.errors).toEqual(['aborted'])
    expect(turns.isActiveAsk('a1')).toBe(false)
    turns.onText('ask', 'the other plugin\'s answer')
    expect(s.deltas).toEqual([])
  })
})
