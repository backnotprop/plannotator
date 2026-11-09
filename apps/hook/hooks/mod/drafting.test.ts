import { describe, expect, test } from 'bun:test'
import { DRAFTING_POST_EVERY_MS, DraftingFeed, type DraftingPost } from './drafting'

function feed() {
  const posts: DraftingPost[] = []
  const clock = { now: 1000 }
  return { posts, clock, feed: new DraftingFeed(() => clock.now, (post) => posts.push(post)) }
}

const tool = (name: string, index = 0) => ({ kind: 'tool', index, id: `call-${index}`, name })
const input = (json: string, index = 0) => ({ kind: 'input', index, json })

describe('DraftingFeed', () => {
  test('an Inbox message with a drawing is posted as it grows, whole each time, then once more as done', () => {
    const { posts, clock, feed: f } = feed()
    f.onChunk(tool('mcp__plannotator__plannotator_inbox'))
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
    f.end()
    expect(posts).toHaveLength(3)
  })

  test('a message with no drawing, and another tool with one, post nothing', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool('plannotator_inbox'))
    f.onChunk(input('{"action":"send_message","body":"Plain words."}'))
    f.onChunk(tool('Write', 1))
    f.onChunk(input('{"content":"```svg\\n<svg/>"}', 1))
    f.end()
    expect(posts).toEqual([])
  })

  test('a response cut off mid-call still ends the drawing', () => {
    const { posts, feed: f } = feed()
    f.onChunk(tool('plannotator_inbox'))
    f.onChunk(input('{"body":"```svg\\n<svg>'))
    f.end()
    expect(posts.at(-1)).toEqual({ call: 'call-0', json: '{"body":"```svg\\n<svg>', done: true })
  })
})
