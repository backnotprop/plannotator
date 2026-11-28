/**
 * Image diffs in code review: the swipe view stacks the two images with no
 * drift, so the divider reveals exactly the pixels that changed, where they
 * are, at device pixel ratio 1 and 2. Two synthetic PNGs differ in one known
 * 40 x 40 block; the test reads the screen's pixels on both sides of the
 * divider. At DPR 2 the browser smooths a 100% image, so each edge pixel is
 * read on its device half away from the edge: a drift of one image pixel
 * still shows as the wrong colour there.
 *
 * Nothing is mocked: `plannotator review` runs in a scratch git repository
 * under a temp PLANNOTATOR_DATA_DIR and HOME, with a PATH of its own, and
 * opens no browser. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { NO_BROWSER } from '../helpers/no-browser';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_IMAGE_DIFF_SHOTS ?? '';

const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
  'plannotator-image-diff-view': 'swipe',
};

const WIDTH = 400;
const HEIGHT = 240;
const BLOCK = { x: 280, y: 60, size: 40 };
const GREY: [number, number, number] = [128, 128, 128];
const MAGENTA: [number, number, number] = [255, 0, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(withBlock: boolean): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < HEIGHT; y++) {
    const row = Buffer.alloc(1 + WIDTH * 3);
    for (let x = 0; x < WIDTH; x++) {
      const inBlock = withBlock && x >= BLOCK.x && x < BLOCK.x + BLOCK.size && y >= BLOCK.y && y < BLOCK.y + BLOCK.size;
      const [r, g, b] = inBlock ? MAGENTA : GREY;
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ownPath(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'git'))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (found) symlinkSync(found, join(bin, 'git'));
  return [bin, '/usr/bin', '/bin'].join(delimiter);
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'screen.png'), png(false));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  writeFileSync(join(repo, 'screen.png'), png(true));
  return repo;
}

async function pixel(page: Page, x: number, y: number): Promise<[number, number, number]> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const shot = await page.screenshot({ scale: 'device' });
  return page.evaluate(
    async ({ data, px, py }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
      return [r, g, b] as [number, number, number];
    },
    { data: shot.toString('base64'), px: Math.floor(x * dpr), py: Math.floor(y * dpr) },
  );
}

function expectColor(actual: [number, number, number], expected: [number, number, number], where: string) {
  const near = actual.every((value, i) => Math.abs(value - expected[i]!) <= 2);
  expect(near, `${where}: got rgb(${actual.join(', ')}), wanted rgb(${expected.join(', ')})`).toBe(true);
}

async function withReview(browser: Browser, dpr: number, run: (page: Page) => Promise<void>) {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-image-swipe-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], {
      cwd: repo,
      stdio: 'ignore',
      env: {
        PATH: ownPath(root),
        HOME: root,
        PLANNOTATOR_TEST_SANDBOX: root,
        PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
        PLANNOTATOR_DATA_DIR: join(root, 'data'),
        PLANNOTATOR_READY_FILE: readyFile,
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
        NO_BROWSER,
        PLANNOTATOR_REMOTE: '0',
        PLANNOTATOR_UPDATE_CHECK: '0',
      },
    });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: dpr });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await run(page);
    await context.close();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) => child!.once('exit', () => done()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((done) => setTimeout(done, 5_000))]);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

for (const dpr of [1, 2]) {
  test(`the swipe divider reveals exactly the changed block (dpr ${dpr})`, async ({ browser }) => {
    await withReview(browser, dpr, async (page) => {
      const stage = page.locator('[data-image-stage][data-image-mode="swipe"]').first();
      await expect(stage).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-image-layer="new"]').first()).toHaveJSProperty('complete', true);
      const box = (await stage.boundingBox())!;
      const scale = box.width / WIDTH;
      expect(scale).toBe(1);
      const at = (x: number, y: number, leanX = 0.5, leanY = 0.5) => pixel(page, box.x + (x + leanX) * scale, box.y + (y + leanY) * scale);
      const AWAY = 0.25;
      const TOWARD = 0.75;
      const inside = { x: BLOCK.x + 20, y: BLOCK.y + 20 };

      await stage.focus();
      await page.keyboard.press('End');
      expectColor(await at(inside.x, inside.y), GREY, 'at inside.x, inside.y');

      await page.keyboard.press('Home');
      expectColor(await at(inside.x, inside.y), MAGENTA, 'at inside.x, inside.y');
      expectColor(await at(BLOCK.x - 1, inside.y, AWAY), GREY, 'at BLOCK.x - 1, inside.y');
      expectColor(await at(BLOCK.x + BLOCK.size, inside.y, TOWARD), GREY, 'at BLOCK.x + BLOCK.size, inside.y');
      expectColor(await at(BLOCK.x, BLOCK.y, TOWARD, TOWARD), MAGENTA, 'at BLOCK.x, BLOCK.y');
      expectColor(await at(BLOCK.x + BLOCK.size - 1, BLOCK.y + BLOCK.size - 1, AWAY, AWAY), MAGENTA, 'at BLOCK.x + BLOCK.size - 1, BLOCK.y + BLOCK.size - 1');
      expectColor(await at(inside.x, BLOCK.y - 1, 0.5, AWAY), GREY, 'at inside.x, BLOCK.y - 1');

      for (let i = 0; i < 75; i++) await page.keyboard.press('ArrowRight');
      await expect(stage).toHaveAttribute('aria-valuenow', '75');
      const divider = 0.75 * WIDTH;
      expectColor(await at(divider - 2, inside.y), GREY, 'at divider - 2, inside.y');
      expectColor(await at(divider + 1, inside.y), MAGENTA, 'at divider + 1, inside.y');
      if (shots) {
        await page.screenshot({ path: join(shots, `swipe-registration-dpr${dpr}.png`) });
        await page.keyboard.press('Home');
        await page.screenshot({ path: join(shots, `swipe-edge-crop-dpr${dpr}.png`), scale: 'device', clip: { x: box.x + BLOCK.x - 6, y: box.y + BLOCK.y - 6, width: 12, height: 12 } });
      }
    });
  });
}
