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
  'search',
  'resolve_message',
  'snooze_thread',
  'thread_pulls',
  'submit_guide',
  'get_guide_brief',
  'card',
  'steps',
] as const

export type InboxToolAction = (typeof INBOX_TOOL_ACTIONS)[number]

/**
 * The action the Inbox no longer has, and what a call to it answers: an older
 * plugin, skill or note may still name it. `/mcp` answers it as a tool result
 * and `inboxToolCall` as a refusal, in the Inbox's `<snake_code>: <message>`.
 */
export const INBOX_REMOVED_ACTION = 'wait_for_reply'

export const INBOX_REMOVED_ACTION_TEXT =
  'action_removed: The Plannotator Inbox no longer has wait_for_reply. Go on with your work or end your turn. If the reply does not arrive in this session by itself, call read_thread with the thread_id later.'

/**
 * Arguments the connection fills itself, on the Inbox tools that take them:
 * the session's working folder, the host's real session id, and who the
 * person sees. They never appear in the agent's schema, except
 * `project_path` (INBOX_AGENT_PROJECT_PATH).
 */
export const INBOX_FILLED_ARGUMENTS = ['project_path', 'agent_session', 'agent_host', 'agent_name'] as const

export type InboxFilledArguments = Record<(typeof INBOX_FILLED_ARGUMENTS)[number], string>

/**
 * The one filled argument an agent may set itself: the repository or folder
 * a call is about, when it is not the folder the session started in (a
 * message about another repository). Optional in the agent's schema; absent,
 * the connection fills the session's folder (the Claude Code mod: where the
 * session started, which a shell `cd` never moves). The connection resolves a
 * relative path against the current working folder and refuses a path that
 * is not an existing folder before anything reaches the Inbox.
 */
export const INBOX_AGENT_PROJECT_PATH = 'project_path'

export const INBOX_AGENT_PROJECT_PATH_DESCRIPTION =
  'The repository or folder this is about; defaults to the folder your session started in. Pass it only when the message is about another repository or folder.'

/** Why an agent's `project_path` is refused before any folder is looked at, or null when its shape passes. */
export function inboxProjectPathShapeRefusal(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'project_path: a folder path (absolute, or relative to your working folder).'
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'project_path: no control characters or line breaks.'
  if (value.length > 4096) return 'project_path: at most 4096 characters.'
  return null
}

/**
 * The `_meta` key a connection sets to `true` on its `tools/call` when the
 * person's reply reaches this session as a turn by itself (the session's wake
 * runs). The send tools then say the reply arrives by itself. Without it (the
 * stdio shim, a raw MCP client, OpenCode 1, an older connection) they say to
 * read the thread later. An older Inbox ignores it.
 */
export const INBOX_WAKES_META_KEY = 'ai.plannotator/inbox-wakes'

/**
 * The `_meta` key a connection sets on a send (`send_message`,
 * `submit_guide`) to the absolute folder the agent works in now, when that is
 * not the `project_path` it filled: the Claude Code mod files a session's
 * messages under the folder it started in, while a shell `cd` moves the
 * agent. Relative `attachments`, and the body's relative images and links
 * (the message's `base_path`), then resolve there, where they resolved before
 * the project stopped following the `cd`. Never sent with a `project_path`
 * the agent named (its relative paths stay relative to it). An older Inbox
 * ignores it; the mod also makes relative attachments absolute itself.
 */
export const INBOX_WORKING_FOLDER_META_KEY = 'ai.plannotator/working-folder'

/**
 * The `tools/call` params for an Inbox tool call: `wakes` when this session's
 * replies arrive as turns, `workingFolder` (INBOX_WORKING_FOLDER_META_KEY)
 * when the agent works outside the filled `project_path`.
 */
export function inboxToolCallParams(
  call: { name: string; arguments: Record<string, unknown> },
  options: { wakes: boolean; workingFolder?: string },
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ...(options.wakes ? { [INBOX_WAKES_META_KEY]: true } : {}),
    ...(options.workingFolder ? { [INBOX_WORKING_FOLDER_META_KEY]: options.workingFolder } : {}),
  }
  return { name: call.name, arguments: call.arguments, ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}) }
}

/**
 * The rule for a write into a thread an agent may only remember (the
 * misfiled-thread AAR, 2026-10-27: a thread id kept across a context
 * compaction sent seven messages into the wrong thread). In reply_to's and
 * read_thread's descriptions, the agent tool's reply_to, the note in each
 * agent's instructions and the session's thread list.
 */
export const INBOX_REPLY_TO_CHECK = 'Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.'

/**
 * How an issue or PR ref in a message links (a bare `#104` meant for another
 * repo once linked into the thread's project). In send_message's `body`, the
 * agent tool's `body`, and `plannotator inbox --help` / `card --help`.
 * `owner/repo#123` links on the project's own forge, so a GitHub ref from a
 * GitLab project needs its URL.
 */
export const INBOX_REF_LINK_RULE = "A bare #123 links to this project's repository (where your session started, or `project_path`), even in a message about another repo; a word before it (`docs #12`, `docs PR #12`) does not change that. For any other repo's issue or PR, write owner/repo#123 (its `git remote -v`) or its full URL in every mention, repeats and choices too; relaying another agent's report, rewrite its bare refs. In a GitLab project, a GitHub one needs its URL."

/** The card's `say` and `you`: a pointer to the rule on `body`, not the rule again (every request carries both). */
export const INBOX_REF_LINK_POINTER = "Refs link as in send_message's body."

/**
 * The `_meta` key a connection sets to `true` on the read_thread list it reads
 * for the session's thread list (`inboxSessionThreadsParams`), not a call the
 * agent made: the Inbox makes no project for a folder it does not know, and
 * the rows do not count as the session having looked at those threads
 * (send_message's warning line). An older Inbox ignores it.
 */
export const INBOX_PEEK_META_KEY = 'ai.plannotator/inbox-peek'

/** How many of the session's open threads the thread list names (the rest are counted). */
export const INBOX_SESSION_THREADS_MAX = 5

/** The longest subject or name the thread list prints, in characters. */
const SESSION_THREAD_TEXT_MAX = 80

/**
 * The `tools/call` params for the session's open threads: read_thread with no
 * id, as the session itself would list them (its own threads and the ones the
 * person tagged it in, open only), marked as a peek.
 */
export function inboxSessionThreadsParams(projectPath: string, session: string): Record<string, unknown> {
  return {
    name: 'read_thread',
    arguments: { project_path: projectPath, agent_session: session, limit: INBOX_SESSION_THREADS_MAX },
    _meta: { [INBOX_PEEK_META_KEY]: true },
  }
}

/**
 * Whether an Inbox's `/api/inbox/health` answer (parsed JSON) is the
 * registry's Inbox (`serverSession`) and honours the peek mark (`peek: true`,
 * additive). The session's thread list is read only from such an Inbox: an
 * older one ignores the mark, so the read would make a project for every
 * folder that compacts or resumes.
 */
export function inboxHealthPeeks(health: unknown, serverSession: string): boolean {
  const value = health && typeof health === 'object' ? (health as { serverSession?: unknown; peek?: unknown }) : null
  return !!value && value.serverSession === serverSession && value.peek === true
}

/**
 * The thread list's last line: where the rest of the Inbox's context is (the
 * owner's ask, 2026-10-27). The list shows only this session's open threads;
 * every thread and older ones are a read_thread list or a search away.
 */
export const INBOX_SESSION_THREADS_MORE = 'More: read_thread with no id lists every thread (asked_by "anyone", include_resolved); search finds older ones by words (all_projects).'

/**
 * The session's open threads as a few short lines for the agent's context
 * (after a compaction, on a resume), or null when there are none or the
 * result is not a read_thread list. One line per thread: its id, subject,
 * name, open questions, whether the person wrote something unread, and the
 * last activity. Never a message body. Then INBOX_SESSION_THREADS_MORE.
 * `result` is the read_thread list's MCP result (its `structuredContent`).
 */
export function inboxSessionThreadsText(result: unknown, toolName: string = INBOX_TOOL_NAME): string | null {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent as { threads?: unknown; total?: unknown } | undefined
  if (!structured || !Array.isArray(structured.threads)) return null
  const oneLine = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    // Invisible and direction-changing characters go (zero-width, bidi marks, overrides and isolates,
    // the BOM); control characters (C0, DEL, C1) and line or paragraph separators become a space.
    const flat = value
      .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!flat) return null
    return JSON.stringify(flat.length > SESSION_THREAD_TEXT_MAX ? `${flat.slice(0, SESSION_THREAD_TEXT_MAX - 1)}…` : flat)
  }
  const time = (value: unknown): string | null =>
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) ? `${value.slice(0, 10)} ${value.slice(11, 16)}Z` : null
  const lines: string[] = []
  for (const row of structured.threads.slice(0, INBOX_SESSION_THREADS_MAX)) {
    const thread = row as Record<string, unknown> | null
    const id = thread?.thread_id
    if (typeof id !== 'string' || !/^msg_[0-9A-Za-z]{26}$/.test(id)) continue
    const parts = [`- ${id}`, oneLine(thread!.subject) ?? '(no subject)']
    const name = oneLine(thread!.thread_name)
    if (name) parts.push(`name ${name}`)
    const questions = thread!.questions as { open?: unknown } | undefined
    const open = typeof questions?.open === 'number' && questions.open > 0 ? questions.open : 0
    if (open > 0) parts.push(`${open} open question${open === 1 ? '' : 's'}`)
    if (thread!.unread === true) parts.push('the person wrote something you have not read')
    // Your steps there (approval "inbox-thread-steps"): the Inbox lists them only while the person has steps on.
    const steps = thread!.steps as { done?: unknown; total?: unknown } | undefined
    if (typeof steps?.done === 'number' && typeof steps.total === 'number' && steps.total > 0) parts.push(`steps ${steps.done}/${steps.total}`)
    const at = time(thread!.last_at)
    if (at) parts.push(`last ${thread!.last_author === 'person' ? 'the person' : 'an agent'} ${at}`)
    lines.push(parts.join(' · '))
  }
  if (lines.length === 0) return null
  const total = typeof structured.total === 'number' && structured.total > lines.length ? structured.total : lines.length
  const count = total > lines.length ? `${lines.length} of ${total}, newest first` : `${lines.length}`
  const check = INBOX_REPLY_TO_CHECK.replace('call read_thread', `call ${toolName} read_thread`)
  return [`Your open Plannotator Inbox threads in this project (${count}). ${check} ${INBOX_SESSION_THREADS_CHANNEL}`, ...lines, INBOX_SESSION_THREADS_MORE].join('\n')
}

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

/**
 * Chat or Inbox, never a guess at whether the person is watching (the owner,
 * 2026-10-27: an agent raised an Inbox decision again as a blocking question
 * in the chat when the person typed there). A decision in the Inbox stays
 * there; the chat may say what waits there (redundancy is fine), but never
 * asks it again with a blocking question tool. Fixed text: the agent tool's
 * lead and the Inbox's server instructions carry it whole; the reminder, the
 * session's thread list, the note and `plannotator inbox --help` say the same.
 */
export const INBOX_CHANNEL_RULE =
  "A decision in the Inbox stays there: when the person writes in the chat, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Ask in the chat only about something new they raised there that needs no pictures or files, or when they ask."

/**
 * The session's thread list says it too (after a compaction, on a resume):
 * the decisions in these threads stay there.
 */
export const INBOX_SESSION_THREADS_CHANNEL = "Their decisions stay in these threads: when the person writes in the chat, say what waits and link the thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar)."

/** When to use the Inbox. Fixed text: the agent tool's lead and the Inbox's server instructions carry it whole. */
export const INBOX_USE_RULE =
  "Use it for a decision only they can make (a :::question block; go on with other work), finished long work (a short summary with its pictures inline, files in `attachments`), or when they ask."

