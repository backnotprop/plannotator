/**
 * Retake the "themes" dialog's pictures (packages/inbox/assets/theme-chooser/*.webp; the dialog:
 * packages/inbox/components/ThemeChooser.tsx). Not a test. One command, after `bun run build:hook`:
 *
 *   bun scripts/theme-chooser-shots.ts [--out <folder>]
 *
 * It starts a scratch Inbox of its own (a temp data dir and a temp HOME, in a child process; never the person's
 * Inbox, and no browser of theirs), writes three made-up threads, and opens the "Theme switch" thread in a headless
 * Chromium (Playwright's) once per picture: Plannotator Original and Modern in light and dark, and Catppuccin dark,
 * Solarized light and Tokyo Night dark for "Choose your own". The theme is set as a person's cookies set it
 * (`plannotator-theme`, `plannotator-light-theme`, `plannotator-dark-theme`).
 *
 *  - d-<theme>-<mode>.webp: a 1000x680 window at 2x, saved 1360x925 (the fan's sheets are 660 px wide, drawn at 2x).
 *  - p-<theme>-<mode>.webp: a 390x560 phone at 3x, saved 600x862 (the deck's sheets are at most 294 px wide).
 *
 * WebP at quality 0.84, encoded by that Chromium (no image tool to install). Look at each picture before committing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const BUILT_PAGE = join(REPO, 'apps/hook/dist/inbox.html');

const SHEETS: readonly { theme: string; mode: 'light' | 'dark'; phone: boolean }[] = [
  ...(['plannotator', 'plannotator-modern'] as const).flatMap((theme) => (['light', 'dark'] as const).flatMap((mode) => [false, true].map((phone) => ({ theme, mode, phone })))),
  { theme: 'catppuccin', mode: 'dark', phone: false },
  { theme: 'solarized', mode: 'light', phone: false },
  { theme: 'tokyo-night', mode: 'dark', phone: false },
];
const DESKTOP = { viewport: { width: 1000, height: 680 }, scale: 2, out: { width: 1360, height: 925 } };
const PHONE = { viewport: { width: 390, height: 560 }, scale: 3, out: { width: 600, height: 862 } };
const SUBJECT = 'Theme switch';

if (process.argv[2] === '--serve') await serve(process.argv[3]!);
else await shoot();

/** The child: a scratch Inbox with the made-up threads; prints `{ port }` and runs until killed. */
async function serve(root: string): Promise<void> {
  const { refuseRealDataDir } = await import('../tests/helpers/real-data-dir');
  const { refuseRealHome } = await import('../tests/helpers/inbox-process');
  const dataDir = join(root, 'data');
  refuseRealDataDir(dataDir, 'theme-chooser-shots');
  refuseRealHome(process.env.HOME, 'theme-chooser-shots');
  // config.json follows the env: the child was started with it, and it is named here too so nothing else can be read.
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const { InboxStore } = await import('../packages/shared/inbox/store');
  const { startInboxServer } = await import('../packages/server/inbox');
  const past = '2026-10-01T10:00:00.000Z';
  // The tour and the first-run asks are settled, so the window opens on the list.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxTour: { version: 2, seen_at: past, skipped_at: past }, inboxNotifications: { dismissed: true }, inboxAgentNotes: { offered: true }, inboxLaunch: { enabled: false } }));
  const store = InboxStore.open(dataDir);
  const projectRoot = join(root, 'plannotator');
  mkdirSync(projectRoot, { recursive: true });
  const project = store.ensureProject({ name: 'plannotator', root: projectRoot });
  const send = (host: string, name: string, subject: string, body: string) => store.sendMessage({ project_id: project.id, author: { kind: 'agent', host, session: `ses_shots_${subject.replace(/\W/g, '').toLowerCase()}`, name }, subject, body });
  send('codex', 'Codex', 'Release notes', 'The release notes are drafted: three fixes and the new Settings page.');
  send('claude-code', 'Claude Code', 'Docs pass', 'The docs pass is done. I shortened the install page and fixed two dead links.');
  send(
    'claude-code',
    'Claude Code',
    SUBJECT,
    [
      'The theme switch is in. It reads your setting, then follows the system:',
      '',
      '```ts',
      "const dark = matchMedia('(prefers-color-scheme: dark)');",
      "const mode = setting === 'system'",
      "  ? (dark.matches ? 'dark' : 'light')",
      '  : setting;',
      "root.classList.toggle('light', mode === 'light');",
      '```',
      '',
      ':::question',
      'Ship the theme switch in this release?',
      '',
      '- [ ] Yes, ship it (recommended)',
      '- [ ] Hold it for the next release',
      ':::',
    ].join('\n'),
  );
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, version: 'dev', htmlContent: readFileSync(BUILT_PAGE, 'utf8') });
  console.log(JSON.stringify({ port: server.port }));
  await new Promise(() => {});
}

