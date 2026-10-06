/**
 * The `plannotator` tool's contract, as the Claude Code mod registers it
 * (`$.tool.register` in register.ts).
 *
 * A COPY of packages/shared/plannotator-tool.ts: a hooks module may import
 * only its own folder. Everything below the CONTRACT marker must stay byte
 * for byte the same as there; `tool.test.ts` fails when they differ. Edit the
 * shared file, then paste its contract section here.
 */

// --- CONTRACT (copied verbatim into apps/hook/hooks/mod/tool.ts) ---

export const PLANNOTATOR_TOOL_NAME = 'plannotator'

export type PlannotatorToolAction = 'annotate' | 'review' | 'last' | 'list' | 'close'

/** The actions that open a review page. */
export type PlannotatorToolOpenAction = 'annotate' | 'review' | 'last'

export interface PlannotatorToolInput {
  action: PlannotatorToolAction
  /**
   * annotate: one file, folder or URL, or (contract v2) several files as a
   * list, in the order they should be read. A one-item list is returned as a
   * plain string and exact duplicates are dropped, so a list here always has
   * two or more entries. review: a directory or PR URL (string only).
   */
  target?: string | string[]
  gate?: boolean
  options?: { base?: string; markdown?: boolean }
  /** close: a session id (`pn-` + 6 hex, as the results name it) or "all". */
  session?: string
}

