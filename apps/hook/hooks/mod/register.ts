/**
 * The Plannotator mod: non-blocking plan review, annotate, code review and
 * annotate-last for Claude Code, plus "Ask this session".
 *
 * ON BY DEFAULT (enabled.ts). With `PLANNOTATOR_CLAUDE_MOD=0` (or
 * `{ "claudeCodeMod": false }` in config.json) every hook below passes straight
 * through and nothing is registered or set, so the classic hook and skills
 * run exactly as they do without mods.
 *
 * Loaded from `hooks/hooks.json` ("modules") only where Claude Code runs
 * hooks modules (function hooks, 2.1.287+, CLI). Elsewhere the same plugin's
 * classic command hooks and the `/plannotator-*` skills behave exactly as
 * before; the mod also stands down in `-p`/SDK sessions and where there is no
 * `/bin/sh` (Windows), leaving those classic paths in place.
 *
 * What it does:
 * - ExitPlanMode (`tool.call`): answers `deny` with "waiting for review" text
 *   at once and starts `plannotator claude-mod-plan` detached. A revision
 *   while the review is open goes into the same tab. The decision arrives
 *   later as a plugin turn (`$.prompt.submit`, origin `plannotator`). On
 *   approval Claude calls ExitPlanMode again; the call whose plan matches the
 *   approved text passes, and `classic.PermissionRequest` allows it with the
 *   reviewer's permission mode. Because modules sit above the settings hooks
 *   in that chain, the plugin's classic PermissionRequest command hook is
 *   never reached for it: no second review. Where an organization's guard
 *   plugin (Claude Code's `cc-plugin-sec-default` on Team/Enterprise
 *   accounts) sends `classic.PermissionRequest` past this mod, the command
 *   hook is reached; it finds the approval the mod recorded for the call in
 *   flight (plan.ts `PLAN_APPROVALS_DIR`) and allows it without a review (#2007).
 * - `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`
 *   (`command.run`): the user's skills keep their names; the mod answers the
 *   command itself, starting the CLI detached with the same arguments, and
 *   returns the "Opened …" line. It registers a name only where no skill holds it.
 * - `/plannotator-inbox` (`command.run`, the same rule): runs
 *   `plannotator inbox --open` (the Inbox opens in the browser, started
 *   detached when stopped) and answers with its address.
 * - The `plannotator` tool (`$.tool.register`, tool.ts): when Claude itself is
 *   asked to open something in Plannotator it calls this tool instead of the
 *   CLI; the call goes through the same detached launch and returns at once.
 *   Not registered when the user turned the agent tool off
 *   (`PLANNOTATOR_AGENT_TOOL=0` / `{ "agentTool": false }`, read once with the
 *   mod switch). A main-loop Bash call that runs the CLI in a form the tool
 *   can represent (`plannotator annotate|review|last ...`, take-over.ts) is
 *   answered the same way instead of running, with or without the tool: the
 *   take-over adds nothing to Claude's context, it only changes what a
 *   command Claude already chose to run does.
 * - "Ask this session": each launched server gets a pull-bridge token; the
 *   mod polls it and runs the reviewer's questions as turns (bridge.ts).
 * - The Plannotator Inbox (inbox.ts): where the inbox tool switch allows it
 *   (on by default, `PLANNOTATOR_INBOX_TOOL=0` / `{ "inboxTool": false }`),
 *   the `plannotator_inbox` tool, whose actions are the Inbox's own MCP tools
 *   (read once from its `/mcp`, else the list it last answered with, else the
 *   list bundled with the mod, so the tool is there before the Inbox ever
 *   ran; the first call starts it), and the reply wake: the person's Send in
 *   the Inbox reaches the session that asked as a turn once it is idle. With
 *   the tool, and once the Inbox has run here (`inbox/inbox.json` at session
 *   start), a one-line reminder naming the tool's full name rides the
 *   conversation's first message as a `prompt.context` block, unless
 *   `{ "inboxReminder": false }` turns it off. Where a guard plugin skips
 *   that hook (#2159), the line goes as the first prompt's `prompt.submit`
 *   context, only while this machine has not seen `prompt.context` run
 *   (`$.store` `inboxReminderContextWorks`). After a compaction the plugin's
 *   `SessionStart` `compact` command hook (hooks.json) prints it again from
 *   `PLANNOTATOR_INBOX_REMINDER`, which session.start sets.
 * - `PLANNOTATOR_SESSION_TAG=claude-code:<session id>` in the environment
 *   every process the session starts inherits, so a Plannotator server can be
 *   matched to the session that started it.
 *
 * Every `$` call is in this file (`claude plugin validate` follows `$`); the
 * logic lives behind `Host` in controller.ts.
 */

