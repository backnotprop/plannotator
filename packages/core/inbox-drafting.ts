/**
 * A message an agent is still writing (prototype: live drawings).
 *
 * A host that sees a tool call's arguments as the model writes them (Claude
 * Code's `turn.step` `input` chunks) posts the JSON so far to the bridge's
 * event route as `{ type: "drafting", call, json, done? }`. The Inbox reads
 * the unfinished JSON here, and its windows draw the ```svg fences of the
 * unfinished body as they grow. Nothing is stored: the real message replaces
 * the drawing when the call lands.
 */

/** The bridge event's `type`. */
export const INBOX_DRAFTING_EVENT_TYPE = 'drafting'

/** The longest unfinished JSON the Inbox reads; a longer one is ignored (the message still lands whole). */
export const INBOX_DRAFTING_MAX_JSON = 512 * 1024

/**
 * What the windows' streams carry as `event: drafting`: the drawings of the
 * message so far, never its words (a message that is refused or stopped
 * before it lands leaves nothing but its drawing behind, and that goes too).
 */
export interface InboxDraftingFrame {
  /** The tool call's id: one draft per call. */
  call: string
  session: string
  thread_id: string
  /** The ```svg fences of the body so far, in order. */
  drawings: LiveSvgFence[]
  /** The call's arguments are all in: the real message is about to land. */
  done: boolean
  /** With `done`: the response ended first, so no message follows and the draft goes at once. */
  dropped: boolean
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/**
 * The string at `text[start]` (its opening quote), unescaped, as far as it is
 * written: an escape cut short at the end is left out. `end` is the index
 * past its closing quote, or -1 while the string is still open.
 */
function readString(text: string, start: number): { value: string; end: number } {
  let value = ''
  let i = start + 1
  while (i < text.length) {
    const char = text[i]!
    if (char === '"') return { value, end: i + 1 }
    if (char !== '\\') {
      value += char
      i += 1
      continue
    }
    const next = text[i + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6)
      if (hex.length < 4) break
      const code = /^[0-9a-fA-F]{4}$/.test(hex) ? parseInt(hex, 16) : null
      // Half of a pair whose other half has not come yet is left out, with the rest: it would draw as a broken mark.
      if (code !== null && code >= 0xd800 && code <= 0xdbff && text.length < i + 12) break
      value += code === null ? '' : String.fromCharCode(code)
      i += 6
      continue
    }
    value += ESCAPES[next] ?? next
    i += 2
  }
  return { value, end: -1 }
}

/**
 * The top-level string fields of an unfinished JSON object, as far as each
 * is written. A field whose value is no string is skipped; text that is no
 * object gives nothing. Never throws.
 */
export function partialJsonStringFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let i = text.indexOf('{')
  if (i < 0) return fields
  i += 1
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i += 1
    if (text[i] !== '"') break
    const key = readString(text, i)
    if (key.end < 0) break
    i = key.end
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (text[i] !== ':') break
    i += 1
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (i >= text.length) break
    if (text[i] === '"') {
      const value = readString(text, i)
      fields[key.value] = value.value
      if (value.end < 0) break
      i = value.end
      continue
    }
    // Any other value: step over it, minding the strings and brackets inside.
    let depth = 0
    let ended = false
    while (i < text.length) {
      const char = text[i]!
      if (char === '"') {
        const inner = readString(text, i)
        if (inner.end < 0) return fields
        i = inner.end
        continue
      }
      if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        if (depth === 0) return fields
        depth -= 1
      } else if (char === ',' && depth === 0) {
        ended = true
        break
      }
      i += 1
    }
    if (!ended) break
  }
  return fields
}

/** One ```svg fence of an unfinished body: its markup so far. */
export interface LiveSvgFence {
  source: string
  /** Its closing fence is written. */
  closed: boolean
}

/** The ```svg fences of a body that may stop anywhere, in order. */
export function liveSvgFences(body: string): LiveSvgFence[] {
  const fences: LiveSvgFence[] = []
  const lines = body.split('\n')
  let open: { mark: string; lines: string[] } | null = null
  for (const line of lines) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (close && close[1]![0] === open.mark[0] && close[1]!.length >= open.mark.length) {
        fences.push({ source: open.lines.join('\n'), closed: true })
        open = null
      } else open.lines.push(line)
      continue
    }
    const start = /^ {0,3}(`{3,}|~{3,})\s*svg\s*$/i.exec(line)
    if (start) open = { mark: start[1]!, lines: [] }
  }
  if (open) {
    // The last line may be the closing fence half written: never drawn as markup.
    const last = open.lines[open.lines.length - 1]
    if (last !== undefined && /^ {0,3}[`~]+$/.test(last)) open.lines.pop()
    fences.push({ source: open.lines.join('\n'), closed: false })
  }
  return fences
}
