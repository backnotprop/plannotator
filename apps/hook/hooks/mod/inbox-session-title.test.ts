import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Host } from './host'
import {
  claudeProjectSlug,
  claudeTranscriptPaths,
  inboxRegistryPathOf,
  STORE_INBOX_SESSION_NAMES,
  TRANSCRIPT_TITLE_FIRST_READ_BYTES,
  TRANSCRIPT_TITLE_FAILURES_MAX,
  TRANSCRIPT_TITLE_LOCATE_RETRY_MS,
  TRANSCRIPT_TITLE_RETRY_MAX_MS,
  TRANSCRIPT_TITLE_RETRY_MS,
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
/** Claude Code's generated title for a session, as its transcripts carry it (`{"type":"ai-title","aiTitle":…}`). */
const aiTitle = (text: string, sessionId = SESSION) => line({ type: 'ai-title', aiTitle: text, sessionId })
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

  // Catches: the generated title taken as the person's name, the name hidden behind it, a later title not
  // followed, another session's taken.
  test("the generated title is kept apart from the name: read() keeps the person's name, a later one follows", async () => {
    const path = transcript(chatter('hello') + aiTitle('Plannotator usage reference') + aiTitle('Not mine', 'another-session'))
    const { host } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBeNull()
    expect(titles.generatedTitle()).toBe('Plannotator usage reference')

    appendFileSync(path, title('release 0.28.61') + aiTitle('Release notes draft'))
    expect(await titles.read()).toBe('release 0.28.61')
    expect(titles.generatedTitle()).toBe('Release notes draft')

    // Many name lines after it in one read (the script keeps the last 20 lines): neither is lost to the other.
    let text = chatter('hello') + aiTitle('Early title')
    for (let i = 0; i < 25; i += 1) text += title(`name ${i}`)
    const many = new TranscriptTitle(host, SESSION, async () => [transcript(text)])
    expect(await many.read()).toBe('name 24')
    expect(many.generatedTitle()).toBe('Early title')
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
    const { host, clock } = realHost()
    let broken = false
    const titles = new TranscriptTitle({ ...host, run: async (argv, init) => (broken ? { exitCode: 127, stdout: '', stderr: 'sh: not found' } : host.run(argv, init)) }, SESSION, async () => [path])
    expect(await titles.read()).toBe('Kept')
    appendFileSync(path, title('Read once the shell is back'))
    broken = true
    expect(await titles.read()).toBe('Kept')
    // The failed read moved nothing: the bytes are read when it works again, after the wait.
    broken = false
    clock.now += TRANSCRIPT_TITLE_RETRY_MS
    expect(await titles.read()).toBe('Read once the shell is back')
  })

  test('a last line with no newline is read once, and again only after the file grows', async () => {
    const path = transcript(chatter('hello') + title('No newline yet').trimEnd())
    const { host, reads } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBe('No newline yet')
    for (let i = 0; i < 5; i++) expect(await titles.read()).toBe('No newline yet')
    expect(reads).toHaveLength(1)
    appendFileSync(path, `\n${title('After it')}`)
    expect(await titles.read()).toBe('After it')
    expect(reads).toHaveLength(2)
    // The line that had no newline was read again from its start, whole.
    expect(reads[1]!.start).toBe(Buffer.byteLength(chatter('hello')))
  })

  test('a transcript rewritten under the same name, larger, is read as new: the old title does not stay', async () => {
    const path = transcript(chatter('hello') + title('Old name'))
    const { host } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBe('Old name')
    const replace = (text: string) => {
      const next = `${path}.new`
      writeFileSync(next, text)
      renameSync(next, path)
    }
    // A new file (a new inode), larger, with no title: none, so the /rename store answers.
    replace(chatter('x'.repeat(4096)))
    expect(await titles.read()).toBeNull()
    // Rewritten again, its title before where the last read ended: found by reading the new file's end.
    replace(title('New name') + chatter('y'.repeat(8192)))
    expect(await titles.read()).toBe('New name')
  })

  test('growth past a first read is read from the end, never as one long read', async () => {
    const path = transcript(title('Start'))
    const { host, reads } = realHost()
    const titles = new TranscriptTitle(host, SESSION, async () => [path])
    expect(await titles.read()).toBe('Start')
    appendFileSync(path, chatter('z'.repeat(1024)).repeat(Math.ceil((TRANSCRIPT_TITLE_FIRST_READ_BYTES + 256 * 1024) / 1024)) + title('Late'))
    expect(await titles.read()).toBe('Late')
    const size = statSync(path).size
    expect(reads[1]).toEqual({ start: size - TRANSCRIPT_TITLE_FIRST_READ_BYTES, length: TRANSCRIPT_TITLE_FIRST_READ_BYTES })
  })

  test('a read that times out waits longer each time, and a region that keeps timing out is skipped', async () => {
    const path = transcript(title('Kept'))
    const { host, clock } = realHost()
    let timingOut = false
    let runs = 0
    const titles = new TranscriptTitle(
      {
        ...host,
        run: async (argv, init) => {
          runs += 1
          // What a run killed at its timeout looks like: a signal's exit code and no `end:` line.
          return timingOut ? { exitCode: 143, stdout: '', stderr: '' } : host.run(argv, init)
        },
      },
      SESSION,
      async () => [path],
    )
    expect(await titles.read()).toBe('Kept')
    appendFileSync(path, title('Slow region'))
    timingOut = true
    runs = 0
    expect(await titles.read()).toBe('Kept')
    // Every poll in the wait spawns nothing.
    for (let i = 0; i < 10; i++) await titles.read()
    expect(runs).toBe(1)
    clock.now += TRANSCRIPT_TITLE_RETRY_MS
    await titles.read()
    expect(runs).toBe(2)
    // The wait doubled.
    clock.now += TRANSCRIPT_TITLE_RETRY_MS
    await titles.read()
    expect(runs).toBe(2)
    clock.now += TRANSCRIPT_TITLE_RETRY_MS
    await titles.read()
    expect(runs).toBe(TRANSCRIPT_TITLE_FAILURES_MAX)
    // Skipped: no more tries of that region, however long it waits, while the file does not grow.
    clock.now += 60 * 60_000
    for (let i = 0; i < 5; i++) await titles.read()
    expect(runs).toBe(TRANSCRIPT_TITLE_FAILURES_MAX)
    expect(await titles.read()).toBe('Kept')
    // New bytes after it are read as usual once the shell answers again (after the wait still running).
    clock.now += TRANSCRIPT_TITLE_RETRY_MAX_MS
    timingOut = false
    appendFileSync(path, title('After the slow part'))
    expect(await titles.read()).toBe('After the slow part')
  })

  test('the wait keeps doubling across skipped regions, up to the most, and a read that works starts it over', async () => {
    const path = transcript(title('Kept'))
    const { host, clock } = realHost()
    let failing = true
    let runs = 0
    const titles = new TranscriptTitle({ ...host, run: async (argv, init) => ((runs += 1), failing ? { exitCode: 143, stdout: '', stderr: '' } : host.run(argv, init)) }, SESSION, async () => [path])
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      // The file keeps growing, so a skipped region never stops the next try.
      appendFileSync(path, chatter(`work ${i}`))
      const before = runs
      let waited = 0
      // Step until the next run, in seconds: the wait that run took.
      while (runs === before) {
        await titles.read()
        if (runs === before) {
          clock.now += 1_000
          waited += 1_000
        }
      }
      waits.push(waited)
    }
    const max = TRANSCRIPT_TITLE_RETRY_MAX_MS
    const r = TRANSCRIPT_TITLE_RETRY_MS
    expect(waits).toEqual([0, r, 2 * r, 4 * r, 8 * r, 16 * r, 32 * r, max, max].map((ms) => Math.min(ms, max)))
    // A read that works: the next failure waits the first wait again.
    failing = false
    clock.now += max
    appendFileSync(path, title('Back'))
    expect(await titles.read()).toBe('Back')
    failing = true
    appendFileSync(path, chatter('again'))
    await titles.read()
    const after = runs
    appendFileSync(path, chatter('and again'))
    clock.now += r - 1_000
    await titles.read()
    expect(runs).toBe(after)
    clock.now += 1_000
    await titles.read()
    expect(runs).toBe(after + 1)
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
  const titles: unknown[] = []
  let clock = 1_000_000
  const env: Record<string, string> = { HOME: '/home/me', PLANNOTATOR_DATA_DIR: DATA, CLAUDE_CONFIG_DIR: configDir }
  return {
    polls,
    titles,
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
          if (url.endsWith('/api/inbox/bridge/poll')) {
            const body = JSON.parse(init.body ?? '{}') as { label?: unknown; title?: unknown }
            polls.push(body.label)
            titles.push(body.title)
          }
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

  test('an unnamed session sends no name and its generated title apart; a rename then takes the name', async () => {
    const configDir = join(scratch, 'claude-config-ai')
    const folder = '/home/me/src/ai-title'
    const projectDir = join(configDir, 'projects', claudeProjectSlug(folder)!)
    mkdirSync(projectDir, { recursive: true })
    const path = join(projectDir, `${SESSION}.jsonl`)
    writeFileSync(path, chatter('hello') + aiTitle('Plannotator usage reference'))

    const on = await freshHooks('ai-title-wired')
    const world = engineOn(configDir, folder)
    await on.only('session.start')(world.$, { isInteractive: true }, async () => ({ cwd: folder }))
    await world.tick(3)
    expect(world.polls.at(-1)).toBe('')
    expect(world.titles.at(-1)).toBe('Plannotator usage reference')

    appendFileSync(path, title('release 0.28.61'))
    await world.tick(3)
    expect(world.polls.at(-1)).toBe('release 0.28.61')
    expect(world.titles.at(-1)).toBe('Plannotator usage reference')
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
