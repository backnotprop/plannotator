/**
 * The Inbox turns on only when the person runs it (packages/shared/inbox/turned-on.ts), against the compiled
 * binary with the real rule: PLANNOTATOR_TEST_INBOX_ON=0, and a data dir with no mark (`<root>/fresh`, not the
 * `<root>/data` inboxScratch marks as turned on). Registered by inbox.spec.ts, so Browser smoke runs them on every PR.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from './inbox-test';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { LISTED_AGENTS } from '../../apps/marketing/src/lib/inbox-agents';
import { agentSetup, bareCommand, forbiddenCommand, llmsInboxSetup, OPEN_INBOX, promptSetup, setupCommands, TURN_ON, type SetupText } from '../helpers/setup-texts';
import { INBOX_OFF_LINE } from '../../packages/shared/inbox/connection';

const repo = resolve(__dirname, '../..');
const SSH = { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' };

/** The real rule, a scratch HOME and a data dir with no mark. PLANNOTATOR_TEST_SANDBOX keeps a login item's launchctl/systemctl off the machine. */
function realRuleEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: join(root, 'fresh'), PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, NO_ANON_PING: '1', PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_TEST_INBOX_ON: '0', ...extra };
}
const markIn = (dataDir: string): { on: boolean; by: string } | null => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'inbox', 'turned-on'), 'utf8')) as { on: boolean; by: string };
  } catch {
    return null;
  }
};
const ran = (dataDir: string) => existsSync(join(dataDir, 'inbox', 'inbox.json'));
const URL_LINE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?$/;
const mcpLines = (...messages: object[]) => messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
const MCP_INIT = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

