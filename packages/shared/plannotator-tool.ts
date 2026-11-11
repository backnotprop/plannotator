/**
 * The `plannotator` agent tool contract: the one tool every host that can deliver a reviewer's decision later registers, so an agent returns at once instead of blocking on the CLI.
 * Everything below the CONTRACT marker is copied byte for byte into apps/hook/hooks/mod/tool.ts: keep it pure and dependency-free.
 */

// --- CONTRACT (copied verbatim into apps/hook/hooks/mod/tool.ts) ---

export const PLANNOTATOR_TOOL_NAME = 'plannotator'

export type PlannotatorToolAction = 'annotate' | 'review' | 'last' | 'list' | 'close'

export type PlannotatorToolOpenAction = 'annotate' | 'review' | 'last'

export interface PlannotatorToolInput {
  action: PlannotatorToolAction
  /** annotate: one file, folder or URL, or several files as a list in read order (a one-item list is returned as a string, duplicates dropped). review: a directory or PR URL (string only). */
  target?: string | string[]
  gate?: boolean
  options?: { base?: string; markdown?: boolean }
  tailscale?: boolean
  session?: string
}

export const PLANNOTATOR_TOOL_DESCRIPTION = [
  'Open Plannotator, the browser review UI, for the user, and return at once. Also lists and closes the reviews opened in this conversation (by this tool or the user\'s /plannotator-* commands).',
  '- action "annotate": annotate a file (markdown, text, config, HTML), a folder, or a URL; `target` is required. Pass a list as `target` to review several files together, in the order you want them read. `gate: true` adds an Approve button for an explicit sign-off. `options.markdown: true` converts HTML or a URL to markdown first.',
  '- action "review": review code changes; `target` is an optional repository directory or a GitHub/GitLab/Bitbucket pull request URL (default: the current repository). `options.base` sets the compare branch or ref (git only). `gate: true` when you wait for the sign-off: a bare Approve reaches you too.',
  '- action "last": annotate your own last assistant message; no target.',
  '- action "list": the reviews opened in this conversation that are still open, one line each: session id, what it shows, url, age, state, and how many comments the reviewer has not sent yet.',
  '- action "close": close a review opened in this conversation that is no longer needed; `session` is its id (pn-...) or "all". Nothing is sent to you, and the reviewer\'s unsent comments stay saved as a draft. Plan reviews are not closed this way: they end with the reviewer\'s decision.',
  'Opening only opens the page and names its session id (pn-...). The reviewer\'s feedback arrives later as a message in this conversation that names the same id, so end your turn after opening and wait for it. Use this tool instead of running the `plannotator` CLI. Plan review is not done with this tool: it opens by itself when you exit plan mode.',
].join('\n')

export const PLANNOTATOR_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['annotate', 'review', 'last', 'list', 'close'],
      description: 'What to do: open a file/folder/URL to annotate, code changes or a PR to review, or your last message; list your open reviews; close one.',
    },
    target: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
      description: 'annotate: the file, folder or URL (required), or a list of file paths to review together in that order. review: a repository directory or PR URL (optional). Other actions: not used.',
    },
    gate: {
      type: 'boolean',
      description: 'annotate: add an Approve button for an explicit sign-off. review: deliver a bare Approve too.',
    },
    options: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'review only: the branch or ref to compare against (git).' },
        markdown: { type: 'boolean', description: 'annotate only: convert an HTML file or URL to markdown before annotating.' },
      },
      additionalProperties: false,
    },
    session: {
      type: 'string',
      description: 'close: the session id (pn-...) of a review opened in this conversation, or "all".',
    },
  },
  required: ['action'],
  additionalProperties: false,
} as const

export const PLANNOTATOR_TOOL_TAILSCALE_LINE =
  '- `tailscale: true` (annotate, review, last): serve the page over the user\'s tailnet (HTTPS, never public) for their phone or another device; "Ask this session" works there for this computer\'s owner. Only when the user asks for that.'

export const PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION = (() => {
  const lines = PLANNOTATOR_TOOL_DESCRIPTION.split('\n')
  const lastAction = lines.findIndex((line) => line.startsWith('- action "close"'))
  return [...lines.slice(0, lastAction + 1), PLANNOTATOR_TOOL_TAILSCALE_LINE, ...lines.slice(lastAction + 1)].join('\n')
})()