/**
 * Separate work, separate threads (the owner, 2026-10-29: an agent given new
 * work in its chat kept posting into an old thread on a related subject). The
 * owner's sentence, word for word, without more instruction around it: the
 * `thread` field says how. Fixed text, one wording everywhere: the agent
 * tool's lead and the Inbox's server instructions (INBOX_AGENT_RULES), the
 * reminder, the note, `plannotator inbox --help`, the skill and every
 * `/plannotator-inbox` briefing (tests/inbox-guidance-parity.test.ts).
 */
export const INBOX_THREAD_RULE = "One thread per work stream, unless the person says otherwise."

/**
 * Follow through, without pinging (the owner, 2026-10-27: an agent promised
 * the person pictures "coming" and left them unsent for an hour, held
 * questions "to batch them" and never sent them, and left the person's last
 * message in a thread unanswered). The owner's own words (typos fixed,
 * "the person" as everywhere else): no ban on progress, and no clauses that
 * over-specify it; instructions to a model are kept to the spirit. Fixed
 * text, one wording everywhere: the agent tool's lead, the Inbox's server
 * instructions, the reminder, the note, `plannotator inbox --help` and the
 * skill (tests/inbox-guidance-parity.test.ts).
 */
export const INBOX_FOLLOW_THROUGH_RULE =
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination."

/** A subagent's results go to the agent that started it, not to the person. Fixed text. */
export const INBOX_SUBAGENT_RULE = "If another agent started you, report to it instead."

/**
 * The rules every agent gets with the tool or the MCP server, in one string:
 * the agent tool's lead and the Inbox's server instructions carry it whole,
 * so the two can never word them differently.
 */
export const INBOX_AGENT_RULES = `${INBOX_USE_RULE} ${INBOX_THREAD_RULE} ${INBOX_CHANNEL_RULE} ${INBOX_FOLLOW_THROUGH_RULE} ${INBOX_SUBAGENT_RULE}`

/**
 * What the agent tool says, before the per-action lines. Fixed text. Room for
 * INBOX_THREAD_RULE under Claude Code's 2,048 characters came from this first
 * sentence's ", without blocking this session", restored in shorter form as
 * "nothing blocks" by shortening the help line, and from get_guide_brief's lead.
 */
export const INBOX_TOOL_LEAD =
  `The Plannotator Inbox on this machine: message the person, get their answer later; nothing blocks. ${INBOX_AGENT_RULES} Set \`action\` to a tool below, with its fields.`

/**
 * Fixed text: how a reply comes back. The connection delivers the person's
 * reply to a message this session sent as a new turn once the session is idle.
 * Host-neutral: Claude Code frames the turn as the plugin's message, Pi and
 * OpenCode 2 as a user message, and all three carry the wake's first line.
 */
export const INBOX_TOOL_WAKE_NOTE =
  "A reply arrives in this session by itself once it is idle, headed `Plannotator Inbox: <title> (<reply id>)`: end your turn or keep working. To answer it, send_message with reply_to set to that reply id, never one from memory."

/**
 * Fixed text, the description's last line: where everything the tool's short
 * field descriptions leave out lives (the full question guide, every field,
 * examples), so an agent that needs more reads it once instead of every
 * request carrying it.
 */
export const INBOX_TOOL_HELP_NOTE = "Every field and question syntax: `plannotator inbox --help`."

/**
 * Fixed text, one line: the agent tool's description carries it while the
 * Inbox lists no `card` action, the Board being off (approval "inbox-board",
 * the owner's answer of 2026-10-27: agents get one short line saying the
 * Board exists, and `plannotator card --help`). With the Board on, the card
 * action's own line says it and this one is left out.
 */
export const INBOX_TOOL_BOARD_OFF_NOTE = "The Board (cards for work that outlasts a reply) is off until the person turns it on; see `plannotator card --help`."

/**
 * Thread steps (approval "inbox-thread-steps", 2026-11-03): the owner's
 * approved text word for word, after `steps: `. It rides the `steps` field's
 * description (a field description does not count toward Claude Code's 2,048
 * characters; the owner chose this over a cut description) and is the MCP
 * tool's description. Served only while the person has steps on (config.json
 * `inboxSteps`): off, no agent text carries any of it.
 */
export const INBOX_STEPS_LEAD =
  "The person's checklist for this thread, only for multi-step work you're both aligned on. Start one when the person gives the go-ahead on work with several steps. High-level steps, a few plain words each; never your own to-do list. The whole list each call. status: todo, doing, done, waiting (on the person), dropped (say why in note). Update each step as it starts and ends; notifies no one."

/** The agent tool's line for the `steps` action (the owner, 2026-11-07): short, so the description stays under 2,048. */
export const INBOX_STEPS_ACTION_LINE = "person's checklist for multi-step work you're aligned on (see the steps field)."

/** The `steps` field (the action's, and send_message's while steps are on): the approved text, then where a list goes before there is a thread. */
export const INBOX_STEPS_FIELD_DESCRIPTION = `steps: ${INBOX_STEPS_LEAD} No thread yet: send it with the send_message that starts one.`

/**
 * The wake's one line on a reply in a thread where the session keeps steps
 * (approval "inbox-thread-steps", amended 2026-11-07, approved text): "Your
 * checklist here: 3 of 6 done; doing: X. If you're still working on this,
 * keep it current." Without a step in progress,
 * the `doing` part is left out.
 */
export function inboxStepsWakeLine(steps: { done: number; total: number; doing: string | null }): string {
  return `Your checklist here: ${steps.done} of ${steps.total} done${steps.doing ? `; doing: ${steps.doing}` : ''}. If you're still working on this, keep it current.`
}

/**
 * A thread's PRs (approval "inbox-pr-binding", 2026-11-08; the owner's
 * approved text, word for word). send_message's `pulls` field: through the
 * MCP server's field, every connection's `plannotator_inbox` tool carries it.
 */
export const INBOX_PULLS_FIELD_DESCRIPTION =
  "Pull/merge requests this thread is responsible for: added to the thread, so the person sees their live state on its row. You own your thread's list. Full refs, any repo: `owner/repo#123`, `group/sub/project!45`, or the URL. Pass it when you open or take on one for this work, not on later messages. Merged ones stay. To remove one that is no longer part of the work, or add without a message: action thread_pulls."

/** The `thread_pulls` tool's description (approved text). The agent tool lists the name only (INBOX_AGENT_ACTIONS_NO_LINE). */
export const INBOX_THREAD_PULLS_DESCRIPTION =
  "A thread's pull/merge requests: `add`, `remove`, or neither to list them with live state and who added each. The thread's agent owns the list; the person can change it too."

/** The `thread_pulls` tool's `add` field (approved text). */
export const INBOX_THREAD_PULLS_ADD_DESCRIPTION = "PRs to add, any number in one call (a whole stack, or related ones), as send_message's `pulls`."

/** The `thread_pulls` tool's `remove` field (approved text). */
export const INBOX_THREAD_PULLS_REMOVE_DESCRIPTION =
  'PRs to take off: no longer part of this work (moved elsewhere, abandoned). Not merged ones; they stay. ["all"] takes off every one.'

/**
 * The wake's one line when the person changed the thread's PRs since the
 * session last saw them (approved text): "The person changed this thread's
 * PRs: added northwind/design-tokens#88; removed northwind/web-app#1305."
 * An edit alone never wakes anyone: the line rides the next wake.
 */
export function inboxPullsWakeLine(changes: { added: readonly string[]; removed: readonly string[] }): string {
  const parts = [
    ...(changes.added.length > 0 ? [`added ${changes.added.join(', ')}`] : []),
    ...(changes.removed.length > 0 ? [`removed ${changes.removed.join(', ')}`] : []),
  ]
  return `The person changed this thread's PRs: ${parts.join('; ')}.`
}

/** A command's `pulls_changed` as the wake may print it, or null (absent, empty, or not the Inbox's shape). */
function wakePullsChanged(value: unknown): { added: string[]; removed: string[] } | null {
  if (!value || typeof value !== 'object') return null
  const list = (v: unknown): string[] | null => {
    if (!Array.isArray(v) || v.length > 20) return null
    const out: string[] = []
    for (const item of v) {
      // One ref each, no control or separator characters: it goes into the session's prompt.
      if (typeof item !== 'string' || item.length === 0 || item.length > 300 || /[\p{Cc}\p{Zl}\p{Zp}\s,;]/u.test(item)) return null
      out.push(item)
    }
    return out
  }
  const { added, removed } = value as Record<string, unknown>
  const a = list(added ?? [])
  const r = list(removed ?? [])
  if (!a || !r || a.length + r.length === 0) return null
  return { added: a, removed: r }
}

/**
 * The wake's one line when the person's reply answers the receiving session's
 * questions in a thread where that session has no checklist yet, while the
 * person has the checklist on (the owner, 2026-11-09: "when the person answers
 * questions"). Never on a plain reply or a 👍; never once the session has a
 * list there.
 */
export const INBOX_STEPS_START_WAKE_LINE = "If these answers start work with several steps, start a checklist here (the steps action). If not, skip it."

/** A command's `steps` as the wake may print it, or null (absent, or not the Inbox's shape). */
function wakeSteps(value: unknown): { done: number; total: number; doing: string | null } | null {
  if (!value || typeof value !== 'object') return null
  const { done, total, doing } = value as Record<string, unknown>
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 12
  if (!count(done) || !count(total) || total === 0 || done > total) return null
  // One line, no control or separator characters: it goes into the session's prompt.
  const step = typeof doing === 'string' ? doing.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  return { done, total, doing: step || null }
}

/**
 * Actions with no line in the agent tool's description: the name in `action`
 * and its field's description say what they do, and a field description does
 * not count toward the 2,048 (the owner: do not grow the main description).
 */
export const INBOX_AGENT_ACTIONS_NO_LINE: readonly string[] = ['snooze_thread', 'thread_pulls']

/**
 * The agent tool's own line for an action whose Inbox lead is long (the
 * description must stay under Claude Code's 2,048 characters, and every Pi and
 * OpenCode request carries it).
 */
export const INBOX_AGENT_ACTION_LEADS: Readonly<Record<string, string>> = {
  send_message: "Message the person (markdown); with no reply_to or thread, it starts a new thread.",
  resolve_message: "Archive a message's thread, only when nothing in it is left for the person to read or answer.",
  // What a read shows lives on `thread_id` (a field description does not count toward the 2,048).
  read_thread: 'Read a thread (thread_id); with no id, list your threads (asked_by "anyone": all).',
  search: 'Find messages by words, older ones too (read-only).',
  get_guide_brief: "How to write a guided review, with a worked submit_guide call.",
  card: "A Board card for work that outlasts this reply: create it, then move it and say where it is as the work moves.",
  steps: INBOX_STEPS_ACTION_LINE,
}

/**
 * Pictures sit where they are discussed (the owner, 2026-11-02: agents sent
 * a message's screenshots and the pictures of its options as attachments at
 * the bottom, so the person had to scroll there to see what each option
 * was). Fixed text: the agent tool's `body` field, the MCP server's `body`
 * field and `plannotator inbox --help` carry it whole.
 */
/**
 * Option lines (approval "inbox-question-tradeoffs"; DRAFT words, awaiting the owner's OK): `Pros:`, `Cons:` and
 * `Prototype:` under a `- [ ]` choice, and a question's own `Prototype:` line. On every copy of send_message's body.
 */
export const INBOX_OPTION_LINES_RULE =
  'Indented under a `- [ ]` choice (not a plain bullet), only when it helps the person pick: `Pros: <item>; <item>` and `Cons: <item>; <item>` (the card lines them up across options), and `Prototype: <page>`, a page they try before picking: an HTML file you also attach, or the http://localhost address of an app you are running (the send is refused if it does not answer). One `Prototype:` line at the block\'s own indent is one page for all the options.'

