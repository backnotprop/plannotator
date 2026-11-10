/**
 * The Inbox message the model is writing, sent on as it is written (live
 * drawings; packages/core/inbox-drafting.ts).
 *
 * `turn.step` hands every chunk of one model response to one `DraftingFeed`
 * (a new feed per response, so two responses never share a call). While the
 * model writes the arguments of the `plannotator_inbox` call and their text
 * has a ```svg fence in it, the JSON so far is posted, then once more marked
 * `done` when the arguments end, or `dropped` when the response ends before
 * they do (an abort). A call with no drawing posts nothing.
 *
 * `DraftingSender` carries the posts to the Inbox one at a time, never
 * awaited by the stream: each post holds everything so far, so while one is
 * on its way only the newest waits, and a call the Inbox did not take is not
 * posted again.
 */

/** The bridge event's `type` (packages/core/inbox-drafting.ts `INBOX_DRAFTING_EVENT_TYPE`). */
export const DRAFTING_EVENT_TYPE = 'drafting'
/** The least time between two posts of one call; a long message posts less often (`postEveryMs`). */
export const DRAFTING_POST_EVERY_MS = 100
/** Past this the call is left alone (the message still lands whole). */
export const DRAFTING_MAX_JSON = 256 * 1024
/** What marks a drawing in the JSON text: a fence's backticks need no escape there. */
const SVG_FENCE = '```svg'

/** Each post carries the whole text, so the pause grows with it: 100 ms up to 20,000 characters, 1.28 s at the cap. */
export function postEveryMs(length: number): number {
  return Math.max(DRAFTING_POST_EVERY_MS, Math.floor(length / 200))
}

export interface DraftingPost {
  call: string
  json: string
  done?: true
  /** With `done`: the response ended before the arguments did, so no message follows. */
  dropped?: true
}

interface OpenCall {
  index: number
  id: string
  json: string
  drawing: boolean
  postedAt: number
  posted: number
}

export class DraftingFeed {
  private open: OpenCall | null = null

  constructor(
    private readonly now: () => number,
    private readonly post: (body: DraftingPost) => void,
    /** The Inbox tool's name as the engine registered it: only its calls are read. */
    private readonly toolName: string,
  ) {}

  /** One chunk of the response, any kind. */
  onChunk(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return
    const { kind, index, id, name, json } = chunk as { kind?: unknown; index?: unknown; id?: unknown; name?: unknown; json?: unknown }
    if (kind === 'input') {
      if (this.open && index === this.open.index && typeof json === 'string') this.grow(this.open, json)
      return
    }
    // Thinking, and the engine's own marks (a block's start and end, a ping), do not end a call's arguments.
    if (kind === 'thinking' || kind === 'engine') return
    this.finish()
    if (kind === 'tool' && typeof index === 'number' && typeof id === 'string' && name === this.toolName) {
      this.open = { index, id, json: '', drawing: false, postedAt: 0, posted: 0 }
    }
  }

  /** The response is over, however it ended: a call still open was cut off. */
  close(): void {
    const call = this.open
    this.open = null
    if (call?.drawing) this.post({ call: call.id, json: call.json, done: true, dropped: true })
  }

  /** The open call's arguments are all in. */
  private finish(): void {
    const call = this.open
    this.open = null
    if (call?.drawing) this.post({ call: call.id, json: call.json, done: true })
  }

  private grow(call: OpenCall, piece: string): void {
    const before = call.json.length
    if (before + piece.length > DRAFTING_MAX_JSON) {
      // Too long to keep sending: the drawing stays as it was last sent until the message lands.
      this.open = null
      if (call.drawing) this.post({ call: call.id, json: call.json, done: true })
      return
    }
    call.json += piece
    if (!call.drawing) {
      // Only the new text, and the few characters a fence could straddle.
      if (call.json.indexOf(SVG_FENCE, Math.max(0, before - SVG_FENCE.length + 1)) < 0) return
      call.drawing = true
    }
    const now = this.now()
    if (now - call.postedAt < postEveryMs(call.json.length)) return
    call.postedAt = now
    call.posted = call.json.length
    this.post({ call: call.id, json: call.json })
  }
}

/** What a post came to: taken, or not (no Inbox, another server on its port, an Inbox that predates the event). */
export type DraftingSend = (post: DraftingPost, first: boolean) => Promise<boolean>

/**
 * Posts one at a time. While one is on its way, the newest post of each call
 * waits and older ones are forgotten (each holds everything so far); a
 * `done` is never forgotten. A call whose post was not taken is given up:
 * nothing more is sent for it. So a slow or stopped Inbox never has more
 * than one request of this open, and never more than one body per call held.
 */
export class DraftingSender {
  private waiting: DraftingPost[] = []
  private sending = false
  private started = new Set<string>()
  private givenUp = new Set<string>()

  constructor(private readonly send: DraftingSend) {}

  post(post: DraftingPost): void {
    if (this.givenUp.has(post.call)) {
      if (post.done) this.forget(post.call)
      return
    }
    this.waiting = this.waiting.filter((held) => held.call !== post.call || held.done)
    this.waiting.push(post)
    if (!this.sending) void this.drain()
  }

  private async drain(): Promise<void> {
    this.sending = true
    try {
      for (let post = this.waiting.shift(); post; post = this.waiting.shift()) {
        const first = !this.started.has(post.call)
        this.started.add(post.call)
        const taken = await this.send(post, first).catch(() => false)
        const call = post.call
        let ended = post.done === true
        if (!taken) {
          // Whatever waits for this call goes too; its `done` among them means the call is over.
          ended ||= this.waiting.some((held) => held.call === call && held.done)
          this.waiting = this.waiting.filter((held) => held.call !== call)
          if (!ended) this.givenUp.add(call)
        }
        if (ended) this.forget(call)
      }
    } finally {
      this.sending = false
    }
  }

  private forget(call: string): void {
    this.started.delete(call)
    this.givenUp.delete(call)
  }
}
