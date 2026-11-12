import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import fc from 'fast-check'
import { startInboxServer, type InboxServer } from './inbox'
import type { InboxGitRunner } from './inbox-project-root'
import { NO_BROWSER } from '../../tests/helpers/no-browser'
import { discoverInboxTools, INBOX_PROJECT_FOLLOWS_SLASH_CD, InboxLink, inboxSessionProjectEnvValue } from '../../apps/hook/hooks/mod/inbox'
import { realHost } from '../../apps/hook/hooks/mod/testing/claude-session'
import { runInboxCallCommand } from '../../apps/hook/server/inbox-call-command'
import { runCardCommand } from '../../apps/hook/server/card-command'
import type { InboxRegistryEntry } from '@plannotator/shared/inbox/registry'

const RUNS = Number(process.env.PLANNOTATOR_MODEL_RUNS) || 20

const FOLDERS = ['top', 'top/notes', 'top/notes/deep', 'top/repo', 'top/repo/src', 'wt', 'sib', 'tmp'] as const
type Folder = (typeof FOLDERS)[number]

const rootOf = (f: Folder): Folder => (f === 'top/repo' || f === 'top/repo/src' || f === 'wt' ? 'top/repo' : f)

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`)
}
const quietGit: InboxGitRunner = async (args, cwd) => {
  const proc = Bun.spawn(['git', ...args], { cwd, env: GIT_ENV, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { exitCode, stdout }
}

let base = ''
let bin = ''
const saved: Record<string, string | undefined> = {}
const SANDBOX_ENV = ['HOME', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_BROWSER', 'PLANNOTATOR_INBOX_CONNECT'] as const

const abs = (f: Folder) => join(base, 'world', f)

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-project-model-')))
  for (const key of SANDBOX_ENV) saved[key] = process.env[key]
  process.env.HOME = join(base, 'home')
  process.env.PLANNOTATOR_DATA_DIR = join(base, 'home', '.plannotator')
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER
  process.env.PLANNOTATOR_INBOX_CONNECT = '0'
  mkdirSync(process.env.HOME, { recursive: true })
  for (const f of ['top/notes/deep', 'top/repo', 'sib', 'tmp']) mkdirSync(join(base, 'world', f), { recursive: true })
  git(abs('top/repo'), 'init', '-q')
  git(abs('top/repo'), 'commit', '-q', '--allow-empty', '-m', 'init')
  mkdirSync(abs('top/repo/src'), { recursive: true })
  git(abs('top/repo'), 'worktree', 'add', '-q', abs('wt'))
  git(abs('sib'), 'init', '-q')
  for (const f of FOLDERS) writeFileSync(join(abs(f), 'here.txt'), `${f}\n`)
  bin = join(base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'plannotator'), '#!/bin/sh\necho "no Inbox start in this test" >&2\nexit 1\n')
  chmodSync(join(bin, 'plannotator'), 0o755)
})

afterAll(() => {
  for (const key of SANDBOX_ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  if (base) rmSync(base, { recursive: true, force: true })
})

interface Model {
  start: Folder
  root: Folder
  cwd: Folder
  projects: Set<Folder>
  allowed: Set<Folder>
  lastPoll: Folder | null
  polled: boolean
}

const projectFolder = (m: Model): Folder => (INBOX_PROJECT_FOLLOWS_SLASH_CD ? m.root : m.start)

interface Real {
  server: InboxServer
  link: InboxLink
  session: { cwd: string; root: string }
  sequence: number
}

function realProjects(r: Real): string[] {
  return r.server.store
    .listProjects()
    .map((p) => p.root)
    .sort()
}
const modelProjects = (m: Model): string[] => [...m.projects].map(abs).sort()

function messageOf(r: Real, text: string) {
  const id = /"message_id":"(msg_[^"]+)"/.exec(text)?.[1] ?? /\b(msg_[0-9A-Z]{26})\b/.exec(text)?.[1]
  if (!id) throw new Error(`no message id in: ${text.slice(0, 300)}`)
  const message = r.server.store.message(id)
  if (!message) throw new Error(`no message ${id}`)
  return { message, project: r.server.store.project(message.project_id)! }
}

async function send(r: Real, input: Record<string, unknown>): Promise<string> {
  const answer = await r.link.callTool(input, r.session.cwd)
  if ('deny' in answer) throw new Error(answer.deny)
  return answer.text
}

const expectedBase = (folder: Folder, projectRoot: Folder): string | null => (folder === projectRoot ? null : abs(folder))

type Cmd = fc.AsyncCommand<Model, Real>

class ShellCd implements Cmd {
  constructor(readonly to: Folder) {}
  check = () => true
  async run(m: Model, r: Real) {
    m.cwd = this.to
    r.session.cwd = abs(this.to)
  }
  toString = () => `cd ${this.to}`
}

class SlashCd implements Cmd {
  constructor(readonly to: Folder) {}
  check = () => true
  async run(m: Model, r: Real) {
    m.root = this.to
    m.cwd = this.to
    m.polled = false
    if (INBOX_PROJECT_FOLLOWS_SLASH_CD) m.allowed.add(rootOf(this.to))
    r.session.root = abs(this.to)
    r.session.cwd = abs(this.to)
  }
  toString = () => `/cd ${this.to}`
}

class Poll implements Cmd {
  check = () => true
  async run(m: Model, r: Real) {
    m.lastPoll = projectFolder(m)
    m.polled = true
    const commands = await (r.link as unknown as { pendingNow(waitMs: number): Promise<unknown[] | null> }).pendingNow(0)
    expect(commands).not.toBeNull()
  }
  toString = () => 'poll'
}

class Send implements Cmd {
  check = () => true
  async run(m: Model, r: Real) {
    const landed = rootOf(projectFolder(m))
    m.projects.add(landed)
    const text = await send(r, { action: 'send_message', body: `Status ${++r.sequence}.\n\n![shot](shot.png)`, attachments: ['here.txt'] })
    const { message, project } = messageOf(r, text)
    expect(project.root).toBe(abs(landed))
    expect(message.attachments?.[0]?.path).toBe(join(abs(m.cwd), 'here.txt'))
    expect(message.base_path ?? null).toBe(expectedBase(m.cwd, landed))
  }
  toString = () => 'send'
}

class SendNamed implements Cmd {
  constructor(readonly to: Folder) {}
  check = () => true
  async run(m: Model, r: Real) {
    const landed = rootOf(this.to)
    m.projects.add(landed)
    m.allowed.add(landed)
    const named = relative(r.session.cwd, abs(this.to)) || '.'
    const text = await send(r, { action: 'send_message', body: `About ${this.to} ${++r.sequence}.`, project_path: named, attachments: ['here.txt'] })
    const { message, project } = messageOf(r, text)
    expect(project.root).toBe(abs(landed))
    expect(message.attachments?.[0]?.path).toBe(join(abs(this.to), 'here.txt'))
    expect(message.base_path ?? null).toBe(expectedBase(this.to, landed))
  }
  toString = () => `send project_path ${this.to}`
}

class NewMessage implements Cmd {
  check = (m: Readonly<Model>) => m.lastPoll !== null
  async run(m: Model, r: Real) {
    const landed = rootOf(m.lastPoll!)
    m.projects.add(landed)
    const response = await fetch(`http://127.0.0.1:${r.server.port}/api/inbox/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${r.server.port}` },
      body: JSON.stringify({
        serverSession: r.server.serverSession,
        to: { host: 'claude-code', session: 'model-session' },
        body: `A thought ${++r.sequence}.`,
        idempotency_key: `new-${r.sequence}`,
      }),
    })
    expect(response.status).toBe(200)
    const { message } = (await response.json()) as { message: { project_id: string } }
    expect(r.server.store.project(message.project_id)!.root).toBe(abs(landed))
    if (m.polled) expect(landed).toBe(rootOf(projectFolder(m)))
  }
  toString = () => 'New message'
}