export const INBOX_PICTURES_RULE =
  'Pictures go in the body where you write about them, `![alt](/abs/path.png)`, never only in `attachments`; do not also attach one the body shows. Visual options are picture choices, one picture each, inside the choice (not in the text above the question): `- [ ] A · Label — ![alt](path) what it means`; the label comes back.'

/** The `attachments` field's line on pictures (fixed text, on every copy of the field). */
export const INBOX_ATTACHMENTS_PICTURES_LINE =
  'Screenshots and pictures go in the body instead (`![alt](path)`); attach what the person should open or click through.'

/**
 * Bro mode's line (approval "bro-mode", 2026-11-05; the owner's own words, and only the owner changes them). While the
 * person has Bro mode on (config.json `inboxBro`) it goes in send_message's `body` field and nowhere else; off, the
 * field is what it was before.
 */
export const INBOX_BRO_LINE =
  "Don't use jargon and speak coherently. State things more simply and concisely, like one human talking to another. Don't drop important details, especially if the user asks for them."

/** A `body` description with the line, right after its first words. */
export function inboxBodyWithBro(description: string): string {
  return description.replace('The message, markdown.', `The message, markdown. ${INBOX_BRO_LINE}`)
}

/**
 * A remembered tool list as it reads with Bro mode off: only a running Inbox can say the switch is on, and a list kept
 * from one that had it on must not outlive the person turning it off.
 */
export function inboxToolsWithoutBro(tools: InboxToolInfo[]): InboxToolInfo[] {
  return tools.map((tool) => {
    const properties = tool.inputSchema.properties as Record<string, { description?: unknown }> | undefined
    const body = properties?.body
    if (typeof body?.description !== 'string' || !body.description.includes(INBOX_BRO_LINE)) return tool
    const description = body.description.replace(` ${INBOX_BRO_LINE}`, '')
    return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, body: { ...body, description } } } }
  })
}

/**
 * The agent tool's own words for the fields whose Inbox description is long
 * (the MCP server's are written for a raw MCP client, which has no other
 * guide): every Pi and OpenCode request carries the tool whole, so these keep
 * only what an agent needs to call it well, and `plannotator inbox --help`
 * keeps the rest. Keyed by action, then field: applied only to a field that
 * action of the running Inbox offers (a field several actions share is
 * described once, from the first action that has it, `send_message` for `body`).
 */
export const INBOX_AGENT_FIELD_DESCRIPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  send_message: {
    body: [
      'The message, markdown. Ask what only the person can decide as a question block, which renders as an answerable card:',
      '',
      ':::question',
      'Where should the edit that loses a sync conflict go?',
      '',
      'Context in one to three plain sentences: what it affects, what you know, why you recommend one. The person switches in cold.',
      '',
      '- [ ] Nowhere — silent loss, as today',
      '- [ ] Local only, purged after 30 days — cheap',
      '- [ ] Server-side per user — needs a retention policy',
      '',
      'Recommended: Local only, purged after 30 days',
      'Holds up: sync release',
      ':::',
      '',
      'Your recommendation goes on the `Recommended:` line, never in a choice label. Keep the choices in their natural order; never move yours first. `:::question-multi` takes several choices, `:::question-text` free text. The person can always answer Other, add a note or skip, so never add an Other choice yourself. `Stopped: <why>` only when you cannot go on until it is answered (never `Stopped: no`); `Holds up: <work>` names work that waits while you go on. Ask only what you cannot decide alone, about 8 a round at most. Answers come back in the reply under "Answers to your questions".',
      '',
      INBOX_PICTURES_RULE,
      '',
      'Optional lines after the question; most questions need none of these: `Stakes: <what it affects>` (give one with every Stopped or Holds up), `Shows: ![alt](path)` or `Shows: [name](file)` (the one picture or file it is about), `Why: <why your recommendation>` on its own line, `Reversible: no — <why>` only when it cannot be undone.',
      INBOX_OPTION_LINES_RULE,
      '',
      'Only for a true blocker the person must go and do outside this chat, that you cannot do yourself (approve a deploy, sign in, touch a security key, merge a PR you cannot merge), write a `:::action` block: first line the order, then why. Each command the person must run goes in the why in its own fenced code block (```), one block per command in the order to run them, so each gets a copy button. Optional: `Where: <url>`, `Stopped:`, `Watching: <what you watch>`. Never for a decision or a question, for what you can do yourself, or as a checklist or status update; most messages need none. Done or Can\'t do it comes back under "Action items you asked for".',
      '',
      'Blocks fenced as `mermaid` or `dot` draw as diagrams; one fenced as `html` draws as a live, sandboxed page in the message (chart, SVG, mock; https libraries load). Leave its background transparent; use var(--foreground), var(--chart-1)…var(--chart-5). Let content set its height: no vh units or height:100% on html or body.',
      '',
      INBOX_REF_LINK_RULE,
    ].join('\n'),
    reply_to: `A message id: post this as a reply in that message's thread. ${INBOX_REPLY_TO_CHECK}`,
    thread: "A short thread name, one line: the same name in this project is the same open thread, across sessions. With no thread and no reply_to, the message starts a new thread; to add to a thread, reply_to its latest message or use the same thread name. Ignored with reply_to, except when you are asked to name a thread the person started: then it names that thread, once.",
    supersedes: 'Your own questions in this thread that are still open (read_thread state open or picked) and no longer apply: a newer message replaces them, or the reply settled them in words. "<message id>/<key>" for one, "<message id>" for all of that message\'s, as a list of strings, e.g. ["msg_…/q-…"]; send with reply_to into their thread. With one question in this message it replaces them, otherwise they read "No longer applies".',
    done: 'Your own open action items (`:::action`) in this thread that you saw done yourself, e.g. the deploy you watch is Ready: "<message id>/<key>" (key a-…); send with reply_to into their thread. The card says you saw it done; nothing is sent to the person.',
    attachments: `Files to show the person beside the message, absolute or relative to project_path: a plan, an HTML mock, code, a video, any file. ${INBOX_ATTACHMENTS_PICTURES_LINE} Link one from the body (\`[the mock](mock.html)\`) to open it beside the thread. Their comments on the files come back in the reply. Folders and .env files are refused.`,
  },
  read_thread: {
    thread_id: 'A thread id. read_thread shows its open questions, its PRs, the newest messages in full, and earlier ones one line each.',
  },
  submit_guide: {
    guide: "The guide in get_guide_brief's output_schema, as an object or its JSON.",
    snapshot: 'Instead of guide and patch: a complete Plannotator guide snapshot, as an object or its JSON.',
  },
}

/**
 * The one-line reminder a session that has `plannotator_inbox` gets once, at
 * its start (the Claude Code mod's first-prompt context, Pi's hidden
 * before_agent_start message, OpenCode's fixed system line), when the
 * `inboxReminder` switch allows it. Fixed text: it sits in the cached prompt
 * prefix and must never change within a session. For hosts with the wake
 * (the reply comes back as a turn). The follow-through rule sits right after
 * the send, before anything about the chat, so it reads as about the Inbox.
 */
export const INBOX_REMINDER_TEXT =
  `Plannotator Inbox is on: when you finish long work, or need a decision only the person can make, send it with plannotator_inbox send_message (each decision as a \`:::question\` block) and keep going. ${INBOX_FOLLOW_THROUGH_RULE} ${INBOX_THREAD_RULE} Their reply comes back here. A decision in the Inbox stays there: when the person writes here, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Run \`plannotator inbox --help\` for how it works.`

/**
 * The same line for a host without the wake (OpenCode 1): the reply does not
 * come back by itself there, so it says to read the thread.
 */
export const INBOX_REMINDER_TEXT_NO_WAKE =
  `Plannotator Inbox is on: when you finish long work, or need a decision only the person can make, send it with plannotator_inbox send_message (each decision as a \`:::question\` block) and keep going. ${INBOX_FOLLOW_THROUGH_RULE} ${INBOX_THREAD_RULE} Their reply does not come back here by itself: read the thread later with read_thread. A decision in the Inbox stays there: when the person writes here, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Run \`plannotator inbox --help\` for how it works.`

/**
 * The reminder naming the tool as the host registered it. Claude Code defers
 * plugin tools behind tool search and names them `mcp__<server>__plannotator_inbox`,
 * so the line carries that full name for the search to find; other hosts use
 * the plain name. Fixed per process: the name never changes under a session.
 */
export function inboxReminderText(toolName: string = INBOX_TOOL_NAME, options: { wakes?: boolean } = {}): string {
  const text = options.wakes === false ? INBOX_REMINDER_TEXT_NO_WAKE : INBOX_REMINDER_TEXT
  return text.replace(INBOX_TOOL_NAME, toolName)
}

/**
 * The Inbox's guide line on the briefing, the command copies' bullet word for
 * word: never run the window's command to send (the `plannotator` skill's
 * wording). Fixed text.
 */
export const INBOX_BRIEFING_NEVER_RUN =
  "Never run `plannotator inbox` just to send: send_message starts a stopped Inbox itself, and bare `plannotator inbox` opens the window for the person."

/** The briefing's last line, and every `/plannotator-inbox` copy's: what the agent does with the Inbox from now on. Fixed text. */
export const INBOX_BRIEFING_FROM_NOW_ON =
  'For the rest of this session, use the Inbox as above: for a decision the person is not here to make, and to hand over long work you finished.'

/**
 * What `/plannotator-inbox` gives the model where the host answers the
 * command itself and starts no turn (the Claude Code mod, Pi, OpenCode 2;
 * OpenCode 1 puts it in the command's own turn): people type the command to
 * teach their agent the Inbox (the owner, 2026-10-28), so the agent reads
 * this from then on, unseen by the person, beside the address they see. The
 * same guide as the command copies an agent reads itself (apps/skills/*,
 * Gemini, Droid; tests/inbox-guidance-parity.test.ts), without their "tell
 * the person the address" step. Host-neutral: it names the tool only where
 * one may be registered, and lets send_message's result say whether a reply
 * comes back by itself.
 */
export const INBOX_COMMAND_BRIEFING = [
  'The person opened their Plannotator Inbox with /plannotator-inbox and has its address. The Plannotator Inbox is one window on this computer where you leave the person messages, `:::question` blocks they answer with a click, and files. They answer when they can. Nothing blocks: you send, then keep working or end your turn.',
  '',
  `- ${INBOX_USE_RULE}`,
  `- ${INBOX_THREAD_RULE}`,
  '- Send with a `plannotator_inbox` tool when you have one (it can be listed with a prefix and may need loading through tool search first): `action` `send_message`, with a markdown `body`. Otherwise call `send_message` on the Inbox\'s MCP server, `plannotator inbox mcp`.',
  "- send_message's result says whether the person's reply arrives in this session by itself. When it does, do not wait or poll for it: end your turn or go on with other work. When it does not, go on with your work and read the thread later with read_thread.",
  `- ${INBOX_CHANNEL_RULE}`,
  `- ${INBOX_FOLLOW_THROUGH_RULE}`,
  `- ${INBOX_BRIEFING_NEVER_RUN}`,
  '- Before your first send, run `plannotator inbox --help` and read it: every field, the full question syntax, and how to connect the MCP server.',
  '- The `plannotator` skill, where you have it, has more.',
  '',
  `Opening the Inbox asks for no work by itself. ${INBOX_BRIEFING_FROM_NOW_ON}`,
].join('\n')

/** The briefing naming the tool as the host registered it (Claude Code: `mcp__plannotator__plannotator_inbox`), like the reminder. */
export function inboxCommandBriefing(toolName: string = INBOX_TOOL_NAME): string {
  return INBOX_COMMAND_BRIEFING.replace(INBOX_TOOL_NAME, toolName)
}