export const PLANNOTATOR_TOOL_DESCRIPTION = [
  'Open Plannotator, the browser review UI, for the user, and return at once. Also lists and closes the reviews opened in this conversation (by this tool or the user\'s /plannotator-* commands).',
  '- action "annotate": annotate a file (markdown, text, config, HTML), a folder, or a URL; `target` is required. Pass a list as `target` to review several files together, in the order you want them read. `gate: true` adds an Approve button for an explicit sign-off. `options.markdown: true` converts HTML or a URL to markdown first.',
  '- action "review": review code changes; `target` is an optional repository directory or a GitHub/GitLab/Bitbucket pull request URL (default: the current repository). `options.base` sets the compare branch or ref (git only).',
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
      description: 'annotate only: show an Approve button so the reviewer can sign off explicitly.',
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

/** Longest target or base accepted; a real path or URL is far shorter. */
export const PLANNOTATOR_TOOL_MAX_TEXT = 4096

/**
 * A session id as every host names it: `pn-` and six lowercase hex digits, a
 * short alias of the host's own launch id. Hosts resolve an id only among the
 * reviews their own agent session opened.
 */
export const PLANNOTATOR_SESSION_ID_PREFIX = 'pn-'

const SESSION_ID = /^(?:pn-)?([0-9a-f]{6})$/i

/** `pn-3f2a9c` from an id the agent typed (`pn-3F2A9C`, `3f2a9c`), or null when it is not one. */
export function normalizePlannotatorSessionId(value: string): string | null {
  const match = SESSION_ID.exec(value.trim())
  return match ? `${PLANNOTATOR_SESSION_ID_PREFIX}${(match[1] as string).toLowerCase()}` : null
}

/** The session id for six hex digits a host drew for its launch. */
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

/** A string the CLI can take as one argument: no control characters, never read as a flag. */
function checkWord(name: string, value: unknown): string | null {
  if (typeof value !== 'string') return `${name} must be a string`
  if (value.trim() === '') return `${name} must not be empty`
  if (value.length > PLANNOTATOR_TOOL_MAX_TEXT) return `${name} is longer than ${PLANNOTATOR_TOOL_MAX_TEXT} characters`
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} must not contain control characters or line breaks`
  if (value.trim().startsWith('-')) return `${name} must not start with "-"`
  return null
}

/** Whether the action opens a page (and so takes target, gate, options). */
export function isPlannotatorToolOpenAction(action: PlannotatorToolAction): action is PlannotatorToolOpenAction {
  return action === 'annotate' || action === 'review' || action === 'last'
}

/**
 * Validates a tool call strictly: unknown keys, wrong types, and a field the
 * action does not take are errors (a `false` the action ignores is allowed,
 * since models often fill defaults). The error text is for the model.
 */
export function parsePlannotatorToolInput(value: unknown): PlannotatorToolParse {
  const fail = (error: string): PlannotatorToolParse => ({ ok: false, error: `Invalid plannotator call: ${error}.` })
  if (!isRecord(value)) return fail('the input must be an object')
  for (const key of Object.keys(value)) {
    if (!TOOL_KEYS.includes(key)) return fail(`unknown field "${key}"`)
  }
  const action = value.action
  if (typeof action !== 'string' || !ACTIONS.includes(action as PlannotatorToolAction)) {
    return fail('action must be "annotate", "review", "last", "list" or "close"')
  }
  const input: PlannotatorToolInput = { action: action as PlannotatorToolAction }
  const opens = isPlannotatorToolOpenAction(input.action)

  if (value.target !== undefined) {
    if (!opens || action === 'last') return fail(`action "${action}" takes no target`)
    if (Array.isArray(value.target)) {
      if (action !== 'annotate') return fail('a list of targets is for action "annotate" only')
      if (value.target.length === 0) return fail('target must not be an empty list')
      const targets: string[] = []
      for (const [index, item] of value.target.entries()) {
        const problem = checkWord(`target[${index}]`, item)
        if (problem) return fail(problem)
        const trimmed = (item as string).trim()
        if (!targets.includes(trimmed)) targets.push(trimmed)
      }
      input.target = targets.length === 1 ? targets[0] : targets
    } else {
      const problem = checkWord('target', value.target)
      if (problem) return fail(problem)
      input.target = (value.target as string).trim()
    }
  } else if (action === 'annotate') {
    return fail('action "annotate" needs a target (a file, folder or URL)')
  }

  if (value.gate !== undefined) {
    if (typeof value.gate !== 'boolean') return fail('gate must be true or false')
    if (value.gate && action !== 'annotate') return fail('gate is for action "annotate" only')
    if (value.gate) input.gate = true
  }

  if (value.options !== undefined) {
    const options = value.options
    if (!isRecord(options)) return fail('options must be an object')
    for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.includes(key)) return fail(`unknown option "${key}"`)
    }
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

  if (value.session !== undefined) {
    if (action !== 'close') return fail('session is for action "close" only')
    if (typeof value.session !== 'string') return fail('session must be a string')
    if (action === 'close' && value.session.trim().toLowerCase() === 'all') {
      input.session = 'all'
    } else {
      const id = normalizePlannotatorSessionId(value.session)
      if (!id) return fail('session must be a session id such as "pn-3f2a9c" or "all"')
      input.session = id
    }
  } else if (action === 'close') {
    return fail('action "close" needs a session (the pn-... id a result named, or "all")')
  }

  return { ok: true, input }
}

/** The files of an annotate call, in order (one or several). */
export function plannotatorToolTargets(input: PlannotatorToolInput): string[] {
  if (input.target === undefined) return []
  return Array.isArray(input.target) ? [...input.target] : [input.target]
}

/**
 * The arguments the matching slash command would carry (`/plannotator-annotate
 * <these>`), one argument per element, never re-split. A list of annotate
 * targets passes a bare word as `./word`, so the CLI reads every entry as a
 * path. `last` has none, and neither do the actions that open nothing (list,
 * close).
 */
export function plannotatorToolArgs(input: PlannotatorToolInput): string[] {
  switch (input.action) {
    case 'annotate':
      return [
        // A list is files named by their paths, so every entry is passed as
        // one: a bare word becomes `./word`. The CLI then refuses a list with a
        // missing file instead of reading the bare word as prose.
        ...(Array.isArray(input.target)
          ? input.target.map((target) => (looksLikeFilePath(target) || /^https?:\/\//i.test(target) ? target : `./${target}`))
          : plannotatorToolTargets(input)),
        ...(input.gate ? ['--gate'] : []),
        ...(input.options?.markdown ? ['--markdown'] : []),
      ]
    case 'review':
      return [
        ...(input.options?.base ? ['--base', input.options.base] : []),
        ...plannotatorToolTargets(input),
      ]
    case 'last':
    case 'list':
    case 'close':
      return []
  }
}

/**
 * What a review is OF, in full: the absolute file or folder path, the URL, the
 * files of a bundle (in review order), the reviewed directory or the PR URL.
 * Taken from the server that shows (and later submits) the review, never
 * guessed from the words the agent typed: two files can share a name.
 */
export type PlannotatorTarget = string | readonly string[]

/**
 * The line(s) naming a review's full target: `Target: /abs/path/notes.md`, or
 * for several files `Targets:` and one `- path` line each. Empty for no target
 * (the last-message surface has none). Every decision message and the tool's
 * opened text carry it, so an agent never has to guess which of two
 * same-named files a decision is about.
 */
export function plannotatorTargetLines(target: PlannotatorTarget | undefined): string {
  if (target === undefined) return ''
  if (typeof target === 'string') return target.trim() ? `Target: ${target}` : ''
  const paths = target.filter((path) => path.trim() !== '')
  if (paths.length === 0) return ''
  if (paths.length === 1) return `Target: ${paths[0]}`
  return ['Targets:', ...paths.map((path) => `- ${path}`)].join('\n')
}

/**
 * The tool's result once the session is open (`url`) or still starting (no
 * url). `sessionId` leads it when given; `target` (the full path or URL the
 * server opened, when known) follows it.
 */
export function plannotatorToolOpenedText(
  subject: string,
  url: string | undefined,
  gate: boolean,
  sessionId?: string,
  target?: PlannotatorTarget,
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
    'The reviewer is looking at it now. End your turn now and wait: their decision arrives later as a message in this conversation that starts with "Plannotator:".',
    outcome,
    'Do not poll, reopen it, or run the plannotator CLI for this session.',
  ].join('\n')
}

/**
 * The outcome a decision heading names for a code review the reviewer posted
 * straight to the PR platform (GitHub, GitLab, Bitbucket): the same words on
 * every host that delivers it as a message.
 */
export const PLANNOTATOR_OUTCOME_REVIEW_POSTED = 'Review posted'

/**
 * The first line of every decision message a host delivers: what was
 * reviewed, its session id, and the outcome (`Feedback · 3 comments`). With a
 * `target` (the full path, URL or files the SUBMITTING server reviewed) the
 * heading is followed by its `Target:` line(s), so even a bare approval names
 * exactly which file it approves.
 */
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

/** How a pull request URL is named (`PR #12`, `MR !12`), or null when the target is not one. */
export function plannotatorPrSubject(target: PlannotatorTarget | undefined): string | null {
  if (typeof target !== 'string') return null
  const match = PR_URL_PATTERN.exec(target)
  if (!match) return null
  return /merge_requests/i.test(target) ? `MR !${match[1]}` : `PR #${match[1]}`
}

/**
 * The subject a decision is headed with: the launch's own, unless the
 * decision is about a DIFFERENT pull request than the launch opened (the
 * reviewer switched PRs in place), which is then named itself.
 */
export function plannotatorDecisionSubject(
  subject: string,
  launchTarget: PlannotatorTarget | undefined,
  decisionTarget: PlannotatorTarget | undefined,
): string {
  if (decisionTarget === undefined || plannotatorSameTarget(launchTarget, decisionTarget)) return subject
  return plannotatorPrSubject(decisionTarget) ?? subject
}

/** A target as a list of trimmed entries, trailing separators dropped. */
function targetEntries(target: PlannotatorTarget): string[] {
  return (typeof target === 'string' ? [target] : [...target]).map((value) => value.trim().replace(/[\\/]+$/, ''))
}

/** Whether two targets name the same thing (a list compares entry by entry, in order). */
export function plannotatorSameTarget(a: PlannotatorTarget | undefined, b: PlannotatorTarget | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const left = targetEntries(a)
  const right = targetEntries(b)
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== '')
}