class ReadList implements Cmd {
  check = () => true
  async run(m: Model, r: Real) {
    const answer = await r.link.callTool({ action: 'read_thread' }, r.session.cwd)
    if ('deny' in answer) throw new Error(answer.deny)
    expect(answer.text).toMatch(/^\d+ threads?/)
  }
  toString = () => 'read_thread list'
}

async function shellEnv(r: Real): Promise<Record<string, string>> {
  const project = await r.link.projectFolder()
  return {
    PLANNOTATOR_SESSION_TAG: 'claude-code:model-session',
    ...(project ? { PLANNOTATOR_SESSION_PROJECT: inboxSessionProjectEnvValue('model-session', project) } : {}),
  }
}

async function shell(r: Real, run: typeof runInboxCallCommand, argv: string[], env?: Record<string, string>): Promise<string> {
  let out = ''
  let err = ''
  const code = await run(argv, {
    cwd: r.session.cwd,
    env: env ?? (await shellEnv(r)),
    ensureRunning: async () => ({ port: r.server.port }) as InboxRegistryEntry,
    out: (text: string) => void (out += text),
    err: (text: string) => void (err += text),
  })
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err}`)
  return out
}

class ShellSend implements Cmd {
  check = () => true
  async run(m: Model, r: Real) {
    const landed = rootOf(projectFolder(m))
    m.projects.add(landed)
    const out = await shell(r, runInboxCallCommand, ['send_message', JSON.stringify({ body: `From the shell ${++r.sequence}.`, attachments: ['here.txt'] })])
    const { message, project } = messageOf(r, out)
    expect(project.root).toBe(abs(landed))
    expect(message.author).toMatchObject({ kind: 'agent', host: 'claude-code', session: 'model-session' })
    expect(message.attachments?.[0]?.path).toBe(join(abs(m.cwd), 'here.txt'))
  }
  toString = () => 'shell: inbox call send_message'
}

class ShellCard implements Cmd {
  check = (m: Readonly<Model>) => m.projects.has(rootOf(projectFolder(m as Model)))
  async run(m: Model, r: Real) {
    const landed = rootOf(projectFolder(m))
    const out = await shell(r, runCardCommand as typeof runInboxCallCommand, ['create', `Work ${++r.sequence}`, '--json'])
    const id = /"(crd_[0-9A-Z]{26})"/.exec(out)?.[1]
    if (!id) throw new Error(`no card id in: ${out.slice(0, 300)}`)
    expect(r.server.store.project(r.server.store.card(id)!.project_id)!.root).toBe(abs(landed))
  }
  toString = () => 'shell: card create'
}

const folder = fc.constantFrom(...FOLDERS)
const commands = [
  fc.constant(new ShellSend() as Cmd),
  fc.constant(new ShellCard() as Cmd),
  folder.map((f) => new ShellCd(f) as Cmd),
  folder.map((f) => new SlashCd(f) as Cmd),
  fc.constant(new Poll() as Cmd),
  fc.constant(new Send() as Cmd),
  folder.map((f) => new SendNamed(f) as Cmd),
  fc.constant(new NewMessage() as Cmd),
  fc.constant(new ReadList() as Cmd),
]

let runs = 0
async function setup(start: Folder): Promise<{ model: Model; real: Real; done: () => void }> {
  const dataDir = join(base, 'runs', String(++runs), 'data')
  mkdirSync(dataDir, { recursive: true })
  const server = await startInboxServer({ dataDir, version: 'test', binaryPath: null, phones: false, board: true, projectRootGit: quietGit })
  const session = { cwd: abs(start), root: abs(start) }
  const host = realHost({ env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME!, PLANNOTATOR_DATA_DIR: dataDir }, cwd: abs(start), store: new Map() })
  const tools = await discoverInboxTools(host, dataDir)
  const link = new InboxLink({
    host,
    dataDir,
    sessionId: 'model-session',
    tools,
    isBusy: () => false,
    cwd: async () => session.cwd,
    root: async () => session.root,
    instanceId: 'model',
  })
  return {
    model: { start, root: start, cwd: start, projects: new Set(), allowed: new Set([rootOf(start)]), lastPoll: null, polled: false },
    real: { server, link, session, sequence: 0 },
    done: () => {
      link.dispose()
      server.stop()
    },
  }
}

describe('Inbox project of a Claude Code session that moves (spec/inbox-project.qnt, onFix)', () => {
  test('sends, New messages and thread lists land where the model says; no cd makes a project', async () => {
    await fc.assert(
      fc.asyncProperty(folder, fc.commands(commands, { maxCommands: 14 }), async (start, cmds) => {
        const { model, real, done } = await setup(start)
        try {
          await fc.asyncModelRun(() => ({ model, real }), [...cmds].map((cmd) => wrapCheck(cmd)))
        } finally {
          done()
        }
      }),
      { numRuns: RUNS },
    )
  }, 600_000)

  test('a start folder that no longer exists gives way to the working folder: sends and polls still land', async () => {
    const { model, real, done } = await setup('top')
    try {
      const gone = join(base, 'gone-scratch')
      mkdirSync(gone)
      rmSync(gone, { recursive: true })
      real.session.root = gone
      real.session.cwd = abs('top/notes')
      model.cwd = 'top/notes'
      await (real.link as unknown as { pendingNow(waitMs: number): Promise<unknown[] | null> }).pendingNow(0).then((commands) => expect(commands).not.toBeNull())
      const text = await send(real, { action: 'send_message', body: 'From a session whose start folder is gone.', attachments: ['here.txt'] })
      const { message, project } = messageOf(real, text)
      expect(project.root).toBe(abs('top/notes'))
      expect(message.attachments?.[0]?.path).toBe(join(abs('top/notes'), 'here.txt'))
      expect(realProjects(real)).toEqual([abs('top/notes')])
    } finally {
      done()
    }
  }, 120_000)

  test('the four New messages of a session started in a plain folder land in one project', async () => {
    const { model, real, done } = await setup('top')
    try {
      for (const step of [null, 'top/repo', 'top/notes', 'top/notes/deep'] as const) {
        if (step) await new ShellCd(step).run(model, real)
        await new Poll().run(model, real)
        await new NewMessage().run(model, real)
      }
      expect(realProjects(real)).toEqual([abs('top')])
    } finally {
      done()
    }
  }, 120_000)

  test('every client of one session lands in one project across a shell cd', async () => {
    const { model, real, done } = await setup('top')
    try {
      await new ShellCd('top/repo/src').run(model, real)
      await new Send().run(model, real)
      await new ShellSend().run(model, real)
      await new ShellCard().run(model, real)
      await new Poll().run(model, real)
      await new NewMessage().run(model, real)
      expect(realProjects(real)).toEqual([abs('top')])
      const named = await shell(real, runInboxCallCommand, ['send_message', JSON.stringify({ body: 'About the repository.', project_path: '.' })])
      expect(messageOf(real, named).project.root).toBe(abs('top/repo'))
      const nested = { PLANNOTATOR_SESSION_TAG: 'claude-code:nested-session', PLANNOTATOR_SESSION_PROJECT: inboxSessionProjectEnvValue('model-session', abs('top')) }
      const other = await shell(real, runInboxCallCommand, ['send_message', JSON.stringify({ body: 'From a nested agent.' })], nested)
      expect(messageOf(real, other).project.root).toBe(abs('top/repo'))
      const otherHost = { PLANNOTATOR_SESSION_TAG: 'claude-code:model-session', PLANNOTATOR_SESSION_PROJECT: `pi:model-session:${abs('top')}` }
      const piValue = await shell(real, runInboxCallCommand, ['send_message', JSON.stringify({ body: 'Pi value, Claude Code tag.' })], otherHost)
      expect(messageOf(real, piValue).project.root).toBe(abs('top/repo'))
      const bare = await shell(real, runInboxCallCommand, ['--session', 'model-session', 'send_message', JSON.stringify({ body: 'From the Tidy.' })], {
        PLANNOTATOR_SESSION_PROJECT: inboxSessionProjectEnvValue('model-session', abs('top')),
      })
      expect(messageOf(real, bare).project.root).toBe(abs('top'))
      const card = await shell(real, runCardCommand as typeof runInboxCallCommand, ['create', 'For the repository', '--project', '.', '--json'])
      const cardId = /"(crd_[0-9A-Z]{26})"/.exec(card)?.[1]
      expect(real.server.store.project(real.server.store.card(cardId!)!.project_id)!.root).toBe(abs('top/repo'))
    } finally {
      done()
    }
  }, 120_000)
})

function wrapCheck(cmd: Cmd): Cmd {
  return {
    check: (m) => cmd.check(m),
    run: async (m, r) => {
      await cmd.run(m, r)
      expect(realProjects(r)).toEqual(modelProjects(m))
      expect(modelProjects(m).every((root) => [...m.allowed].some((f) => abs(f) === root))).toBe(true)
    },
    toString: () => cmd.toString(),
  }
}
