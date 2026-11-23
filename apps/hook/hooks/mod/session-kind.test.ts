/**
 * Which kind of session the mod is in, and the copies it keeps of what the CLI and the Inbox know (a hooks module may
 * import only its own files). What can regress: a T3 Code thread read as another session (or another session read
 * as a thread), a nested `claude -p` taken for its parent, and the mod's identity or claim folder for a thread
 * drifting from the one the Inbox, the shim and the T3 wake use, which files one thread as two agents or lets one
 * reply go in twice.
 */
import { describe, expect, test } from 'bun:test'
import { INBOX_T3_HOST, INBOX_T3_NAME, isT3ThreadId as coreIsT3ThreadId } from '@plannotator/core/inbox-types'
import { inboxModClaimDir } from '@plannotator/shared/inbox/claims'
import { inboxHostSessionFromEnv, inboxSessionProjectFromEnv } from '../../server/inbox-mcp-shim'
import { isDesktopCodeTabEntrypoint, isDesktopCodeTabSession, isPanelEntrypoint, isT3ThreadId, isT3ThreadOwnTools, panelHostOwnsPlanMode, sessionKindOf, SESSION_KIND_FEATURES, t3ThreadOf, type T3SessionEnv } from './enabled'
import { inboxAgentProjectEnvValue, inboxSessionDirName, inboxSessionDirOf, inboxT3Agent } from './inbox'

/** Every id form T3 gives a thread (packages/core/inbox-t3.ts), and look-alikes it never gives. */
const THREADS = [
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  'mcp:0f8fad5b-d9cb-469f-a165-70867728950e',
  `mcp:launch:${'a'.repeat(64)}`,
  'mcp:0f8fad5b-d9cb-469f-a165-70867728950e:fork',
  'import:claudeAgent:ses_1',
  'thread:mcp:ns:req%20one:2',
  'thread:project:p1:0f8fad5b-d9cb-469f-a165-70867728950e',
  'thread:delegated-task:cmd',
  'thread:subagent:0123456789abcdef',
  "thread:provider:claudeAgent:native-thread:it's(1)!*~",
]
const NOT_THREADS = ['', ' ', ':mcp', '-x', 'a b', 'a/b', 'a\nb', 'x'.repeat(4097), 1, null]

const thread = THREADS[0]!
const t3 = (extra: Partial<T3SessionEnv> = {}): T3SessionEnv => ({ entrypoint: 't3-code', thread, claudecode: undefined, childSession: undefined, sessionTag: undefined, ...extra })

