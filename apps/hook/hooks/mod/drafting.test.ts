import { describe, expect, test } from 'bun:test'
import { DRAFTING_MAX_JSON, DRAFTING_POST_EVERY_MS, DraftingFeed, DraftingSender, postEveryMs, type DraftingPost } from './drafting'

const TOOL = 'mcp__plannotator__plannotator_inbox'

function feed() {
  const posts: DraftingPost[] = []
  const clock = { now: 1000 }
  return { posts, clock, feed: new DraftingFeed(() => clock.now, (post) => posts.push(post), TOOL) }
}

const tool = (name: string, index = 0) => ({ kind: 'tool', index, id: `call-${index}`, name })
const input = (json: string, index = 0) => ({ kind: 'input', index, json })

describe('DraftingFeed', () => {
  test('an Inbox message with a drawing is posted as it grows, whole each time, then once more as done', () => {
    const { posts, clock, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"action":"send_message","body":"Look:\\n'))
    expect(posts).toEqual([])
    f.onChunk(input('```svg\\n<svg>'))
    expect(posts).toEqual([{ call: 'call-0', json: '{"action":"send_message","body":"Look:\\n```svg\\n<svg>' }])
    // Within the pause: held, and carried by the next post.
    clock.now += DRAFTING_POST_EVERY_MS - 1
    f.onChunk(input('<rect/>'))
    expect(posts).toHaveLength(1)
    clock.now += 1
    f.onChunk(input('</svg>'))
    expect(posts[1]!.json.endsWith('<svg><rect/></svg>')).toBe(true)
    f.onChunk(input('\\n```"}'))
    f.onChunk({ kind: 'stop', stopReason: 'tool_use' })
    expect(posts[2]).toEqual({ call: 'call-0', json: '{"action":"send_message","body":"Look:\\n```svg\\n<svg><rect/></svg>\\n```"}', done: true })
    // The response's end after that says nothing twice.
    f.close()
    expect(posts).toHaveLength(3)
  })

  test('a fence split across two pieces is still found', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"body":"``'))
    f.onChunk(input('`sv'))
    f.onChunk(input('g\\n<svg>'))
    expect(posts).toHaveLength(1)
  })

  test('a message with no drawing, another tool, and a tool that only ends with the same name post nothing', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"action":"send_message","body":"Plain words."}'))
    f.onChunk(tool('Write', 1))
    f.onChunk(input('{"content":"```svg\\n<svg/>"}', 1))
    // Another server's tool of the same short name is not ours to read.
    f.onChunk(tool('mcp__other__plannotator_inbox', 2))
    f.onChunk(input('{"body":"```svg\\n<svg/>"}', 2))
    f.close()
    expect(posts).toEqual([])
  })

  test("thinking, the engine's own marks and another call's pieces between a call's pieces do not end it", () => {
    const { posts, clock, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"body":"```svg\\n<svg>'))
    f.onChunk({ kind: 'thinking', text: '…' })
    f.onChunk({ kind: 'engine', event: { type: 'ping' } })
    f.onChunk(input('{"x":1}', 7))
    expect(posts).toHaveLength(1)
    clock.now += DRAFTING_POST_EVERY_MS
    f.onChunk(input('<rect/>'))
    expect(posts.at(-1)).toEqual({ call: 'call-0', json: '{"body":"```svg\\n<svg><rect/>' })
  })

  test('a response cut off mid-call says the drawing was dropped, so no window waits for a message', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"body":"```svg\\n<svg>'))
    f.close()
    expect(posts.at(-1)).toEqual({ call: 'call-0', json: '{"body":"```svg\\n<svg>', done: true, dropped: true })
  })

  test('a drawing past the size limit is ended, not left open; a long one posts less often', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool(TOOL))
    f.onChunk(input('{"body":"```svg\\n<svg>'))
    f.onChunk(input('x'.repeat(DRAFTING_MAX_JSON)))
    expect(posts.at(-1)).toEqual({ call: 'call-0', json: '{"body":"```svg\\n<svg>', done: true })
    // Nothing more for that call.
    f.onChunk(input('more'))
    f.close()
    expect(posts).toHaveLength(2)
    expect(postEveryMs(1_000)).toBe(DRAFTING_POST_EVERY_MS)
    expect(postEveryMs(DRAFTING_MAX_JSON)).toBeGreaterThan(1000)
  })
})

describe('DraftingSender', () => {
  /** A send whose answers the test gives one at a time. */
  function held() {
    const sent: { post: DraftingPost; first: boolean; answer: (taken: boolean) => void }[] = []
    const sender = new DraftingSender((post, first) => new Promise<boolean>((answer) => sent.push({ post, first, answer })))
    return { sent, sender }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  test('one post at a time: while one is on its way only the newest waits, and done always goes', async () => {
    const { sent, sender } = held()
    sender.post({ call: 'a', json: '1' })
    sender.post({ call: 'a', json: '12' })
    sender.post({ call: 'a', json: '123' })
    sender.post({ call: 'a', json: '1234', done: true })
    // Still held behind the first: a hung Inbox never has more than one request open.
    expect(sent.map((s) => s.post.json)).toEqual(['1'])
    expect(sent[0]!.first).toBe(true)
    sent[0]!.answer(true)
    await tick()
    expect(sent.map((s) => s.post.json)).toEqual(['1', '1234'])
    expect(sent[1]!.post.done).toBe(true)
    expect(sent[1]!.first).toBe(false)
  })

  test('a call the Inbox did not take is given up; the next call starts afresh', async () => {
    const { sent, sender } = held()
    sender.post({ call: 'a', json: '1' })
    sender.post({ call: 'a', json: '12' })
    sent[0]!.answer(false)
    await tick()
    sender.post({ call: 'a', json: '123' })
    sender.post({ call: 'a', json: '1234', done: true })
    await tick()
    expect(sent).toHaveLength(1)
    sender.post({ call: 'b', json: '1' })
    await tick()
    expect(sent.map((s) => [s.post.call, s.first])).toEqual([
      ['a', true],
      ['b', true],
    ])
  })

  test('a send that throws counts as not taken and never stops the next call', async () => {
    let calls = 0
    const sender = new DraftingSender(async () => {
      calls += 1
      throw new Error('gone')
    })
    sender.post({ call: 'a', json: '1' })
    await tick()
    sender.post({ call: 'b', json: '1' })
    await tick()
    expect(calls).toBe(2)
  })
})
