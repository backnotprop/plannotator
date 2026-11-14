/**
 * Whether the mod is switched on. It is ON BY DEFAULT wherever Claude Code
 * runs hooks modules, interactive or not (what it does in each kind of
 * session: `SESSION_KIND_FEATURES` below; register.ts stands down only in
 * Plannotator's own Ask AI children and where it finds no shell for its
 * scripts). The user turns it off with:
 *
 *   PLANNOTATOR_CLAUDE_MOD=0            (env; also false/off/disabled; wins over the config file)
 *   { "claudeCodeMod": false }          (config.json in the data dir)
 *
 * Off, the mod is inert: every hook passes straight through, nothing is
 * registered, no environment is set, and the classic PermissionRequest hook
 * and `/plannotator-*` skills run exactly as they do without mods.
 *
 * Mirrors `resolveClaudeCodeMod` in packages/shared/config.ts (a hooks module
 * may import only its own files); `enabled.test.ts` keeps the two in step.
 */

import { inboxReminderCustomText, inboxReminderRulesText } from './inbox-contract'

/** The env override: true/false, or undefined when it does not decide (unset, empty, unrecognized). */
export function parseClaudeModEnv(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on') return true
  if (v === '0' || v === 'false' || v === 'off' || v === 'disabled') return false
  return undefined
}

/**
 * config.json's `claudeCodeMod`, coerced like the CLI's other boolean keys
 * (`coerceConfigBoolean`): a boolean, or the strings true/1 and false/0.
 * Anything else, a missing key, or an unreadable file is the default: on.
 */
export function parseClaudeModConfig(configText: string | null | undefined): boolean {
  if (!configText) return true
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.claudeCodeMod
  } catch {
    return true
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return true
}

export function resolveClaudeModEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  return parseClaudeModEnv(envValue) ?? parseClaudeModConfig(configText)
}

/**
 * Whether the mod registers Claude's `plannotator` tool when nothing is set.
 * Mirrors the claude-code entry of `AGENT_TOOL_DEFAULTS` in
 * packages/shared/config.ts (enabled.test.ts keeps them equal): on here, where
 * the tool is deferred behind tool search and costs only its name until used.
 */
export const AGENT_TOOL_DEFAULT = true

/**
 * Whether the mod registers the `plannotator` tool (the rest of the mod is
 * unaffected). Off with:
 *
 *   PLANNOTATOR_AGENT_TOOL=0            (env; also false/off/disabled; wins over the config file)
 *   { "agentTool": false }              (config.json in the data dir)
 *
 * Mirrors `resolveAgentTool(config, env, 'claude-code')` in packages/shared/config.ts. Read once, at the
 * first session.start of the Claude Code process: the tool list is part of
 * the prompt, so it never changes under a running session.
 */
export function resolveAgentToolEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  const fromEnv = parseClaudeModEnv(envValue)
  if (fromEnv !== undefined) return fromEnv
  if (!configText) return AGENT_TOOL_DEFAULT
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.agentTool
  } catch {
    return AGENT_TOOL_DEFAULT
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return AGENT_TOOL_DEFAULT
}

/**
 * Whether the mod reviews ExitPlanMode. Off with `PLANNOTATOR_PLAN_REVIEW=0`
 * or `{ "planReview": false }`, and ExitPlanMode gets Claude Code's own dialog.
 * Mirrors `resolvePlanReview(config, env)` in packages/shared/config.ts.
 */
export function resolvePlanReviewEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  const fromEnv = parseClaudeModEnv(envValue)
  if (fromEnv !== undefined) return fromEnv
  if (!configText) return true
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.planReview
  } catch {
    return true
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return true
}

/**
 * Whether the mod registers the `plannotator_inbox` tool and runs the reply
 * wake when nothing is set. Mirrors the claude-code
 * entry of `INBOX_TOOL_DEFAULTS` in packages/shared/config.ts.
 */
export const INBOX_TOOL_DEFAULT = true

/**
 * Whether the mod connects this session to the Plannotator Inbox (the
 * `plannotator_inbox` tool and the reply wake). The tool is registered even
 * before the Inbox ever ran here (a bundled tool list; the first call starts
 * it), and the wake starts polling once `inbox/inbox.json` exists. Off with:
 *
 *   PLANNOTATOR_INBOX_TOOL=0            (env; also false/off/disabled; wins over the config file)
 *   { "inboxTool": false }              (config.json in the data dir, every host)
 *   { "inboxTool": { "claude-code": false } }   (this host only; the Inbox's Settings writes this)
 *
 * Mirrors `resolveInboxTool(config, env, 'claude-code')` in
 * packages/shared/config.ts. Read once, at the first session.start of the
 * Claude Code process, like the agent tool switch.
 */
