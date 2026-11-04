import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from './host'
import {
  claudeProjectSlug,
  claudeTranscriptPaths,
  inboxRegistryPathOf,
  STORE_INBOX_SESSION_NAMES,
  TRANSCRIPT_TITLE_FIRST_READ_BYTES,
  TRANSCRIPT_TITLE_LOCATE_RETRY_MS,
  TranscriptTitle,
} from './inbox'

// Session labels from the transcript (#2450, the reporter's second comment): a
// Claude Code session whose name was set by a `custom-title` transcript entry,
// which is what Claude Code shows, gets that label, not only a `/rename` the mod
// saw. The failures this catches: a hook-set title never reaching the poll; a
// later rename not following; message text that quotes the record taken as a
// title; another session's record; a title half-written at the read lost for
// good; the whole transcript read again on every poll (or read at all while it
// has not grown); a first read that is not bounded; and a session with no
// transcript losing its `/rename` name. Real files and a real `/bin/sh`, in a
// temp folder: never the person's own ~/.claude.

const scratch = mkdtempSync(join(tmpdir(), 'plannotator-session-title-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const SESSION = '3f6c2a1e-6b1d-4c55-9a3e-0d1c2b3a4f5e'
const line = (record: unknown) => `${JSON.stringify(record)}\n`
const title = (customTitle: string, sessionId = SESSION) => line({ type: 'custom-title', customTitle, sessionId })
const chatter = (text: string) => line({ type: 'user', sessionId: SESSION, message: { role: 'user', content: text } })

let fileCount = 0
function transcript(text = ''): string {
  const path = join(scratch, `t${(fileCount += 1)}.jsonl`)
  writeFileSync(path, text)
  return path
}

/** A host on real files and real processes, counting the shell reads and the region each one asked for. */
function realHost(clock = { now: 1_000_000 }) {
  const reads: { start: number; length: number }[] = []
  const host: Pick<Host, 'fileSize' | 'run' | 'now'> = {
    now: async () => clock.now,
    fileSize: async (path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() ? stat.size : null
      } catch {
        return null
      }
    },
    run: async (argv) => {
      reads.push({ start: Number(argv[4]) - 1, length: Number(argv[6]) })
      const child = Bun.spawnSync([...argv], { stdout: 'pipe', stderr: 'pipe' })
      return { exitCode: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
    },
  }
  return { host, reads, clock }
}

describe('where the transcript is', () => {
  test("Claude Code's folder name: every character but a letter or digit is a dash", () => {
    expect(claudeProjectSlug('/Users/me/src/ai-collab')).toBe('-Users-me-src-ai-collab')
    expect(claudeProjectSlug('/home/me/my project/é')).toBe('-home-me-my-project--')
    // Past 200, Claude Code adds a hash it does not publish: not guessed.
    expect(claudeProjectSlug(`/${'a'.repeat(250)}`)).toBeNull()
  })

  test('one path per folder, the first folder first, and none for an id that is not a file name', () => {
    expect(claudeTranscriptPaths('/home/me/.claude/', ['/w/a', '/w/a', '/w/b', ''], SESSION)).toEqual([
      `/home/me/.claude/projects/-w-a/${SESSION}.jsonl`,
      `/home/me/.claude/projects/-w-b/${SESSION}.jsonl`,
    ])
    expect(claudeTranscriptPaths('/home/me/.claude', ['/w/a'], '../../etc/passwd')).toEqual([])
    expect(claudeTranscriptPaths('', ['/w/a'], SESSION)).toEqual([])
  })
})

describe('the title in the transcript', () => {
  test('the latest custom-title wins; quoted record text and another session are never a title', async () => {
    const path = transcript(
      chatter('append {"type":"custom-title","customTitle":"Not this"} to the file') +
        title('Fix login redirect') +
        chatter('working') +
        title('Someone else', 'another-session') +
        line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { text: '"type":"custom-title"' } }] } }),
    )
    const { host } = realHost()
    expect(await new TranscriptTitle(host, SESSION, async () => [path]).read()).toBe('Fix login redirect')
  })

  test('a title set later (a hook, a /rename, a rename from the phone) follows on the next read, from the new bytes only', async () => {
    const path = transcript(chatter('hello') + title('First name'))
    const { host, reads } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBe('First name')
    const firstEnd = statSync(path).size

    // Nothing new: a stat, no process.
    expect(await titles.read()).toBe('First name')
    expect(reads).toHaveLength(1)

    appendFileSync(path, chatter('more work') + title('Set by a hook'))
    expect(await titles.read()).toBe('Set by a hook')
    expect(reads).toHaveLength(2)
    expect(reads[1]).toEqual({ start: firstEnd, length: statSync(path).size - firstEnd })

    // Work that sets no title keeps the one it had.
    appendFileSync(path, chatter('and more'))
    expect(await titles.read()).toBe('Set by a hook')
  })

  test('a title line Claude Code was still writing is read again whole, never lost', async () => {
    const whole = title('Half written')
    const path = transcript(chatter('hello') + whole.slice(0, 20))
    const { host } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBeNull()
    appendFileSync(path, whole.slice(20))
    expect(await titles.read()).toBe('Half written')
  })

  test('an empty title says the session has none', async () => {
    const path = transcript(title('Named') + title(''))
    const { host } = realHost()
    expect(await new TranscriptTitle(host, SESSION, async () => [path]).read()).toBe('')
  })

  test('the first read takes only the end of a long transcript', async () => {
    const filler = chatter('x'.repeat(1024)).repeat(Math.ceil((TRANSCRIPT_TITLE_FIRST_READ_BYTES + 512 * 1024) / 1024))
    const path = transcript(title('Too far back') + filler + title('Near the end'))
    const { host, reads } = realHost()
    expect(await new TranscriptTitle(host, SESSION, async () => [path]).read()).toBe('Near the end')
    const size = statSync(path).size
    expect(reads).toEqual([{ start: size - TRANSCRIPT_TITLE_FIRST_READ_BYTES, length: TRANSCRIPT_TITLE_FIRST_READ_BYTES }])
  })

  test('no transcript: null and no process, looked for again only after the wait', async () => {
    const path = join(scratch, 'not-yet.jsonl')
    const { host, reads, clock } = realHost()
    let asked = 0
    const titles = new TranscriptTitle(host, SESSION, async () => {
      asked += 1
      return [path]
    })
    expect(await titles.read()).toBeNull()
    writeFileSync(path, title('Arrived'))
    expect(await titles.read()).toBeNull()
    expect(asked).toBe(1)
    expect(reads).toHaveLength(0)
    clock.now += TRANSCRIPT_TITLE_LOCATE_RETRY_MS
    expect(await titles.read()).toBe('Arrived')
    expect(asked).toBe(2)
  })

  test('a shell that cannot run keeps the last word', async () => {
    const path = transcript(title('Kept'))
    const { host } = realHost()
    let broken = false
    const titles = new TranscriptTitle({ ...host, run: async (argv, init) => (broken ? { exitCode: 127, stdout: '', stderr: 'sh: not found' } : host.run(argv, init)) }, SESSION, async () => [path])
    expect(await titles.read()).toBe('Kept')
    appendFileSync(path, title('Read once the shell is back'))
    broken = true
    expect(await titles.read()).toBe('Kept')
    // The failed read moved nothing: the bytes are read when it works again.
    broken = false
    expect(await titles.read()).toBe('Read once the shell is back')
  })
})

