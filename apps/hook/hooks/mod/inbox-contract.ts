/**
 * The Plannotator Inbox connection contract, a byte-for-byte copy of the
 * CONTRACT section of packages/shared/inbox/connection.ts (a hooks module may
 * import only its own folder). `inbox-contract.test.ts` fails when the two
 * differ: edit the shared file, then paste.
 */

// --- CONTRACT (copied byte for byte into apps/hook/hooks/mod/inbox-contract.ts; edit packages/shared/inbox/connection.ts, then paste) ---

/** The agent tool every connection registers. */
export const INBOX_TOOL_NAME = 'plannotator_inbox'

/**
 * The Inbox MCP tools the agent tool may carry, in the order it lists them.
 * Only those the running Inbox offers become actions; an Inbox without one
 * (an older binary) simply has no such action.
 */
export const INBOX_TOOL_ACTIONS = [
  'send_message',
  'read_thread',
  'wait_for_reply',
  'resolve_message',
  'list_decisions',
  'record_decision',
  'submit_guide',
  'get_guide_brief',
] as const

export type InboxToolAction = (typeof INBOX_TOOL_ACTIONS)[number]

/**
 * Arguments the connection fills itself, on the Inbox tools that take them:
 * the session's working folder, the host's real session id, and who the
 * person sees. They never appear in the agent's schema.
 */
export const INBOX_FILLED_ARGUMENTS = ['project_path', 'agent_session', 'agent_host', 'agent_name'] as const

export type InboxFilledArguments = Record<(typeof INBOX_FILLED_ARGUMENTS)[number], string>

/** The bridge routes on the Inbox server (bearer token, loopback Host, no Origin). */
export const INBOX_BRIDGE_POLL_PATH = '/api/inbox/bridge/poll'
export const INBOX_BRIDGE_EVENT_PATH = '/api/inbox/bridge/event'
/** The longest the server holds a poll open. */
export const INBOX_BRIDGE_POLL_MAX_MS = 25_000

/** One tool as the Inbox's `tools/list` describes it. */
export interface InboxToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The tools in a `tools/list` result that the agent tool can carry, in INBOX_TOOL_ACTIONS order. */
export function parseInboxToolList(result: unknown): InboxToolInfo[] {
  const listed = result && typeof result === 'object' ? (result as { tools?: unknown }).tools : undefined
  if (!Array.isArray(listed)) return []
  const byName = new Map<string, InboxToolInfo>()
  for (const item of listed) {
    if (!item || typeof item !== 'object') continue
    const tool = item as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof tool.name !== 'string' || !(INBOX_TOOL_ACTIONS as readonly string[]).includes(tool.name)) continue
    const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? (tool.inputSchema as Record<string, unknown>) : { type: 'object' }
    byName.set(tool.name, { name: tool.name, description: typeof tool.description === 'string' ? tool.description : '', inputSchema: schema })
  }
  return INBOX_TOOL_ACTIONS.flatMap((name) => {
    const tool = byName.get(name)
    return tool ? [tool] : []
  })
}

function propertiesOf(tool: InboxToolInfo): Record<string, Record<string, unknown>> {
  const properties = tool.inputSchema.properties
  return properties && typeof properties === 'object' ? (properties as Record<string, Record<string, unknown>>) : {}
}

function isFilled(name: string): boolean {
  return (INBOX_FILLED_ARGUMENTS as readonly string[]).includes(name)
}

/** The first sentence of a description (up to the first ". " or line break). */
function leadOf(description: string): string {
  const line = description.split('\n', 1)[0] ?? ''
  const stop = line.search(/\.\s/)
  return (stop >= 0 ? line.slice(0, stop + 1) : line).trim()
}

/** What the agent tool says, before the per-action lines. Fixed text. */
export const INBOX_TOOL_LEAD =
  "The Plannotator Inbox on this machine: message the person and get their answer without holding this session open. Set `action` to one of the Inbox's tools below and pass that tool's fields; the project and this session are filled in for you."