import { PlannotatorMod } from './controller'
import { resolveAgentToolEnabled, resolveClaudeModEnabled, resolveInboxReminderCustom, resolveInboxReminderEnabled, resolveInboxToolEnabled } from './enabled'
import type { Host, LoadedPluginInfo } from './host'
import {
  discoverInboxTools,
  engineHasSessionAppend,
  inboxRegistryPathOf,
  inboxReminderEnvValue,
  inboxReminderFirstTurnLesson,
  inboxReminderSubmitCopy,
  pluginVersionOf,
  readReminderContextWorks,
  reminderSessionResumed,
  STORE_INBOX_REMINDER_CONTEXT_WORKS,
  withInboxReminder,
} from './inbox'
import { inboxAgentTool, inboxReminderFor, type InboxToolInfo } from './inbox-contract'
import { INBOX_DEFAULT_TOOLS } from './inbox-default-tools'
import { COMMANDS, dataDirOf, debugAppendArgv, INBOX_COMMAND, isModCommand, waitArgv } from './launch'
import { PLAN_TOOL } from './plan'
import { answerShellCall, SHELL_TOOL, shellTakeOver } from './take-over'
import { PLANNOTATOR_TOOL_NAME, PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION, PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA } from './tool'

// Minimal local types: the engine's declarations are written by `/plugin-types`
// and not vendored here.
type Engine = any
type Next = any
type On = (event: string, ...args: unknown[]) => void

