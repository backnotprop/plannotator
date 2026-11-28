import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_BROWSER } from '../../../../tests/helpers/no-browser'
import { cleanupArgv, launchArgv } from './launch'

const systemd = process.platform === 'linux' ? Bun.which('systemd-run') : null
const systemctl = process.platform === 'linux' ? Bun.which('systemctl') : null
const setsid = process.platform === 'linux' ? Bun.which('setsid') : null
const supportsScope = !!systemd && !!systemctl && Bun.spawnSync([systemd, '--user', '--scope', '--quiet', '--collect', '--', 'true'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(25)
  expect(existsSync(path)).toBe(true)
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sandbox(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-systemd-'))
  roots.push(root)
  const dir = join(root, 'launch')
  mkdirSync(dir)
  writeFileSync(join(dir, 'stdin'), 'test input\n')
  return { root, dir }
}

// What /proc/self/cgroup shows (cgroup v2) for a process in T3 Code's
// per-thread scope, and for one in a login session (SSH, a console).
const AGENT_SCOPE = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-t3code.slice/t3code-claude-harbor.scope\n'
const LOGIN_SESSION = '0::/user.slice/user-1000.slice/session-3.scope\n'

function cgroupFile(root: string, content: string): string {
  const file = join(root, `cgroup-${crypto.randomUUID()}`)
  writeFileSync(file, content)
  return file
}

describe.skipIf(process.platform !== 'linux')('detached launch without a usable user manager', () => {
  test('falls back to the original launch when systemd-run fails', async () => {
    const { root, dir } = sandbox()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\necho attempted > "$PLANNOTATOR_DATA_DIR/attempted"\nexit 1\n')
    chmodSync(join(bin, 'systemd-run'), 0o755)
    const child = Bun.spawn(launchArgv(dir, ['/bin/sh', '-c', 'cat; exit 7']), {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_MOD_CGROUP_FILE: cgroupFile(root, AGENT_SCOPE) },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    expect(await child.exited).toBe(0)
    await waitFor(join(dir, 'exit'))
    expect(existsSync(join(root, 'attempted'))).toBe(true)
    expect(readFileSync(join(dir, 'stdout'), 'utf8')).toBe('test input\n')
    expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('7')
  })

  test('does not launch twice if systemd-run reports an error after starting the worker', async () => {
    const { root, dir } = sandbox()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nshift 5\n"$@"\nexit 1\n')
    chmodSync(join(bin, 'systemd-run'), 0o755)
    const worker = ['/bin/sh', '-c', 'echo ran >> "$1/runs"; exit 7', 'worker', root]
    const child = Bun.spawn(launchArgv(dir, worker), {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_MOD_CGROUP_FILE: cgroupFile(root, AGENT_SCOPE) },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    expect(await child.exited).toBe(0)
    await waitFor(join(dir, 'exit'))
    await Bun.sleep(100)
    expect(readFileSync(join(root, 'runs'), 'utf8')).toBe('ran\n')
    expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('7')
  })

  test('does not relaunch if cleanup removes the marker before systemd-run returns', async () => {
    const { root, dir } = sandbox()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nshift 5\n"$@"\necho done > "$PLANNOTATOR_DATA_DIR/worker-done"\nwhile [ ! -e "$PLANNOTATOR_DATA_DIR/release" ]; do sleep 0.05; done\nexit 1\n')
    chmodSync(join(bin, 'systemd-run'), 0o755)
    const child = Bun.spawn(launchArgv(dir, ['/bin/sh', '-c', 'echo ran >> "$1/runs"', 'worker', root]), {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_MOD_CGROUP_FILE: cgroupFile(root, AGENT_SCOPE) },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    expect(await child.exited).toBe(0)
    await waitFor(join(root, 'worker-done'))
    expect(Bun.spawnSync(cleanupArgv(dir), { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0)
    writeFileSync(join(root, 'release'), '')
    await Bun.sleep(150)
    expect(readFileSync(join(root, 'runs'), 'utf8')).toBe('ran\n')
    expect(existsSync(dir)).toBe(false)
  })
})

describe.skipIf(!supportsScope)('detached launch inside a systemd user scope', () => {
  test.skipIf(!setsid)('review and exit waiter survive the agent process group being terminated', async () => {
    const { root, dir } = sandbox()
    const unit = `plannotator-mod-test-${process.pid}-${crypto.randomUUID()}`
    const worker = ['/bin/sh', '-c', 'while [ ! -e "$1/release" ]; do sleep 0.05; done; echo done; exit 7', 'worker', root]
    const parent = Bun.spawn([setsid!, systemd!, '--user', '--scope', '--quiet', '--unit', unit, '--', '/bin/sh', '-c', '"$@"; sleep 60', 'parent', ...launchArgv(dir, worker)], {
      env: { ...process.env, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    let pid: number | undefined
    try {
      await waitFor(join(dir, 'pid'))
      await waitFor(join(dir, 'scope-started'))
      pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim())
      const pgid = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(parent.pid)]).stdout.toString().trim()
      expect(pgid).toBe(String(parent.pid))
      process.kill(-parent.pid, 'SIGTERM')
      await parent.exited
      expect(() => process.kill(pid!, 0)).not.toThrow()
      writeFileSync(join(root, 'release'), '')
      await waitFor(join(dir, 'exit'))
      expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('7')
      expect(readFileSync(join(dir, 'stdout'), 'utf8').trim()).toBe('done')
      pid = undefined
    } finally {
      Bun.spawnSync([systemctl!, '--user', 'stop', `${unit}.scope`], { stdout: 'ignore', stderr: 'ignore' })
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
      parent.kill()
      await parent.exited
    }
  }, 20_000)

  test('server and its exit waiter survive the old scope stopping', async () => {
    const { root, dir } = sandbox()
    const unit = `plannotator-mod-test-${process.pid}-${crypto.randomUUID()}`
    const worker = ['/bin/sh', '-c', 'while [ ! -e "$1/release" ]; do sleep 0.05; done; echo done; exit 7', 'worker', root]
    const parent = Bun.spawn([systemd!, '--user', '--scope', '--quiet', '--unit', unit, '--', '/bin/sh', '-c', '"$@"; sleep 60', 'parent', ...launchArgv(dir, worker)], {
      env: { ...process.env, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    let pid: number | undefined
    try {
      await waitFor(join(dir, 'pid'))
      await waitFor(join(dir, 'scope-started'))
      pid = Number(readFileSync(join(dir, 'pid'), 'utf8').trim())
      expect(Bun.spawnSync([systemctl!, '--user', 'stop', `${unit}.scope`], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0)
      expect(() => process.kill(pid!, 0)).not.toThrow()
      writeFileSync(join(root, 'release'), '')
      await waitFor(join(dir, 'exit'))
      expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('7')
      expect(readFileSync(join(dir, 'stdout'), 'utf8').trim()).toBe('done')
      pid = undefined
    } finally {
      Bun.spawnSync([systemctl!, '--user', 'stop', `${unit}.scope`], { stdout: 'ignore', stderr: 'ignore' })
      if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
      parent.kill()
      await parent.exited
    }
  }, 20_000)

  // systemd-run 254+ expands `$NAME`, `${NAME}` and `$$` in the command it runs.
  test("the person's words reach the CLI unchanged through systemd-run", async () => {
    const { root, dir } = sandbox()
    const unit = `plannotator-mod-test-${process.pid}-${crypto.randomUUID()}`
    const words = ['$HOME', '$TODO.md', 'a$$b', '${HOME}/x']
    const parent = Bun.spawn([systemd!, '--user', '--scope', '--quiet', '--unit', unit, '--', '/bin/sh', '-c', '"$@"; sleep 60', 'parent', ...launchArgv(dir, dumpArgv(root, words))], {
      env: { ...process.env, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    try {
      await waitFor(join(dir, 'exit'))
      expect(existsSync(join(dir, 'scope-started'))).toBe(true)
      expect(dumped(root).argv).toEqual(words)
    } finally {
      Bun.spawnSync([systemctl!, '--user', 'stop', `${unit}.scope`], { stdout: 'ignore', stderr: 'ignore' })
      parent.kill()
      await parent.exited
    }
  }, 20_000)
})

// The CLI stand-in: records the argv it got and any PLANNOTATOR_SCOPE_ variable left in its environment.
function dumpArgv(root: string, words: readonly string[]): string[] {
  const script = join(root, 'dump.js')
  writeFileSync(script, [
    "const { writeFileSync } = require('node:fs')",
    "const leaked = Object.keys(process.env).filter((k) => k.startsWith('PLANNOTATOR_SCOPE_'))",
    'writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), leaked }))',
  ].join('\n'))
  return [process.execPath, script, join(root, 'argv.json'), ...words]
}

function dumped(root: string): { argv: string[]; leaked: string[] } {
  return JSON.parse(readFileSync(join(root, 'argv.json'), 'utf8'))
}

// A systemd-run that does what `systemd-run --scope` does with its command
// (systemd's replace_env_argv, then exec): a word that is `$NAME` becomes the
// variable split on whitespace (or nothing), `${NAME}` inside a word becomes
// the variable, and `$$` becomes `$`.
const EXPANDING_SYSTEMD_RUN = [
  "const { appendFileSync } = require('node:fs')",
  "const { spawnSync } = require('node:child_process')",
  "appendFileSync(process.env.FAKE_CALLS, 'called\\n')",
  'const env = process.env',
  'const valid = (n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)',
  'function inWord(w) {',
  "  let out = ''",
  '  for (let i = 0; i < w.length;) {',
  "    if (w[i] === '$' && w[i + 1] === '$') { out += '$'; i += 2; continue }",
  "    if (w[i] === '$' && w[i + 1] === '{') {",
  "      const end = w.indexOf('}', i + 2)",
  '      const name = end < 0 ? null : w.slice(i + 2, end)',
  "      if (name !== null && !name.includes(':')) { out += env[name] ?? ''; i = end + 1; continue }",
  '    }',
  '    out += w[i]; i += 1',
  '  }',
  '  return out',
  '}',
  'const args = process.argv.slice(2)',
  "const command = args.slice(args.indexOf('--') + 1)",
  'const run = []',
  'for (const w of command) {',
  "  if (w[0] === '$' && w[1] !== '{' && w[1] !== '$') {",
  '    const name = w.slice(1)',
  '    if (valid(name) && env[name] !== undefined) run.push(...env[name].split(/\\s+/).filter(Boolean))',
  '    continue',
  '  }',
  '  run.push(inWord(w))',
  '}',
  "process.exit(spawnSync(run[0], run.slice(1), { stdio: 'inherit', env }).status ?? 1)",
].join('\n')

// Words a person can type into a file name or a request, each of which some
// layer between the mod and the CLI has mangled at one time or another.
const HOSTILE_WORDS = [
  '$HOME', '$TODO.md', 'a$$b', '${HOME}/x', '$', '$$', 'price-$5', '$(touch pwned)', '`touch pwned`',
  "it's", '"quoted"', 'two words', 'line\nbreak', 'trailing\n', '', '-x', '--', '--version',
  '%n %u %h', 'naïve 文字 🚀', '\\back\\slash', 'tab\there', '*', '~', ';', '|',
]

interface FakeLaunch {
  /** What the fake `uname -s` prints. */
  uname: string
  /** /proc/self/cgroup's content, or null for a file that cannot be read. */
  cgroup: string | null
  /** The launch directory's name inside the sandbox. */
  dirName?: string
  words?: readonly string[]
}

async function fakeLaunch(o: FakeLaunch): Promise<{ argv: string[]; leaked: string[]; systemdRunCalls: number; scopeStarted: boolean }> {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-scope-fake-'))
  roots.push(root)
  const dir = join(root, o.dirName ?? 'launch')
  mkdirSync(dir)
  writeFileSync(join(dir, 'stdin'), '')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho '${o.uname}'\n`)
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexec "$FAKE_BUN" "$FAKE_SYSTEMD_RUN" "$@"\n')
  chmodSync(join(bin, 'uname'), 0o755)
  chmodSync(join(bin, 'systemd-run'), 0o755)
  writeFileSync(join(root, 'systemd-run.js'), EXPANDING_SYSTEMD_RUN)
  const calls = join(root, 'calls')
  const child = Bun.spawn(launchArgv(dir, dumpArgv(root, o.words ?? ['plain.md'])), {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      PLANNOTATOR_DATA_DIR: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MOD_CGROUP_FILE: o.cgroup === null ? join(root, 'no-cgroup-file') : cgroupFile(root, o.cgroup),
      FAKE_BUN: process.execPath,
      FAKE_SYSTEMD_RUN: join(root, 'systemd-run.js'),
      FAKE_CALLS: calls,
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  })
  expect(await child.exited).toBe(0)
  await waitFor(join(dir, 'exit'))
  expect(readFileSync(join(dir, 'exit'), 'utf8').trim()).toBe('0')
  expect(existsSync(join(root, 'pwned'))).toBe(false)
  return {
    ...dumped(root),
    systemdRunCalls: existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0,
    scopeStarted: existsSync(join(dir, 'scope-started')),
  }
}

describe.skipIf(process.platform === 'win32')('which launch the wrapper takes, and what reaches the CLI', () => {
  test('in an agent scope, a launch directory and words full of $ and quotes reach the CLI byte for byte, as they do in a login session', async () => {
    const dirName = 'launch a$$b ${HOME} $HOME'
    const scoped = await fakeLaunch({ uname: 'Linux', cgroup: AGENT_SCOPE, dirName, words: HOSTILE_WORDS })
    expect(scoped.systemdRunCalls).toBe(1)
    expect(scoped.scopeStarted).toBe(true)
    expect(scoped.argv).toEqual(HOSTILE_WORDS)
    expect(scoped.leaked).toEqual([])

    const plain = await fakeLaunch({ uname: 'Linux', cgroup: LOGIN_SESSION, dirName, words: HOSTILE_WORDS })
    expect(plain.systemdRunCalls).toBe(0)
    expect(plain.argv).toEqual(HOSTILE_WORDS)
  }, 20_000)

  test('a login session takes the plain launch and never runs systemd-run', async () => {
    const launch = await fakeLaunch({ uname: 'Linux', cgroup: LOGIN_SESSION })
    expect(launch.systemdRunCalls).toBe(0)
    expect(launch.scopeStarted).toBe(false)
    expect(launch.argv).toEqual(['plain.md'])
  })

  test('an unreadable /proc/self/cgroup takes the plain launch', async () => {
    const launch = await fakeLaunch({ uname: 'Linux', cgroup: null })
    expect(launch.systemdRunCalls).toBe(0)
    expect(launch.argv).toEqual(['plain.md'])
  })

  test('cgroup v1: the name=systemd line decides', async () => {
    const v1 = (unit: string) => `12:pids:/user.slice/user-1000.slice\n2:cpu,cpuacct:/user.slice\n1:name=systemd:/user.slice/user-1000.slice/${unit}\n0::/\n`
    expect((await fakeLaunch({ uname: 'Linux', cgroup: v1('session-c2.scope') })).systemdRunCalls).toBe(0)
    expect((await fakeLaunch({ uname: 'Linux', cgroup: v1('user@1000.service/app.slice/app-t3code.slice/t3code-claude-fern.scope') })).systemdRunCalls).toBe(1)
  })

  test('macOS and Git Bash never consult systemd-run, even from an agent scope', async () => {
    for (const uname of ['Darwin', 'MINGW64_NT-10.0-19045']) {
      const launch = await fakeLaunch({ uname, cgroup: AGENT_SCOPE, words: HOSTILE_WORDS })
      expect(launch.systemdRunCalls).toBe(0)
      expect(launch.scopeStarted).toBe(false)
      expect(launch.argv).toEqual(HOSTILE_WORDS)
    }
  }, 20_000)
})
