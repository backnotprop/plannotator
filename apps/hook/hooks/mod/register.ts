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
 *   never reached for it: no second review.
 * - `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`
 *   (`command.run`): the user's skills keep their names; the mod answers the
 *   command itself, starting the CLI detached with the same arguments, and
 *   returns the "Opened …" line. It registers a name only where no skill holds it.
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
 * - `PLANNOTATOR_SESSION_TAG=claude-code:<session id>` in the environment
 *   every process the session starts inherits, so a Plannotator server can be
 *   matched to the session that started it.
 *
 * Every `$` call is in this file (`claude plugin validate` follows `$`); the
 * logic lives behind `Host` in controller.ts.
 */

import { PlannotatorMod } from './controller'
import { resolveAgentToolEnabled, resolveClaudeModEnabled } from './enabled'
import type { Host } from './host'
import { COMMANDS, dataDirOf, debugAppendArgv, isModCommand, waitArgv } from './launch'
import { PLAN_TOOL } from './plan'
import { answerShellCall, SHELL_TOOL, shellTakeOver } from './take-over'
import { PLANNOTATOR_TOOL_DESCRIPTION, PLANNOTATOR_TOOL_INPUT_SCHEMA, PLANNOTATOR_TOOL_NAME } from './tool'

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

/** Every closure over `$` the logic uses. `debugPath` set: lines go to that file. */
function hostOf($: Engine, debugPath: string | null): Host {
  return {
    now: () => $.clock.now(),
    sleep: (ms) => $.clock.sleep(ms),
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
}

// One plugin instance per Claude Code process.
let allowed: Allowed | null = null
let mod: PlannotatorMod | null = null
let switching: Promise<PlannotatorMod | null> | null = null

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
    const instance = new PlannotatorMod(hostOf($, settings.debugPath), { sessionId, dataDir: settings.dataDir, interactive: true })
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
      name: PLANNOTATOR_TOOL_NAME,
      description: PLANNOTATOR_TOOL_DESCRIPTION,
      inputSchema: PLANNOTATOR_TOOL_INPUT_SCHEMA,
    })
    toolName = registered && typeof registered.tool === 'string' ? registered.tool : null
  } catch (error) {
    // A session with no built-in tools, --bare, or a host without a tool
    // registrar: Claude keeps the CLI through the plannotator skill.
    toolName = null
    $.ui.log(`Plannotator: the plannotator tool is not available in this session (${error instanceof Error ? error.message : String(error)}).`)
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
    allowed = await resolveAllowed($, e)
    if (!allowed) return result
    const instance = await currentMod($)
    if (!instance) return result
    await registerCommands($)
    // Decided once per process, here: the tool list is part of Claude's
    // prompt, so it never changes under a running session.
    if (allowed.agentTool) await registerTool($)
    return result
  })

  on('session.end', async ($: Engine, e: any, next: Next) => {
    // Stop delivering for the session that ended; its open reviews stay in
    // the store and reattach if it is resumed.
    mod?.dispose()
    return next(e)
  })

  on('command.run', async ($: Engine, e: any, next: Next) => {
    const name: string = typeof e.command === 'string' ? e.command : ''
    if (!allowed || !isModCommand(name)) return next(e)
    const instance = await currentMod($)
    if (!instance) return next(e)
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
      instance.onPlanCallSettled(e.tool_use_id)
    }
  })

  on('classic.PermissionRequest', async ($: Engine, e: any, next: Next) => {
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
    let result
    try {
      result = await next(e)
    } catch (error) {
      if (live) instance.onPromptDropped(ref)
      throw error
    }
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
      if (instance) await instance.onTurnStart(e.turnId, typeof e.text === 'string' ? e.text : '')
    }
    return next(e)
  })

  on('turn.step', async function* ($: Engine, e: any, next: Next) {
    const instance = allowed ? mod : null
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
    return next(e)
  })
}