describe('a T3 Code thread', () => {
  test("the mod's thread id rule is core's, for every id form and look-alike", () => {
    for (const id of [...THREADS, ...NOT_THREADS]) expect([id, isT3ThreadId(id)]).toEqual([id, coreIsT3ThreadId(id)])
  })

  test('is the entrypoint t3-code beside a thread id T3 gives, in every id form', () => {
    for (const id of THREADS) expect(t3ThreadOf(t3({ thread: id }))).toBe(id)
  })

  test('is not: another entrypoint with a thread id, t3-code without one, a malformed id', () => {
    for (const entrypoint of ['sdk-ts', 'sdk-cli', 'cli', 'claude-vscode', 'claude-desktop', 't3-code-nightly', 'T3-CODE', '', undefined]) {
      expect([entrypoint, t3ThreadOf(t3({ entrypoint }))]).toEqual([entrypoint, null])
    }
    // A Claude T3 runs for no thread (a title, a capability probe).
    expect(t3ThreadOf(t3({ thread: undefined }))).toBeNull()
    for (const id of NOT_THREADS) expect([id, t3ThreadOf(t3({ thread: id }))]).toEqual([id, null])
  })

  test("a run started from inside a thread (it inherits both variables) is not the thread; the thread's own reload is", () => {
    expect(t3ThreadOf(t3({ claudecode: '1', childSession: '1' }))).toBeNull()
    expect(t3ThreadOf(t3({ claudecode: '1' }))).toBeNull()
    expect(t3ThreadOf(t3({ childSession: '1' }))).toBeNull()
    expect(t3ThreadOf(t3({ sessionTag: `t3:${THREADS[1]}` }))).toBeNull()
    expect(t3ThreadOf(t3({ sessionTag: `t3:${thread}` }))).toBe(thread)
  })

  test('T3 started from the shell of another Claude Code session (its tag inherited): still the thread', () => {
    expect(t3ThreadOf(t3({ sessionTag: 'claude-code:0f8fad5b-d9cb-469f-a165-000000000000' }))).toBe(thread)
    expect(t3ThreadOf(t3({ sessionTag: 'opencode:ses_01ABC' }))).toBe(thread)
    // The shim and `plannotator inbox call` in the thread's own Claude (no CLAUDE_CODE_CHILD_SESSION) file as the thread.
    const own = { CLAUDE_CODE_ENTRYPOINT: 't3-code', T3CODE_THREAD_ID: thread, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '0f8fad5b-d9cb-469f-a165-000000000001' }
    for (const tag of ['claude-code:0f8fad5b-d9cb-469f-a165-000000000000', 'opencode:ses_01ABC', 'pi:019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b']) {
      expect([tag, inboxHostSessionFromEnv({ ...own, PLANNOTATOR_SESSION_TAG: tag })]).toEqual([tag, inboxT3Agent(thread)])
    }
    // A Claude Code session's own commands (CLAUDE_CODE_CHILD_SESSION) keep its tag; so does any other entrypoint.
    expect(inboxHostSessionFromEnv({ ...own, CLAUDE_CODE_CHILD_SESSION: '1', PLANNOTATOR_SESSION_TAG: 'claude-code:0f8fad5b-d9cb-469f-a165-000000000000' })?.host).toBe('claude-code')
    expect(inboxHostSessionFromEnv({ ...own, CLAUDE_CODE_ENTRYPOINT: 'cli', PLANNOTATOR_SESSION_TAG: 'claude-code:0f8fad5b-d9cb-469f-a165-000000000000' })?.host).toBe('claude-code')
    // A thread's tag names that thread.
    expect(inboxHostSessionFromEnv({ ...own, PLANNOTATOR_SESSION_TAG: `t3:${THREADS[1]}` })).toEqual(inboxT3Agent(THREADS[1]!))
  })

  test("the thread's own Claude is told by T3's t3-code tools, which a title run or a claude -p never has", () => {
    expect(isT3ThreadOwnTools(['Bash', 'mcp__t3-code__get_thread', 'mcp__plugin_plannotator__plannotator_inbox'])).toBe(true)
    for (const names of [[], ['Bash'], ['mcp__t3-codex__x', 'mcp__t3__x', 'mcp__plugin_t3-code__x', 't3-code'], [null, 1]]) {
      expect([names, isT3ThreadOwnTools(names)]).toEqual([names, false])
    }
  })

  test('files as host t3 and the thread id, under the name T3 Code, as the shim and the T3 wake file it', () => {
    for (const id of THREADS) {
      const agent = inboxT3Agent(id)
      expect(agent).toEqual({ host: INBOX_T3_HOST, session: id, name: INBOX_T3_NAME })
      // The tag the mod sets makes every process the thread starts (`plannotator inbox call`, the shim) the same agent.
      expect(inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: `t3:${id}`, CLAUDE_CODE_SESSION_ID: '0f8fad5b-d9cb-469f-a165-000000000000' })).toEqual(agent)
    }
  })

  test("the mod's claim folder for a thread is where the Inbox looks for it, for every id form", () => {
    for (const id of THREADS) {
      const fromInbox = inboxModClaimDir('/data/inbox', 'msg_1', id)
      expect(fromInbox).toBe(`${inboxSessionDirOf('/data', inboxSessionDirName(id))}/claims/msg_1`)
    }
  })

  test("the shell's project variable names the thread where it can carry it, and is left out where its id holds a ':'", () => {
    const value = inboxAgentProjectEnvValue(inboxT3Agent(thread), '/work')
    expect(inboxSessionProjectFromEnv({ PLANNOTATOR_SESSION_PROJECT: value ?? undefined })).toEqual({ host: 't3', session: thread, folder: '/work' })
    for (const id of THREADS.filter((id) => id.includes(':'))) expect(inboxAgentProjectEnvValue(inboxT3Agent(id), '/work')).toBeNull()
  })
})

