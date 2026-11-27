import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_BROWSER } from '../../../../tests/helpers/no-browser'
import { cleanupArgv, launchArgv } from './launch'

const systemd = process.platform === 'linux' ? Bun.which('systemd-run') : null
const systemctl = process.platform === 'linux' ? Bun.which('systemctl') : null
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

describe.skipIf(process.platform !== 'linux')('detached launch without a usable user manager', () => {
  test('falls back to the original launch when systemd-run fails', async () => {
    const { root, dir } = sandbox()
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\necho attempted > "$PLANNOTATOR_DATA_DIR/attempted"\nexit 1\n')
    chmodSync(join(bin, 'systemd-run'), 0o755)
    const child = Bun.spawn(launchArgv(dir, ['/bin/sh', '-c', 'cat; exit 7']), {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
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
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
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
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, PLANNOTATOR_DATA_DIR: root, PLANNOTATOR_BROWSER: NO_BROWSER },
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
})