/**
 * Subjects that tell open reviews apart. Reviews whose subjects are equal and
 * whose targets are different paths (two `QUESTIONS.md` in different folders)
 * are each named by the shortest trailing part of their path, two segments at
 * least, that none of the others shares (`releases-2026-10-04/QUESTIONS.md`).
 * A subject that ends in the path's last segment keeps its other words
 * (`changes in app/web`). Every other subject is returned as is, in order.
 */
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

/** What a host answers a list of several files with when its Plannotator CLI is too old to open them as one review. */
export const PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT =
  'Plannotator did not open: the installed Plannotator is too old to open several files at once. Ask the user to update Plannotator to open several files at once, or open them one at a time for now.'

/**
 * The line a CLI that opens bundles adds to its "Ambiguous annotate
 * arguments" error (`ANNOTATE_BUNDLE_HINT` in annotate-target.ts; copied here
 * because this section must stay dependency-free).
 */
export const PLANNOTATOR_BUNDLE_HINT_LINE =
  'To review several files together, pass only their paths: plannotator annotate a.md b.html'

/**
 * Whether a CLI's startup error for several file paths is an OLDER CLI's
 * refusal: its ambiguity error without the bundle hint a current CLI adds. A
 * host that sent a list of paths answers `PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT`
 * then, instead of showing an error that tells the agent to pick one file.
 */