// Through the real hooks, instance and link: the transcript under CLAUDE_CONFIG_DIR is found from the session's
// folder and its title reaches the poll; with no transcript the `/rename` store still answers.
const DATA = '/data'
const REGISTRY = JSON.stringify({ v: 1, pid: 1, port: 4100, token: 't'.repeat(40), serverSession: 'srv', url: 'http://127.0.0.1:4100' })

type Hook = ($: unknown, e: unknown, next: (e: unknown) => unknown) => unknown

async function freshHooks(name: string) {
  const { register } = (await import(`./register?${name}`)) as typeof import('./register')
  const held = new Map<string, { matcher: unknown; run: Hook }[]>()
  register((event: string, ...args: unknown[]) => {
    held.set(event, [...(held.get(event) ?? []), { matcher: args.length > 1 ? args[0] : undefined, run: args.at(-1) as Hook }])
  })
  return {
    only: (event: string) => held.get(event)![0]!.run,
    command: (command: string) => held.get('command.run')!.find((hook) => (hook.matcher as { command: string[] }).command.includes(command))!.run,
  }
}

function engineOn(configDir: string, folder: string) {
  const files = new Map<string, string>([['/bin/sh', ''], [inboxRegistryPathOf(DATA), REGISTRY]])
  const store = new Map<string, unknown>()
  const timers = new Set<() => void>()
  const polls: unknown[] = []
  let clock = 1_000_000
  const env: Record<string, string> = { HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, CLAUDE_CONFIG_DIR: configDir }
  return {
    polls,
    store,
    tick: async (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock += 1_000
        for (const fn of [...timers]) fn()
        for (let spin = 0; spin < 500; spin += 1) await Promise.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    $: {
      env: { get: async (name: string) => env[name], set: async () => undefined },
      fs: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const text = files.get(path)
          if (text === undefined) throw new Error(`ENOENT: ${path}`)
          return text
        },
        write: async (path: string, text: string) => void files.set(path, text),
        // Real only under the scratch folder: anything else is not there.
        stat: async (path: string) => {
          if (!path.startsWith(scratch)) throw new Error('ENOENT')
          const stat = statSync(path)
          return { kind: stat.isFile() ? 'file' : 'directory', size: stat.size, mtimeMs: stat.mtimeMs, isLink: false }
        },
      },
      session: {
        id: async () => SESSION,
        cwd: async () => folder,
        root: async () => folder,
        messages: async () => [],
        version: async () => ({ version: '2.1.316', base: '2.1.316' }),
      },
      clock: {
        now: async () => clock,
        sleep: async () => undefined,
        every: (_ms: number, fn: () => void) => {
          timers.add(fn)
          return { cancel: () => timers.delete(fn) }
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
      // The title read is the only process this run starts with a real shell; the rest answer as the engine's would.
      process: {
        run: async (argv: string[]) => {
          if (argv[0] !== '/bin/sh' || !String(argv[5]).startsWith(scratch)) return { exitCode: 0, stdout: '', stderr: '' }
          const child = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' })
          return { exitCode: child.exitCode ?? 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
        },
      },
      http: {
        fetch: async (url: string, init: { body?: string }) => {
          if (url.endsWith('/api/inbox/bridge/poll')) polls.push((JSON.parse(init.body ?? '{}') as { label?: unknown }).label)
          return { status: 200, ok: true, text: JSON.stringify({ commands: [] }) }
        },
      },
      tool: { register: async (spec: { name: string }) => ({ tool: `mcp__plugin_plannotator__${spec.name}` }) },
      command: { list: async () => [], register: async () => undefined },
      ui: { log: () => undefined, status: () => undefined, toast: () => undefined },
      prompt: { submit: async () => undefined, suggest: async () => undefined },
      turn: { abort: async () => undefined },
    },
  }
}

describe('from the transcript to a poll body', () => {
  test("a title only the transcript has reaches the poll, and a later one follows; it outranks the /rename store", async () => {
    const configDir = join(scratch, 'claude-config')
    const folder = '/home/me/src/ai-collab'
    const projectDir = join(configDir, 'projects', claudeProjectSlug(folder)!)
    mkdirSync(projectDir, { recursive: true })
    const path = join(projectDir, `${SESSION}.jsonl`)
    writeFileSync(path, chatter('hello') + title('Set by a hook'))

    const on = await freshHooks('title-wired')
    const world = engineOn(configDir, folder)
    await world.$.store.set(STORE_INBOX_SESSION_NAMES, { [SESSION]: { name: 'Old /rename name', at: 1 } })
    await on.only('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: folder }))
    await world.tick(3)
    expect(world.polls.length).toBeGreaterThan(0)
    expect(world.polls.at(-1)).toBe('Set by a hook')

    appendFileSync(path, title('Renamed in Claude Code'))
    await world.tick(3)
    expect(world.polls.at(-1)).toBe('Renamed in Claude Code')
    await on.only('session.end')(world.$, {}, (e: unknown) => e)
  })

  test('with no transcript the /rename store still names the session', async () => {
    const on = await freshHooks('title-none')
    const world = engineOn(join(scratch, 'empty-config'), '/home/me/src/elsewhere')
    await on.only('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: '/home/me/src/elsewhere' }))
    await on.command('rename')(world.$, { command: 'rename', args: 'From /rename' }, async () => ({ ref: 1 }))
    await world.tick(3)
    expect(world.polls.at(-1)).toBe('From /rename')
    await on.only('session.end')(world.$, {}, (e: unknown) => e)
  })
})