export function resolveInboxToolEnabled(envValue: string | undefined, configText: string | null | undefined): boolean {
  const fromEnv = parseClaudeModEnv(envValue)
  if (fromEnv !== undefined) return fromEnv
  if (!configText) return INBOX_TOOL_DEFAULT
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.inboxTool
  } catch {
    return INBOX_TOOL_DEFAULT
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as Record<string, unknown>)['claude-code']
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return INBOX_TOOL_DEFAULT
}

/**
 * Whether a session that has the `plannotator_inbox` tool starts with the
 * Inbox's one-line reminder (the first prompt's context; register.ts also
 * requires that the Inbox has run here). Never without the tool; then on
 * unless turned off in config.json with:
 *
 *   { "inboxReminder": false }                       (every host)
 *   { "inboxReminder": { "claude-code": false } }    (this host only)
 *
 * There is no env var of its own: PLANNOTATOR_INBOX_TOOL decides it through
 * the tool. Mirrors `resolveInboxReminder(config, env, 'claude-code')` in
 * packages/shared/config.ts. Read once, at the first session.start, with the tool.
 */
export function resolveInboxReminderEnabled(inboxToolEnv: string | undefined, configText: string | null | undefined): boolean {
  if (!resolveInboxToolEnabled(inboxToolEnv, configText)) return false
  if (!configText) return true
  let value: unknown
  try {
    value = (JSON.parse(configText) as Record<string, unknown> | null)?.inboxReminder
  } catch {
    return true
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as Record<string, unknown>)['claude-code']
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1') return true
    if (v === 'false' || v === '0') return false
  }
  return true
}

/**
 * The person's own Inbox reminder for Claude Code, from config.json
 * (`prompts.inbox.runtimes["claude-code"].reminder`, then
 * `prompts.inbox.reminder`), or null when none is usable (the built-in line
 * then goes, byte for byte as before). `inboxReminderFor(custom, toolName)`
 * makes the line. Mirrors `resolveInboxReminderText(config, 'claude-code', {
 * toolName })` in packages/shared/config.ts (inbox-reminder-custom.test.ts
 * keeps the two equal). Read once, at the first session.start, with the switch.
 */
export function resolveInboxReminderCustom(configText: string | null | undefined): string | null {
  if (!configText) return null
  try {
    return inboxReminderCustomText(JSON.parse(configText), 'claude-code')
  } catch {
    return null
  }
}

export function resolveInboxReminderRules(configText: string | null | undefined): string | null {
  if (!configText) return null
  try {
    return inboxReminderRulesText(JSON.parse(configText), 'claude-code')
  } catch {
    return null
  }
}

/**
 * The entrypoint Claude Code's VS Code extension gives the sessions its chat
 * panel starts (`CLAUDE_CODE_ENTRYPOINT`, set in the environment it spawns
 * the CLI with; read in the 2.1.322 extension). Claude Desktop's is
 * `claude-desktop`, an Agent SDK app's `sdk-ts` / `sdk-py`, `claude -p`'s
 * `sdk-cli`, T3 Code's `t3-code`.
 */
export const VSCODE_PANEL_ENTRYPOINT = 'claude-vscode'

/** What `isVsCodePanelSession` reads, each variable as `$.env.get` answers it. */
export type PanelSessionEnv = {
  /** `CLAUDE_CODE_ENTRYPOINT`. */
  entrypoint: unknown
  /** `CLAUDECODE`: set by Claude Code in every process it starts (and by IDE extensions in their terminals). */
  claudecode: unknown
  /** `CLAUDE_CODE_CHILD_SESSION`: set by Claude Code only in the processes it starts. */
  childSession: unknown
  /** `PLANNOTATOR_SESSION_TAG`: what the mod of the session that started this process set (`claude-code:<id>`). */
  sessionTag: unknown
}

const setIn = (value: unknown) => typeof value === 'string' && value !== ''

/**
 * Whether a session that is not interactive (`session.start`'s
 * `isInteractive` false) is a chat panel of the VS Code extension, where the
 * mod runs as in the terminal (#3111). The extension hosts Claude Code
 * through the Agent SDK, so its sessions are not interactive, but a person
 * reads the panel and a plugin's turn shows there ("Prompt from the
 * <plugin> plugin").
 *
 * The entrypoint is inherited: a `claude -p` started from inside a panel
 * session (Claude's Bash, or an agent job of a Plannotator CLI the mod
 * started) keeps `claude-vscode` (Claude Code changes only `cli`). Such a
 * process is told apart by what its parent put in its environment, which the
 * extension removes from the panel's own (it deletes `CLAUDECODE` and
 * `CLAUDE_CODE_CHILD_SESSION` before it spawns the CLI): either Claude Code
 * variable, or the mod's session tag naming another session. The tag naming
 * this session is this process's own (a module reload runs `session.start`
 * again after the mod set it).
 */
export function isVsCodePanelSession(env: PanelSessionEnv, sessionId: string): boolean {
  if (env.entrypoint !== VSCODE_PANEL_ENTRYPOINT) return false
  if (setIn(env.claudecode) || setIn(env.childSession)) return false
  if (setIn(env.sessionTag) && env.sessionTag !== `claude-code:${sessionId}`) return false
  return true
}

