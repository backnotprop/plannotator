/**
 * The Plannotator mod: non-blocking plan review, annotate, code review and
 * annotate-last for Claude Code, plus "Ask this session".
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
import type { Host } from './host'
import { COMMANDS, dataDirOf, isModCommand, waitArgv } from './launch'
import { PLAN_TOOL } from './plan'

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

const debugLines: string[] = []

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
      debugLines.push(`${new Date().toISOString()} ${text}`)
      if (debugLines.length > 500) debugLines.splice(0, debugLines.length - 500)
      void $.fs.write(debugPath, `${debugLines.join('\n')}\n`).catch(() => undefined)
    },
    sha256: async (text) => hexOf(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))),
  }
}

export function register(on: On) {
  let mod: PlannotatorMod | null = null

  on('session.start', async ($: Engine, e: any, next: Next) => {
    mod = null
    const result = await next(e)
    // A person at the prompt is what makes a later plugin turn mean anything;
    // `-p` and SDK runs keep the classic, blocking flows.
    if (!e.isInteractive) return result
    if (!(await $.fs.exists('/bin/sh'))) return result
    const home = await $.env.get('HOME')
    const dataDir = dataDirOf({ home, dataDir: await $.env.get('PLANNOTATOR_DATA_DIR') })
    if (!dataDir) return result
    const sessionId = await $.session.id()
    await $.env.set('PLANNOTATOR_SESSION_TAG', `claude-code:${sessionId}`)

    const debug = await $.env.get('PLANNOTATOR_MOD_DEBUG')
    const debugPath = debug && debug !== '0' ? `${dataDir}/claude-code-mod/debug.log` : null
    const instance = new PlannotatorMod(hostOf($, debugPath), { sessionId, dataDir, interactive: true })
    mod = instance

    // Commands: answer the user's own skills by name; register only names no one holds.
    const listed = await $.command.list().catch(() => [])
    const taken = new Set((Array.isArray(listed) ? listed : []).map((command: { name: string }) => command.name))
    for (const [name, spec] of Object.entries(COMMANDS)) {
      if (taken.has(name)) continue
      await $.command
        .register({ name, description: spec.description, ...(spec.argumentHint ? { argumentHint: spec.argumentHint } : {}), immediate: true })
        .catch(() => undefined)
    }

    await instance.restore().catch(() => undefined)
    return result
  })

  on('command.run', async ($: Engine, e: any, next: Next) => {
    const instance = mod
    const name: string = typeof e.command === 'string' ? e.command : ''
    if (!instance || !isModCommand(name)) return next(e)
    const spec = COMMANDS[name]
    const text = await instance.runCommand(spec.kind, typeof e.args === 'string' ? e.args : '')
    return { text }
  })

  on('tool.call', async ($: Engine, e: any, next: Next) => {
    const instance = mod
    // Only the main loop's ExitPlanMode: a subagent's keeps the classic flow.
    if (!instance || e.tool !== PLAN_TOOL || e.agentId) return next(e)
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
    if (!instance || e.tool_name !== PLAN_TOOL) return next(e)
    const decision = instance.onPlanPermission(typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined, e.tool_input)
    // Answered here, without next(e): the plugin's own classic command hook
    // below never runs for this call, so it cannot open a second review.
    return decision ? { decision } : next(e)
  })

  on('turn.start', async ($: Engine, e: any, next: Next) => {
    if (mod && typeof e.turnId === 'string') await mod.onTurnStart(e.turnId, typeof e.text === 'string' ? e.text : '')
    return next(e)
  })

  on('turn.step', async function* ($: Engine, e: any, next: Next) {
    const instance = mod
    if (!instance || !instance.turns.ownsTurn(e.turnId)) return yield* next(e)
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      const chunk = step.value
      if (chunk && chunk.kind === 'text' && typeof chunk.text === 'string') instance.turns.onText(e.turnId, chunk.text)
      else if (chunk && chunk.kind === 'tool' && typeof chunk.name === 'string') instance.turns.onTool(e.turnId, chunk.name)
      yield chunk
      step = await stream.next()
    }
    return step.value
  })

  on('turn.complete', async ($: Engine, e: any, next: Next) => {
    if (mod && !e.agentId && typeof e.turnId === 'string') {
      mod.onTurnComplete(e.turnId, typeof e.answer === 'string' ? e.answer : '', e.isAborted === true)
    }
    return next(e)
  })
}