export function isOlderCliBundleRefusal(errorText: string): boolean {
  return errorText.includes('Ambiguous annotate arguments:') && !errorText.includes(PLANNOTATOR_BUNDLE_HINT_LINE)
}

/** The file name of a path, for subjects (either separator). */
function fileNameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed
}

/**
 * What a review of several files is called wherever one line names it: the
 * tool's result, the decision heading, the session list. Up to three file
 * names, then a count of the rest: "3 files: spec.md, mock.html, notes.md",
 * "5 files: a.md, b.md, c.md +2 more".
 */
export function plannotatorBundleSubject(paths: readonly string[]): string {
  const names = paths.map(fileNameOf)
  const rest = names.length - 3
  return `${names.length} files: ${names.slice(0, 3).join(', ')}${rest > 0 ? ` +${rest} more` : ''}`
}

/**
 * A subject from the target the CLI reports it opened (the ready line, the
 * result record), for the kinds whose subject names what was opened:
 * annotate (the file name, a URL's host, or a bundle's file names) and
 * review (`PR #12` / `MR !12`, or `changes in <directory>`). Null when the
 * target names nothing usable; the host then keeps the subject it built from
 * the typed words, as it must for an older CLI that reports no target. Typed
 * words are not trusted for this when a target is known: the CLI ignores a
 * stray `.` or prose words beside a file, so `annotate . a.md` opens a.md.
 */
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

/**
 * Whether a shell word reads as a file path rather than prose: it has a path
 * separator, starts with `~`, `.` or `@`, or ends in a file extension. A URL
 * is not a path. Pure: nothing is looked up on disk.
 */
