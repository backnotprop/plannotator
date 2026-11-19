/**
 * Whether the person has turned the Plannotator Inbox on on this computer.
 *
 * The owner's rule (2026-11-18): "Installing Plannotator should not put the
 * inbox on at all. You have to run inbox first. You have to purposely want to
 * use inbox." So the Inbox (its process, the agents' `plannotator_inbox` tool,
 * the reminder, the note in agents' instruction files, the MCP server's tools)
 * exists only after `plannotator inbox` was run here (or `/plannotator-inbox`,
 * which runs it). Nothing a hook, the MCP server, a tool call, an installer, an
 * update, a restart or the start at login does turns it on, and
 * `inbox/inbox.json` existing says nothing about it.
 *
 * The fact is one record in `state.json` (the data dir's per-computer state,
 * beside config.json, which may live in a dotfiles repo and roam): the key
 * INBOX_ON_KEY. No record means an install from before the rule, not decided
 * yet: `packages/shared/inbox/inbox-on.ts` decides it once from what the person
 * did with the Inbox, and writes the record.
 *
 * The CONTRACT section below is pure (no imports, no runtime APIs) because the
 * Claude Code mod can import only its own folder: it keeps a byte-for-byte
 * copy in `apps/hook/hooks/mod/inbox-on-contract.ts`, and
 * `inbox-on-contract.test.ts` there fails when the two differ (edit here, then
 * paste).
 */

// --- CONTRACT (copied byte for byte into apps/hook/hooks/mod/inbox-on-contract.ts; edit packages/shared/inbox/inbox-on-contract.ts, then paste) ---

/** The key in the data dir's `state.json` that holds whether the person turned the Inbox on here. */
export const INBOX_ON_KEY = 'inboxOn'

/** The data dir's per-computer state file (never config.json: that may roam with dotfiles). */
export const INBOX_ON_FILE = 'state.json'

/**
 * What last set the record. `command`: a run of `plannotator inbox` (or
 * `/plannotator-inbox`, which runs it). `settings`: the Settings switch in
 * plan review, code review or annotate. `off`: Turn the Inbox off. The one-time decision for an install from before the rule:
 * `update-used` (the person used the window), `update-ran` (the person ran
 * `plannotator inbox`), `update-agent-only` (only agents ever started it),
 * `update-never-ran`, `update-slow` (the store took too long to read: kept
 * on). `record-lost`: a record existed here once (the decided mark,
 * INBOX_ON_DECIDED_FILE) and is gone (state.json deleted or set aside as
 * corrupt), and the mark held no copy of it: the store was read again (on
 * when the person used the Inbox, else off). A copy in the mark comes back
 * as it was, so a lost record never undoes the person's on or off.
 */
export type InboxOnBy =
  | 'command'
  | 'settings'
  | 'off'
  | 'update-used'
  | 'update-ran'
  | 'update-agent-only'
  | 'update-never-ran'
  | 'update-slow'
  | 'record-lost'

/**
 * Beside state.json in the data dir: rewritten with a copy of each record
 * written and never removed, so an install is decided once and a lost
 * state.json comes back from it.
 */
export const INBOX_ON_DECIDED_FILE = 'inbox-on-decided'

/**
 * The record. `notes: 'remove'`: Plannotator's own untouched notes in agents'
 * instruction files are still to be removed (an install decided off before a
 * process that can edit them ran); cleared after one try, whatever it removed.
 */
export interface InboxOnRecord {
  on: boolean
  at: string
  by: string
  notes?: 'remove'
}

/** The record in `state.json`'s text, or null when there is none (not decided yet) or it cannot be read. */
export function inboxOnRecord(stateText: string | null | undefined): InboxOnRecord | null {
  if (typeof stateText !== 'string' || stateText.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stateText.replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const value = (parsed as Record<string, unknown>)[INBOX_ON_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.on !== 'boolean') return null
  return {
    on: record.on,
    at: typeof record.at === 'string' ? record.at : '',
    by: typeof record.by === 'string' ? record.by : '',
    ...(record.notes === 'remove' ? { notes: record.notes } : {}),
  }
}

/** Whether the Inbox is on, from `state.json`'s text: true or false once decided, undefined when not decided yet. */
export function inboxOnFromState(stateText: string | null | undefined): boolean | undefined {
  return inboxOnRecord(stateText)?.on
}

/** How every refusal starts, so a host can recognise one in a CLI's output. */
export const INBOX_OFF_LEAD = 'The Plannotator Inbox is off on this computer'

/**
 * The one line given when something tries to use or start the Inbox while it
 * is off: a tool call, the MCP server, a CLI command that would start it. It
 * never names what turns the Inbox on.
 */
export const INBOX_OFF_AGENT_LINE = `${INBOX_OFF_LEAD}: ask the person in the chat instead. Only the person can turn the Inbox on; do not try to turn it on yourself.`

/** Whether a CLI's output is the Inbox-off refusal. */
export function isInboxOffAnswer(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(INBOX_OFF_LEAD)
}

/** What a pre-rule install shows of the person's own use of the Inbox. */
export type InboxUseEvidence = 'used' | 'ran'

/**
 * The cheap part of the one-time decision, from files a host can read
 * without walking the Inbox's store: `config` (config.json's text), `state`
 * (state.json's text), `agentsFile` (whether `inbox/agents.json` exists).
 *
 *  - `used`: config.json's `inboxNotifications` (only the window's
 *    notification ask and Settings write it), or a Tour stamp
 *    (`inboxTour.seen_at` / `finished_at` / `skipped_at`, only a click in the
 *    window sets them) in either file.
 *  - `ran`: `inbox/agents.json` exists (written only by the connect step of a
 *    person's `plannotator inbox`, which a detached start never runs, or by
 *    the window's Settings → Agents), or config.json's `inboxTool` turns the
 *    tool on for a host (the connect step and Settings write it).
 *
 * null: none of these; the store may still show the window was used
 * (`inboxUseOnDisk` in inbox-on.ts reads it).
 */
export function inboxUseFromFiles(files: { config?: string | null; state?: string | null; agentsFile?: boolean }): InboxUseEvidence | null {
  const read = (text: string | null | undefined): Record<string, unknown> => {
    if (typeof text !== 'string' || text.trim() === '') return {}
    try {
      const parsed = JSON.parse(text.replace(/^﻿/, '')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  const config = read(files.config)
  const state = read(files.state)
  const notifications = config.inboxNotifications
  if (notifications && typeof notifications === 'object' && !Array.isArray(notifications)) return 'used'
  for (const tour of [config.inboxTour, state.inboxTour]) {
    if (!tour || typeof tour !== 'object' || Array.isArray(tour)) continue
    const stamps = tour as Record<string, unknown>
    if (['seen_at', 'finished_at', 'skipped_at'].some((key) => typeof stamps[key] === 'string' && stamps[key] !== '')) return 'used'
  }
  if (files.agentsFile === true) return 'ran'
  const tool = config.inboxTool
  const on = (value: unknown) => value === true || value === 'true' || value === '1'
  if (on(tool)) return 'ran'
  if (tool && typeof tool === 'object' && !Array.isArray(tool) && Object.values(tool as Record<string, unknown>).some(on)) return 'ran'
  return null
}
