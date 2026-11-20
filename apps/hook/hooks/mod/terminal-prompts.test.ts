/**
 * "Stuck on a prompt in its terminal" from the Claude Code mod (INBOX_BLOCKED_FIELD; terminal-prompts.ts and the
 * InboxLink's `blocked` option). The failures these guard:
 *  - a permission prompt (`tool.check` answered `ask`) or an AskUserQuestion never reaching the Inbox, or reaching it
 *    for an `ask` that auto mode or a hook answered at once (under TERMINAL_PROMPT_SETTLE_MS);
 *  - a prompt that stays "blocked" after it was answered (the call ran or settled, the loop asked the model again,
 *    the turn ended), or a subagent's next step clearing the main loop's prompt;
 *  - a permission told on an engine that never delivers `tool.run` to the mod (Claude Code before 2.1.326, or a guard
 *    that sends it past the user tier): there its end is never seen, and it would say "asking" for the whole run of the
 *    approved tool (review H1). Told only once a `tool.run` was seen in the process; a question needs none;
 *  - the link not telling the Inbox at once (a `state` event) or not repeating it on each poll, or still saying it
 *    once it is over;
 *  - anything of the prompt besides its kind leaving the session;
 *  - the silent link rule broken: a request or a file while no Inbox exists (no registry).
 * A memory host: no Inbox, no Claude Code.
 */
import { describe, expect, test } from 'bun:test'
import { InboxLink, inboxRegistryPathOf } from './inbox'
import { INBOX_BLOCKED_AT_FIELD, INBOX_BLOCKED_FIELD, INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, type InboxBlockedKind } from './inbox-contract'
import { TERMINAL_PROMPT_SETTLE_MS, TerminalPrompts } from './terminal-prompts'
import { fakeHost } from './testing/fake-host'

const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })
const T = 1_000_000
const SETTLED = T + TERMINAL_PROMPT_SETTLE_MS

/** A tracker in a process whose engine has delivered a `tool.run` (any call's), so a permission's end is seen. */
function runSeen(): TerminalPrompts {
  const prompts = new TerminalPrompts()
  prompts.ran('an-earlier-allowed-call')
  return prompts
}

describe('what waits in the terminal (TerminalPrompts)', () => {
  test('no tool.run seen in this process (an older engine): an approved call that runs for minutes is never "asking"; a question still is', () => {
    const prompts = new TerminalPrompts()
    prompts.asked('npm-build', undefined, T)
    // Approved after 3 s; the build runs on. With no tool.run, nothing marks its end until it settles.
    expect(prompts.kind(T + 3_000)).toBeNull()
    expect(prompts.kind(T + 240_000)).toBeNull()
    prompts.question('ask-1', undefined, T)
    expect(prompts.kind(SETTLED)).toBe('question')
    // The first tool.run seen (any call's): from then on its end is seen, so a permission is told.
    prompts.settled('npm-build')
    prompts.ran('another-call')
    prompts.asked('rm-call', undefined, T)
    expect(prompts.kind(SETTLED)).toBe('permission')
  })

  test("an ask is told only once it has held the settle time, and ends when the call runs or settles", () => {
    const prompts = runSeen()
    prompts.asked('call-1', undefined, T)
    expect(prompts.kind(T + TERMINAL_PROMPT_SETTLE_MS - 1)).toBeNull()
    expect(prompts.kind(SETTLED)).toBe('permission')
    prompts.ran('call-1')
    expect(prompts.kind(SETTLED)).toBeNull()
    prompts.asked('call-2', undefined, T)
    prompts.settled('call-2')
    expect(prompts.kind(SETTLED)).toBeNull()
  })

  test('a question lasts through its own run and ends when its call settles; a permission wins over it', () => {
    const prompts = runSeen()
    prompts.question('ask-1', undefined, T)
    // Its own check may say ask too: still a question.
    prompts.asked('ask-1', undefined, T)
    prompts.ran('ask-1')
    expect(prompts.kind(SETTLED)).toBe('question')
    prompts.asked('call-2', 'agent-a', T)
    expect(prompts.kind(SETTLED)).toBe('permission')
    prompts.settled('ask-1')
    prompts.settled('call-2')
    expect(prompts.kind(SETTLED)).toBeNull()
  })

  test("a loop's next step clears only that loop's prompts; the turn's end clears all", () => {
    const prompts = runSeen()
    prompts.asked('main', undefined, T)
    prompts.asked('sub', 'agent-a', T)
    prompts.stepped('agent-a')
    expect(prompts.kind(SETTLED)).toBe('permission')
    prompts.stepped(undefined)
    expect(prompts.kind(SETTLED)).toBeNull()
    prompts.asked('main-2', undefined, T)
    prompts.question('sub-2', 'agent-b', T)
    prompts.ended()
    expect(prompts.kind(SETTLED)).toBeNull()
  })
})