export function turnedOnCases(binary: string): void {
  test('Inbox off on a fresh computer: every agent path gives the one line and starts nothing', async () => {
    const root = inboxScratch('plannotator-inbox-off-e2e-');
    try {
      const env = realRuleEnv(root);
      const dataDir = env.PLANNOTATOR_DATA_DIR;
      const refused: [string[], Record<string, string>][] = [
        [['inbox', '--background'], {}],
        [['inbox', 'restart'], {}],
        [['inbox', 'call', 'send_message', '{"body":"Ship it?"}'], {}],
        // A detached start (an older Inbox's Restart spawns one) is Plannotator's own.
        [['inbox', '--no-open'], { PLANNOTATOR_INBOX_DETACHED: '1' }],
      ];
      for (const [args, extra] of refused) {
        const run = spawnSync(binary, args, { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
        expect([args.join(' '), run.status]).toEqual([args.join(' '), 1]);
        expect([args.join(' '), `${run.stdout}${run.stderr}`.includes(INBOX_OFF_LINE)]).toEqual([args.join(' '), true]);
      }
      const mcp = spawnSync(binary, ['inbox', 'mcp'], {
        env,
        encoding: 'utf8',
        timeout: 30_000,
        input: mcpLines(...MCP_INIT, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { body: 'Ship it?' } } }),
      });
      const answers = mcp.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[] }; error?: { message: string } });
      expect(answers.find((a) => a.id === 2)?.result?.tools).toEqual([]);
      expect(answers.find((a) => a.id === 3)?.error?.message).toBe(INBOX_OFF_LINE);
      expect([ran(dataDir), markIn(dataDir)]).toEqual([false, null]);
    } finally {
      await removeInboxScratch(root);
    }
  });

  test('Inbox on: plannotator inbox, --no-open and --open turn it on; --background alone (an older plugin) never does', async () => {
    for (const way of ['bare', '--no-open', '--open', '--background'] as const) {
      const root = inboxScratch('plannotator-inbox-on-e2e-');
      try {
        const env = realRuleEnv(root, way === '--open' ? SSH : {});
        const dataDir = env.PLANNOTATOR_DATA_DIR;
        if (way === '--open' || way === '--background') {
          const run = spawnSync(binary, ['inbox', way], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
          if (way === '--background') {
            expect([way, run.status, run.stderr.includes(INBOX_OFF_LINE), ran(dataDir), markIn(dataDir)]).toEqual([way, 1, true, false, null]);
            continue;
          }
          expect([way, run.status]).toEqual([way, 0]);
          expect(run.stdout.trim()).toMatch(URL_LINE);
        } else {
          // The person's own run serves in the foreground: wait for it to come up, then stop it.
          const served = spawn(binary, way === 'bare' ? ['inbox'] : ['inbox', '--no-open'], { env, stdio: 'ignore' });
          try {
            await expect.poll(() => ran(dataDir), { timeout: 60_000 }).toBe(true);
          } finally {
            // Wait for it to be gone: a start beside an Inbox still shutting down is a different case.
            const gone = new Promise<void>((done) => (served.exitCode !== null || served.signalCode !== null ? done() : served.once('exit', () => done())));
            served.kill('SIGTERM');
            await Promise.race([gone, new Promise((done) => setTimeout(done, 30_000))]);
          }
        }
        expect([way, markIn(dataDir)]).toEqual([way, expect.objectContaining({ on: true, by: 'command' })]);
        // Turned on, Plannotator's own start works as before.
        const again = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
        expect([way, again.status, again.stdout.trim(), again.status === 0 ? '' : again.stderr]).toEqual([way, 0, expect.stringMatching(URL_LINE), '']);
      } finally {
        await removeInboxScratch(root);
      }
    }
  });

  // Where an Inbox already ran, it stays on: a person who only reads threads and picks answers in the window
  // (inbox.json and projects/* on disk, nothing else), and a person's Inbox an older plannotator started on a fresh
  // computer (it writes inbox.json and no mark). Restart (what Update ends in) brings it back.
  test('Inbox where one already ran (no mark): the reading-and-picking window user and an older plannotator stay on, and Restart works', async () => {
    const shapes: [string, (dataDir: string) => void][] = [
      ['window user who reads and picks only', (d) => {
        mkdirSync(join(d, 'inbox', 'projects', 'p1'), { recursive: true });
        writeFileSync(join(d, 'inbox', 'projects', 'p1', 'questions.jsonl'), '{"id":"q1","picked_at":"2026-11-01T00:00:00.000Z"}\n');
      }],
      ['an older plannotator started it', () => undefined],
    ];
    for (const [name, arrange] of shapes) {
      const root = inboxScratch('plannotator-inbox-existing-e2e-');
      try {
        const env = realRuleEnv(root);
        const dataDir = env.PLANNOTATOR_DATA_DIR;
        mkdirSync(join(dataDir, 'inbox'), { recursive: true });
        // The registry an Inbox left (stopped).
        writeFileSync(join(dataDir, 'inbox', 'inbox.json'), JSON.stringify({ pid: 999999, port: 9, token: 'old', serverSession: 'old', version: '0.29.0', startedAt: '2026-11-01T00:00:00.000Z' }));
        arrange(dataDir);
        const run = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
        expect([name, run.status, run.stdout.trim()]).toEqual([name, 0, expect.stringMatching(URL_LINE)]);
        expect([name, markIn(dataDir)]).toEqual([name, expect.objectContaining({ on: true, by: 'update-existing' })]);
        const restarted = spawnSync(binary, ['inbox', 'restart'], { env, encoding: 'utf8', timeout: 60_000 });
        expect([name, restarted.status, restarted.stdout.trim()]).toEqual([name, 0, expect.stringMatching(URL_LINE)]);
      } finally {
        await removeInboxScratch(root);
      }
    }
  });

  // The --open that turns the Inbox on (the setup's step) connects the agents it finds, but only after its URL is
  // out, and returns within its callers' 30 s wait.
  test('Inbox --open that turns it on prints its URL before it connects the agents it finds, and returns within 30 s', async () => {
    const root = inboxScratch('plannotator-inbox-open-connect-e2e-');
    try {
      const { PLANNOTATOR_INBOX_CONNECT: _off, ...env } = realRuleEnv(root, SSH);
      // An agent the connect finds: Cursor, in the sandbox's agent home.
      mkdirSync(join(env.PLANNOTATOR_DATA_DIR, 'agents-home', '.cursor'), { recursive: true });
      // stdout and stderr into one file, so their order is kept.
      const out = join(root, 'open.out');
      const fd = openSync(out, 'w');
      const started = Date.now();
      let run: ReturnType<typeof spawnSync>;
      try {
        run = spawnSync(binary, ['inbox', '--open'], { env, timeout: 30_000, stdio: ['ignore', fd, fd] });
      } finally {
        closeSync(fd);
      }
      expect([run.error?.message ?? null, run.status]).toEqual([null, 0]);
      expect(Date.now() - started).toBeLessThan(30_000);
      const lines = readFileSync(out, 'utf8').split('\n');
      const urlAt = lines.findIndex((line) => URL_LINE.test(line.trim()));
      const connectedAt = lines.findIndex((line) => /^Connected .*Cursor/.test(line));
      expect([urlAt >= 0, connectedAt > urlAt]).toEqual([true, true]);
      expect(existsSync(join(env.PLANNOTATOR_DATA_DIR, 'agents-home', '.cursor', 'mcp.json'))).toBe(true);
    } finally {
      await removeInboxScratch(root);
    }
  });

  // Where the Inbox is on already (every existing install), --open is what it was before the mark: start a stopped
  // Inbox, open the window, print the URL, return. It connects nothing, so /plannotator-inbox changes nothing.
  // Its mark is written once: --open and bare `plannotator inbox` never rewrite a mark that says on (bytes and mtime kept).
  test('Inbox --open where it is on already connects nothing and returns at once, as before the mark, and no run rewrites the mark', async () => {
    const shapes: [string, (dataDir: string) => void][] = [
      ['the mark says on', (d) => writeFileSync(join(d, 'inbox', 'turned-on'), '{"on":true,"by":"command","at":"2026-11-19T00:00:00.000Z"}\n')],
      ['an Inbox ran here before the mark', (d) => writeFileSync(join(d, 'inbox', 'inbox.json'), JSON.stringify({ pid: 999999, port: 9, token: 'old', serverSession: 'old', version: '0.29.0', startedAt: '2026-11-01T00:00:00.000Z' }))],
    ];
    for (const [name, arrange] of shapes) {
      const root = inboxScratch('plannotator-inbox-open-on-e2e-');
      try {
        const { PLANNOTATOR_INBOX_CONNECT: _off, ...env } = realRuleEnv(root, SSH);
        const dataDir = env.PLANNOTATOR_DATA_DIR;
        mkdirSync(join(dataDir, 'inbox'), { recursive: true });
        arrange(dataDir);
        // An agent a connect would find, and connect: Cursor, in the sandbox's agent home.
        mkdirSync(join(dataDir, 'agents-home', '.cursor'), { recursive: true });
        const markPath = join(dataDir, 'inbox', 'turned-on');
        const markNow = () => (existsSync(markPath) ? { text: readFileSync(markPath, 'utf8'), mtime: statSync(markPath).mtimeMs } : null);
        const before = markNow();
        const run = spawnSync(binary, ['inbox', '--open'], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
        expect([name, run.error?.message ?? null, run.status, run.stdout.trim()]).toEqual([name, null, 0, expect.stringMatching(URL_LINE)]);
        expect([name, /Connected /.test(run.stderr), existsSync(join(dataDir, 'agents-home', '.cursor', 'mcp.json'))]).toEqual([name, false, false]);
        expect([name, markIn(dataDir)?.on]).toEqual([name, true]);
        // The mark that was there is untouched; one written by this first read (from before the mark) is written once.
        const written = markNow();
        if (before) expect([name, written]).toEqual([name, before]);
        // Bare `plannotator inbox` with the Inbox running opens a tab, connects and exits: the mark stays as it is.
        const bare = spawnSync(binary, ['inbox'], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
        expect([name, bare.error?.message ?? null, bare.status]).toEqual([name, null, 0]);
        expect([name, markNow()]).toEqual([name, written]);
      } finally {
        await removeInboxScratch(root);
      }
    }
  });

  /**
   * The first setup on a fresh computer: the setup script, the llms Inbox page and the Claude Code and Codex pages
   * (tests/helpers/setup-texts.ts), each with and without SSH_CONNECTION, stdin never a terminal. Every command from
   * them, in their order: none gets the off line, and once the Inbox is on, `plannotator inbox mcp` lists the tools
   * and the script's first message is sent. The script and the llms page are an agent's: each command returns
   * (setup-order.test.ts keeps bare `plannotator inbox` and `--background` out of them). The Claude Code and Codex
   * pages are a person's: their bare `plannotator inbox` serves in the foreground while the rest runs.
   */
  test('First setup: the setup script, the llms page, the Claude Code and Codex pages run in order: never off, each returns, tools after the turn-on', async () => {
    const promptSource = readFileSync(join(repo, 'apps/marketing/src/lib/inbox-prompt.md'), 'utf8');
    const agent = (slug: string) => agentSetup(LISTED_AGENTS.find((a) => a.slug === slug)!);
    const pages: SetupText[] = [promptSetup(promptSource), llmsInboxSetup(), agent('claude-code'), agent('codex')];
    const RETURNS_WITHIN_MS = 30_000;
    /** What an agent runs from a page: the read-only commands, the turn-on and the MCP server. */
    const runnable = (command: string) => /^plannotator (?:--version|--help|inbox --help|inbox call --help|inbox --open|inbox mcp)(?:\s|$)/.test(bareCommand(command)) || bareCommand(command) === OPEN_INBOX;
    for (const page of pages) {
      for (const ssh of [false, true]) {
        const where = `${page.name}${ssh ? ' over SSH' : ''}`;
        const root = inboxScratch('plannotator-inbox-setup-walk-e2e-');
        let served: ReturnType<typeof spawn> | null = null;
        try {
          const env = realRuleEnv(root, ssh ? SSH : {});
          const commands = setupCommands(page.text).filter(runnable);
          expect([where, commands.includes(page.by === 'agent' ? TURN_ON : OPEN_INBOX)]).toEqual([where, true]);
          let on = false;
          for (const command of commands) {
            expect([where, command, forbiddenCommand(command, page.by)]).toEqual([where, command, null]);
            if (bareCommand(command) === OPEN_INBOX && served) {
              // Again, with the Inbox running: it opens a tab, connects and exits.
              const again = spawnSync(binary, ['inbox'], { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
              expect([where, command, again.status]).toEqual([where, command, 0]);
              continue;
            }
            if (bareCommand(command) === OPEN_INBOX) {
              // The person's own run, in their terminal: it turns the Inbox on and serves it.
              served = spawn(binary, ['inbox'], { env, stdio: 'ignore' });
              await expect.poll(() => ran(env.PLANNOTATOR_DATA_DIR), { timeout: 60_000 }).toBe(true);
              expect(markIn(env.PLANNOTATOR_DATA_DIR)).toMatchObject({ on: true, by: 'command' });
              on = true;
              continue;
            }
            const assignments = Object.fromEntries([...command.slice(0, command.length - bareCommand(command).length).matchAll(/([A-Z_]+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]));
            const args = bareCommand(command).replace(/\s*<.*$/, '').split(/\s+/).slice(1);
            let input: string | undefined;
            if (args[0] === 'inbox' && args[1] === 'mcp') {
              // `inbox mcp < first.json`: the script's first message, as the script has the agent write it (one line, no initialize).
              const first = command.includes('<') ? page.text.slice(page.text.indexOf(command)).match(/```json\n(.*)\n```/)?.[1] : undefined;
              input = first ? `${first.replaceAll('AGENT_NAME', 'Codex').replaceAll('AGENT_HOST', 'codex')}\n` : mcpLines(...MCP_INIT);
            }
            const started = Date.now();
            const run = spawnSync(binary, args, { env: { ...env, ...assignments }, encoding: 'utf8', timeout: RETURNS_WITHIN_MS, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
            expect([where, command, run.error?.message ?? null, run.status]).toEqual([where, command, null, 0]);
            expect(Date.now() - started).toBeLessThan(RETURNS_WITHIN_MS);
            expect([where, command, `${run.stdout}${run.stderr}`.includes(INBOX_OFF_LINE)]).toEqual([where, command, false]);
            if (bareCommand(command) === TURN_ON) {
              on = true;
              expect(run.stdout.trim()).toMatch(URL_LINE);
              expect(markIn(env.PLANNOTATOR_DATA_DIR)).toMatchObject({ on: true, by: 'command' });
            }
            if (args[0] === 'inbox' && args[1] === 'mcp') {
              expect([where, command, on]).toEqual([where, command, true]);
              const answers = run.stdout.trim().split('\n').map((l) => JSON.parse(l) as { id?: number; result?: { tools?: unknown[]; structuredContent?: { thread_id?: string } } });
              if (input?.includes('"tools/list"')) expect(answers.find((a) => a.id === 2)?.result?.tools?.length ?? 0).toBeGreaterThan(0);
              else expect(answers.find((a) => a.id === 1)?.result?.structuredContent?.thread_id).toBeTruthy();
            }
          }
        } finally {
          if (served) {
            const child = served;
            const gone = new Promise<void>((done) => (child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', () => done())));
            child.kill('SIGTERM');
            await Promise.race([gone, new Promise((done) => setTimeout(done, 30_000))]);
          }
          await removeInboxScratch(root);
        }
      }
    }
  });
}
