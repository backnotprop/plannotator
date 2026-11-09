/**
 * `tapStream` against `yield*`, the pass-through it replaces in `turn.step`:
 * the same chunks, the same result, the same error, and the same closing of
 * what is beneath when the consumer stops early. If the last one fails, a
 * response the person stops (Esc) leaves the hooks and the model request
 * beneath the mod open.
 */
import { describe, expect, test } from 'bun:test'
import { tapStream } from './stream'

function beneath(options: { failAt?: number } = {}) {
  const seen = { closed: 0, ended: 0 }
  async function* run(): AsyncGenerator<number, string> {
    try {
      for (let n = 0; n < 4; n++) {
        if (options.failAt === n) throw new Error('the request failed')
        yield n
      }
      seen.ended += 1
      return 'result'
    } finally {
      seen.closed += 1
    }
  }
  return { seen, stream: run() }
}

async function* passThrough(stream: AsyncGenerator<number, string>): AsyncGenerator<number, string> {
  return yield* stream
}

const WAYS = [
  ['yield*', (stream: AsyncGenerator<number, string>, tapped: number[], ends: { n: number }) => passThrough(stream)],
  ['tapStream', (stream: AsyncGenerator<number, string>, tapped: number[], ends: { n: number }) => tapStream(stream, (c) => void tapped.push(c), () => void (ends.n += 1))],
] as const

describe.each(WAYS)('%s', (name, wrap) => {
  test('every chunk and the result come through', async () => {
    const b = beneath()
    const tapped: number[] = []
    const ends = { n: 0 }
    const out: number[] = []
    const stream = wrap(b.stream, tapped, ends)
    let step = await stream.next()
    for (; !step.done; step = await stream.next()) out.push(step.value)
    expect(out).toEqual([0, 1, 2, 3])
    expect(step.value).toBe('result')
    expect(b.seen).toEqual({ closed: 1, ended: 1 })
    if (name === 'tapStream') expect([tapped, ends.n]).toEqual([[0, 1, 2, 3], 1])
  })

  test('closed early by the consumer: what is beneath is closed too', async () => {
    const b = beneath()
    const ends = { n: 0 }
    const stream = wrap(b.stream, [], ends)
    await stream.next()
    await stream.next()
    expect(await stream.return('stopped')).toEqual({ value: 'stopped', done: true })
    expect(b.seen).toEqual({ closed: 1, ended: 0 })
    if (name === 'tapStream') expect(ends.n).toBe(1)
  })

  test('an error thrown in by the consumer closes what is beneath and comes back out', async () => {
    const b = beneath()
    const stream = wrap(b.stream, [], { n: 0 })
    await stream.next()
    await expect(stream.throw(new Error('aborted'))).rejects.toThrow('aborted')
    expect(b.seen).toEqual({ closed: 1, ended: 0 })
  })

  test('an error from beneath comes out unchanged, after the chunks before it', async () => {
    const b = beneath({ failAt: 2 })
    const ends = { n: 0 }
    const out: number[] = []
    const stream = wrap(b.stream, [], ends)
    await expect(
      (async () => {
        for await (const chunk of stream) out.push(chunk)
      })(),
    ).rejects.toThrow('the request failed')
    expect(out).toEqual([0, 1])
    if (name === 'tapStream') expect(ends.n).toBe(1)
  })
})

test('a tap that throws does not go unnoticed: the caller wraps what may throw', async () => {
  const b = beneath()
  const stream = tapStream(b.stream, () => {
    throw new Error('tap')
  }, () => undefined)
  await expect(stream.next()).rejects.toThrow('tap')
  // And still nothing beneath is left open.
  expect(b.seen.closed).toBe(1)
})