function hexOf(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Debug lines waiting to be appended; at most this many are kept while an append runs. */
const DEBUG_PENDING_MAX = 500
let debugPending: string[] = []
let debugAppending = false
/** Tells this process's lines apart from another's in the shared log. */
let debugTag: string | null = null

/** This plugin's name: what `$.prompt.submit` stamps as the origin of our prompts. */
const PLUGIN_NAME = 'plannotator'

/**
 * When this module loaded: the plugin a restart would replace was loaded then.
 * The Inbox compares it with the plugin registry's `lastUpdated`, which is the
 * only sign of an update that kept the version and the folder.
 */
const MODULE_LOADED_AT = Date.now()

/** The plugin this process loaded (plugin.json's version, its folder, the load time), read once. */
let loadedPlugin: Promise<LoadedPluginInfo> | null = null
// Never null: a mod of this release always reports `plugin`, with `root` or `version` null when it could not
// read them, so a poll without the field only ever means an older mod (the Inbox flags that as outdated).
function readLoadedPlugin($: Engine): Promise<LoadedPluginInfo> {
  loadedPlugin ??= (async () => {
    let root: string | null = null
    try {
      const raw: unknown = $.plugin.root
      root = typeof raw === 'string' && raw ? raw.replace(/\/+$/, '') || null : null
    } catch {
      root = null
    }
    if (!root) return { version: null, root: null, loaded_at: MODULE_LOADED_AT }
    // `$.plugin.root` is the folder holding `.claude-plugin/plugin.json`.
    const text = (await $.fs.read(`${root}/.claude-plugin/plugin.json`).catch(() => null)) ?? (await $.fs.read(`${root}/plugin.json`).catch(() => null))
    return { version: pluginVersionOf(typeof text === 'string' ? text : null), root, loaded_at: MODULE_LOADED_AT }
  })()
  return loadedPlugin
}

/** Claude Code's own version, read once (`$.session.version()`'s `base`). */
let engineVersion: Promise<string | null> | null = null
function readEngineVersion($: Engine): Promise<string | null> {
  engineVersion ??= (async () => {
    try {
      const version = await $.session.version()
      const base = version?.base ?? version?.version
      return typeof base === 'string' && base ? base : null
    } catch {
      return null
    }
  })()
  return engineVersion
}

/** Every closure over `$` the logic uses. `debugPath` set: lines go to that file. */
function hostOf($: Engine, debugPath: string | null): Host {
  return {
    now: () => $.clock.now(),
    sleep: (ms, signal) => $.clock.sleep(ms, signal ? { signal } : undefined),
    waitForAny: async (paths, timeoutMs) => {
      await $.process.run(waitArgv(paths, timeoutMs), { timeoutMs: timeoutMs + 5_000 }).catch(() => undefined)
    },
    every: (ms, fn) => $.clock.every(ms, fn),
    run: (argv, init) => $.process.run(argv, init),
    readFile: (path) => $.fs.read(path),
    writeFile: (path, text) => $.fs.write(path, text),
    exists: (path) => $.fs.exists(path),
    fileSize: async (path) => {
      const stat = await $.fs.stat(path)
      return stat && stat.kind === 'file' ? Number(stat.size) : null
    },
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    submit: async (text) => {
      await $.prompt.submit({ text })
    },
    // Called only where `sessionAppendAvailable` said the engine has it; a refusal stops Send now here (inbox.ts).
    appendUserRow: async (text) => {
      const stored = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (stored && typeof stored.deny === 'string') throw new Error(stored.deny)
    },
    appendNotice: async (text) => {
      const stored = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
      if (stored && typeof stored.deny === 'string') throw new Error(stored.deny)
    },
    // Decided from the engine's version (validate refuses `typeof $.session.append`): an older engine never offers Send now.
    sessionAppendAvailable: async () => {
      try {
        const version = await $.session.version()
        return engineHasSessionAppend(version?.base ?? version?.version)
      } catch {
        return false
      }
    },
    loadedPlugin: () => readLoadedPlugin($),
    engineVersion: () => readEngineVersion($),
    suggest: async (text) => {
      await $.prompt.suggest({ text })
    },
    status: (text) => $.ui.status(text),
    log: (text) => $.ui.log(text),
    toast: (text) => $.ui.toast(text),
    messages: async () => {
      const messages = await $.session.messages()
      return (Array.isArray(messages) ? messages : []).map((message: { role: 'user' | 'assistant'; text: string }) => ({
        role: message.role,
        text: typeof message.text === 'string' ? message.text : '',
      }))
    },
    fetch: (url, init) => $.http.fetch(url, init),
    abortTurn: (turnId) => $.turn.abort({ turnId }),
    randomHex: (bytes) => hexOf(crypto.getRandomValues(new Uint8Array(bytes))),
    debug: (text) => {
      if (!debugPath) return
      debugTag ??= hexOf(crypto.getRandomValues(new Uint8Array(3)))
      debugPending.push(`${new Date().toISOString()} [${debugTag}] ${text}`)
      if (debugPending.length > DEBUG_PENDING_MAX) debugPending.splice(0, debugPending.length - DEBUG_PENDING_MAX)
      if (debugAppending) return
      // Appended (O_APPEND, launch.ts DEBUG_APPEND_SCRIPT), one batch at a
      // time: several Claude Code processes share this log, and rewriting the
      // whole file from each one's buffer clobbered the other's lines.
      debugAppending = true
      void (async () => {
        try {
          while (debugPending.length > 0) {
            const batch = debugPending
            debugPending = []
            await $.process.run(debugAppendArgv(debugPath), { stdin: `${batch.join('\n')}\n`, timeoutMs: 5_000 }).catch(() => undefined)
          }
        } finally {
          debugAppending = false
        }
      })()
    },
    sha256: async (text) => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))),
  }
}

/** What session.start found: the mod may run in this process. Null: inert. */
interface Allowed {
  dataDir: string
  debugPath: string | null
  /** Register Claude's `plannotator` tool (the agent tool switch, on by default). */
  agentTool: boolean
  /** Connect to the Plannotator Inbox (the inbox tool switch, on by default). */
  inboxTool: boolean
  /** With the Inbox tool: the one-line reminder at the start of each conversation (`inboxReminder`, on by default). */
  inboxReminder: boolean
  /** The person's own reminder text (config.json `prompts.inbox`), or null: the built-in line. */
  inboxReminderCustom: string | null
}

// One plugin instance per Claude Code process.
let allowed: Allowed | null = null
/**
 * The Inbox tools registered as `plannotator_inbox` at the first session.start
 * (fixed for the process: the tool list is part of Claude's prompt); null: no
 * Inbox connection.
 */
let inboxTools: readonly InboxToolInfo[] | null = null
/** `mcp__<plugin server>__plannotator_inbox` as the engine registered it; null until then. */
let inboxToolName: string | null = null
/** `inbox/inbox.json` existed at the first session.start: the person has run the Inbox here (the reminder's gate). */
let inboxRanHere = false
let mod: PlannotatorMod | null = null
let switching: Promise<PlannotatorMod | null> | null = null

/**
 * The reminder is on in this process: the switch, an Inbox that has run here,
 * and plannotator_inbox registered (its full name is in the text). Fixed after
 * the first session.start.
 */
function reminderOn(): boolean {
  return !!allowed?.inboxReminder && inboxRanHere && !!inboxToolName
}