export const PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA = {
  ...PLANNOTATOR_TOOL_INPUT_SCHEMA,
  properties: {
    ...PLANNOTATOR_TOOL_INPUT_SCHEMA.properties,
    tailscale: {
      type: 'boolean',
      description: 'annotate, review, last: serve the page over the user\'s tailnet (HTTPS, never public), to open on another device. "Ask this session" works there for the computer owner\'s Tailscale login.',
    },
  },
} as const

export interface PlannotatorToolParseOptions {
  tailscale?: boolean
}

/** What a host answers a `tailscale` call with when its CLI cannot serve it. */
export const PLANNOTATOR_TOOL_TAILSCALE_UNAVAILABLE_TEXT =
  'Plannotator did not open: the installed Plannotator is too old to open a review over the tailnet from this tool. Ask the user to update Plannotator (`plannotator update`), or open it without `tailscale` for now.'

/** True for an OLDER CLI's refusal of the `--tailscale` flag itself; a current CLI's publish failure starts with `--tailscale:` and is shown as is. */
export function isOlderCliTailscaleRefusal(errorText: string): boolean {
  if (errorText.includes('--tailscale:')) return false
  return (
    /File not found: [^\n]*--tailscale/.test(errorText) ||
    errorText.includes('--tailscale is only supported with') ||
    /(?:unknown|unrecognized|unexpected) (?:option|flag|argument)[^\n]*--tailscale/i.test(errorText)
  )
}

export const PLANNOTATOR_TOOL_MAX_TEXT = 4096

/** `pn-` and six lowercase hex digits; hosts resolve an id only among the reviews their own agent session opened. */
export const PLANNOTATOR_SESSION_ID_PREFIX = 'pn-'

const SESSION_ID = /^(?:pn-)?([0-9a-f]{6})$/i

export function normalizePlannotatorSessionId(value: string): string | null {
  const match = SESSION_ID.exec(value.trim())
  return match ? `${PLANNOTATOR_SESSION_ID_PREFIX}${(match[1] as string).toLowerCase()}` : null
}

export function plannotatorSessionId(hex6: string): string {
  return `${PLANNOTATOR_SESSION_ID_PREFIX}${hex6.toLowerCase()}`
}

const TOOL_KEYS = ['action', 'target', 'gate', 'options', 'session']
const OPTION_KEYS = ['base', 'markdown']
const ACTIONS: readonly PlannotatorToolAction[] = ['annotate', 'review', 'last', 'list', 'close']

export type PlannotatorToolParse = { ok: true; input: PlannotatorToolInput } | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkWord(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${name} must be a string`
  if (value.trim() === '') return `${name} must not be empty`
  if (value.length > PLANNOTATOR_TOOL_MAX_TEXT) return `${name} is longer than ${PLANNOTATOR_TOOL_MAX_TEXT} characters`
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} must not contain control characters or line breaks`
  if (value.trim().startsWith('-')) return `${name} must not start with "-"`
  return null
}

export function isPlannotatorToolOpenAction(action: PlannotatorToolAction): action is PlannotatorToolOpenAction {
  return action === 'annotate' || action === 'review' || action === 'last'
}

/** An optional field a model sent empty (`null`, `""`, `[]`, `{}`) is read as absent: providers with strict schemas (GitHub Copilot's Responses models) fill every property. A required field stays required. */
function isEmptyOptional(value: unknown): boolean {
  if (value === null || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  return isRecord(value) && Object.keys(value).length === 0
}

function withoutEmptyOptionals(value: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (!isEmptyOptional(member)) kept[key] = member
  }
  return kept
}