/**
 * Fixed text: how a reply comes back. The connection delivers the person's
 * reply to a message this session sent as a new turn once the session is idle.
 * Host-neutral: Claude Code frames the turn as the plugin's message, Pi and
 * OpenCode 2 as a user message, and all three carry the wake's first line.
 */
export const INBOX_TOOL_WAKE_NOTE =
  "When the person replies to a message you sent, their reply arrives in this session by itself once the session is idle, as a message with the line `Plannotator Inbox: <subject> (<reply id>)`: you can end your turn instead of waiting with wait_for_reply."

/**
 * The agent tool: name, description and input schema, built from the Inbox's
 * own tools. Null when it offers none. `wakes: false` for a host that cannot
 * deliver a reply as a turn (OpenCode 1): the description then says nothing
 * about replies arriving by themselves.
 */
export function inboxAgentTool(
  tools: readonly InboxToolInfo[],
  options: { wakes?: boolean } = {},
): { name: string; description: string; inputSchema: Record<string, unknown> } | null {
  if (tools.length === 0) return null
  const description = [
    INBOX_TOOL_LEAD,
    '',
    ...tools.map((tool) => `- ${tool.name}: ${leadOf(tool.description)}`),
    ...(options.wakes === false ? [] : ['', INBOX_TOOL_WAKE_NOTE]),
  ].join('\n')
  const properties: Record<string, Record<string, unknown>> = {
    action: { type: 'string', enum: tools.map((tool) => tool.name), description: 'Which Inbox tool to call.' },
  }
  const usedBy = new Map<string, string[]>()
  for (const tool of tools) {
    for (const [name, schema] of Object.entries(propertiesOf(tool))) {
      if (isFilled(name) || name === 'action') continue
      const users = usedBy.get(name)
      if (users) {
        users.push(tool.name)
        continue
      }
      usedBy.set(name, [tool.name])
      // send_message's description carries the question-block guide: it rides
      // the body field, so the tool's own description stays short.
      const extra = tool.name === 'send_message' && name === 'body' ? `\n\n${tool.description}` : ''
      properties[name] = { ...schema, description: `${typeof schema.description === 'string' ? schema.description : ''}${extra}`.trim() }
    }
  }
  for (const [name, users] of usedBy) {
    const schema = properties[name]!
    properties[name] = { ...schema, description: `(${users.join(', ')}) ${schema.description}`.trim() }
  }
  return { name: INBOX_TOOL_NAME, description, inputSchema: { type: 'object', properties, required: ['action'], additionalProperties: false } }
}

/**
 * The Inbox tool call an agent tool call stands for: the action's own fields
 * (any other field is refused, naming the action's fields) plus the filled
 * arguments that tool takes.
 */
export function inboxToolCall(
  input: unknown,
  tools: readonly InboxToolInfo[],
  filled: InboxFilledArguments,
): { name: string; arguments: Record<string, unknown> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid plannotator_inbox call: expected an object with an action.' }
  const { action, ...rest } = input as Record<string, unknown>
  const tool = tools.find((candidate) => candidate.name === action)
  if (!tool) {
    return {
      error: `Invalid plannotator_inbox call: action must be one of ${tools.map((candidate) => candidate.name).join(', ')}${typeof action === 'string' && (INBOX_TOOL_ACTIONS as readonly string[]).includes(action) ? ` (this Plannotator Inbox has no ${action}; update Plannotator for it)` : ''}.`,
    }
  }
  const own = propertiesOf(tool)
  const args: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(rest)) {
    if (value === undefined) continue
    if (!(name in own) || isFilled(name)) {
      const fields = Object.keys(own).filter((field) => !isFilled(field))
      return { error: `Invalid plannotator_inbox call: ${tool.name} takes no "${name}" (its fields: ${fields.join(', ') || 'none'}).` }
    }
    args[name] = value
  }
  for (const name of INBOX_FILLED_ARGUMENTS) if (name in own) args[name] = filled[name]
  return { name: tool.name, arguments: args }
}

