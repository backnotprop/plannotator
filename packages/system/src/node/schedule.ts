// The scheduled check on macOS: one launchd agent per drawn project.
//
//   ~/Library/LaunchAgents/ai.plannotator.system.<project key>.plist
//   label ai.plannotator.system.<project key>
//   program: <plannotator> system tick --project <root> --key <project key>
//
// The Inbox installs one when a first drawing finishes with "An agent on this
// Mac", and removes every one when System is switched off. launchctl runs
// through an injectable runner, so tests never load a job.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { SYSTEM_TICK_INTERVAL_SECONDS } from '../agent/command.ts';
import { checkKey, systemPaths } from './state.ts';

// How often the check runs: in agent/command.ts, beside the command's usage lines, so the help can say it.
export { SYSTEM_TICK_INTERVAL_SECONDS };

export const LABEL_PREFIX = 'ai.plannotator.system.';

/** The launchd label of a project's job. */
export const scheduleLabel = (key: string) => `${LABEL_PREFIX}${checkKey(key)}`;

/** Runs one command; the default runs it for real. */
export type CommandRunner = (argv: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type ScheduleOptions = {
  /** The Inbox's project key. */
  key: string;
  /** The project's folder (its repo root), absolute. */
  root: string;
  /** The plannotator binary, absolute. */
  program: string;
  /** Seconds between ticks; SYSTEM_TICK_INTERVAL_SECONDS unless given. */
  interval?: number;
  /** The Inbox's data folder, absolute: the job gets it as PLANNOTATOR_DATA_DIR. */
  dataDir: string;
  /** More environment for the job, PATH above all: launchd starts it with almost none, and the tick runs git, gh and the agent. */
  env?: Record<string, string>;
};

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Characters a plist (XML 1.0) cannot carry at all. */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/;

/** The plist text of a project's job. Pure: nothing is written. */
export function plist(o: ScheduleOptions): string {
  const label = scheduleLabel(o.key);
  for (const [name, path] of [['root', o.root], ['program', o.program], ['dataDir', o.dataDir]] as const) {
    if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path: ${path}`);
  }
  const interval = o.interval ?? SYSTEM_TICK_INTERVAL_SECONDS;
  if (!Number.isInteger(interval) || interval < 1) throw new Error(`interval must be a whole number of seconds: ${interval}`);
  const env: Record<string, string> = { ...o.env, PLANNOTATOR_DATA_DIR: o.dataDir };
  const texts = [o.root, o.program, ...Object.keys(env), ...Object.values(env)];
  if (texts.some((t) => NOT_XML.test(t))) throw new Error('a path or variable holds a control character a plist cannot carry');
  const string = (s: string) => `<string>${xml(s)}</string>`;
  const args = [o.program, 'system', 'tick', '--project', o.root, '--key', o.key];
  const log = join(systemPaths(o.dataDir, o.key).dir, 'tick.err.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${string(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    ${string(a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.keys(env).sort().map((k) => `    <key>${xml(k)}</key>${string(env[k]!)}`),
    '  </dict>',
    `  <key>WorkingDirectory</key>${string(o.root)}`,
    `  <key>StartInterval</key><integer>${interval}</integer>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>LowPriorityIO</key><true/>',
    `  <key>StandardOutPath</key>${string('/dev/null')}`,
    `  <key>StandardErrorPath</key>${string(log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

const realRunner: CommandRunner = (argv) =>
  new Promise((done) => {
    execFile(argv[0]!, argv.slice(1), { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

function launchd(o: { run?: CommandRunner; uid?: number }): { run: CommandRunner; domain: string } {
  if (!o.run && process.platform !== 'darwin') throw new Error('the scheduled check runs on macOS only (launchd)');
  const uid = o.uid ?? process.getuid?.();
  if (uid == null) throw new Error('no user id for the launchd domain');
  return { run: o.run ?? realRunner, domain: `gui/${uid}` };
}

/** The person's launchd agents folder, ~/Library/LaunchAgents. HOME first, so a test's temp HOME is the one used. */
export const launchAgentsDir = () => join(process.env.HOME || homedir(), 'Library', 'LaunchAgents');
const agentsDirOf = (o: { agentsDir?: string }) => o.agentsDir ?? launchAgentsDir();
const plistPath = (dir: string, key: string) => join(dir, `${scheduleLabel(key)}.plist`);

/**
 * Write a project's plist and load it (`launchctl bootstrap gui/<uid>`). A job
 * already loaded under the label is booted out first, so installing again
 * picks up a new root, program or environment.
 */
export async function install(o: ScheduleOptions & { agentsDir?: string; run?: CommandRunner; uid?: number }): Promise<void> {
  const text = plist(o);
  const { run, domain } = launchd(o);
  const dir = agentsDirOf(o);
  const path = plistPath(dir, o.key);
  await mkdir(dir, { recursive: true });
  await mkdir(systemPaths(o.dataDir, o.key).dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o644 });
  await rename(tmp, path);
  await run(['launchctl', 'bootout', `${domain}/${scheduleLabel(o.key)}`]);
  const loaded = await run(['launchctl', 'bootstrap', domain, path]);
  if (loaded.code !== 0) throw new Error(`launchctl bootstrap: ${(loaded.stderr || loaded.stdout).trim() || `exit ${loaded.code}`}`);
}

/** Unload a project's job (`launchctl bootout`) and delete its plist. A job that is not there is not an error. */
export async function remove(key: string, o: { agentsDir?: string; run?: CommandRunner; uid?: number } = {}): Promise<void> {
  const { run, domain } = launchd(o);
  await run(['launchctl', 'bootout', `${domain}/${scheduleLabel(key)}`]);
  await unlink(plistPath(agentsDirOf(o), key)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/** The project keys that have a System plist, so the Inbox can find strays from a crash. */
export async function list(o: { agentsDir?: string } = {}): Promise<string[]> {
  const names = await readdir(agentsDirOf(o)).catch(() => [] as string[]);
  return names
    .filter((n) => n.startsWith(LABEL_PREFIX) && n.endsWith('.plist'))
    .map((n) => n.slice(LABEL_PREFIX.length, -'.plist'.length))
    .filter((k) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(k) && !k.includes('..'))
    .sort();
}

export const schedule = { plist, install, remove, list, label: scheduleLabel, interval: SYSTEM_TICK_INTERVAL_SECONDS };
