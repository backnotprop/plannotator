/**
 * Read a streaming hook's response without changing it: every chunk from
 * beneath is shown to `onChunk` and yielded as it came, and the result from
 * beneath is returned. `onEnd` runs once, however the response ends.
 *
 * Why not a plain loop over `stream.next()`: when the consumer closes this
 * generator early (Esc, a hook above settled first, an error thrown in),
 * a plain loop leaves what is beneath suspended, its `finally` blocks never
 * run. `yield* next(e)` closes it; so does this.
 */
export async function* tapStream<C, R>(stream: AsyncGenerator<C, R>, onChunk: (chunk: C) => void, onEnd: () => void): AsyncGenerator<C, R> {
  let finished = false
  try {
    let step = await stream.next()
    while (!step.done) {
      onChunk(step.value)
      yield step.value
      step = await stream.next()
    }
    finished = true
    return step.value
  } finally {
    try {
      onEnd()
    } finally {
      if (!finished) await Promise.resolve(stream.return?.(undefined as R)).catch(() => undefined)
    }
  }
}
