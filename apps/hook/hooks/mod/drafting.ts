/**
 * The Inbox message the model is writing, sent on as it is written
 * (prototype: live drawings; packages/core/inbox-drafting.ts).
 *
 * `turn.step` hands every chunk of the model's response here. While the
 * model writes the arguments of a `plannotator_inbox` call whose text has a
 * ```svg fence in it, the JSON so far goes to the Inbox a few times a second,
 * and once more, marked done, when the arguments end. A call with no drawing
 * sends nothing. Each post carries everything so far, so a lost one costs
 * nothing, and none is waited for: the model's stream is never slowed.
 */

/** The bridge event's `type` (packages/core/inbox-drafting.ts `INBOX_DRAFTING_EVENT_TYPE`). */
export const DRAFTING_EVENT_TYPE = 'drafting'
/** The least time between two posts of one call. */
export const DRAFTING_POST_EVERY_MS = 100
/** Past this the call is left alone (the message still lands whole). */
export const DRAFTING_MAX_JSON = 256 * 1024
/** What marks a drawing in the JSON text: a fence's backticks need no escape there. */
const SVG_FENCE = '```svg'

export interface DraftingPost {
  call: string
  json: string
  done?: true
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
  ) {}

  /** One chunk of a `turn.step` response, any kind. */
  onChunk(chunk: unknown): void {
    if (!chunk || typeof chunk !== 'object') return
    const { kind, index, id, name, json } = chunk as { kind?: unknown; index?: unknown; id?: unknown; name?: unknown; json?: unknown }
    if (kind === 'input' && this.open && index === this.open.index && typeof json === 'string') {
      this.grow(this.open, json)
      return
    }
    // Thinking between a call's pieces does not end it; anything else does.
    if (kind === 'thinking' || kind === 'input') return
    this.end()
    if (kind === 'tool' && typeof index === 'number' && typeof id === 'string' && typeof name === 'string' && /(^|__)plannotator_inbox$/.test(name)) {
      this.open = { index, id, json: '', drawing: false, postedAt: 0, posted: 0 }
    }
  }

  /** The response is over, however it ended. */
  end(): void {
    const call = this.open
    this.open = null
    if (call?.drawing) this.post({ call: call.id, json: call.json, done: true })
  }

  private grow(call: OpenCall, piece: string): void {
    call.json += piece
    if (call.json.length > DRAFTING_MAX_JSON) {
      this.open = null
      return
    }
    if (!call.drawing) {
      if (!call.json.includes(SVG_FENCE)) return
      call.drawing = true
    }
    const now = this.now()
    if (call.json.length === call.posted || now - call.postedAt < DRAFTING_POST_EVERY_MS) return
    call.postedAt = now
    call.posted = call.json.length
    this.post({ call: call.id, json: call.json })
  }
}