/**
 * Settles with `reminderOn()` once the first session.start has decided it
 * (the switch, inbox.json, plannotator_inbox registered), or with false on its
 * early returns (`-p`, the mod off). The engine runs prompt.context BEFORE
 * session.start finishes (seen live on 2.1.310: the Inbox tool was registered
 * about 230 ms after prompt.context returned), so prompt.context and the
 * prompt.submit fallback wait on this, bounded, instead of reading the
 * not-yet-set module state.
 */
let reminderGateValue: boolean | null = null
let resolveReminderGate: (on: boolean) => void = () => undefined
const reminderGate = new Promise<boolean>((resolve) => {
  resolveReminderGate = resolve
})
function settleReminderGate(on: boolean): void {
  if (reminderGateValue !== null) return
  reminderGateValue = on
  resolveReminderGate(on)
}
/** The longest prompt.context / prompt.submit wait for session.start's decision. */
const REMINDER_GATE_WAIT_MS = 2_500
/**
 * The decision, waiting at most REMINDER_GATE_WAIT_MS for session.start;
 * `null` when it has not decided by then (the caller then knows nothing).
 */
async function reminderGateDecided($: Engine): Promise<boolean | null> {
  if (reminderGateValue !== null) return reminderGateValue
  const controller = new AbortController()
  const waited = Promise.resolve()
    .then(() => $.clock.sleep(REMINDER_GATE_WAIT_MS, { signal: controller.signal }))
    .then(
      () => null,
      () => null,
    )
  try {
    return await Promise.race([reminderGate, waited])
  } finally {
    controller.abort()
  }
}

/** `$.clock.now()` at this process's first session.start: tells a resumed session from one started here. */
let processStartedAt: number | null = null

/**
 * Per conversation (session id), in this process: `contextRan`, the mod's
 * `prompt.context` hook ran for it; `delivered`, the reminder reached it by
 * either path; `firstTurnDone`, its first main turn has been looked at.
 */
interface ReminderConversation {
  contextRan: boolean
  delivered: boolean
  firstTurnDone: boolean
}
const reminderConversations = new Map<string, ReminderConversation>()
function reminderConversation(sessionId: string): ReminderConversation {
  let state = reminderConversations.get(sessionId)
  if (!state) {
    state = { contextRan: false, delivered: false, firstTurnDone: false }
    reminderConversations.set(sessionId, state)
  }
  return state
}

/** `inboxReminderContextWorks` as this process knows it: read from `$.store` once, then kept in step with its writes. */
let reminderContextWorks: Promise<boolean | undefined> | null = null
function readContextWorks($: Engine): Promise<boolean | undefined> {
  reminderContextWorks ??= Promise.resolve($.store.get(STORE_INBOX_REMINDER_CONTEXT_WORKS)).then(readReminderContextWorks, () => undefined)
  return reminderContextWorks
}
async function writeContextWorks($: Engine, value: boolean): Promise<void> {
  if ((await readContextWorks($)) === value) return
  reminderContextWorks = Promise.resolve(value)
  await $.store.set(STORE_INBOX_REMINDER_CONTEXT_WORKS, value)
}

/**
 * The instance for the session the process is in NOW. `session.start` does
 * not fire for `/clear` or an in-process resume (the process goes on under
 * another session id), so the id is checked here and a new instance is made
 * (restoring that session's open reviews) when it changed. The old one was
 * disposed at `session.end`, so its decisions never land in another session.
 */
async function currentMod($: Engine): Promise<PlannotatorMod | null> {
  const settings = allowed
  if (!settings) return null
  const sessionId = await $.session.id()
  if (mod && !mod.isDisposed && mod.session.sessionId === sessionId) return mod
  if (switching) return switching
  switching = (async () => {
    mod?.dispose()
    await $.env.set('PLANNOTATOR_SESSION_TAG', `claude-code:${sessionId}`)
    const instance = new PlannotatorMod(hostOf($, settings.debugPath), {
      sessionId,
      dataDir: settings.dataDir,
      interactive: true,
      ...(inboxTools
        ? {
            inboxTools,
            ...(inboxToolName ? { inboxToolName } : {}),
            cwd: async () => String(await $.session.cwd()),
            // The session's root (where it started; a shell cd does not move it): its `claude --resume` folder.
            root: async () => String(await $.session.root()),
          }
        : {}),
    })
    mod = instance
    await instance.restore().catch(() => undefined)
    return instance
  })()
  try {
    return await switching
  } finally {
    switching = null
  }
}