/** An MCP `tools/call` result as the text the agent tool answers with: the text, then any structured content as JSON. */
export function inboxToolResultText(result: unknown): { text: string; isError: boolean } {
  const value = result && typeof result === 'object' ? (result as { content?: unknown; structuredContent?: unknown; isError?: unknown }) : {}
  const text = Array.isArray(value.content)
    ? value.content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n')
    : ''
  const structured = value.structuredContent && typeof value.structuredContent === 'object' ? `\n\n${JSON.stringify(value.structuredContent, null, 2)}` : ''
  return { text: `${text}${value.isError === true ? '' : structured}`.trim(), isError: value.isError === true }
}

/** The JSON-RPC message in an MCP answer: a JSON body, or the `data:` lines of an SSE body. */
export function mcpAnswerOf(text: string): { result?: unknown; error?: { message?: string } } | null {
  const candidates = /^\s*(event:|data:|:)/m.test(text)
    ? text
        .split(/\r?\n\r?\n/)
        .map((block) =>
          block
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n'),
        )
        .filter((data) => data.trim())
    : [text]
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as { result?: unknown; error?: { message?: string } }
      if (value && typeof value === 'object' && ('result' in value || 'error' in value)) return value
    } catch {
      // The next block.
    }
  }
  return null
}

/** The registry fields a connection reads (`inbox/inbox.json`), re-read on every call. */
export interface InboxRegistryView {
  pid: number
  port: number
  token: string
  serverSession: string
  url: string
}

export function parseInboxRegistry(text: string | null | undefined): InboxRegistryView | null {
  if (!text) return null
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (
      value.v === 1 &&
      typeof value.pid === 'number' &&
      typeof value.port === 'number' &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port < 65536 &&
      typeof value.token === 'string' &&
      value.token.length >= 32 &&
      typeof value.serverSession === 'string' &&
      typeof value.url === 'string'
    ) {
      return { pid: value.pid, port: value.port, token: value.token, serverSession: value.serverSession, url: value.url }
    }
  } catch {
    // Unreadable: the same as none.
  }
  return null
}

/** One reply the person sent to a message of the polling session. */
export interface InboxReplyCommand {
  type: 'reply'
  /** The person's reply (a `msg_` id). */
  id: string
  thread_id: string
  /** The agent message it answers. */
  reply_to: string
  /** The thread's subject. */
  subject: string | null
  /** The reply, markdown, verbatim. */
  body: string
  /** The thread in the Inbox page. */
  url: string
}

export function parseInboxBridgeCommands(text: string): InboxReplyCommand[] {
  try {
    const body = JSON.parse(text) as { commands?: unknown }
    if (!Array.isArray(body.commands)) return []
    return body.commands.filter((command): command is InboxReplyCommand => {
      if (!command || typeof command !== 'object') return false
      const c = command as Record<string, unknown>
      return c.type === 'reply' && typeof c.id === 'string' && typeof c.thread_id === 'string' && typeof c.body === 'string'
    })
  } catch {
    return []
  }
}

/** The fixed second line of every wake: who is speaking, and how to answer. */
export const INBOX_WAKE_INSTRUCTION =
  "The person replied to you in the Plannotator Inbox. Their reply follows as they wrote it: it is their answer to you. When they need to hear back, answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above."

/**
 * The turn a reply becomes: `Plannotator Inbox: <subject> (<reply id>)`, the
 * fixed instruction line, then the reply verbatim. Never the thread re-sent.
 */
export function inboxWakeText(command: Pick<InboxReplyCommand, 'id' | 'subject' | 'body'>): string {
  const subject = (command.subject ?? '').replace(/\s+/g, ' ').trim() || 'a reply'
  return `Plannotator Inbox: ${subject} (${command.id})\n${INBOX_WAKE_INSTRUCTION}\n\n${command.body}`
}