/** A link whose `blocked` says `now()`; returns every state event and poll body the Inbox got. */
async function linkOf(options: { registry: boolean; blocked: () => InboxBlockedKind | null; ticks: number; between?: (i: number) => void }) {
  const host = fakeHost()
  if (options.registry) host.files.set(inboxRegistryPathOf(DATA), REGISTRY)
  const before = new Set(host.files.keys())
  const events: Record<string, unknown>[] = []
  const polls: Record<string, unknown>[] = []
  let requests = 0
  host.onFetch = (url, body) => {
    requests += 1
    if (url.endsWith(INBOX_BRIDGE_EVENT_PATH)) events.push(body as Record<string, unknown>)
    if (url.endsWith(INBOX_BRIDGE_POLL_PATH)) polls.push(body as Record<string, unknown>)
    return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
  }
  const link = new InboxLink({ host, dataDir: DATA, sessionId: 'ses-1', tools: [], isBusy: () => true, blocked: options.blocked, instanceId: 'me' })
  link.start()
  for (let i = 0; i < options.ticks; i += 1) {
    options.between?.(i)
    host.clock += 1_000
    await host.tick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  link.dispose()
  return { events: events.filter((body) => body.type === 'state'), polls, requests, written: [...host.files.keys()].filter((path) => !before.has(path)) }
}

describe("the link tells the Inbox what waits in the terminal", () => {
  test('a prompt coming up and going: a state event each time, the kind only, and polls repeat it while it lasts', async () => {
    let now: InboxBlockedKind | null = null
    const { events, polls } = await linkOf({
      registry: true,
      ticks: 8,
      blocked: () => now,
      between: (i) => {
        if (i === 3) now = 'permission'
        if (i === 6) now = null
      },
    })
    const said = events.map((body) => body[INBOX_BLOCKED_FIELD] ?? null)
    expect(said).toContainEqual({ kind: 'permission' })
    // The last state event says it is over: no field at all.
    expect(INBOX_BLOCKED_FIELD in events.at(-1)!).toBe(false)
    // Only the kind leaves the session.
    for (const body of events) if (body[INBOX_BLOCKED_FIELD]) expect(body[INBOX_BLOCKED_FIELD]).toEqual({ kind: 'permission' })
    expect(polls.some((body) => INBOX_BLOCKED_FIELD in body)).toBe(true)
    // Each word says when it changed, later for each change, so a poll built before the clearing event never undoes it.
    const up = events.find((body) => body[INBOX_BLOCKED_FIELD])!
    const gone = events.at(-1)!
    expect(typeof up[INBOX_BLOCKED_AT_FIELD]).toBe('number')
    expect(gone[INBOX_BLOCKED_AT_FIELD] as number).toBeGreaterThan(up[INBOX_BLOCKED_AT_FIELD] as number)
    for (const body of polls) expect(typeof body[INBOX_BLOCKED_AT_FIELD]).toBe('number')
  })

  test('no Inbox (no registry): no request and no file, prompt or not', async () => {
    const { requests, written } = await linkOf({ registry: false, ticks: 6, blocked: () => 'question' })
    expect(requests).toBe(0)
    expect(written).toEqual([])
  })
})
