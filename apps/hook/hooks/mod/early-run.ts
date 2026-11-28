/**
 * Opening a review behind Claude Code's built-in guard, which holds a model's
 * call until the session allowed it.
 *
 * Where `cc-plugin-sec-default` is seated (a Team or Enterprise login, or a
 * machine with managed settings), Claude Code 2.1.326 added an "early run" rule
 * to it: the guard remembers each call the model makes until the call reaches
 * `tool.run` (allowed, about to run) or, for a call a hook answered or refused,
 * until the person's next prompt. While it remembers one, a person-installed
 * mod's `$.process.run` that repeats it is refused: an argv that ends in a
 * remembered Bash command, or that hands a shell an item equal to one of a
 * remembered call's texts (an MCP call's `annotate`, its target path), each
 * checked as a Bash call against the session's rules. The mod answered the
 * `plannotator` tool and a taken-over Bash `plannotator` command at `tool.call`,
 * ahead of the permission check, and its launch hands `/bin/sh` the call's
 * words, so every open was refused: `$.process.run: this repeats a Bash call
 * that is not allowed; serve an allowed call at tool.run`. A
 * `Bash(plannotator:*)` rule cannot allow it: for the tool, the Bash calls the
 * guard checks are the bare words (`annotate`, the path).
 *
 * What the mod does: it still answers at `tool.call`, so nothing changes where
 * the guard does not refuse (no guard, an engine before 2.1.326, a call that
 * repeats nothing). When the guard refuses the launch, the mod passes the call
 * on instead: the session decides it (its rules, its mode, auto mode's
 * classifier, a prompt), and the mod opens it at `tool.run`, where the guard
 * has forgotten the call. It never answers a permission question and never
 * reads its own `tool.check` hook, which the guard sends its re-checks past
 * ("its tool.check hook was skipped").
 */

import { SHELL_TOOL } from './take-over'

/**
 * The guard's refusal of a repeat (`earlyRunRefusal` in Claude Code's
 * `mods/sec-default`), inside the error `$.process.run` rejects with
 * (`<plugin>: $.process.run: this repeats a Bash call that is not allowed; serve
 * an allowed call at tool.run`). Its other form, for a script tool ("pass it
 * on with next"), never names a call the mod launches.
 */
const EARLY_RUN_REFUSAL = /\bthis repeats an? \S+ call that is not allowed; serve an allowed call at tool\.run\b/

/** Whether `text` (a launch's error, as the mod words it) carries the guard's early-run refusal. */
export function isEarlyRunRefusal(text: unknown): boolean {
  return typeof text === 'string' && EARLY_RUN_REFUSAL.test(text)
}

/** The event an allowed call runs at (Claude Code 2.1.326+). */
export const RUN_EVENT = 'tool.run'

/**
 * What Claude reads when the guard refuses the start at `tool.run`, where its
 * own advice ("serve an allowed call at tool.run") no longer applies. The
 * call was allowed and the guard forgot it there, so another call it still
 * holds shares this one's words. That is a call refused in this turn, or one
 * a hook answered, and the guard keeps it until the person's next message.
 */
export const HELD_AT_RUN_TEXT =
  'Plannotator could not start: Claude Code\'s guard is still holding an earlier call with the same words (one refused or answered in this turn), so it refused this start. It lets go at the person\'s next message: ask them to send one, then call again.'

/** The answer at `tool.run`: the guard's refusal there reads as HELD_AT_RUN_TEXT, anything else as it was. */
export function answerAtRun<A extends object>(answer: A | { deny: string }): A | { deny: string } {
  return 'deny' in answer && isEarlyRunRefusal(answer.deny) ? { deny: HELD_AT_RUN_TEXT } : answer
}

/**
 * A plugin tool named `plannotator` as the engine names it (`mcp__<server>__plannotator`);
 * the hook still checks the call names the mod's own registered tool.
 */
const MOD_TOOL = /^mcp__.+__plannotator$/

/**
 * The calls the `tool.run` hook may serve: Claude Code's shell (the take-over)
 * and the mod's `plannotator` tool. Never every tool: a hook that may match a
 * tool is in that tool's chain.
 */
export const RUN_MATCHER = { tool: [SHELL_TOOL, MOD_TOOL] }

/** Whether the `tool.run` hook hears calls to `tool` (RUN_MATCHER), so a call passed on there is served. */
export function isServedAtRun(tool: unknown): boolean {
  return typeof tool === 'string' && (tool === SHELL_TOOL || MOD_TOOL.test(tool))
}