/** Whether the mod runs here (on unless the user turned it off) and where its data dir is; null: stay inert. */
async function resolveAllowed($: Engine, e: { isInteractive?: unknown }): Promise<Allowed | null> {
  // A person at the prompt is what makes a later plugin turn mean anything;
  // `-p` and SDK runs keep the classic, blocking flows.
  if (!e.isInteractive) return null
  if (!(await $.fs.exists('/bin/sh'))) return null
  const home = await $.env.get('HOME')
  const dataDir = dataDirOf({
    home,
    dataDir: await $.env.get('PLANNOTATOR_DATA_DIR'),
    xdgDataHome: await $.env.get('XDG_DATA_HOME'),
    legacyExists: home ? await $.fs.exists(`${String(home).replace(/\/+$/, '')}/.plannotator`) : false,
  })
  if (!dataDir) return null
  // On by default; nothing happens when the user turned the mod off.
  const read = await $.fs.read(`${dataDir}/config.json`).catch(() => null)
  const configText = typeof read === 'string' ? read : null
  if (!resolveClaudeModEnabled(await $.env.get('PLANNOTATOR_CLAUDE_MOD'), configText)) {
    return null
  }
  const debug = await $.env.get('PLANNOTATOR_MOD_DEBUG')
  return {
    dataDir,
    debugPath: debug && debug !== '0' ? `${dataDir}/claude-code-mod/debug.log` : null,
    agentTool: resolveAgentToolEnabled(await $.env.get('PLANNOTATOR_AGENT_TOOL'), configText),
    inboxTool: resolveInboxToolEnabled(await $.env.get('PLANNOTATOR_INBOX_TOOL'), configText),
    inboxReminder: resolveInboxReminderEnabled(await $.env.get('PLANNOTATOR_INBOX_TOOL'), configText),
    inboxReminderCustom: resolveInboxReminderCustom(configText),
  }
}

/** Register the slash commands no one holds (the user's own skills keep theirs; command.run answers them). */
async function registerCommands($: Engine): Promise<void> {
  const listed = await $.command.list().catch(() => [])
  const taken = new Set((Array.isArray(listed) ? listed : []).map((command: { name: string }) => command.name))
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (taken.has(name)) continue
    await $.command
      .register({ name, description: spec.description, ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}), immediate: true })
      .catch(() => undefined)
  }
  if (!taken.has(INBOX_COMMAND.name)) {
    await $.command.register({ name: INBOX_COMMAND.name, description: INBOX_COMMAND.description, immediate: true }).catch(() => undefined)
  }
}

/**
 * The `plannotator` tool's full name as the engine registered it
 * (`mcp__<plugin server>__plannotator`); null until registered, and never set
 * while the mod is off.
 */
let toolName: string | null = null

/** Register Claude's `plannotator` tool (tool.ts): agent-initiated opens get the slash commands' launch. */
async function registerTool($: Engine): Promise<void> {
  try {
    const registered = await $.tool.register({
      // The tailscale variant: the mod's CLI launch can publish over the tailnet (#2166).
      name: PLANNOTATOR_TOOL_NAME,
      description: PLANNOTATOR_TOOL_TAILSCALE_DESCRIPTION,
      inputSchema: PLANNOTATOR_TOOL_TAILSCALE_INPUT_SCHEMA,
    })
    toolName = registered && typeof registered.tool === 'string' ? registered.tool : null
  } catch (error) {
    // A session with no built-in tools, --bare, or a host without a tool
    // registrar: Claude keeps the CLI through the plannotator skill.
    toolName = null
    $.ui.log(`Plannotator: the plannotator tool is not available in this session (${error instanceof Error ? error.message : String(error)}).`)
  }
}

/**
 * Register `plannotator_inbox` (inbox.ts): its actions are the tools the Inbox
 * offers, so an older Inbox gives fewer actions; before any Inbox ran here,
 * the list bundled with the mod (the first call starts the Inbox).
 */
async function registerInboxTool($: Engine, settings: Allowed): Promise<void> {
  const host = hostOf($, settings.debugPath)
  // The reminder speaks only for an Inbox that has run here; the tool is there either way.
  inboxRanHere = await host.exists(inboxRegistryPathOf(settings.dataDir)).catch(() => false)
  const tools = await discoverInboxTools(host, settings.dataDir).catch(() => INBOX_DEFAULT_TOOLS.map((tool) => ({ ...tool })))
  const spec = tools.length > 0 ? inboxAgentTool(tools) : null
  if (!spec) return
  try {
    const registered = await $.tool.register(spec)
    inboxToolName = registered && typeof registered.tool === 'string' ? registered.tool : null
    if (inboxToolName) inboxTools = tools
  } catch (error) {
    inboxToolName = null
    $.ui.log(`Plannotator: the plannotator_inbox tool is not available in this session (${error instanceof Error ? error.message : String(error)}).`)
  }
}