/**
 * The most characters (UTF-16 code units, a string's `length`) a custom Inbox
 * reminder may hold. Longer text is refused when saved and ignored when read,
 * so the host falls back to the next text in line (the shared one, then the
 * default).
 */
export const INBOX_REMINDER_MAX_CHARS = 4128

/**
 * The person's own reminder for a host, from config.json
 * (`prompts.inbox.runtimes.<host>.reminder`, which wins, then the shared
 * `prompts.inbox.reminder`), or null when neither holds usable text: a
 * string with something besides whitespace, at most INBOX_REMINDER_MAX_CHARS
 * long. Takes the parsed config.json object (anything else reads as unset).
 */
export function inboxReminderCustomText(config: unknown, host: string): string | null {
  const record = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const usable = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' && value.length <= INBOX_REMINDER_MAX_CHARS ? value : null
  const inbox = record(record(record(config)?.prompts)?.inbox)
  if (!inbox) return null
  return usable(record(record(inbox.runtimes)?.[host])?.reminder) ?? usable(inbox.reminder)
}

/**
 * The reminder a host sends: the person's own text when there is one (it
 * REPLACES the line, for hosts with the wake and without it alike, every
 * whole word `plannotator_inbox` in it renamed to the tool as the host
 * registered it), else exactly `inboxReminderText(toolName, options)`.
 */
export function inboxReminderFor(custom: string | null | undefined, toolName: string = INBOX_TOOL_NAME, options: { wakes?: boolean } = {}): string {
  if (typeof custom !== 'string' || custom.trim() === '') return inboxReminderText(toolName, options)
  return custom.replace(/(^|[^A-Za-z0-9_])plannotator_inbox(?![A-Za-z0-9_])/g, (_match: string, before: string) => before + toolName)
}

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
    ...tools.filter((tool) => !INBOX_AGENT_ACTIONS_NO_LINE.includes(tool.name)).map((tool) => `- ${tool.name}: ${INBOX_AGENT_ACTION_LEADS[tool.name] ?? leadOf(tool.description)}`),
    ...(options.wakes === false ? [] : ['', INBOX_TOOL_WAKE_NOTE]),
    '',
    // The Board off: no card action, one line that it exists (nothing changes while it is on).
    ...(tools.some((tool) => tool.name === 'card') ? [] : [INBOX_TOOL_BOARD_OFF_NOTE]),
    INBOX_TOOL_HELP_NOTE,
  ].join('\n')
  const properties: Record<string, Record<string, unknown>> = {
    action: { type: 'string', enum: tools.map((tool) => tool.name), description: 'Which Inbox tool to call.' },
  }
  const usedBy = new Map<string, string[]>()
  for (const tool of tools) {
    for (const [name, schema] of Object.entries(propertiesOf(tool))) {
      if ((isFilled(name) && name !== INBOX_AGENT_PROJECT_PATH) || name === 'action') continue
      const users = usedBy.get(name)
      if (users) {
        users.push(tool.name)
        continue
      }
      usedBy.set(name, [tool.name])
      if (name === INBOX_AGENT_PROJECT_PATH) {
        // Optional, and described for the agent: the Inbox's own text is about the fill.
        properties[name] = { type: 'string', description: INBOX_AGENT_PROJECT_PATH_DESCRIPTION }
        continue
      }
      // The agent tool's own short words where the Inbox's are long; the rest is the Inbox's.
      const own = INBOX_AGENT_FIELD_DESCRIPTIONS[tool.name]?.[name]
      const served = typeof schema.description === 'string' ? schema.description : ''
      // The running Inbox says Bro mode is on by carrying the line in the field these words stand in for.
      properties[name] = { ...schema, description: (own === undefined ? served : served.includes(INBOX_BRO_LINE) ? inboxBodyWithBro(own) : own).trim() }
    }
  }
  for (const [name, users] of usedBy) {
    const schema = properties[name]!
    properties[name] = { ...schema, description: `(${users.join(', ')}) ${schema.description}`.trim() }
  }
  return { name: INBOX_TOOL_NAME, description, inputSchema: { type: 'object', properties, required: ['action'], additionalProperties: false } }
}

/**
 * A string that reads as a piece of JSON rather than a value: it opens with
 * `{"` or `["`, or holds a quote, a comma or colon, and another quote or
 * bracket (`", "` or `": [`), which is what is left when a value's quoting
 * broke and the rest of the call ran into it.
 */
const INBOX_JSON_FRAGMENT_RE = /^\s*[{[]\s*"|"\s*[,:]\s*["[{]/

/**
 * Whether an agent tool call with no action the Inbox has reads as input
 * that never arrived as fields (an agent's call with broken quoting, which a
 * host hands over empty, as one leftover field, or with the rest of the call
 * inside a value), rather than a readable call that names no action or a
 * wrong one: an action holding quotes, brackets, colons or commas; or no
 * action and nothing at all, only fields no Inbox tool takes, or a value
 * that holds JSON.
 */
export function inboxInputUnread(input: Record<string, unknown>, tools: readonly InboxToolInfo[]): boolean {
  const { action, ...rest } = input
  if (typeof action === 'string') return /["{}[\]:,\n]/.test(action)
  if (action !== undefined) return false
  const keys = Object.keys(rest)
  if (keys.length === 0) return true
  const known = new Set(tools.flatMap((tool) => Object.keys(propertiesOf(tool))))
  if (keys.every((key) => !known.has(key))) return true
  return Object.values(rest).some((value) => typeof value === 'string' && INBOX_JSON_FRAGMENT_RE.test(value))
}

/** What an agent tool call whose input did not arrive as fields answers: what arrived, the quoting to check, a call that reads, and the actions. */
export function inboxUnreadInputText(input: unknown, tools: readonly InboxToolInfo[]): string {
  let got: string
  if (input === null || input === undefined) got = 'it arrived empty'
  else if (typeof input !== 'object') got = `it arrived as a ${typeof input}, not fields`
  else if (Array.isArray(input)) got = 'it arrived as a list, not fields'
  else {
    const keys = Object.keys(input)
    const named = keys.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40))).join(', ')
    got = keys.length === 0 ? 'it arrived empty' : `it arrived as ${named}${keys.length > 3 ? ` and ${keys.length - 3} more` : ''}`
  }
  return `Invalid plannotator_inbox call: its input could not be read as fields (${got}). Check the JSON quoting and call again: every field is its own key and every string value is in double quotes, e.g. {"action": "send_message", "body": "…", "supersedes": ["msg_…/q-…"]}. action is one of ${tools.map((tool) => tool.name).join(', ')}.`
}

/**
 * The key Claude Code hands a tool call under when it could not parse the
 * model's JSON: `{"__unparsedToolInput": {"raw": "<the model's text>", "len":
 * <its length>}}`, `raw` cut at 2,048 characters. A session sent the same
 * call with a bare `"supersedes": msg_…/q-…,` six times this way and was
 * told only "action must be one of …".
 */
export const INBOX_UNPARSED_INPUT_KEY = '__unparsedToolInput'

/** What a host's unparsed wrapper holds: the model's text and its full length (absent: as long as `raw`). */
function unparsedInputOf(input: unknown): { raw: string; len: number } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const wrapper = (input as Record<string, unknown>)[INBOX_UNPARSED_INPUT_KEY]
  if (!wrapper || typeof wrapper !== 'object') return null
  const { raw, len } = wrapper as { raw?: unknown; len?: unknown }
  if (typeof raw !== 'string') return null
  return { raw, len: typeof len === 'number' && Number.isFinite(len) && len > raw.length ? len : raw.length }
}

/** An Inbox id an agent writes bare: a message id, optionally with a question or action item key. */
const INBOX_BARE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}(?:\/[aq]-[0-9a-f]{8}(?:-\d{1,3})?)?$/

/**
 * Where JSON text first fails to read, by a small reader of its own (an
 * engine's parse error may not give a position): the character offset, what
 * is wrong there (`bare`: a value with no quotes; `unterminated`: a string
 * that never ends; `unexpected`: anything else), the field being read, and,
 * for `bare`, the token. Null when the text reads.
 */
function jsonFailure(text: string): { at: number; kind: 'bare' | 'unterminated' | 'unexpected'; field: string | null; token?: string } | null {
  let i = 0
  let field: string | null = null
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++
  }
  const fail = (kind: 'bare' | 'unterminated' | 'unexpected', at = i, token?: string) => ({ at, kind, field, ...(token ? { token } : {}) })
  type Failure = ReturnType<typeof fail>
  const str = (): Failure | string => {
    const start = i++
    let out = ''
    while (i < text.length) {
      const c = text[i]!
      if (c === '"') {
        i++
        return out
      }
      if (c === '\\') i++
      else if (c < ' ') return fail('unexpected', i)
      out += c
      i++
    }
    return fail('unterminated', start)
  }
  const value = (): Failure | null => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return (i++, null)
      for (;;) {
        ws()
        if (text[i] !== '"') return fail('unexpected')
        const key = str()
        if (typeof key !== 'string') return key
        ws()
        if (text[i] !== ':') return fail('unexpected')
        i++
        const outer = field
        field = key
        const inner = value()
        if (inner) return inner
        ws()
        // A failure right after the value is still about this field (an inner quote with no backslash).
        if (text[i] !== ',' && text[i] !== '}') return fail('unexpected')
        field = outer
        if (text[i++] === '}') return null
      }
    }
    if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return (i++, null)
      for (;;) {
        const inner = value()
        if (inner) return inner
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') return (i++, null)
        return fail('unexpected')
      }
    }
    if (c === '"') {
      const read = str()
      return typeof read === 'string' ? null : read
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?![A-Za-z0-9_\/-])/.exec(text.slice(i))
    if (literal) return (i += literal[0].length, null)
    const bare = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*/.exec(text.slice(i))
    return bare ? fail('bare', i, bare[0]) : fail('unexpected')
  }
  const failure = value()
  if (failure) return failure
  ws()
  return i < text.length ? fail('unexpected') : null
}

/** About 40 characters of `text` around `at`, on one line, with an arrow after the spot. */
function spotOf(text: string, at: number, end: number): string {
  const line = (part: string) => part.replace(/\s+/g, ' ')
  return `${at > 20 ? '…' : ''}${line(text.slice(Math.max(0, at - 20), end))} ←`
}

/**
 * A call Claude Code could not parse (INBOX_UNPARSED_INPUT_KEY), read again:
 * when the text is whole, each bare value that is an Inbox id
 * (`msg_…/q-…`) or an action name gets its quotes (and a bare id in a
 * field that takes a list becomes a one-item list), and a text that then
 * reads is the call, with a line saying what was read. Only those shapes are
 * mended. Otherwise the refusal names the spot: the character and the text
 * around it, or, when the host cut the text, the field the cut fell in.
 */