export function looksLikeFilePath(word: string): boolean {
  if (/^https?:\/\//i.test(word)) return false
  if (/[\\/]/.test(word) || /^[~.@]/.test(word)) return true
  return /\.[A-Za-z0-9]{1,12}$/.test(word)
}

/** One open review, as `list` reports it. */
export interface PlannotatorSessionSummary {
  id: string
  kind: 'plan' | 'annotate' | 'review' | 'last'
  /** What it shows: the file(s), folder, URL, PR, or "local changes". */
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

/** `list`'s result: one line per open review, or a sentence when there is none. */
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

/** How one `close` went, for `plannotatorToolCloseText`. */
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

/** `close` naming a session this conversation did not open (or that already ended). */
export function plannotatorUnknownSessionText(id: string): string {
  return `No open Plannotator review ${id} from this conversation. Call the plannotator tool with action "list" to see yours.`
}

/**
 * The words of `command` when it is ONE simple command a shell would run
 * without interpreting anything; null otherwise.
 *
 * Quoting follows the slash commands' splitter (`splitShellWords`): whitespace
 * separates, single quotes are literal, double quotes group (a backslash
 * escapes `"`, `\`, `$` and a backtick inside them), a backslash outside quotes
 * escapes the next character. Where that splitter tolerates, this refuses:
 * anything the shell would expand or treat as syntax makes the result null, so
 * a word here is exactly the argument the program would have received. That
 * is: an unquoted operator or redirect (`; & | < > ( )`), a line break, `$`
 * or a backtick outside single quotes, an unquoted glob or brace (`* ? [ { }`),
 * a `#` that starts a word (a comment), a `~` that starts a word other than
 * `~` or `~/...` (the CLIs expand those two themselves), and an unterminated
 * quote.
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

/**
 * Annotate flags for a script that reads the CLI's own channels: the exit
 * code and stdout record of a strict gate (`--require-approval`,
 * `--result-file`) or the hook-shaped stdout (`--hook`). A host that starts
 * the CLI detached and delivers the decision later as a message has no caller
 * reading any of them, so the reviewer's decision would be lost. Such a host
 * refuses annotate words carrying one (`scriptOnlyAnnotateFlag`), and the
 * shell take-over below leaves a command carrying one to run as written.
 */
export const SCRIPT_ONLY_ANNOTATE_FLAGS: readonly string[] = ['--require-approval', '--result-file', '--hook']

/** The first script-only annotate flag among the words, or null. */
export function scriptOnlyAnnotateFlag(words: readonly string[]): string | null {
  return words.find((word) => SCRIPT_ONLY_ANNOTATE_FLAGS.includes(word)) ?? null
}

/** What a detached host answers when the user's annotate words carry a script-only flag. */
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
 * An agent's shell command (a Bash tool call) as the `plannotator` tool call
 * that opens the same thing, or null when the command is not one to take over.
 *
 * A host that can deliver decisions later answers such a command itself,
 * through the same launch as the tool, instead of running the blocking CLI:
 * the agent gets the tool's experience (the page opens, the turn ends, the
 * decision arrives as a message, Ask AI asks this session) even when it reached
 * for the CLI.
 *
 * Taken over: one simple command (see `simpleShellCommandWords`) whose first
 * word is exactly `plannotator` (the installed binary on PATH; a path such as
 * `./plannotator` is a dev build and runs for real), with subcommand
 * `annotate`, `review`, `annotate-last` or `last`, carrying only what the tool
 * represents: annotate `<target>` (or several targets that all read as file
 * paths, `looksLikeFilePath`, which become `target: [...]`, a review of
 * several files) plus `--gate` and `--markdown`; review `[target]` plus
 * `--base <ref>`; last with no arguments. `--json` is accepted and dropped
 * (the decision arrives as a message, not on stdout). The result passes
 * `parsePlannotatorToolInput`.
 *
 * Everything else is null and runs as written: other subcommands, any other
 * flag (`--require-approval`, `--result-file`, `--hook`, `--tailscale`,
 * `--static`, `--app`, `--no-jina`, `--help`, ...), a repeated flag, several
 * targets that are not all file paths (or for review), an environment prefix,
 * and any shell syntax (`cd x && ...`,
 * pipes, redirects, substitutions), so scripted strict gates keep the CLI.
 */
export function plannotatorCommandToToolInput(command: string): PlannotatorToolInput | null {
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
    if (word === '--gate' && action === 'annotate') call.gate = true
    else if (word === '--markdown' && action === 'annotate') options.markdown = true
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
  const parsed = parsePlannotatorToolInput(call)
  return parsed.ok ? parsed.input : null
}