/**
 * The entrypoint T3 Code gives the Claude it runs for a thread
 * (`CLAUDE_CODE_ENTRYPOINT`, set in `mergeClaudeProcessEnvironment`, T3's
 * `ClaudeHome.ts`), beside `T3CODE_THREAD_ID`.
 */
export const T3_ENTRYPOINT = 't3-code'

/**
 * A T3 Code thread id: `isT3ThreadId` in packages/core/inbox-t3.ts, copied
 * (a hooks module may import only its own files; session-kind.test.ts keeps them equal).
 */
const T3_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._~%:!*'()-]{0,4095}$/

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === 'string' && T3_THREAD_ID.test(value)
}

/** What `t3ThreadOf` reads, each variable as `$.env.get` answers it. */
export type T3SessionEnv = PanelSessionEnv & {
  /** `T3CODE_THREAD_ID`: the thread T3 runs this Claude for. */
  thread: unknown
}

/**
 * The T3 Code thread this session is, or null. T3 runs a thread's Claude
 * through the Agent SDK with `CLAUDE_CODE_ENTRYPOINT=t3-code` and
 * `T3CODE_THREAD_ID`, and deletes `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION`
 * from that environment. Both are inherited by everything the session
 * starts, so a `claude -p` run from inside a thread is told apart as the
 * panel's is: either Claude Code variable, or a session tag naming another
 * session. The tag naming this thread is this process's own (a module
 * reload). A Claude T3 runs for no thread (a title, a probe) has no thread id.
 */
export function t3ThreadOf(env: T3SessionEnv): string | null {
  if (env.entrypoint !== T3_ENTRYPOINT || !isT3ThreadId(env.thread)) return null
  if (setIn(env.claudecode) || setIn(env.childSession)) return null
  if (setIn(env.sessionTag) && env.sessionTag !== `t3:${env.thread}`) return null
  return env.thread
}

/**
 * Where the session runs, as the mod sorts it at `session.start`:
 *
 * - `terminal`: a person at Claude Code's own prompt (`isInteractive`);
 * - `panel`: the VS Code extension's chat panel (`isVsCodePanelSession`);
 * - `t3`: a T3 Code thread (`t3ThreadOf`);
 * - `headless`: any other session that is not interactive: `claude -p`,
 *   another Agent SDK app, Claude Desktop, an unknown or missing entrypoint.
 *
 * The first three take a later turn from a plugin while the process lives
 * (the panel and T3 show it as a turn of the thread), so the mod runs there
 * as in the terminal. A `headless` session may be a one-shot run that exits
 * as its turn ends, and nothing at `session.start` says whether it is: there
 * a decision or a reply promised for later could be lost, so the flows that
 * deliver later keep the classic, blocking path and the Inbox tool sends
 * without the wake (`SESSION_KIND_FEATURES`).
 */
export type SessionKind = 'terminal' | 'panel' | 't3' | 'headless'

export function sessionKindOf(s: { isInteractive: boolean; panel: boolean; t3Thread: string | null }): SessionKind {
  if (s.isInteractive) return 'terminal'
  if (s.panel) return 'panel'
  if (s.t3Thread !== null) return 't3'
  return 'headless'
}

/**
 * What the mod does in each kind of session (the switches still apply on top):
 * `reviews`, the non-blocking reviews (the slash commands, the `plannotator`
 * tool, the Bash take-over, Ask this session); `planReview`, ExitPlanMode
 * (T3 Code owns Plan mode: its own plan card stays); `inboxTool`, the
 * `plannotator_inbox` tool; `wake`, the Inbox reply as a later turn.
 */
export const SESSION_KIND_FEATURES: Readonly<Record<SessionKind, { reviews: boolean; planReview: boolean; inboxTool: boolean; wake: boolean }>> = {
  terminal: { reviews: true, planReview: true, inboxTool: true, wake: true },
  panel: { reviews: true, planReview: true, inboxTool: true, wake: true },
  t3: { reviews: true, planReview: false, inboxTool: true, wake: true },
  headless: { reviews: false, planReview: false, inboxTool: true, wake: false },
}

/**
 * A prompt's `origin.kind` as the mod reads it. In a VS Code panel session
 * or a T3 Code thread the person's Enter reaches Claude Code as the SDK
 * host's own turn (`sdk`: the host sends what the person typed), so there it
 * reads as `composer`, the person's Enter in the terminal: a prompt they type
 * takes over the turn answering an "Ask this session" question and pulls the
 * session's leases to this process, as in the terminal. Everywhere else, and
 * for every other origin, the kind as the engine stamped it.
 */
export function promptOriginKind(kind: string, sdkHost: boolean): string {
  return sdkHost && kind === 'sdk' ? 'composer' : kind
}