/** Validates strictly: unknown keys, wrong types and fields the action does not take are errors; a `false` the action ignores is allowed. The error text is for the model. */
export function parsePlannotatorToolInput(value: unknown, parseOptions: PlannotatorToolParseOptions = {}): PlannotatorToolParse {
  const fail = (error: string): PlannotatorToolParse => ({ ok: false, error: `Invalid plannotator call: ${error}.` })
  if (!isRecord(value)) return fail('the input must be an object')
  for (const key of Object.keys(value)) {
    if (!TOOL_KEYS.includes(key) && !(key === 'tailscale' && parseOptions.tailscale === true)) return fail(`unknown field "${key}"`)
  }
  const action = value.action
  if (typeof action !== 'string' || !ACTIONS.includes(action as PlannotatorToolAction)) {
    return fail('action must be "annotate", "review", "last", "list" or "close"')
  }
  const fields = withoutEmptyOptionals(value)
  if (isRecord(fields.options)) {
    for (const key of Object.keys(fields.options)) {
      if (!OPTION_KEYS.includes(key)) return fail(`unknown option "${key}"`)
    }
    const options = withoutEmptyOptionals(fields.options)
    if (isEmptyOptional(options)) delete fields.options
    else fields.options = options
  }
  const input: PlannotatorToolInput = { action: action as PlannotatorToolAction }
  const opens = isPlannotatorToolOpenAction(input.action)

  if (fields.target !== undefined) {
    if (!opens || action === 'last') return fail(`action "${action}" takes no target`)
    if (Array.isArray(fields.target)) {
      if (action !== 'annotate') return fail('a list of targets is for action "annotate" only')
      const targets: string[] = []
      for (const [index, item] of fields.target.entries()) {
        const problem = checkWord(`target[${index}]`, item)
        if (problem) return fail(problem)
        const trimmed = (item as string).trim()
        if (!targets.includes(trimmed)) targets.push(trimmed)
      }
      input.target = targets.length === 1 ? targets[0] : targets
    } else {
      const problem = checkWord('target', fields.target)
      if (problem) return fail(problem)
      input.target = (fields.target as string).trim()
    }
  } else if (action === 'annotate') {
    return fail('action "annotate" needs a target (a file, folder or URL)')
  }

  if (fields.gate !== undefined) {
    if (typeof fields.gate !== 'boolean') return fail('gate must be true or false')
    if (fields.gate && action !== 'annotate' && action !== 'review') return fail('gate is for actions "annotate" and "review" only')
    if (fields.gate) input.gate = true
  }

  if (fields.tailscale !== undefined) {
    if (typeof fields.tailscale !== 'boolean') return fail('tailscale must be true or false')
    if (fields.tailscale && !opens) return fail('tailscale is for actions "annotate", "review" and "last" only')
    if (fields.tailscale) input.tailscale = true
  }

  if (fields.options !== undefined) {
    const options = fields.options
    if (!isRecord(options)) return fail('options must be an object')
    const parsed: NonNullable<PlannotatorToolInput['options']> = {}
    if (options.base !== undefined) {
      if (action !== 'review') return fail('options.base is for action "review" only')
      const problem = checkWord('options.base', options.base)
      if (problem) return fail(problem)
      if (/\s/.test((options.base as string).trim())) return fail('options.base must not contain spaces')
      parsed.base = (options.base as string).trim()
    }
    if (options.markdown !== undefined) {
      if (typeof options.markdown !== 'boolean') return fail('options.markdown must be true or false')
      if (options.markdown && action !== 'annotate') return fail('options.markdown is for action "annotate" only')
      if (options.markdown) parsed.markdown = true
    }
    if (Object.keys(parsed).length > 0) input.options = parsed
  }

  if (fields.session !== undefined) {
    if (action !== 'close') return fail('session is for action "close" only')
    if (typeof fields.session !== 'string') return fail('session must be a string')
    if (action === 'close' && fields.session.trim().toLowerCase() === 'all') {
      input.session = 'all'
    } else {
      const id = normalizePlannotatorSessionId(fields.session)
      if (!id) return fail('session must be a session id such as "pn-3f2a9c" or "all"')
      input.session = id
    }
  } else if (action === 'close') {
    return fail('action "close" needs a session (the pn-... id a result named, or "all")')
  }

  return { ok: true, input }
}

export function plannotatorToolTargets(input: PlannotatorToolInput): string[] {
  if (input.target === undefined) return []
  return Array.isArray(input.target) ? [...input.target] : [input.target]
}