function readUnparsedInput(
  unparsed: { raw: string; len: number },
  tools: readonly InboxToolInfo[],
): { input: Record<string, unknown>; note?: string } | { error: string } {
  const { raw, len } = unparsed
  const actions = new Set<string>([...tools.map((tool) => tool.name), ...INBOX_TOOL_ACTIONS])
  const lists = new Set(tools.flatMap((tool) => Object.entries(propertiesOf(tool)).filter(([, schema]) => schema.type === 'array').map(([name]) => name)))
  if (raw.length >= len) {
    let text = raw
    const mended: { field: string | null; value: string }[] = []
    for (let tries = 0; tries < 20; tries++) {
      const failure = jsonFailure(text)
      if (!failure) break
      const token = failure.kind === 'bare' ? failure.token! : ''
      const id = INBOX_BARE_ID_RE.test(token)
      if (!id && !(failure.field === 'action' && actions.has(token))) break
      const inList = /\[\s*$/.test(text.slice(0, failure.at)) || /,\s*$/.test(text.slice(0, failure.at)) && mended.some((m) => m.field === failure.field)
      const quoted = JSON.stringify(token)
      const wrap = id && !inList && failure.field !== null && lists.has(failure.field)
      text = text.slice(0, failure.at) + (wrap ? `[${quoted}]` : quoted) + text.slice(failure.at + token.length)
      mended.push({ field: failure.field, value: wrap ? `[${quoted}]` : quoted })
    }
    if (!jsonFailure(text)) {
      const input = JSON.parse(text) as unknown
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        if (mended.length === 0) return { input: input as Record<string, unknown> }
        const fields = [...new Set(mended.map((m) => m.field ?? 'a value'))].join(', ')
        const read = mended.map((m) => m.value).join(', ')
        return {
          input: input as Record<string, unknown>,
          note: `Your call's JSON had ${mended.length === 1 ? 'an unquoted value' : 'unquoted values'} (${fields}); ${mended.length === 1 ? 'it was' : 'they were'} read as ${read}. Quote every string value.`,
        }
      }
    }
  }
  const failure = jsonFailure(raw)
  const prefix = 'Invalid plannotator_inbox call: '
  if (raw.length < len && (!failure || failure.at >= raw.length - 1 || failure.kind === 'unterminated')) {
    const where = failure?.field ? `inside ${failure.field}` : 'past what arrived'
    const what = failure?.field ?? 'the long text'
    return {
      error: `${prefix}this call was ${len} characters and only the first ${raw.length} arrived readable; the JSON breaks ${where}. Check that quotes and backslashes inside ${what} are escaped, or send a shorter ${what} and attach the rest as a file.`,
    }
  }
  if (!failure) return { error: inboxUnreadInputText({ [INBOX_UNPARSED_INPUT_KEY]: null }, tools) }
  if (failure.kind === 'bare') {
    return { error: `${prefix}this call's JSON couldn't be read at character ${failure.at}: ${spotOf(raw, failure.at, failure.at + Math.min(failure.token!.length, 20))} this value needs double quotes. Fix that spot and call again.` }
  }
  if (failure.kind === 'unterminated') {
    return { error: `${prefix}this call's JSON couldn't be read at character ${failure.at}: ${spotOf(raw, failure.at, failure.at + 20)} this string never ends. Check that quotes and backslashes inside ${failure.field ?? 'it'} are escaped, then call again.` }
  }
  // A string that ended before the text did (`"He said "ship it""`): an inner quote with no backslash.
  const endedEarly = /"\s*$/.test(raw.slice(0, failure.at)) && /^[^\s,:}\]]/.test(raw.slice(failure.at))
  const why = endedEarly ? `the string before this spot ended early: a double quote inside ${failure.field ?? 'a string'} needs a backslash (\\").` : 'here.'
  return { error: `${prefix}this call's JSON couldn't be read at character ${failure.at}: ${spotOf(raw, failure.at, failure.at + 1)} ${why} Fix that spot and call again.` }
}

/**
 * The Inbox tool call an agent tool call stands for: the action's own fields
 * (any other field is refused, naming the action's fields) plus the filled
 * arguments that tool takes. An agent's own `project_path` (shape-checked
 * here) comes back as `projectPath`, with the working folder still in
 * `arguments`: the connection resolves it against that folder, refuses a
 * path that is not an existing folder, and puts the result in
 * `arguments.project_path` before calling the Inbox. A call the host could
 * not parse (INBOX_UNPARSED_INPUT_KEY) is read again first; when a bare id
 * or action name was mended, `note` says so and the connection puts it
 * after the result (inboxResultWithNote).
 */
export function inboxToolCall(
  input: unknown,
  tools: readonly InboxToolInfo[],
  filled: InboxFilledArguments,
): { name: string; arguments: Record<string, unknown>; projectPath?: string; note?: string } | { error: string } {
  const unparsed = unparsedInputOf(input)
  if (unparsed) {
    const read = readUnparsedInput(unparsed, tools)
    if ('error' in read) return read
    const call = inboxToolCall(read.input, tools, filled)
    if (!read.note) return call
    return 'error' in call ? { error: `${call.error} (${read.note})` } : { ...call, note: read.note }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: inboxUnreadInputText(input, tools) }
  const { action, ...rest } = input as Record<string, unknown>
  if (action === INBOX_REMOVED_ACTION) return { error: INBOX_REMOVED_ACTION_TEXT }
  const tool = tools.find((candidate) => candidate.name === action)
  if (!tool) {
    if (inboxInputUnread(input as Record<string, unknown>, tools)) return { error: inboxUnreadInputText(input, tools) }
    return {
      error: `Invalid plannotator_inbox call: action must be one of ${tools.map((candidate) => candidate.name).join(', ')}${typeof action === 'string' && (INBOX_TOOL_ACTIONS as readonly string[]).includes(action) ? ` (this Plannotator Inbox has no ${action}; update Plannotator for it)` : ''}.`,
    }
  }
  const own = propertiesOf(tool)
  const args: Record<string, unknown> = {}
  let projectPath: string | undefined
  for (const [name, value] of Object.entries(rest)) {
    if (value === undefined) continue
    if (name === INBOX_AGENT_PROJECT_PATH && name in own) {
      const refusal = inboxProjectPathShapeRefusal(value)
      if (refusal) return { error: `Invalid plannotator_inbox call: ${refusal}` }
      projectPath = value as string
      continue
    }
    if (!(name in own) || isFilled(name)) {
      const fields = Object.keys(own).filter((field) => !isFilled(field) || field === INBOX_AGENT_PROJECT_PATH)
      return { error: `Invalid plannotator_inbox call: ${tool.name} takes no "${name}" (its fields: ${fields.join(', ') || 'none'}).` }
    }
    args[name] = value
  }
  for (const name of INBOX_FILLED_ARGUMENTS) if (name in own) args[name] = filled[name]
  return projectPath === undefined ? { name: tool.name, arguments: args } : { name: tool.name, arguments: args, projectPath }
}

/** A tool result's text with a call's `note` (inboxToolCall) after it, on a line of its own; unchanged without one. */
export function inboxResultWithNote(text: string, note: string | undefined): string {
  return note ? `${text}\n\n${note}` : text
}

/**
 * The `_meta` key an Inbox sets to `true` on a tool result whose text already
 * says everything its structured content holds (read_thread, search): a
 * compact transcript the model reads instead of JSON. A
 * connection then hands the model the text alone. An older connection does
 * not know the key and appends the structured content as before, which the
 * Inbox keeps to the same trimmed shape.
 */
export const INBOX_TEXT_COMPLETE_META_KEY = 'ai.plannotator/text-complete'

/**
 * An MCP `tools/call` result as the text the agent tool answers with: the
 * text, then any structured content as compact JSON (no indentation: it can
 * be most of the bytes the model reads), unless the Inbox marked the text
 * complete (INBOX_TEXT_COMPLETE_META_KEY).
 */
