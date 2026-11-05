/**
 * A sandboxed Inbox with Shape boards, for the Shape specs and their shots.
 * Everything lives in a scratch folder (inboxScratch): its data dir, its
 * config.json (Shape switched on or not), its projects. The threads come from
 * agents on the MCP stdio shim (SimAgent) and the boards from the real
 * `plannotator shape update`, exactly as an agent makes them. Invented
 * content only.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf } from './inbox-scratch';

const repo = resolve(__dirname, '../..');

/** The sandbox env every process of the world runs with (never the person's data, Inbox or agents). */
export function shapeWorldEnv(root: string): Record<string, string> {
  const scratchConfig = join(root, 'config-home');
  mkdirSync(scratchConfig, { recursive: true });
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: '1',
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    // Agents' own config folders, read by the Inbox's skill list: scratch ones.
    CLAUDE_CONFIG_DIR: join(scratchConfig, 'claude'),
    CODEX_HOME: join(scratchConfig, 'codex'),
    XDG_CONFIG_HOME: join(scratchConfig, 'xdg'),
  };
}

const css = `
.card { width: min(520px, calc(100% - 32px)); box-sizing: border-box; margin: 40px auto; border-radius: 14px; background: var(--surface); box-shadow: 0 0 0 1px var(--rule), 0 12px 30px -18px rgba(0,0,0,.35); padding: 22px 24px; }
.card h3 { margin: 0 0 6px; font-size: 17px; }
.card p { margin: 0 0 14px; color: var(--ink2); font-size: 14px; }
.row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-top: 1px solid var(--rule); font-size: 14px; }
.pill { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--sunk); color: var(--grey); }
.on { background: var(--mark-soft); color: var(--mark); box-shadow: 0 0 0 1.5px var(--mark); }
.btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.btn { font-size: 13px; padding: 6px 12px; border-radius: 8px; box-shadow: 0 0 0 1px var(--rule); }
.btn.primary { background: var(--ink); color: var(--paper); box-shadow: none; }
.label { position: absolute; font-size: 13px; color: var(--mark); }
.wrap { position: relative; }
`;

function dialogBoard(title: string, claim: string, heading: string, lines: [string, string, boolean][], note: string) {
  const rows = lines.map(([k, v, on], i) => `<div class="row" id="row-${i}" data-step="${i + 2}" data-mark="row-${i}"><span>${k}</span><span class="pill${on ? ' on' : ''}">${v}</span></div>`).join('');
  return {
    title,
    claim,
    views: {
      picture: {
        html: `<div class="wrap"><div class="card" data-step="1" data-mark="card"><h3 data-mark="heading">${heading}</h3><p data-mark="note">${note} <a href="#row-0" data-link="hash">The first row</a> · <a href="https://example.com/notes" data-link="out">notes</a></p>${rows}<div class="btns" data-step="9"><span class="btn">Not now</span><span class="btn primary">Turn it on</span></div></div></div>`,
        css,
      },
      how: {
        html: `<svg viewBox="0 0 900 300" width="900" height="300"><g data-step="1" data-mark="how-start"><rect class="ink" x="20" y="110" width="200" height="70" rx="12"/><text x="120" y="150" text-anchor="middle">You open the thread</text></g><path class="line draw" pathLength="1" d="M220 145 H340" data-step="2"/><text x="280" y="135" text-anchor="middle" class="t-grey" data-step="2">checks</text><g data-step="3" data-mark="how-rule"><rect class="acc-fill" x="340" y="110" width="220" height="70" rx="12"/><text x="450" y="150" text-anchor="middle" class="t-acc">Shown once, ever</text></g><path class="line draw" pathLength="1" d="M560 145 H680" data-step="4"/><text x="620" y="135" text-anchor="middle" class="t-grey" data-step="4">shows</text><g data-step="5" data-mark="how-out"><rect class="ink" x="680" y="110" width="200" height="70" rx="12"/><text x="780" y="150" text-anchor="middle">The dialog</text></g></svg>`,
        width: 900,
        height: 300,
      },
      know: 'Everyone who used the app **2 days** or more sees it [^1]. It shows once, ever, and any way out counts.',
    },
    refs: [
      { n: 1, kind: 'file', title: 'Who gets it', target: 'src/reveal.ts', line: 3 },
      { n: 2, kind: 'image', title: 'Today\'s dialog', target: 'shot.png' },
    ],
  };
}

export interface ShapeWorld {
  root: string;
  url: string;
  dataDir: string;
  env: Record<string, string>;
  agents: SimAgent[];
  projects: Record<string, string>;
  threads: Record<string, string>;
  boards: Record<string, string>;
  /** Runs `plannotator shape …` as an agent of this world would. */
  shape: (args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string };
}