/** A tool call's arguments: the event minus the keys the engine reserves. */
function toolArgsOf(e: Record<string, unknown>): Record<string, unknown> {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...args } = e
  return args
}

export function register(on: On) {
  on('session.start', async ($: Engine, e: any, next: Next) => {
    const result = await next(e)
    if (allowed) return result
    try {
      allowed = await resolveAllowed($, e)
      if (!allowed) return result
      processStartedAt = await Promise.resolve($.clock.now()).catch(() => null)
      // Before the instance exists: it owns the Inbox link when the tool is registered.
      if (allowed.inboxTool) await registerInboxTool($, allowed)
      // The reminder for the plugin's SessionStart `compact` command hook
      // (hooks.json), which prints it after a compaction: the conversation then
      // holds it again whether or not prompt.context reaches this mod. Unset
      // when the reminder is off (a value inherited from a parent Claude Code
      // must not speak for this session).
      await Promise.resolve($.env.set('PLANNOTATOR_INBOX_REMINDER', inboxReminderEnvValue(reminderOn(), inboxToolName, allowed.inboxReminderCustom))).catch(() => undefined)
    } finally {
      // Decided (or inert): prompt.context, which the engine may already be
      // running, adds the block now, without waiting for the commands and tools below.
      settleReminderGate(reminderOn())
    }
    const instance = await currentMod($)
    if (!instance) return result
    await registerCommands($)
    // Decided once per process, here: the tool list is part of Claude's
    // prompt, so it never changes under a running session.
    if (allowed.agentTool) await registerTool($)
    return result
  })

  // The Inbox reminder: one fixed line in the context of the conversation's
  // first message, only in a process that registered plannotator_inbox, where
  // the Inbox had run (inbox/inbox.json at the first session.start) and with
  // the switch on, all decided once then. It names the tool by its registered
  // full name, so tool search finds the deferred tool. The engine renders it
  // once per conversation, after the system prompt and the tools, so it never
  // moves a cached prefix; it is never invalidated.
  //
  // Where a guard plugin seated above the mod skips this hook (#2159), the
  // same line goes as `prompt.submit` context instead (below). This hook
  // running is the evidence that stops that copy: it records the conversation
  // as reached and the machine as one where prompt.context works.
  //
  // The engine runs this hook while session.start may still be registering
  // the tool, so it waits for session.start's decision (bounded). When that
  // does not come in time the hook adds nothing, but it still records that it
  // ran, so the machine is never taken for one where prompt.context is skipped.
  on('prompt.context', async ($: Engine, e: any, next: Next) => {
    const decided = await reminderGateDecided($)
    if (decided === false) return next(e)
    const toolName = decided ? inboxToolName : null
    const result = toolName ? await next({ ...e, blocks: withInboxReminder(Array.isArray(e.blocks) ? e.blocks : [], toolName, allowed?.inboxReminderCustom ?? null) }) : await next(e)
    try {
      const state = reminderConversation(String(await $.session.id()))
      state.contextRan = true
      if (toolName) {
        state.delivered = true
        await writeContextWorks($, true)
      }
    } catch {
      // Bookkeeping only: the block above is what matters.
    }
    return result
  })

  on('session.end', async ($: Engine, e: any, next: Next) => {
    // Stop delivering for the session that ended; its open reviews stay in
    // the store and reattach if it is resumed.
    mod?.dispose()
    return next(e)
  })

  // Matched by name: an unmatched hook makes the engine credit Plannotator on every plugin's command answer.
  on('command.run', { command: [...Object.keys(COMMANDS), INBOX_COMMAND.name] }, async ($: Engine, e: any, next: Next) => {
    const name: string = typeof e.command === 'string' ? e.command : ''
    if (!allowed || (!isModCommand(name) && name !== INBOX_COMMAND.name)) return next(e)
    const instance = await currentMod($)
    if (!instance) return next(e)
    // `/plannotator-inbox`: open the Inbox and say where it is; no review opens.
    if (!isModCommand(name)) return { text: await instance.openInbox() }
    const spec = COMMANDS[name]
    const text = await instance.runCommand(spec.kind, typeof e.args === 'string' ? e.args : '')
    return { text }
  })

  on('tool.call', async ($: Engine, e: any, next: Next) => {
    // Claude's `plannotator` tool: answered here, with the same detached
    // launch the slash commands use. No other hook or core runs for it.
    if (allowed && toolName && e.tool === toolName) {
      const instance = await currentMod($)
      if (!instance) return { deny: 'Plannotator is not available in this session; run the plannotator CLI instead.' }
      // `last` reads the main session's transcript, so from a subagent it
      // would annotate a message the subagent never wrote.
      if (e.agentId && e.action === 'last') {
        return { deny: 'Invalid plannotator call: action "last" annotates the main session\'s last message and is not available to a subagent.' }
      }
      const answer = await instance.runTool(toolArgsOf(e))
      return 'deny' in answer ? { deny: answer.deny } : { result: answer.text }
    }
    // `plannotator_inbox`: the Inbox tool the call names, through the Inbox's
    // /mcp, with this session's working folder and id filled in (inbox.ts).
    if (allowed && inboxToolName && e.tool === inboxToolName) {
      const instance = await currentMod($)
      if (!instance?.inbox) return { deny: 'The Plannotator Inbox is not connected in this session; use the plannotator inbox mcp server instead.' }
      const answer = await instance.inbox.callTool(toolArgsOf(e), String(await $.session.cwd()))
      return 'deny' in answer ? { deny: answer.deny } : { result: answer.text }
    }
    // Claude running `plannotator annotate|review|last` in Bash on the main
    // loop: the same launch and result as the tool (take-over.ts); anything
    // the tool cannot represent, and every subagent's command, runs as written.
    if (allowed && e.tool === SHELL_TOOL) {
      const input = shellTakeOver(e.command, !!e.agentId)
      if (!input) return next(e)
      const instance = await currentMod($)
      if (!instance) return next(e)
      return answerShellCall(instance, input)
    }
    // Only the main loop's ExitPlanMode: a subagent's keeps the classic flow.
    if (!allowed || e.tool !== PLAN_TOOL || e.agentId) return next(e)
    const instance = await currentMod($)
    if (!instance) return next(e)
    const answer = await instance.onPlanCall({ tool_use_id: e.tool_use_id, plan: e.plan, planFilePath: e.planFilePath })
    if ('deny' in answer) return { deny: answer.deny }
    try {
      return await next(e)
    } finally {
      await instance.onPlanCallSettled(e.tool_use_id)
    }
  })

  // Matched on ExitPlanMode alone (#2159): a plugin seated above that sends
  // classic.PermissionRequest past this mod (cc-plugin-sec-default) makes the
  // engine print "its classic.PermissionRequest hook was skipped" for every
  // tool the hook is selected for. Unmatched, that was every permission prompt
  // of every tool. Matched, the engine never selects it for another tool, and
  // a skip during a plan approval is answered by the record plan.ts writes.
  on('classic.PermissionRequest', { tool_name: PLAN_TOOL }, async ($: Engine, e: any, next: Next) => {
    const instance = mod
    // A subagent's ExitPlanMode keeps the classic hook (its tool.call was not ours).
    if (!instance || instance.isDisposed || e.tool_name !== PLAN_TOOL || e.agent_id) return next(e)
    const decision = instance.onPlanPermission(typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined, e.tool_input)
    // Answered here, without next(e): the plugin's own classic command hook
    // below never runs for this call, so it cannot open a second review.
    return decision ? { decision } : next(e)
  })

  on('prompt.submit', async ($: Engine, e: any, next: Next) => {
    const instance = allowed ? mod : null
    const live = !!instance && !instance.isDisposed
    // A prompt typed (or delivered) while a turn ran carries that turn's id:
    // when the turn is a question's and a person sent it, the rest of the turn
    // answers this prompt instead (turns.ts, take-over). Streaming stops HERE,
    // before the hooks beneath run, so a slow one cannot let the next step
    // through; it resumes if one of them drops the prompt.
    const origin = e.origin
    const ref = {
      fromUs: !!origin && origin.kind === 'plugin' && origin.name === PLUGIN_NAME,
      ...(typeof e.turnId === 'string' ? { turnId: e.turnId } : {}),
      ...(origin && typeof origin.kind === 'string' ? { originKind: origin.kind } : {}),
    }
    if (live) instance.onPromptSubmitting(ref)
    // The learned fallback for the Inbox reminder (#2159): on a conversation
    // the reminder has not reached, while this machine has no evidence that
    // prompt.context runs, the prompt carries the same line as context.
    let entering = e
    let reminderFor: ReminderConversation | null = null
    // A prompt typed while session.start is still deciding waits for it (bounded), as prompt.context does.
    if (!ref.fromUs && (await reminderGateDecided($)) === true && inboxToolName) {
      try {
        const state = reminderConversation(String(await $.session.id()))
        const copy = inboxReminderSubmitCopy({
          delivered: state.delivered,
          contextWorks: await readContextWorks($),
          isMeta: e.isMeta === true,
          command: !!e.command,
        })
        if (copy) {
          entering = { ...e, context: [...(Array.isArray(e.context) ? e.context : []), inboxReminderFor(allowed?.inboxReminderCustom ?? null, inboxToolName)] }
          reminderFor = state
        }
      } catch {
        entering = e
      }
    }
    let result
    try {
      result = await next(entering)
    } catch (error) {
      if (live) instance.onPromptDropped(ref)
      throw error
    }
    // Entered: the conversation has the reminder now (a dropped prompt does not).
    if (reminderFor && result && typeof result.text === 'string') reminderFor.delivered = true
    if (!live || instance.isDisposed) return result
    if (result && typeof result.text === 'string') {
      // Every prompt seen here is someone else's (the engine skips our hooks
      // for prompts our own code submitted): its turn is never a question's.
      instance.onPromptEntered({ ...ref, text: result.text })
    } else {
      instance.onPromptDropped(ref)
    }
    return result
  })

  on('turn.start', async ($: Engine, e: any, next: Next) => {
    if (allowed && typeof e.turnId === 'string') {
      const instance = await currentMod($).catch(() => null)
      // A subagent's start carries its id: the controller counts only the main loop's turns.
      if (instance) await instance.onTurnStart(e.turnId, typeof e.text === 'string' ? e.text : '', typeof e.agentId === 'string' ? e.agentId : undefined)
    }
    return next(e)
  })

  on('turn.step', async function* ($: Engine, e: any, next: Next) {
    const instance = allowed ? mod : null
    // A main-loop model request is going out: a reply Send now put into the turn is in it (inbox.ts).
    if (instance && !instance.isDisposed && !e.agentId && typeof e.turnId === 'string') instance.onMainStep(e.turnId)
    if (!instance || !instance.turns.ownsTurn(e.turnId)) return yield* next(e)
    // A question's turn that someone else's prompt entered settles here: this
    // request carries their prompt, so nothing it says is the question's answer.
    instance.onTurnStep(e.turnId)
    if (!instance.turns.ownsTurn(e.turnId)) return yield* next(e)
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      const chunk = step.value
      if (chunk && chunk.kind === 'text' && typeof chunk.text === 'string') instance.turns.onText(e.turnId, chunk.text)
      else if (chunk && chunk.kind === 'tool' && typeof chunk.name === 'string') instance.turns.onTool(e.turnId, chunk.name)
      else if (chunk && chunk.kind === 'stop') instance.onTurnStepStop(e.turnId, typeof chunk.stopReason === 'string' ? chunk.stopReason : null)
      yield chunk
      step = await stream.next()
    }
    return step.value
  })

  on('turn.complete', async ($: Engine, e: any, next: Next) => {
    if (allowed && mod && !mod.isDisposed && !e.agentId && typeof e.turnId === 'string') {
      mod.onTurnComplete(e.turnId, typeof e.answer === 'string' ? e.answer : '', e.isAborted === true)
    }
    // A conversation's first main turn: prompt.context resolves while the
    // first request is built, so by now it ran unless something above the mod
    // skipped it. Then this machine learns `false`, and the conversation's
    // next prompt carries the reminder (prompt.submit above).
    if (reminderOn() && !e.agentId) {
      try {
        const state = reminderConversation(String(await $.session.id()))
        if (!state.firstTurnDone) {
          const usage = state.contextRan ? null : await Promise.resolve($.session.usage()).catch(() => null)
          const lesson = inboxReminderFirstTurnLesson({
            contextRan: state.contextRan,
            aborted: e.isAborted === true,
            resumed: reminderSessionResumed(usage?.startedAt, processStartedAt),
            contextWorks: await readContextWorks($),
          })
          state.firstTurnDone = lesson.done
          if (lesson.write === false) {
            await writeContextWorks($, false)
            if (allowed) hostOf($, allowed.debugPath).debug('inbox reminder: prompt.context did not run in the first turn; the reminder goes as prompt.submit context on this machine')
          }
        }
      } catch {
        // Bookkeeping only.
      }
    }
    return next(e)
  })
}