export function inboxToolResultText(result: unknown): { text: string; isError: boolean } {
  const value = result && typeof result === 'object' ? (result as { content?: unknown; structuredContent?: unknown; isError?: unknown; _meta?: unknown }) : {}
  const text = Array.isArray(value.content)
    ? value.content
        .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
        .filter(Boolean)
        .join('\n')
    : ''
  const meta = value._meta && typeof value._meta === 'object' ? (value._meta as Record<string, unknown>) : {}
  const complete = meta[INBOX_TEXT_COMPLETE_META_KEY] === true
  const structured = !complete && value.structuredContent && typeof value.structuredContent === 'object' ? `\n\n${JSON.stringify(value.structuredContent)}` : ''
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

/**
 * The one bound on a request body the Inbox reads, `/mcp` included: Bun's own
 * default for `Bun.serve`, made explicit, and handed to the MCP SDK, whose
 * default (4 MiB) refused ordinary large messages. A body is read whole and
 * parsed in memory, so the long-lived Inbox that holds every thread keeps a
 * bound; under it a message works, over it the request is refused at once
 * with {@link inboxRequestTooLargeMessage}, never left to time out.
 */
export const INBOX_MAX_REQUEST_BYTES = 128 * 1024 * 1024

/** The refusal for a request over {@link INBOX_MAX_REQUEST_BYTES}, naming the bound. */
export function inboxRequestTooLargeMessage(bytes?: number): string {
  const size = bytes === undefined ? '' : ` (${bytes} bytes)`
  return `The message is too large for the Plannotator Inbox${size}: one request may carry at most ${INBOX_MAX_REQUEST_BYTES} bytes (128 MiB). Send a smaller message, or attach the content as a file.`
}

/** {@link mcpAnswerOf} with the HTTP status: an unreadable 413 (the server's own refusal, no body) is the request bound. */
export function mcpAnswerOfResponse(status: number, text: string): { result?: unknown; error?: { message?: string } } | null {
  return mcpAnswerOf(text) ?? (status === 413 ? { error: { message: inboxRequestTooLargeMessage() } } : null)
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

/**
 * One thing the person sent the polling session: a `reply` to a message it
 * sent, or a `message` the person wrote to it with New message (plan step 8),
 * which answers nothing (`reply_to` null). Both are delivered the same way.
 */
export interface InboxReplyCommand {
  type: 'reply' | 'message'
  /** The person's reply or message (a `msg_` id). */
  id: string
  thread_id: string
  /** The agent message a reply answers; null for a message. */
  reply_to: string | null
  /**
   * The title a wake shows, as the Inbox decided it (`InboxStore.agentTitle`):
   * on a plain reply the thread's short name, or null when it has none, which
   * every connection words `a reply`; on everything else the thread's
   * subject. An older Inbox always sends the subject here.
   */
  subject: string | null
  /** The reply or message, markdown, verbatim. */
  body: string
  /** The thread in the Inbox page. */
  url: string
  /**
   * On a reply the person sent to this session because the session that
   * asked had ended (they picked this one at Send): the asking agent's name,
   * e.g. `Claude Code`. Absent on every other reply and message.
   */
  redirected_from?: string | null
  /**
   * On a `message` that starts a new thread the person wrote (compose): the
   * wake takes INBOX_NEW_THREAD_INSTRUCTION instead of the New message line.
   * An older connection ignores it and words it as a New message, which is
   * still true. Absent on every other command.
   */
  new_thread?: boolean
  /**
   * On words the person added to a thread they started, handed to a session
   * that has seen nothing of that thread (the person moved them to another
   * session): the wake says to read the thread first (`inboxContinuesLine`).
   * Absent on every other command.
   */
  continues_thread?: boolean
  /**
   * In a thread the person started that has no name yet, on a command handed
   * to a session that may name it (`InboxStore.canNameThread`: the session it
   * is addressed to): the wake adds INBOX_NAME_THREAD_LINE. Absent once a name
   * is set (by the person in compose, or by an agent) and on every other
   * command; an older connection ignores it.
   */
  name_thread?: boolean
  /**
   * The person pressed Send now in the Inbox: deliver it at once, into the
   * running turn when one runs (Claude Code: `$.session.append`; Pi: a
   * steer; OpenCode 2: `delivery: "steer"`), instead of waiting for the
   * session to go idle. Only handed to a connection whose poll said it can
   * (`INBOX_SEND_NOW_POLL_FIELD`). Absent on every other command.
   */
  now?: boolean
  /**
   * On the person's 👍 Looks good, delivered once its Undo window passed
   * (amended 2026-10-16: it reaches the agent): the agent message they
   * marked. The wake is `inboxAckLine` instead of a reply's instruction and
   * words. The command stays a `reply`, so an older connection still
   * delivers it, with its body (the same line) as the person's words.
   * Absent on every other command.
   */
  ack_of?: string
  /**
   * With `ack_of`: the emoji the person reacted with from the 👍's tray
   * (approval "inbox-reaction-tray"), the one they ended on when the Undo
   * window closed, with their name for it when it has one. The wake is
   * `inboxAckLine` with it. Absent for 👍 Looks good.
   */
  ack_reaction?: { emoji: string; label?: string }
  /**
   * On a reply handed to a session the person tagged with `@` that does not
   * own the thread (approval "inbox-tag-agents"): the owning session's agent,
   * named from its host (`Claude Code`). The wake takes
   * INBOX_TAGGED_INSTRUCTION and `inboxTaggedLine` instead of the reply's
   * instruction: it reads the thread first and answers only what is addressed
   * to it. Only handed to a connection whose poll said it understands tags
   * (`INBOX_TAGS_POLL_FIELD`), so an older one never words it as a reply to
   * it. Absent on every other command.
   */
  tagged?: { owner: string }
  /**
   * On a reply that tags other sessions, handed to its owner: those sessions'
   * agents, named from their hosts. The wake adds `inboxAlsoTaggedLine`. An
   * older connection ignores it, and its wake ("the person replied to you")
   * stays true. Absent on every other command.
   */
  also_tagged?: string[]
  /**
   * With `tagged`, on a reply that tags a session the person ADDED to the
   * thread ("Add instead", approval "inbox-tag-handoff"): it works alongside
   * the owner and gets the person's later replies there too. The wake takes
   * INBOX_ADDED_INSTRUCTION and `inboxAddedLine`. An older connection words
   * it as a tag, which stays true for this one reply. Absent otherwise.
   */
  added?: boolean
  /**
   * On a reply that hands the thread to this session ("Hand off instead"):
   * the former owner's agent, named from its host. The wake takes
   * INBOX_HANDOFF_INSTRUCTION and `inboxHandoffLine`. An older connection
   * words it as a reply to it, which is true. Absent otherwise.
   */
  handoff?: { from: string }
  /**
   * The former owner's notice on a hand-off: the new owner's agent, named
   * from its host. The body is `inboxHandedAwayLine` (so an older connection
   * still says it), and the wake is that line alone. Absent otherwise.
   */
  handed_away?: { to: string }
  /**
   * On the person's Re-ask note (approval "inbox-reask"): they asked the
   * session to ask its open questions in the thread again, together in one
   * message. The wake takes INBOX_REASK_INSTRUCTION instead of the reply's
   * line ("it is their answer to you" would not be true); the body lists the
   * questions and what to do. The command stays a `reply`, so an older
   * connection still delivers it, with the reply's line. Absent on every
   * other command.
   */
  reask?: boolean
  /**
   * On a Re-ask note that lists action items (#2059): `actions` when it lists
   * only action items, `both` when questions too. The wake then names what
   * the note lists (`inboxReaskInstruction`). Absent when it lists only
   * questions, so that wake stays INBOX_REASK_INSTRUCTION byte for byte; an
   * older connection ignores it and words every Re-ask as questions.
   */
  reask_items?: 'actions' | 'both'
  /**
   * On a Re-ask note that lists exactly one question or action item (owner,
   * 2026-10-23: Re-ask shows for one question too): the wake words it in the
   * singular (`inboxReaskInstruction`). Absent when the note lists more, so
   * those wakes stay as they were; an older connection ignores it and words
   * the wake in the plural, while the body still names the one question.
   */
  reask_one?: boolean
  /**
   * On the person's Tidy (2026-10-28): the body is the whole wake under its
   * first line (it opens with the Tidy instruction and lists the session's
   * threads), so the wake adds no instruction line and names no one thread.
   * The command is a `message`, so an older connection words it as a New
   * message and the body still says what it is. Absent on every other command.
   */
  tidy?: boolean
  /**
   * The receiving session's steps in this thread (approval
   * "inbox-thread-steps"), only while the person has steps on and the session
   * keeps a list there: the wake adds `inboxStepsWakeLine`. Absent otherwise;
   * an older connection ignores it.
   */
  steps?: { done: number; total: number; doing: string | null }
  /**
   * What the person changed in the thread's PRs since the receiving session
   * last saw them (approval "inbox-pr-binding"), each PR as an agent writes
   * it: the wake adds `inboxPullsWakeLine`. Only on a wake for the thread's
   * owner; absent otherwise, and an older connection ignores it.
   */
  pulls_changed?: { added: string[]; removed: string[] }
  /**
   * The person's reply answers the receiving session's questions in a thread
   * where it keeps no checklist, while the person has steps on: the wake adds
   * INBOX_STEPS_START_WAKE_LINE. Absent otherwise (and always with `steps`);
   * an older connection ignores it.
   */
  steps_start?: true
  /**
   * What the wake's details line says about the thread (approval
   * "inbox-wake-context"). Absent on a Tidy, a 👍, a hand-off notice and a
   * brand new thread; an older connection ignores it and delivers `body` as
   * it always did. Without it (an older Inbox too) the wake still names the
   * thread, `[Thread <id>]`, and `body` stays whole.
   */
  context?: InboxWakeContext
}

/** A command's `context`: the thread at the moment the Inbox handed the command over. */
export interface InboxWakeContext {
  /** The thread's messages, as read_thread counts them. */
  messages: number
  /** What waits on the person in the thread, as read_thread's header lists it. */
  open_questions: number
  open_actions: number
  /** When the session this goes to last wrote in the thread. Absent when it never did. */
  last_agent_at?: string
  /** The session's own message the person answered, only when it is not the session's latest. */
  replying_to?: InboxWakeReplyingTo
  /**
   * The still-open sentence `body` carries for a connection that has no
   * details line (`inboxStillOpenLine`): this connection's wake leaves it out.
   * `body` stays as stored, so an older connection still says it.
   */
  still_open_line?: string
  /** Where in `body` the store wrote it: the wake takes out that paragraph only, never words the person typed. */
  still_open_at?: number
}

export interface InboxWakeReplyingTo {
  id: string
  at: string
  /** About its first ten words, plain text. Without one, the wake counts what the message asked instead. */
  quote?: string
  questions?: number
  actions?: number
}

/**
 * The poll field (`true`) by which a connection says it understands a reply
 * it was tagged in (`tagged` on a command): only such a session can be tagged,
 * and only it is handed what it was tagged in. An older connection never sends
 * it; the window then says to update Plannotator to tag that session.
 */
export const INBOX_TAGS_POLL_FIELD = 'tags'

/**
 * The most of a poll's `label` (the session's name) anyone looks at, in
 * characters (code points): a client keeps no longer a name, and the server
 * reads no further before it cleans and cuts the label to what it shows.
 */
export const INBOX_SESSION_LABEL_INPUT_MAX = 200

/**
 * The fixed second line of the wake of a session the person tagged in a
 * thread another session owns: not a reply to anything it asked.
 */
export const INBOX_TAGGED_INSTRUCTION =
  "The person tagged you in a Plannotator Inbox thread that another session owns. Their reply follows as they wrote it; parts of it may be meant for the other session, not for you."

/**
 * The line under INBOX_TAGGED_INSTRUCTION: whose thread it is, read it first,
 * and answer only your part, in the thread.
 */
export function inboxTaggedLine(owner: string, id: string): string {
  return `The thread belongs to another session (${owner}); you have not seen it. Read it first with read_thread (message_id ${id}). Answer only what is addressed to you, in the same thread: plannotator_inbox send_message with reply_to ${id}.`
}

/** The line under the instruction on the owner's wake of a reply that tags other sessions. */
export function inboxAlsoTaggedLine(names: readonly string[]): string {
  const list = names.length <= 1 ? (names[0] ?? 'another session') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `This reply also tags ${list} (other sessions); each gets it too. Leave what is addressed to them to them.`
}

/**
 * The fixed second line of the wake of a session the person added to a
 * thread another session owns ("Add instead", approval "inbox-tag-handoff").
 */
export const INBOX_ADDED_INSTRUCTION =
  "The person added you to a Plannotator Inbox thread that another session owns: you work on it alongside that session, and their later replies in it come to you too. Their reply follows as they wrote it; parts of it may be meant for the other session."

/** The line under INBOX_ADDED_INSTRUCTION: whose thread it is, read it first, answer in it. */
export function inboxAddedLine(owner: string, id: string): string {
  return `The thread's owner is ${owner}. If you have not read the thread yet, read it first with read_thread (message_id ${id}). Answer your part in the same thread: plannotator_inbox send_message with reply_to ${id}.`
}

/**
 * The fixed second line of the wake of a session the person handed a thread
 * to ("Hand off instead", approval "inbox-tag-handoff").
 */
export const INBOX_HANDOFF_INSTRUCTION =
  "The person handed you this Plannotator Inbox thread: it is yours now, and their later replies in it come to you. Their reply follows as they wrote it."

/** The line under INBOX_HANDOFF_INSTRUCTION: who had it, read it first, answer in it. */
export function inboxHandoffLine(from: string, id: string): string {
  return `Another session (${from}) had this thread before; you have not seen it. Read it first with read_thread (message_id ${id}), then answer in it: plannotator_inbox send_message with reply_to ${id}.`
}

/** The whole notice the former owner of a handed-off thread gets (and the body of its command). */
export function inboxHandedAwayLine(to: string): string {
  return `The person handed this thread to another session (${to}); their later replies in it go there. Stop work on it, and write in it only if they ask you to.`
}

/**
 * The only agent names a wake line may carry about ANOTHER agent (the owner
 * a tagged session is told about, the sessions also tagged, the session that
 * asked a redirected reply): the hosts' own names. An agent chooses its own
 * host string, and these lines go into another session's prompt, so any
 * other value reads as "another agent" (`agent` in the redirected line).
 */
export const INBOX_WAKE_AGENT_NAMES: readonly string[] = ['Claude Code', 'Pi', 'OpenCode', 'Codex', 'Cursor', 'Grok Build', 'Qwen Code']

/** An agent name a wake line carries: one of INBOX_WAKE_AGENT_NAMES (spacing folded), else '' (the caller says "another agent"). */
function wakeName(value: unknown): string {
  if (typeof value !== 'string') return ''
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
  return INBOX_WAKE_AGENT_NAMES.includes(name) ? name : ''
}

/**
 * The poll field (`true`) by which a connection says it can deliver a reply
 * into a running turn: the window offers Send now only for such a session.
 * An older Inbox ignores it; an older connection never sends it, so it is
 * never offered there.
 */
export const INBOX_SEND_NOW_POLL_FIELD = 'send_now'

/**
 * The poll and `state` field (`true`) by which the Claude Code mod says its
 * session refused the reply it tried to put in, and holds every reply until
 * the person types there: Claude Code drops a plugin's prompt after the
 * person stopped the session, until their own next input (#2780). The window
 * words a waiting reply "Stopped: goes in when you type in that session"
 * (approval "inbox-stopped-reply"). `false` on a `state` event clears it.
 * An older Inbox ignores it; an older connection never sends it.
 */
export const INBOX_HELD_POLL_FIELD = 'held'

/**
 * The poll field by which a connection says which session ids its
 * conversation continues, nearest first (a string, or a list of at most 8):
 * the host gave the conversation a new session id (Claude Code's branch of a
 * conversation, whose transcript names the session it came from, and its
 * hand-over to a new session, which the old transcript records). Set by the
 * host from its own records, never by the model: it is no tool argument.
 * While a session it names is not live, the Inbox hands this session what
 * waits for that one (packages/server/inbox-continuations.ts); a session that
 * still polls keeps its own. An older Inbox ignores it; an older connection
 * never sends it.
 */
export const INBOX_CONTINUES_POLL_FIELD = 'continues'

/**
 * The poll field by which a connection says the title its host generated for
 * the session (Claude Code's `ai-title`, a summary of the first prompt), apart
 * from `label`, the name the person gave. The Inbox's list rows show it for a
 * session the person never named (option A, 2026-11-10); every other place
 * reads `label` alone. Sent on every poll; empty or absent clears it. Display
 * only, cleaned like `label`. An older Inbox ignores it; an older connection
 * never sends it.
 */
export const INBOX_TITLE_POLL_FIELD = 'title'

/**
 * On a poll, the connection's tick goes on polling while a steer waits for the running turn. A connection without it
 * (from before that) stops polling until the steer goes in, so the Inbox counts a session it handed one as there.
 * An older Inbox ignores it.
 */
export const INBOX_STEER_POLLS_POLL_FIELD = 'steer_polls'

/**
 * The poll field (`true`) by which a connection says it can answer Ask AI
 * live. An older connection never sends it, so a question never waits for it.
 */
export const INBOX_ASK_POLL_FIELD = 'ask'

/**
 * Set (`true`) on every poll answer while a question waits for this session
 * and its Ask AI client has not connected, and a held poll ends at once. The
 * connection then runs the client against `inboxAskBridgeBase(session)`, with
 * the Inbox's token, until the Inbox says `closing`. It is a state, not an
 * event: a poll answer that does not read it loses nothing.
 */
export const INBOX_ASK_WAITS_FIELD = 'ask_waits'

export const INBOX_ASK_BRIDGE_PREFIX = '/api/inbox/ask/'

/** Where a session's Ask AI client talks to the Inbox: the pull bridge's two paths go after it. */
export function inboxAskBridgeBase(session: string): string {
  return `${INBOX_ASK_BRIDGE_PREFIX}${encodeURIComponent(session)}`
}

export function parseInboxAskWaits(text: string): boolean {
  try {
    return (JSON.parse(text) as Record<string, unknown>)[INBOX_ASK_WAITS_FIELD] === true
  } catch {
    return false
  }
}

/**
 * The poll field (`true`) by which a Claude Code connection says it reloads
 * Plannotator by itself (`/reload-plugins`, owner approval "cc-auto-reload")
 * when a poll answer carries INBOX_RELOAD_FIELD. An older connection never
 * sends it, so it is never told.
 */
export const INBOX_AUTO_RELOAD_POLL_FIELD = 'auto_reload'

/**
 * Set on a poll answer to a connection that sent INBOX_AUTO_RELOAD_POLL_FIELD
 * while the Inbox judges its session outdated and a reload brings it up to
 * date (`claudeSessionOutdated`, fix `restart`): `{ installed }`, the version
 * a reload loads (null when the registry names none). A state, said on every
 * answer: an answer without it says no reload is needed.
 */
export const INBOX_RELOAD_FIELD = 'reload'

export interface InboxReloadOffer {
  installed: string | null
}

export function parseInboxReloadOffer(text: string): InboxReloadOffer | null {
  try {
    const value = (JSON.parse(text) as Record<string, unknown>)[INBOX_RELOAD_FIELD]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const installed = (value as Record<string, unknown>).installed
    return { installed: typeof installed === 'string' && installed.trim() && installed.length <= 64 ? installed.trim() : null }
  } catch {
    return null
  }
}

/**
 * The turn a connection submits when a reply it put into a running turn
 * arrived as that turn ended, so the model never read it: the reply is in
 * the conversation already, so this only points at it.
 */
export function inboxSentNowFollowUpText(command: Pick<InboxReplyCommand, 'id' | 'subject' | 'type'>): string {
  const subject = (command.subject ?? '').replace(/\s+/g, ' ').trim() || (command.type === 'message' ? 'a message' : 'a reply')
  return `Plannotator Inbox: ${subject} (${command.id})\nThe person's ${command.type === 'message' ? 'message' : 'reply'} above (${command.id}) arrived as your last turn was ending. If you have not answered it yet, answer it now.`
}

export function parseInboxBridgeCommands(text: string): InboxReplyCommand[] {
  try {
    const body = JSON.parse(text) as { commands?: unknown }
    if (!Array.isArray(body.commands)) return []
    return body.commands.filter((command): command is InboxReplyCommand => {
      if (!command || typeof command !== 'object') return false
      const c = command as Record<string, unknown>
      return (c.type === 'reply' || c.type === 'message') && typeof c.id === 'string' && typeof c.thread_id === 'string' && typeof c.body === 'string'
    })
  } catch {
    return []
  }
}

/** The fixed second line of every wake: who is speaking, and how to answer. */
export const INBOX_WAKE_INSTRUCTION =
  "This is a user reply from Plannotator Inbox. Their reply follows as they wrote it: it is their answer to you. When they need to hear back, answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above."

/**
 * The fixed second line of a Re-ask wake (approval "inbox-reask"): the person
 * asked for the open questions again, in one message, and how to answer.
 */
export const INBOX_REASK_INSTRUCTION =
  "The person asked, from the Plannotator Inbox, for the open questions in this thread to be asked again, together in one new message. The questions and what to do with each follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above."

/** What a Re-ask note lists: only questions (absent), only action items, or both (#2059). */
export type InboxReaskItems = 'actions' | 'both' | undefined

const reaskWords = (items: InboxReaskItems): { what: string; they: string } =>
  items === 'actions'
    ? { what: 'open action items', they: 'The action items' }
    : items === 'both'
      ? { what: 'open questions and action items', they: 'They' }
      : { what: 'open questions', they: 'The questions' }

/** What a Re-ask note's ids (`<message id>/<key>`; an action item's key starts with a-) list. */
export function inboxReaskItemsOf(ids: readonly string[] | undefined): InboxReaskItems {
  const actions = (ids ?? []).filter((id) => id.includes('/a-')).length
  if (actions === 0) return undefined
  return actions === (ids ?? []).length ? 'actions' : 'both'
}

/**
 * The Re-ask wake's second line, naming only what the note lists. With only
 * questions, more than one, it is INBOX_REASK_INSTRUCTION byte for byte.
 * `one`: the note lists a single question or action item.
 */
export function inboxReaskInstruction(items: InboxReaskItems, one = false): string {
  if (one && items !== 'both') {
    const what = items === 'actions' ? 'action item' : 'question'
    return `The person asked, from the Plannotator Inbox, for the open ${what} in this thread to be asked again, in one new message. The ${what} and what to do with it follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.`
  }
  if (items !== 'actions' && items !== 'both') return INBOX_REASK_INSTRUCTION
  const { what, they } = reaskWords(items)
  return `The person asked, from the Plannotator Inbox, for the ${what} in this thread to be asked again, together in one new message. ${they} and what to do with each follow. Answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above.`
}

/**
 * The line under INBOX_REASK_INSTRUCTION on a Re-ask the person sent to this
 * session because the session that asked had ended: the questions are
 * another session's, and this one takes them over.
 */
export function inboxReaskRedirectedLine(asker: string, id: string, items?: InboxReaskItems, one = false): string {
  if (one && items !== 'both') {
    const what = items === 'actions' ? 'This action item' : 'This question'
    return `${what} was asked by another ${asker} session, which has ended; the person picked you to take it over. Read the thread first with read_thread (message_id ${id}), then ask it again as below if it is still needed.`
  }
  const these = items === 'actions' ? 'These action items' : items === 'both' ? 'These questions and action items' : 'These questions'
  return `${these} were asked by another ${asker} session, which has ended; the person picked you to take them over. Read the thread first with read_thread (message_id ${id}), then ask the ones still needed again as below.`
}

/** The fixed second line of a New message wake: the person wrote first, and how to answer. */
export const INBOX_MESSAGE_INSTRUCTION =
  "The person wrote to you from the Plannotator Inbox. Their message follows as they wrote it: it is from them, not from the Inbox. When they need to hear back, answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above."

/**
 * The fixed second line of a wake for a thread the person started from the
 * Inbox (compose): their own idea or request, not an answer to something the
 * agent asked, and possibly unrelated to its current work.
 */
export const INBOX_NEW_THREAD_INSTRUCTION =
  "The person started a new thread with you in the Plannotator Inbox: an idea or a request of their own, not an answer to something you asked. Their message follows as they wrote it. It may be unrelated to what you were doing; say how you will handle it before you start. When they need to hear back, answer in the same thread: plannotator_inbox send_message with reply_to set to the id in parentheses on the line above."

/**
 * The line under the instruction (and any redirected or continues line) on a
 * command that carries `name_thread`: the agent names the thread the person
 * started, with send_message's `thread` on its reply (approval
 * "inbox-agent-names-own-thread"; the name is the thread's chip).
 */
export const INBOX_NAME_THREAD_LINE =
  "Name this thread in your reply: pass `thread` with a few words saying what it is about. The first name you give sets it, once."

/**
 * The line under the instruction on a message that adds to a thread the
 * person started with another session: the session reading it has not seen
 * that thread, so it reads it first.
 */
export function inboxContinuesLine(id: string): string {
  return `This continues a thread the person started with another session; you have not seen it. Read it first with read_thread (message_id ${id}), then answer in it with reply_to ${id}.`
}

/**
 * The longest asking-agent name a redirected wake carries. The server names
 * it from the host (`Claude Code`); the wake takes only a host's own name
 * (INBOX_WAKE_AGENT_NAMES), because it goes into another session's prompt.
 */
export const INBOX_REDIRECTED_NAME_MAX = 40

/**
 * The line under the instruction on a reply written to another session that
 * has ended: the session reading it never asked, so it reads the thread first.
 */
export function inboxRedirectedLine(asker: string, id: string): string {
  return `This reply was written to another ${asker} session that has ended. Read the thread with read_thread to see what it asked, then answer with reply_to ${id}.`
}

/**
 * The person's reaction as a wake and read_thread say it (approval
 * "inbox-reaction-tray", addendum 2026-11-07T12:20Z: every reaction, 👍
 * included, is one quick label): one short emoji (pictographic, a flag or a
 * keycap) with no spaces or controls, and its name with controls made spaces
 * and invisible format characters taken out (the joiner emoji use stays), at
 * most 24 characters ('' when it has none). 👍 Looks good when there is no
 * reaction (an ack from before the tray, an older Inbox), when it is not one,
 * or for 👍 with no name.
 */
export function inboxAckReaction(value: unknown): { emoji: string; label: string } {
  const thumbs = { emoji: '👍', label: 'Looks good' }
  if (!value || typeof value !== 'object') return thumbs
  const { emoji, label } = value as { emoji?: unknown; label?: unknown }
  if (typeof emoji !== 'string' || emoji.length === 0 || emoji.length > 16 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji) || /[\s\p{Cc}\p{Cf}]/u.test(emoji.replace(/[\u200d\ufe0f\u{e0020}-\u{e007f}]/gu, ''))) return thumbs
  const text = typeof label === 'string' ? label.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/(?!\u200d)\p{Cf}/gu, '').replace(/\s+/g, ' ').trim() : ''
  const name = [...text].slice(0, 24).join('').trim()
  if (!name && emoji === '👍') return thumbs
  return { emoji, label: name }
}

