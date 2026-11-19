/**
 * Whether the person has turned the Plannotator Inbox on on this computer.
 *
 * The owner's rule (2026-11-18): "Installing Plannotator should not put the
 * inbox on at all. You have to run inbox first. You have to purposely want to
 * use inbox." So the Inbox (its process, the agents' `plannotator_inbox` tool,
 * the reminder, the note in agents' instruction files, the MCP server's tools)
 * exists for a person only after THEY turned it on here: their own
 * `plannotator inbox` in their own terminal, their `/plannotator-inbox`, or
 * `plannotator inbox on` in their own terminal. Nothing an
 * agent, a hook, the MCP server, an installer, an update or a restart does
 * turns it on, and `inbox/inbox.json` existing says nothing about it.
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
 * What last set the record. The person's acts: `command` (their own
 * `plannotator inbox`), `slash-command` (`/plannotator-inbox`), `inbox-on`
 * (`plannotator inbox on`), `settings` (an earlier build's Settings switch). `off`: Turn the
 * Inbox off. The one-time decision for an install from before the rule:
 * `update-used` (the person used the window), `update-ran` (the person ran
 * `plannotator inbox`), `update-agent-only` (only agents ever started it),
 * `update-never-ran`. `record-lost`: a record existed here once (the decided
 * mark, INBOX_ON_DECIDED_FILE) and is gone (state.json deleted or set aside as
 * corrupt): off, never decided again, so a lost record never undoes the
 * person's off.
 */
export type InboxOnBy =
  | 'command'
  | 'slash-command'
  | 'inbox-on'
  | 'settings'
  | 'off'
  | 'update-used'
  | 'update-ran'
  | 'update-agent-only'
  | 'update-never-ran'
  | 'record-lost'

/**
 * Beside state.json in the data dir: written with the first record and never
 * removed, so an install is decided once even when state.json is lost.
 */
export const INBOX_ON_DECIDED_FILE = 'inbox-on-decided'

/**
 * The record. `notes: 'remove'`: Plannotator's own untouched notes in agents'
 * instruction files are still to be removed (an install decided off before a
 * process that can edit them ran); cleared once they are. `notes: 'left'`:
 * some could not be removed (a damaged or read-only file); nothing retries by
 * itself, `plannotator inbox status` says so, and `plannotator inbox off`
 * tries again.
 */
export interface InboxOnRecord {
  on: boolean
  at: string
  by: string
  notes?: 'remove' | 'left'
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
    ...(record.notes === 'remove' || record.notes === 'left' ? { notes: record.notes } : {}),
  }
}

/** Whether the Inbox is on, from `state.json`'s text: true or false once decided, undefined when not decided yet. */
export function inboxOnFromState(stateText: string | null | undefined): boolean | undefined {
  return inboxOnRecord(stateText)?.on
}

/** How every refusal starts, so a host can recognise one in a CLI's output. */
export const INBOX_OFF_LEAD = 'The Plannotator Inbox is off on this computer'

/**
 * The one line an agent gets when it tries to use or start the Inbox while it
 * is off: a tool call, the MCP server, a CLI command that would start it. It
 * never names what turns the Inbox on: only the person does that.
 */
export const INBOX_OFF_AGENT_LINE = `${INBOX_OFF_LEAD}: ask the person in the chat instead. Only the person can turn the Inbox on; do not try to turn it on yourself.`

/**
 * The same refusal for a person at their own terminal: only a run with no
 * agent's marker and a terminal on stdin and stdout gets it (inbox-on-command.ts).
 */
export const INBOX_OFF_PERSON_LINE = `${INBOX_OFF_LEAD}. Run \`plannotator inbox\` to turn it on.`

/** Whether a CLI's output is the Inbox-off refusal. */
export function isInboxOffAnswer(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.includes(INBOX_OFF_LEAD)
}

/**
 * Passed by Plannotator's own `/plannotator-inbox` commands (the Claude Code
 * mod for a command the person typed, Pi, OpenCode, Gemini, Droid, Amp and the
 * model-disabled `plannotator-inbox` skills) to the `plannotator inbox --open`
 * they run: the person typed the command, so it turns the Inbox on. A flag,
 * not an environment variable, so it works in PowerShell and cmd too. Hidden:
 * never in `--help` and never in words an agent is told to run.
 */
export const INBOX_SLASH_COMMAND_FLAG = '--from-slash-command'

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
