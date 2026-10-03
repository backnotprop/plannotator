/**
 * The `plannotator` agent tool: the one contract every host that can deliver
 * a reviewer's decision LATER registers, so an agent asked to "open this in
 * plannotator" calls a tool that returns at once instead of running the CLI
 * and blocking on it.
 *
 * Hosts: the Claude Code mod (`apps/hook/hooks/mod/tool.ts` keeps a copy,
 * because a hooks module may import only its own folder; `tool.test.ts` there
 * fails when the two differ). Pi and OpenCode adopt it in their own PRs.
 *
 * A host validates the call with `parsePlannotatorToolInput`, turns it into
 * the words its slash command would carry with `plannotatorToolArgs`, launches
 * the session the way that slash command does, and answers with
 * `plannotatorToolOpenedText` (or the startup error). Plan review is not part
 * of the tool: it stays on each host's plan-exit hook or tool.
 *
 * Pure and dependency-free: everything below the CONTRACT marker is copied
 * byte for byte into the Claude Code mod.
 */

// --- CONTRACT (copied verbatim into apps/hook/hooks/mod/tool.ts) ---

export const PLANNOTATOR_TOOL_NAME = 'plannotator'

export type PlannotatorToolAction = 'annotate' | 'review' | 'last'

export interface PlannotatorToolInput {
  action: PlannotatorToolAction
  target?: string
  gate?: boolean
  options?: { base?: string; markdown?: boolean }
}

export const PLANNOTATOR_TOOL_DESCRIPTION = [
  'Open Plannotator, the browser review UI, for the user, and return at once.',
  '- action "annotate": annotate a file (markdown, text, config, HTML), a folder, or a URL; `target` is required. `gate: true` adds an Approve button for an explicit sign-off. `options.markdown: true` converts HTML or a URL to markdown first.',
  '- action "review": review code changes; `target` is an optional repository directory or a GitHub/GitLab/Bitbucket pull request URL (default: the current repository). `options.base` sets the compare branch or ref (git only).',
  '- action "last": annotate your own last assistant message; no target.',
  'The call only opens the page. The reviewer\'s feedback arrives later as a message from the plannotator plugin, so end your turn after calling this and wait for it. Use this tool instead of running the `plannotator` CLI. Plan review is not done with this tool: it opens by itself when you exit plan mode.',
].join('\n')

export const PLANNOTATOR_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['annotate', 'review', 'last'],
      description: 'What to open: annotate a file/folder/URL, review code changes or a PR, or annotate your last message.',
    },
    target: {
      type: 'string',
      description: 'annotate: the file, folder or URL (required). review: a repository directory or PR URL (optional). last: not used.',
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
  },
  required: ['action'],
  additionalProperties: false,
} as const

/** Longest target or base accepted; a real path or URL is far shorter. */
export const PLANNOTATOR_TOOL_MAX_TEXT = 4096

const TOOL_KEYS = ['action', 'target', 'gate', 'options']
const OPTION_KEYS = ['base', 'markdown']

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
  if (action !== 'annotate' && action !== 'review' && action !== 'last') {
    return fail('action must be "annotate", "review" or "last"')
  }
  const input: PlannotatorToolInput = { action }

  if (value.target !== undefined) {
    if (action === 'last') return fail('action "last" takes no target')
    const problem = checkWord('target', value.target)
    if (problem) return fail(problem)
    input.target = (value.target as string).trim()
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

  return { ok: true, input }
}

/**
 * The arguments the matching slash command would carry (`/plannotator-annotate
 * <these>`), one argument per element, never re-split. `last` has none.
 */
export function plannotatorToolArgs(input: PlannotatorToolInput): string[] {
  switch (input.action) {
    case 'annotate':
      return [
        input.target ?? '',
        ...(input.gate ? ['--gate'] : []),
        ...(input.options?.markdown ? ['--markdown'] : []),
      ]
    case 'review':
      return [
        ...(input.options?.base ? ['--base', input.options.base] : []),
        ...(input.target ? [input.target] : []),
      ]
    case 'last':
      return []
  }
}

/** The tool's result once the session is open (`url`) or still starting (no url). */
export function plannotatorToolOpenedText(subject: string, url: string | undefined, gate: boolean): string {
  const where = url ? `Opened ${subject} in Plannotator: ${url}` : `Plannotator is starting for ${subject}; it opens in the browser when ready.`
  const outcome = gate
    ? 'If they approve, an approval message arrives; if they send annotations, the feedback arrives. Closing it sends nothing.'
    : 'When they send annotations, the feedback arrives. Closing it with nothing to send sends nothing.'
  return [
    where,
    'The reviewer is looking at it now. End your turn now and wait: their decision arrives later as a message from the plannotator plugin.',
    outcome,
    'Do not poll, reopen it, or run the plannotator CLI for this session.',
  ].join('\n')
}