async function shoot(): Promise<void> {
  if (!existsSync(BUILT_PAGE)) throw new Error(`${BUILT_PAGE} is missing: run \`bun run build:hook\` first.`);
  const outFlag = process.argv.indexOf('--out');
  const out = outFlag > 0 ? resolve(process.argv[outFlag + 1]!) : join(REPO, 'packages/inbox/assets/theme-chooser');
  mkdirSync(out, { recursive: true });
  const { NO_BROWSER } = await import('../tests/helpers/no-browser');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-theme-chooser-shots-')));
  for (const name of ['data', 'home', 'xdg-config', 'xdg-data', 'codex', 'claude', 'gh']) mkdirSync(join(root, name));
  // The scratch HOME is the child's from its start: the Inbox reads the home once.
  const child = spawn(process.execPath, [import.meta.path, '--serve', root], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      PLANNOTATOR_DATA_DIR: join(root, 'data'),
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER: '1',
      NO_ANON_PING: '1',
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_TAILSCALE: '0',
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      GH_CONFIG_DIR: join(root, 'gh'),
      GH_TOKEN: 'sandbox-not-a-token',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  try {
    const port = await new Promise<number>((done, fail) => {
      let line = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        line += chunk.toString('utf8');
        if (line.includes('\n')) done((JSON.parse(line.trim()) as { port: number }).port);
      });
      child.on('exit', (code) => fail(new Error(`the scratch Inbox stopped (exit ${code})`)));
    });
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      for (const sheet of SHEETS) {
        const form = sheet.phone ? PHONE : DESKTOP;
        const context = await browser.newContext({ viewport: form.viewport, deviceScaleFactor: form.scale, colorScheme: sheet.mode, isMobile: sheet.phone, hasTouch: sheet.phone });
        await context.addCookies(
          [
            ['plannotator-theme', sheet.mode],
            ['plannotator-light-theme', sheet.theme],
            ['plannotator-dark-theme', sheet.theme],
          ].map(([name, value]) => ({ name: name!, value: value!, domain: 'localhost', path: '/' })),
        );
        const page = await context.newPage();
        await page.goto(`http://localhost:${port}/`);
        await page.getByText(SUBJECT, { exact: true }).first().click();
        await page.getByText('Ship the theme switch in this release?').first().waitFor();
        // Everything at its top, the pointer away, the highlighter and the fonts settled.
        await page.mouse.move(2, 2);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
        });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.waitForTimeout(1200);
        const png = await page.screenshot({ type: 'png' });
        const webp = await page.evaluate(
          async ({ src, width, height }) => {
            const image = new Image();
            image.src = src;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const drawing = canvas.getContext('2d')!;
            drawing.imageSmoothingQuality = 'high';
            drawing.drawImage(image, 0, 0, width, height);
            return canvas.toDataURL('image/webp', 0.84).split(',')[1]!;
          },
          { src: `data:image/png;base64,${png.toString('base64')}`, ...form.out },
        );
        const file = join(out, `${sheet.phone ? 'p' : 'd'}-${sheet.theme}-${sheet.mode}.webp`);
        writeFileSync(file, Buffer.from(webp, 'base64'));
        console.log(`${file} (${Math.round(Buffer.from(webp, 'base64').length / 1024)} KB)`);
        await context.close();
      }
    } finally {
      await browser.close();
    }
  } finally {
    child.kill();
  }
}
