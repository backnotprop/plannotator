import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install, launchAgentsDir, list, plist, remove, scheduleLabel, SYSTEM_TICK_INTERVAL_SECONDS, type CommandRunner } from '../src/node/index.ts';
import { tempDir } from './helpers.ts';

// launchctl never runs for real here: every install and remove gets a runner
// that records the command, and every plist goes to a temp folder.

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
function sandbox() {
  const t = tempDir();
  cleanups.push(t.done);
  return { agentsDir: join(t.dir, 'LaunchAgents'), dataDir: join(t.dir, 'data'), dir: t.dir };
}
function recorder(answers: Record<string, number> = {}) {
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return { code: answers[argv[1]!] ?? 0, stdout: '', stderr: answers[argv[1]!] ? 'Bootstrap failed: 5: Input/output error' : '' };
  };
  return { calls, run };
}
const base = (dataDir: string) => ({
  key: 'acme-1a2b3c', root: '/srv/code/R&D <acme>', program: '/usr/local/bin/plannotator', dataDir,
  env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
});

test('the check runs every 15 minutes, as the owner ruled', () => {
  expect(SYSTEM_TICK_INTERVAL_SECONDS).toBe(900);
});

describe('plist', () => {
  test.skipIf(process.platform !== 'darwin')('is a valid property list that runs the tick for this project with the data folder', () => {
    const s = sandbox();
    const file = join(s.dir, 'job.plist');
    writeFileSync(file, plist(base(s.dataDir)));
    expect(execFileSync('plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
    const job = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    expect(job.Label).toBe('ai.plannotator.system.acme-1a2b3c');
    expect(job.ProgramArguments).toEqual(['/usr/local/bin/plannotator', 'system', 'tick', '--project', '/srv/code/R&D <acme>', '--key', 'acme-1a2b3c']);
    expect(job.StartInterval).toBe(900);
    expect(job.RunAtLoad).toBe(true);
    expect(job.EnvironmentVariables).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin:/bin', PLANNOTATOR_DATA_DIR: s.dataDir });
    expect(job.StandardErrorPath).toBe(join(s.dataDir, 'system', 'acme-1a2b3c', 'tick.err.log'));
  });

  test('the data folder given always wins over one in env', () => {
    const s = sandbox();
    const text = plist({ ...base(s.dataDir), env: { PLANNOTATOR_DATA_DIR: '/elsewhere' } });
    expect(text).toContain(`<key>PLANNOTATOR_DATA_DIR</key><string>${s.dataDir}</string>`);
    expect(text).not.toContain('/elsewhere');
  });

  test('refuses what would make a broken or misdirected job', () => {
    const s = sandbox();
    expect(() => plist({ ...base(s.dataDir), root: 'code/acme' })).toThrow('root must be an absolute path');
    expect(() => plist({ ...base(s.dataDir), program: 'plannotator' })).toThrow('program must be an absolute path');
    expect(() => plist({ ...base(s.dataDir), key: '../x' })).toThrow('not a project key');
    expect(() => plist({ ...base(s.dataDir), interval: 0 })).toThrow('interval');
    expect(() => plist({ ...base(s.dataDir), root: '/a\u0001b' })).toThrow('control character');
  });
});

describe('install, list and remove', () => {
  test('install writes the plist, boots out an old job and bootstraps the new one; remove undoes it', async () => {
    const s = sandbox();
    const { calls, run } = recorder();
    await install({ ...base(s.dataDir), agentsDir: s.agentsDir, run, uid: 501 });
    const file = join(s.agentsDir, 'ai.plannotator.system.acme-1a2b3c.plist');
    expect(readFileSync(file, 'utf8')).toBe(plist(base(s.dataDir)));
    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501/ai.plannotator.system.acme-1a2b3c'],
      ['launchctl', 'bootstrap', 'gui/501', file],
    ]);
    expect(await list({ agentsDir: s.agentsDir })).toEqual(['acme-1a2b3c']);

    calls.length = 0;
    await remove('acme-1a2b3c', { agentsDir: s.agentsDir, run, uid: 501 });
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/ai.plannotator.system.acme-1a2b3c']]);
    expect(existsSync(file)).toBe(false);
    expect(await list({ agentsDir: s.agentsDir })).toEqual([]);
    // removing again, or a project never installed, is not an error
    await remove('acme-1a2b3c', { agentsDir: s.agentsDir, run, uid: 501 });
  });

  test('a bootstrap launchd refuses is an error that names it', async () => {
    const s = sandbox();
    const { run } = recorder({ bootstrap: 5 });
    await expect(install({ ...base(s.dataDir), agentsDir: s.agentsDir, run, uid: 501 })).rejects.toThrow('launchctl bootstrap: Bootstrap failed');
  });

  test('list finds only System jobs, for the Inbox to clear strays', async () => {
    const s = sandbox();
    const { run } = recorder();
    await install({ ...base(s.dataDir), agentsDir: s.agentsDir, run, uid: 501 });
    await install({ ...base(s.dataDir), key: 'small-4d5e6f', agentsDir: s.agentsDir, run, uid: 501 });
    writeFileSync(join(s.agentsDir, 'com.example.other.plist'), '');
    expect(await list({ agentsDir: s.agentsDir })).toEqual(['acme-1a2b3c', 'small-4d5e6f']);
    expect(await list({ agentsDir: join(s.dir, 'none') })).toEqual([]);
  });

  test('with no agentsDir the plist goes to ~/Library/LaunchAgents, here a temp HOME', async () => {
    const s = sandbox();
    const before = process.env.HOME;
    process.env.HOME = s.dir;
    try {
      // never reach the real folder
      expect(launchAgentsDir()).toBe(join(s.dir, 'Library', 'LaunchAgents'));
      const { run } = recorder();
      await install({ ...base(s.dataDir), run, uid: 501 });
      expect(existsSync(join(s.dir, 'Library', 'LaunchAgents', `${scheduleLabel('acme-1a2b3c')}.plist`))).toBe(true);
    } finally {
      process.env.HOME = before;
    }
  });
});