/**
 * The whole of a reaction's wake under its first line, and the body of the
 * note the Inbox stores for it: the reaction the person ended on when the
 * Undo window closed (`inboxAckReaction`), with its name when it has one.
 */
export function inboxAckLine(messageId: string, reaction?: unknown): string {
  const picked = inboxAckReaction(reaction)
  return `The person reacted ${picked.emoji}${picked.label ? ` ${picked.label}` : ''} to your message (${messageId}).`
}

/**
 * The thread id a wake names: the Inbox's own id shape only (`msg_` + a ULID
 * today), so nothing else a command carries reaches the prompt there.
 * Anything else (an older Inbox without the field) is ''.
 */
function wakeThreadId(value: unknown): string {
  return typeof value === 'string' && /^msg_[0-9A-Za-z]{1,64}$/.test(value) ? value : ''
}

/** The closing line of every wake but a 👍's, after the body: how to read more, and where the Inbox explains itself. */
export const INBOX_WAKE_CLOSING_LINE = '[for context: read_thread (opt: set limit) or search · help: plannotator inbox --help]'

/** How long ago `at` was, in short plain words ("a minute ago", "11 hours ago"), or '' when it is not a time. */
export function inboxWakeAgo(at: unknown, now: number): string {
  const then = typeof at === 'string' ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((now - then) / 60_000)
  // Also a clock a little behind the writer's.
  if (minutes < 1) return 'just now'
  if (minutes < 2) return 'a minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 2) return 'an hour ago'
  if (hours < 24) return `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days < 2 ? 'a day ago' : `${days} days ago`
}

const wakeCount = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null)

const wakePlural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * `[Thread <id>: 14 messages, 1 question open, don't re-ask it. Your last
 * message was a minute ago]`, under the wake's first lines, or '' without the
 * Inbox's data (an older Inbox). A Re-ask asks for the questions again, so it
 * leaves out "don't re-ask". `queued`: the text goes into a host's queue and
 * may wait there through a turn, so it never says "nothing open": the agent
 * may have asked something by the time it reads this.
 */
export function inboxWakeDetailsLine(threadId: unknown, context: unknown, options: { now: number; reask?: boolean; queued?: boolean }): string {
  const thread = wakeThreadId(threadId)
  if (!thread || !context || typeof context !== 'object') return ''
  const { messages, open_questions, open_actions, last_agent_at } = context as Record<string, unknown>
  const count = wakeCount(messages)
  const questions = wakeCount(open_questions)
  const actions = wakeCount(open_actions)
  if (count === null || questions === null || actions === null) return ''
  const open: string[] = []
  if (questions > 0) open.push(`${wakePlural(questions, 'question')} open${options.reask ? '' : `, don't re-ask ${questions === 1 ? 'it' : 'them'}`}`)
  if (actions > 0) open.push(`${wakePlural(actions, 'action item')} open`)
  const state = open.join(', ') || (options.queued ? '' : 'nothing open')
  const ago = inboxWakeAgo(last_agent_at, options.now)
  return `[Thread ${thread}: ${wakePlural(count, 'message')}${state ? `, ${state}` : ''}${ago ? `. Your last message was ${ago}` : ''}]`
}

/**
 * Text an agent wrote, as a wake may quote it: one line, no control, format or
 * separator characters, and no brackets or double quotes, so it can neither
 * start another line of the wake nor end this one early.
 */
function wakeQuote(value: unknown): string {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\p{Cf}+/gu, '')
    .replace(/[[\]]/g, '')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...flat]
  return chars.length > 120 ? `${chars.slice(0, 120).join('').trimEnd()}…` : flat
}

/**
 * `[Replying to your message from 6 hours ago (<id>): "The first words…"]`, or,
 * with no words to quote, `…(<id>), with 3 questions]`. '' without the Inbox's data.
 */
export function inboxWakeReplyingLine(target: unknown, now: number): string {
  if (!target || typeof target !== 'object') return ''
  const { id, at, quote, questions, actions } = target as Record<string, unknown>
  const message = wakeThreadId(id)
  const ago = inboxWakeAgo(at, now)
  if (!message || !ago) return ''
  const head = `Replying to your message from ${ago} (${message})`
  const words = wakeQuote(quote)
  if (words) return `[${head}: "${words}"]`
  const asked: string[] = []
  if ((wakeCount(questions) ?? 0) > 0) asked.push(wakePlural(questions as number, 'question'))
  if ((wakeCount(actions) ?? 0) > 0) asked.push(wakePlural(actions as number, 'action item'))
  return `[${head}${asked.length > 0 ? `, with ${asked.join(' and ')}` : ''}]`
}

/**
 * The command as a wake with a details line words it: the body without the
 * still-open sentence, only when the details line says it instead (it prints,
 * and counts a question open). Otherwise, and when that sentence is all the
 * body holds, the body stays.
 */
export function inboxWakeCommand<T extends { body: string; thread_id?: unknown; context?: unknown }>(command: T): T {
  if (!command.context || typeof command.context !== 'object') return command
  const { still_open_line: line, still_open_at: at, ...context } = command.context as Record<string, unknown>
  if (typeof line !== 'string' || line === '') return command
  if (!inboxWakeDetailsLine(command.thread_id, context, { now: 0 }) || !wakeCount(context.open_questions)) return { ...command, context }
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !command.body.startsWith(line, at)) return { ...command, context }
  const end = at + line.length
  const alone = (at === 0 || command.body.slice(at - 2, at) === '\n\n') && (end === command.body.length || command.body.slice(end, end + 2) === '\n\n')
  if (!alone) return { ...command, context }
  const body = [command.body.slice(0, Math.max(0, at - 2)), command.body.slice(end + 2)].filter((part) => part !== '').join('\n\n')
  return { ...command, context, body: body === '' ? command.body : body }
}

/**
 * The turn a reply or a message becomes: `Plannotator Inbox: <title> (<id>)`
 * (the title is the command's `subject`, or `a reply` / `a message` without
 * one), the fixed instruction line for its type (a reply, a New message, or a
 * thread the person started; on a redirected reply, the line
 * saying so under it), the details and Replying to lines when the Inbox sent
 * their data (`inboxWakeDetailsLine`, `inboxWakeReplyingLine`), then the words
 * verbatim, then INBOX_WAKE_CLOSING_LINE. Never the thread re-sent. A 👍 Looks
 * good (`ack_of`) is the first line and `inboxAckLine`, closed by
 * `[thread <id>]` alone.
 */
export function inboxWakeText(
  command: Pick<InboxReplyCommand, 'id' | 'subject' | 'body'> & {
    type?: InboxReplyCommand['type']
    thread_id?: unknown
    redirected_from?: string | null
    new_thread?: boolean
    continues_thread?: boolean
    name_thread?: boolean
    ack_of?: string
    ack_reaction?: unknown
    tagged?: { owner?: unknown } | null
    also_tagged?: unknown
    added?: unknown
    handoff?: { from?: unknown } | null
    handed_away?: { to?: unknown } | null
    reask?: boolean
    reask_items?: unknown
    reask_one?: unknown
    tidy?: boolean
    steps?: unknown
    pulls_changed?: unknown
    steps_start?: unknown
    context?: unknown
  },
  now: number = Date.now(),
  wording: { queued?: boolean } = {},
): string {
  // Tidy: the body is the wake; it spans threads, so the closing line names none.
  if (command.tidy === true) {
    return `Plannotator Inbox: ${(command.subject ?? '').replace(/\s+/g, ' ').trim() || 'Tidy'} (${command.id})\n${command.body}\n\n${INBOX_WAKE_CLOSING_LINE}`
  }
  if (typeof command.ack_of === 'string' && command.ack_of !== '') {
    const ackSubject = (command.subject ?? '').replace(/\s+/g, ' ').trim() || 'a message'
    const thread = wakeThreadId(command.thread_id)
    return `Plannotator Inbox: ${ackSubject} (${command.id})\n${inboxAckLine(command.ack_of, command.ack_reaction)}${thread ? `\n\n[thread ${thread}]` : ''}`
  }
  // The session's steps in this thread (approval "inbox-thread-steps"), its own paragraph before the closing line;
  // with none there yet and the person's answers in this reply, the line that says when to start one.
  const steps = wakeSteps(command.steps)
  // What the person changed in the thread's PRs (approval "inbox-pr-binding"), its own paragraph too.
  const pulls = wakePullsChanged(command.pulls_changed)
  const stepsLine = steps ? inboxStepsWakeLine(steps) : command.steps_start === true ? INBOX_STEPS_START_WAKE_LINE : ''
  const closing = `${pulls ? `\n\n${inboxPullsWakeLine(pulls)}` : ''}${stepsLine ? `\n\n${stepsLine}` : ''}\n\n${INBOX_WAKE_CLOSING_LINE}`
  const { body, context } = inboxWakeCommand(command)
  const details = inboxWakeDetailsLine(command.thread_id, context, { now, reask: command.reask === true, queued: wording.queued === true })
  const target = details ? inboxWakeReplyingLine((context as { replying_to?: unknown }).replying_to, now) : ''
  // No details (a brand new thread, a hand-off notice, an older Inbox): the wake still names its thread.
  const thread = wakeThreadId(command.thread_id)
  const facts = details ? `\n${details}${target ? `\n${target}` : ''}` : thread ? `\n[Thread ${thread}]` : ''
  const subject = (command.subject ?? '').replace(/\s+/g, ' ').trim() || (command.type === 'message' ? 'a message' : 'a reply')
  // The thread was handed to another session: the notice alone.
  if (command.handed_away && typeof command.handed_away === 'object') {
    const to = wakeName(command.handed_away.to) || 'another agent'
    return `Plannotator Inbox: ${subject} (${command.id})\n${inboxHandedAwayLine(to)}${facts}${closing}`
  }
  // Handed this thread: it is this session's now; read it first.
  if (command.handoff && typeof command.handoff === 'object') {
    const from = wakeName(command.handoff.from) || 'another agent'
    return `Plannotator Inbox: ${subject} (${command.id})\n${INBOX_HANDOFF_INSTRUCTION}\n${inboxHandoffLine(from, command.id)}${facts}\n\n${body}${closing}`
  }
  // Tagged into a thread another session owns: what it is, then read the thread first.
  if (command.tagged && typeof command.tagged === 'object') {
    const owner = wakeName(command.tagged.owner) || 'another agent'
    if (command.added === true) {
      return `Plannotator Inbox: ${subject} (${command.id})\n${INBOX_ADDED_INSTRUCTION}\n${inboxAddedLine(owner, command.id)}${facts}\n\n${body}${closing}`
    }
    return `Plannotator Inbox: ${subject} (${command.id})\n${INBOX_TAGGED_INSTRUCTION}\n${inboxTaggedLine(owner, command.id)}${facts}\n\n${body}${closing}`
  }
  const others = Array.isArray(command.also_tagged)
    ? command.also_tagged
        .filter((name) => typeof name === 'string' && name.trim() !== '')
        .map((name) => wakeName(name) || 'another agent')
        .slice(0, 8)
    : []
  const also = others.length > 0 ? `\n${inboxAlsoTaggedLine(others)}` : ''
  const reaskItems: InboxReaskItems = command.reask_items === 'actions' || command.reask_items === 'both' ? command.reask_items : undefined
  const reaskOne = command.reask_one === true
  const instruction =
    command.type === 'message'
      ? command.new_thread === true
        ? INBOX_NEW_THREAD_INSTRUCTION
        : INBOX_MESSAGE_INSTRUCTION
      : command.reask === true
        ? inboxReaskInstruction(reaskItems, reaskOne)
        : INBOX_WAKE_INSTRUCTION
  const asker =
    command.type !== 'message' && typeof command.redirected_from === 'string' && command.redirected_from.trim() !== ''
      ? wakeName(command.redirected_from) || 'agent'
      : ''
  const redirected = asker
    ? `\n${command.reask === true ? inboxReaskRedirectedLine(asker, command.id, reaskItems, reaskOne) : inboxRedirectedLine(asker, command.id)}`
    : command.continues_thread === true
      ? `\n${inboxContinuesLine(command.id)}`
      : ''
  const naming = command.name_thread === true ? `\n${INBOX_NAME_THREAD_LINE}` : ''
  return `Plannotator Inbox: ${subject} (${command.id})\n${instruction}${redirected}${also}${naming}${facts}\n\n${body}${closing}`
}

/**
 * A session is live while its connection polled within this long (plan step
 * 8): New message is addressed only to a live session. A connection polls
 * again at once after each held poll (at most 25 s), so a running session is
 * never this long without one.
 */
export const INBOX_SESSION_LIVE_MS = 30_000

/**
 * A claimed reply whose claimant stopped saying it is alive for this long has
 * a claimant that quit: the Claude Code mod reports it then, and the Inbox
 * reads it as stuck once that session is gone too.
 */
export const INBOX_UNDELIVERED_AFTER_MS = 60_000