/**
 * The world: three projects, threads from Claude Code, and boards. `boards: 'many'` makes four (the sidebar row
 * shows), `'few'` two (search only). `shape`: config.json `inboxShape`; `board`: `inboxBoard`.
 */
export async function seedShapeWorld(options: { binary: string; /** config.json `inboxShape` once the boards are drawn. */ shape: boolean; board?: boolean; boards?: 'many' | 'few' | 'none'; prefix?: string }): Promise<ShapeWorld> {
  const root = inboxScratch(options.prefix ?? 'plannotator-inbox-shape-');
  const env = shapeWorldEnv(root);
  const dataDir = env.PLANNOTATOR_DATA_DIR;
  markTourDecided(dataDir);
  const configPath = join(dataDir, 'config.json');
  const writeConfig = (change: Record<string, unknown>) => writeFileSync(configPath, JSON.stringify({ ...(JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>), ...change }));
  // On while the boards are drawn (the command is refused while Shape is off); the switch is set as asked after.
  writeConfig({ inboxShape: true, inboxBoard: options.board ?? true });
  const started = spawnSync(options.binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  if (started.status !== 0) throw new Error(`inbox --background: ${started.stderr}`);
  rememberInboxOf(dataDir);
  const src = join(root, 'src');
  const projects = { plannotator: scratchProject(src, 'plannotator'), relay: scratchProject(src, 'relay'), pando: scratchProject(src, 'pando') };
  // One agent per thread: a session's messages in one project share a thread.
  const claude = await SimAgent.connect({ binary: options.binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary: options.binary, env, name: 'Codex', host: 'codex' });
  const threads: Record<string, string> = {};
  const snooze = await claude.send({ project_path: projects.plannotator, subject: 'Snooze: announce it once', body: 'The dialog is built. It shows once, ever, after 2 days of use. No question waits on you.' });
  threads.snooze = snooze.thread_id as string;
  const kettle = await claude.send({ project_path: projects.relay, subject: 'Kettle: one whistle', body: 'The kettle now whistles once when it boils, then stays quiet.' });
  threads.kettle = kettle.thread_id as string;
  const notes = await codex.send({ project_path: projects.plannotator, subject: 'Release notes page', body: 'The notes page lists each release with its date.' });
  threads.notes = notes.thread_id as string;

  const shape = (args: string[], cwd = projects.plannotator) => {
    const r = spawnSync(options.binary, ['shape', ...args], { env, cwd, encoding: 'utf8', timeout: 30_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const boards: Record<string, string> = {};
  const put = (key: string, project: string, board: unknown, thread: string | null) => {
    const dir = join(root, 'boards', key);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(repo, 'tests/manual/shape-harness/public/refs/built-desktop-light.png'), join(dir, 'shot.png'));
    writeFileSync(join(dir, 'board.json'), JSON.stringify(board));
    const r = shape(['update', '--file', join(dir, 'board.json'), '--project', project, ...(thread ? ['--thread', thread] : [])], project);
    if (r.status !== 0) throw new Error(`shape update ${key}: ${r.stderr}`);
    boards[key] = (JSON.parse(r.stdout) as { id: string }).id;
  };
  if ((options.boards ?? 'many') !== 'none') {
    put('snooze', projects.plannotator, dialogBoard('A one-time Snooze announcement', 'Built. Nothing waits on you.', 'Snooze a thread until later', [['Later today', '1:00 PM', false], ['Tomorrow', 'Wed 9:00 AM', true], ['Next week', 'Mon 9:00 AM', false]], 'Pick when it comes back. The thread leaves the list until then.'), threads.snooze!);
    put('night', projects.pando, dialogBoard('Night mode for the reader', 'Proposed. Waits on your pick of the default.', 'Reading at night', [['Follow the system', 'Default', true], ['Always dark', 'Off', false], ['Warmer text after 9 PM', 'Off', false]], 'The reader follows your system unless you pick.'), null);
    if (options.boards !== 'few') {
      put('kettle', projects.relay, dialogBoard('The kettle whistles once', 'Built. Merged on main.', 'Kettle sounds', [['When it boils', 'One whistle', true], ['When it is ready again', 'Silent', false]], 'One whistle, then quiet until the next boil.'), threads.kettle!);
      put('notes', projects.plannotator, dialogBoard('Release notes, one page per release', 'In review.', 'What\'s new', [['0.28.48', 'Nov 3', true], ['0.28.47', 'Oct 30', false], ['0.28.46', 'Oct 27', false]], 'Each release, newest first, with what changed.'), threads.notes!);
    }
  }
  if (!options.shape) writeConfig({ inboxShape: false });
  return { root, url: started.stdout.trim(), dataDir, env, agents: [claude, codex], projects, threads, boards, shape };
}