describe('what the mod does in each kind of session', () => {
  test('the panel hosts, and which of them draws its own plan card (Orca only, for now)', () => {
    for (const entrypoint of ['claude-vscode', 'orca']) expect([entrypoint, isPanelEntrypoint(entrypoint)]).toEqual([entrypoint, true])
    for (const entrypoint of ['claude-desktop', 'sdk-ts', 'sdk-cli', 'cli', 't3-code', 'claude-vscode-insiders', 'Claude-Desktop', 'constructor', 'toString', '', undefined, 1]) {
      expect([entrypoint, isPanelEntrypoint(entrypoint), panelHostOwnsPlanMode(entrypoint)]).toEqual([entrypoint, false, false])
    }
    expect(['claude-vscode', 'orca'].filter(panelHostOwnsPlanMode)).toEqual(['orca'])
  })

  // #3239: the desktop app's Code tab gets the reply wake only, so its entrypoints must never read as a panel host's.
  test("the desktop app's Code tab: exactly claude-desktop and claude-desktop-3p, and neither is a panel host", () => {
    for (const entrypoint of ['claude-desktop', 'claude-desktop-3p']) {
      expect([entrypoint, isDesktopCodeTabEntrypoint(entrypoint), isPanelEntrypoint(entrypoint), panelHostOwnsPlanMode(entrypoint)]).toEqual([entrypoint, true, false, false])
    }
    // Cowork (local-agent), the other hosts, and look-alikes.
    for (const entrypoint of ['local-agent', 'claude-vscode', 'orca', 't3-code', 'sdk-ts', 'sdk-cli', 'cli', 'Claude-Desktop', 'claude-desktop-3P', 'claude-desktop-insiders', ' claude-desktop', 'constructor', '', undefined, 1]) {
      expect([entrypoint, isDesktopCodeTabEntrypoint(entrypoint)]).toEqual([entrypoint, false])
    }
  })

  test("a Code tab session under the panel's guards: a run started inside it (either nested-run variable, another session's tag) is not the Code tab", () => {
    const tab = (extra: Record<string, unknown> = {}) => ({ entrypoint: 'claude-desktop', claudecode: undefined, childSession: undefined, sessionTag: undefined, ...extra })
    expect(isDesktopCodeTabSession(tab(), 'sess-1')).toBe(true)
    expect(isDesktopCodeTabSession(tab({ entrypoint: 'claude-desktop-3p' }), 'sess-1')).toBe(true)
    // A module reload in its own session: the tag the mod set names this session.
    expect(isDesktopCodeTabSession(tab({ sessionTag: 'claude-code:sess-1' }), 'sess-1')).toBe(true)
    // An empty variable counts as unset, as for the panel.
    expect(isDesktopCodeTabSession(tab({ claudecode: '', childSession: '' }), 'sess-1')).toBe(true)
    expect(isDesktopCodeTabSession(tab({ claudecode: '1', childSession: '1' }), 'sess-1')).toBe(false)
    expect(isDesktopCodeTabSession(tab({ claudecode: '1' }), 'sess-1')).toBe(false)
    expect(isDesktopCodeTabSession(tab({ childSession: '1' }), 'sess-1')).toBe(false)
    expect(isDesktopCodeTabSession(tab({ sessionTag: 'claude-code:the-code-tab-session' }), 'sess-1')).toBe(false)
    expect(isDesktopCodeTabSession(tab({ entrypoint: 'local-agent' }), 'sess-1')).toBe(false)
  })

  test('sorted: the terminal first, then a panel host, then the Code tab, then a T3 thread, else headless', () => {
    expect(sessionKindOf({ isInteractive: true, panel: false, desktop: false, t3Thread: null })).toBe('terminal')
    expect(sessionKindOf({ isInteractive: true, panel: false, desktop: true, t3Thread: null })).toBe('terminal')
    expect(sessionKindOf({ isInteractive: false, panel: true, desktop: false, t3Thread: null })).toBe('panel')
    expect(sessionKindOf({ isInteractive: false, panel: false, desktop: true, t3Thread: null })).toBe('desktop')
    expect(sessionKindOf({ isInteractive: false, panel: false, desktop: false, t3Thread: thread })).toBe('t3')
    expect(sessionKindOf({ isInteractive: false, panel: false, desktop: false, t3Thread: null })).toBe('headless')
  })

  // The owner's rule (2026-11-14): the mod is active in every session; a feature stays classic only where it
  // cannot work. A one-shot run ends with its turn, so nothing promised for later may depend on it.
  test('the table', () => {
    expect(SESSION_KIND_FEATURES).toEqual({
      terminal: { reviews: true, planReview: true, inboxTool: true, wake: true, reminder: true },
      panel: { reviews: true, planReview: true, inboxTool: true, wake: true, reminder: true },
      // #3239: the Code tab is headless plus the reply wake, nothing else.
      desktop: { reviews: false, planReview: false, inboxTool: true, wake: true, reminder: false },
      // T3 owns Plan mode: its own plan card stays.
      t3: { reviews: true, planReview: false, inboxTool: true, wake: true, reminder: true },
      // The Inbox tool sends and reads; reviews and plans keep the CLI, which waits for the decision inside the run.
      headless: { reviews: false, planReview: false, inboxTool: true, wake: false, reminder: false },
    })
  })
})
