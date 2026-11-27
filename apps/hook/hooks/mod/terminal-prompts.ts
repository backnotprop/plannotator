/**
 * What this session waits on in its terminal now (INBOX_BLOCKED_FIELD, inbox-contract.ts): a permission prompt or a
 * question, the kind only, for the Inbox's Agents list. Kept by tool call id, from the mod's hooks (register.ts):
 *
 *  - `tool.check` answered `ask` for a Bash call: a permission prompt (Claude Code's rules, a hook or a plugin asked).
 *    Bash alone: the mod reads verdicts only through its Bash-matched hook, never a wildcard or a hook on another
 *    tool's permission, so another tool's prompt is never seen;
 *  - `tool.call` of `AskUserQuestion`: a question;
 *  - the call runs (`tool.run`, 2.1.326+) or settles (its `tool.call` returns): a permission is over; a question is
 *    over when its call settles (its answer is the tool's result);
 *  - the next model request of the same loop (`turn.step`: an answer, a refusal or Escape went back to the model) and
 *    the main turn's end clear what that loop had.
 *
 * Told only once it has held SETTLE_MS: an `ask` that auto mode's classifier or a PermissionRequest hook answers at
 * once is never shown. Never the tool's input, its command or the question's words.
 *
 * A permission is told only in a process that has seen `tool.run` fire (`runSeen`): its end is the call's run, and
 * where the engine never delivers that event to the mod (Claude Code before 2.1.326, or a guard that sends it past the
 * user tier) the prompt would read as "asking" for the whole run of the approved tool. There, no permission is told
 * at all (an under-claim). A question needs no `tool.run`: it ends when its call settles.
 */
import type { InboxBlockedKind } from './inbox-contract'

/** How long a prompt must be up before the Inbox hears of it. */
export const TERMINAL_PROMPT_SETTLE_MS = 1_500

/** Claude Code's question tool: its call shows the person a question in the terminal. */
export const ASK_QUESTION_TOOL = 'AskUserQuestion'

interface Prompt {
  kind: InboxBlockedKind
  /** The loop it belongs to: a subagent's id, or '' for the main loop. */
  loop: string
  since: number
}

export class TerminalPrompts {
  private readonly prompts = new Map<string, Prompt>()
  /** `tool.run` reached the mod in this process: the end of a permission is seen, so it may be told. */
  private runSeen = false

  /** `tool.check` said `ask` for this call (a question's own check keeps it a question). */
  asked(callId: string, agentId: string | undefined, now: number): void {
    if (this.prompts.has(callId)) return
    this.prompts.set(callId, { kind: 'permission', loop: agentId ?? '', since: now })
  }

  /** An `AskUserQuestion` call started. */
  question(callId: string, agentId: string | undefined, now: number): void {
    this.prompts.set(callId, { kind: 'question', loop: agentId ?? '', since: this.prompts.get(callId)?.since ?? now })
  }

  /** The call was allowed and runs now: a permission prompt is over (a question is answered as the call settles). */
  ran(callId: string): void {
    this.runSeen = true
    if (this.prompts.get(callId)?.kind === 'permission') this.prompts.delete(callId)
  }

  /** The call settled (its result, a refusal or an error): nothing of it waits any more. */
  settled(callId: string): void {
    this.prompts.delete(callId)
  }

  /** The loop asked the model again: whatever it waited on was answered. */
  stepped(agentId: string | undefined): void {
    const loop = agentId ?? ''
    for (const [id, prompt] of this.prompts) if (prompt.loop === loop) this.prompts.delete(id)
  }

  /** The main turn ended (or was stopped): nothing waits. */
  ended(): void {
    this.prompts.clear()
  }

  /** What the Inbox hears now: a permission prompt before a question, each only once it has held SETTLE_MS. */
  kind(now: number): InboxBlockedKind | null {
    let out: InboxBlockedKind | null = null
    for (const prompt of this.prompts.values()) {
      if (now - prompt.since < TERMINAL_PROMPT_SETTLE_MS) continue
      if (prompt.kind === 'permission') {
        if (this.runSeen) return 'permission'
        continue
      }
      out = 'question'
    }
    return out
  }
}