/** The arguments the matching slash command would carry, one per element, never re-split. A list of annotate targets passes a bare word as `./word`. */
export function plannotatorToolArgs(input: PlannotatorToolInput): string[] {
  switch (input.action) {
    case 'annotate':
      return [
        // A list is files named by paths: a bare word becomes `./word`, so the CLI refuses a missing file instead of reading it as prose.
        ...(Array.isArray(input.target)
          ? input.target.map((target) => (looksLikeFilePath(target) || /^https?:\/\//i.test(target) ? target : `./${target}`))
          : plannotatorToolTargets(input)),
        ...(input.gate ? ['--gate'] : []),
        ...(input.options?.markdown ? ['--markdown'] : []),
        ...(input.tailscale ? ['--tailscale'] : []),
      ]
    case 'review':
      // A review's `gate` is the host's alone, never passed on: the page always has Approve, and a CLI older than `review --gate` refuses the flag.
      return [
        ...(input.options?.base ? ['--base', input.options.base] : []),
        ...(input.tailscale ? ['--tailscale'] : []),
        ...plannotatorToolTargets(input),
      ]
    case 'last':
      return input.tailscale ? ['--tailscale'] : []
    case 'list':
    case 'close':
      return []
  }
}

/** What a review is OF, in full, taken from the server that shows it and never guessed from the agent's words: two files can share a name. */
export type PlannotatorTarget = string | readonly string[]

/** The line(s) naming a review's full target (`Target:`, or `Targets:` with a `- path` line each); empty for no target. */
export function plannotatorTargetLines(target: PlannotatorTarget | undefined): string {
  if (target === undefined) return ''
  if (typeof target === 'string') return target.trim() ? `Target: ${target}` : ''
  const paths = target.filter((path) => path.trim() !== '')
  if (paths.length === 0) return ''
  if (paths.length === 1) return `Target: ${paths[0]}`
  return ['Targets:', ...paths.map((path) => `- ${path}`)].join('\n')
}

/** How a tailnet session answers Ask AI: `ask` is true when it answers for the machine owner's Tailscale login. */
export interface PlannotatorTailnetOpen {
  ask: boolean
}

export function plannotatorTailnetOpenedLine(tailnet: PlannotatorTailnetOpen): string {
  return tailnet.ask
    ? 'It is served over the user\'s tailnet (HTTPS, never public): they open the URL on their phone or another device. "Ask this session" answers there only for the Tailscale login that owns this computer.'
    : 'It is served over the user\'s tailnet (HTTPS, never public): they open the URL on their phone or another device. "Ask this session" is not available on the other device for this review.'
}

/** The tool's result once the session is open (`url`) or still starting (no url). */
export function plannotatorToolOpenedText(
  subject: string,
  url: string | undefined,
  gate: boolean,
  sessionId?: string,
  target?: PlannotatorTarget,
  tailnet?: PlannotatorTailnetOpen,
): string {
  const where = url ? `Opened ${subject} in Plannotator: ${url}` : `Plannotator is starting for ${subject}; it opens in the browser when ready.`
  const outcome = gate
    ? 'If they approve, an approval message arrives; if they send annotations, the feedback arrives. Closing it sends nothing.'
    : 'When they send annotations, the feedback arrives. Closing it with nothing to send sends nothing.'
  const targetLines = plannotatorTargetLines(target)
  return [
    ...(sessionId ? [`Session: ${sessionId}`] : []),
    ...(targetLines ? [targetLines] : []),
    where,
    ...(tailnet ? [plannotatorTailnetOpenedLine(tailnet)] : []),
    'The reviewer is looking at it now. End your turn now and wait: their decision arrives later as a message in this conversation that starts with "Plannotator:".',
    outcome,
    'Do not poll, reopen it, or run the plannotator CLI for this session.',
  ].join('\n')
}

/** The outcome named for a code review posted straight to the PR platform. */
export const PLANNOTATOR_OUTCOME_REVIEW_POSTED = 'Review posted'

/** First line of every decision message: what was reviewed, its session id and the outcome, followed by the `Target:` line(s) when a `target` is given. */
export function plannotatorDecisionHeading(
  subject: string,
  sessionId: string | undefined,
  outcome: string,
  target?: PlannotatorTarget,
): string {
  const heading = `Plannotator: ${subject}${sessionId ? ` (${sessionId})` : ''} — ${outcome}.`
  const targetLines = plannotatorTargetLines(target)
  return targetLines ? `${heading}\n${targetLines}` : heading
}

const PR_URL_PATTERN = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i

export function plannotatorPrSubject(target: PlannotatorTarget | undefined): string | null {
  if (typeof target !== 'string') return null
  const match = PR_URL_PATTERN.exec(target)
  if (!match) return null
  return /merge_requests/i.test(target) ? `MR !${match[1]}` : `PR #${match[1]}`
}

/** The launch's subject, unless the decision is about a different PR than the launch opened (the reviewer switched PRs). */
export function plannotatorDecisionSubject(
  subject: string,
  launchTarget: PlannotatorTarget | undefined,
  decisionTarget: PlannotatorTarget | undefined,
): string {
  if (decisionTarget === undefined || plannotatorSameTarget(launchTarget, decisionTarget)) return subject
  return plannotatorPrSubject(decisionTarget) ?? subject
}

function targetEntries(target: PlannotatorTarget): string[] {
  return (typeof target === 'string' ? [target] : [...target]).map((value) => value.trim().replace(/[\\/]+$/, ''))
}

export function plannotatorSameTarget(a: PlannotatorTarget | undefined, b: PlannotatorTarget | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const left = targetEntries(a)
  const right = targetEntries(b)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '')
}

/** Subjects that tell open reviews apart: equal subjects with different paths get the shortest trailing path part (two segments at least) that none of the others shares. Other subjects are returned as is. */
export function plannotatorDistinctSubjects(
  reviews: readonly { subject: string; target?: PlannotatorTarget }[],
): string[] {
  const subjects = reviews.map((review) => review.subject)
  const groups = new Map<string, number[]>()
  reviews.forEach((review, index) => {
    if (typeof review.target !== 'string' || /^https?:\/\//i.test(review.target)) return
    const group = groups.get(review.subject) ?? []
    group.push(index)
    groups.set(review.subject, group)
  })
  for (const [subject, members] of groups) {
    const paths = members.map((index) => pathSegments(targetEntries(reviews[index]?.target as string)[0] as string))
    const joined = paths.map((segments) => segments.join('/'))
    if (new Set(joined).size < 2) continue
    const tail = (segments: readonly string[], depth: number) => segments.slice(-depth).join('/')
    members.forEach((index, position) => {
      const segments = paths[position] as string[]
      const last = segments[segments.length - 1]
      if (!last || !subject.endsWith(last)) return
      let depth = 2
      while (
        depth < segments.length &&
        paths.some((other, at) => joined[at] !== joined[position] && tail(other, depth) === tail(segments, depth))
      ) {
        depth += 1
      }
      subjects[index] = `${subject.slice(0, subject.length - last.length)}${tail(segments, depth)}`
    })
  }
  return subjects
}

export const PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT =
  'Plannotator did not open: the installed Plannotator is too old to open several files at once. Ask the user to update Plannotator to open several files at once, or open them one at a time for now.'

/** The line a bundle-capable CLI adds to its "Ambiguous annotate arguments" error (`ANNOTATE_BUNDLE_HINT` in annotate-target.ts; copied because this section must stay dependency-free). */
export const PLANNOTATOR_BUNDLE_HINT_LINE =
  'To review several files together, pass only their paths: plannotator annotate a.md b.html'

/** True for an OLDER CLI's refusal of several file paths: its ambiguity error without the bundle hint. */
export function isOlderCliBundleRefusal(errorText: string): boolean {
  return errorText.includes('Ambiguous annotate arguments:') && !errorText.includes(PLANNOTATOR_BUNDLE_HINT_LINE)
}

function fileNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

/** Name of a multi-file review: up to three file names, then a count of the rest ("5 files: a.md, b.md, c.md +2 more"). */
export function plannotatorBundleSubject(paths: readonly string[]): string {
  const names = paths.map(fileNameOf)
  const rest = names.length - 3
  return `${names.length} files: ${names.slice(0, 3).join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
}

/** A subject from the target the CLI reports it opened, or null when it names nothing usable. Typed words are not trusted when a target is known: the CLI ignores a stray `.` or prose beside a file. */
export function plannotatorTargetSubject(kind: 'annotate' | 'review', target: PlannotatorTarget | undefined): string | null {
  if (target === undefined) return null
  const entries = (typeof target === 'string' ? [target] : [...target]).filter((entry) => entry.trim() !== '')
  if (entries.length === 0) return null
  if (kind === 'annotate' && entries.length > 1) return plannotatorBundleSubject(entries)
  if (entries.length !== 1) return null
  const only = entries[0] as string
  if (kind === 'review') {
    const pr = plannotatorPrSubject(only)
    if (pr) return pr
    if (/^https?:\/\//i.test(only)) return null
    const name = fileNameOf(only)
    return name ? `changes in ${name}` : null
  }
  if (/^https?:\/\//i.test(only)) {
    try {
      return new URL(only).host || only
    } catch {
      return only
    }
  }
  return fileNameOf(only) || null
}

/** Whether a shell word reads as a file path rather than prose (a separator, a leading `~`, `.` or `@`, or an extension; a URL is not). Nothing is looked up on disk. */
export function looksLikeFilePath(word: string): boolean {
  if (/^https?:\/\//i.test(word)) return false
  if (/[\\/]/.test(word) || /^[~.@]/.test(word)) return true
  return /\.[A-Za-z0-9]{1,12}$/.test(word)
}

export interface PlannotatorSessionSummary {
  id: string
  kind: 'plan' | 'annotate' | 'review' | 'last'
  subject: string
  url?: string
  ageMs: number
  /** starting: the server is not up yet. open: waiting for the reviewer. decided: the reviewer decided and it is closing. */
  state: 'starting' | 'open' | 'decided'
  /** Comments the reviewer wrote and has not sent; null when the server cannot say (an older Plannotator). */
  unsent: number | null
}

function ageText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} days`
}

export function plannotatorToolListText(sessions: readonly PlannotatorSessionSummary[]): string {
  if (sessions.length === 0) return 'No open Plannotator reviews from this conversation.'
  const lines = sessions.map((session) =>
    [
      session.id,
      session.kind,
      session.subject,
      session.url ?? 'no url yet',
      ageText(session.ageMs),
      session.state,
      `unsent: ${session.unsent === null ? 'unknown' : session.unsent}`,
    ].join(' · '),
  )
  const plans = sessions.some((session) => session.kind === 'plan')
  return [
    `${sessions.length} open Plannotator ${sessions.length === 1 ? 'review' : 'reviews'} from this conversation:`,
    ...lines,
    plans
      ? 'Close one you no longer need with action "close" and its session id. Plan reviews close only with the reviewer\'s decision.'
      : 'Close one you no longer need with action "close" and its session id.',
  ].join('\n')
}

export type PlannotatorCloseOutcome =
  | { id: string; subject: string; closed: true; unsent: number | null }
  | { id: string; subject: string; closed: false; reason: 'plan' | 'decided' | 'failed'; detail?: string }

function savedText(unsent: number | null): string {
  if (unsent === null) return 'any unsent comments stay saved as a draft'
  if (unsent === 0) return 'no unsent comments'
  return `${unsent} unsent ${unsent === 1 ? 'comment' : 'comments'} saved as a draft`
}

/** `close`'s result. Nothing is sent to the agent later for a review it closed. */
export function plannotatorToolCloseText(outcomes: readonly PlannotatorCloseOutcome[]): string {
  if (outcomes.length === 0) return 'No open Plannotator reviews from this conversation to close.'
  const lines = outcomes.map((outcome) => {
    if (outcome.closed) return `Closed ${outcome.subject} (${outcome.id}): ${savedText(outcome.unsent)}.`
    switch (outcome.reason) {
      case 'plan':
        return `Not closed: ${outcome.subject} (${outcome.id}) is a plan review; it ends with the reviewer's decision.`
      case 'decided':
        return `Not closed: ${outcome.subject} (${outcome.id}) was already decided; its decision arrives as a message.`
      case 'failed':
        return `Could not close ${outcome.subject} (${outcome.id})${outcome.detail ? `: ${outcome.detail}` : ''}.`
    }
  })
  const closedAny = outcomes.some((outcome) => outcome.closed)
  return closedAny ? [...lines, 'Nothing more arrives for a review you closed.'].join('\n') : lines.join('\n')
}

export function plannotatorUnknownSessionText(id: string): string {
  return `No open Plannotator review ${id} from this conversation. Call the plannotator tool with action "list" to see yours.`
}

/**
 * The words of `command` when it is ONE simple command a shell would run without interpreting anything; null otherwise.
 * Quoting follows `splitShellWords`, but where that splitter tolerates, this refuses (operators, expansions, globs, comments, unterminated quotes).
 */
export function simpleShellCommandWords(command: string): string[] | null {
  const input = command.trim()
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | null = null

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string

    if (quote === "'") {
      if (char === "'") quote = null
      else word += char
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null
      } else if (char === '\\' && index + 1 < input.length && '"\\$`'.includes(input[index + 1] as string)) {
        word += input[index + 1]
        index += 1
      } else if (char === '$' || char === '`') {
        return null
      } else {
        word += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      inWord = true
      continue
    }

    if (char === '\\' && index + 1 < input.length) {
      // A backslash before a line break joins lines: not one simple word.
      if (input[index + 1] === '\n' || input[index + 1] === '\r') return null
      word += input[index + 1]
      inWord = true
      index += 1
      continue
    }

    if (char === '\n' || char === '\r') return null

    if (/\s/.test(char)) {
      if (inWord) {
        words.push(word)
        word = ''
        inWord = false
      }
      continue
    }

    if (';&|<>()$`*?[{}'.includes(char)) return null
    if (!inWord && char === '#') return null
    if (!inWord && char === '~') {
      const after = input[index + 1]
      if (after !== undefined && after !== '/' && !/\s/.test(after)) return null
    }

    word += char
    inWord = true
  }

  if (quote) return null
  if (inWord) words.push(word)
  return words
}

/** Annotate flags for a script that reads the CLI's own channels (exit code, stdout record, hook output). A detached host has no such reader, so it refuses them and leaves a command carrying one to run as written. */
export const SCRIPT_ONLY_ANNOTATE_FLAGS: readonly string[] = ['--require-approval', '--result-file', '--hook']

export function scriptOnlyAnnotateFlag(words: readonly string[]): string | null {
  return words.find((word) => SCRIPT_ONLY_ANNOTATE_FLAGS.includes(word)) ?? null
}

export function scriptOnlyAnnotateFlagText(flag: string): string {
  return (
    `Plannotator did not open: ${flag} is for scripts that read the CLI's exit code or result file, ` +
    'and here your decision comes back as a message instead, so nothing would read it. ' +
    `Run \`plannotator annotate <file> --gate --json ${flag === '--result-file' ? '--result-file <path>' : flag}\` in a terminal, ` +
    `or drop ${SCRIPT_ONLY_ANNOTATE_FLAGS.join(' / ')} to annotate here.`
  )
}

const COMMAND_ACTIONS: Record<string, PlannotatorToolAction> = {
  annotate: 'annotate',
  review: 'review',
  'annotate-last': 'last',
  last: 'last',
}

/**
 * An agent's shell command as the `plannotator` tool call that opens the same thing, or null when it is not one to take over.
 * Taken over only when it is one simple command whose first word is exactly `plannotator` (a path such as `./plannotator` is a dev build) and carries only what the tool represents. Everything else runs as written, so scripted strict gates keep the CLI.
 */
export function plannotatorCommandToToolInput(
  command: string,
  parseOptions: PlannotatorToolParseOptions = {},
): PlannotatorToolInput | null {
  const words = simpleShellCommandWords(command)
  if (!words || words.length < 2) return null
  const program = words[0] as string
  if (program !== 'plannotator') return null
  const action = COMMAND_ACTIONS[words[1] as string]
  if (!action) return null

  const seen = new Set<string>()
  const targets: string[] = []
  const call: Record<string, unknown> = { action }
  const options: Record<string, unknown> = {}
  const rest = words.slice(2)
  if (scriptOnlyAnnotateFlag(rest)) return null
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] as string
    if (!word.startsWith('-')) {
      targets.push(word)
      continue
    }
    if (seen.has(word)) return null
    seen.add(word)
    if (word === '--json') continue
    if (word === '--gate' && (action === 'annotate' || action === 'review')) call.gate = true
    else if (word === '--markdown' && action === 'annotate') options.markdown = true
    else if (word === '--tailscale' && parseOptions.tailscale === true) call.tailscale = true
    else if (word === '--base' && action === 'review') {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('-')) return null
      options.base = value
      index += 1
    } else return null
  }

  if (targets.length > 1) {
    // Several targets are taken over only as a review of several files:
    // annotate, and every word a file path. Anything else (prose around a
    // path, which the CLI's tolerant resolution reads) runs as written.
    if (action !== 'annotate' || !targets.every(looksLikeFilePath)) return null
    call.target = targets
  } else if (targets.length === 1) call.target = targets[0]
  if (Object.keys(options).length > 0) call.options = options
  const parsed = parsePlannotatorToolInput(call, parseOptions)
  return parsed.ok ? parsed.input : null
}
