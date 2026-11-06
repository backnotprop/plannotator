/**
 * "Pages only" (owner, 2026-11-05), proved on the network in a real browser
 * against the compiled binary: an attached HTML page shows its web pictures,
 * and the Inbox window itself never asks the web for one. Nothing is mocked:
 * `plannotator inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and
 * HOME, an agent sends through `plannotator inbox mcp` (scripts/inbox-sim.ts),
 * and two local stand-ins for "the web" (one https with a throwaway
 * certificate, one http) log every request they get.
 *
 * - The attached page is its own document (packages/server/inbox-pages.ts):
 *   its `https:` picture is fetched and drawn, its plain `http:` one is not,
 *   and its picture from another folder on this computer still loads.
 * - A message whose text names web pictures (three Mermaid ways: an image
 *   node, an `<img>` in a label, a background in a label's style; a markdown
 *   image; a raw `<img>`; a protocol-relative one) makes zero requests: the
 *   window's CSP is `img-src 'self' data: blob:` (the review of #2722 found a
 *   Mermaid diagram reaching the web while that policy was widened).
 * - Annotation still works in the served page: a click pins its paragraph, the
 *   comment saves, and the page draws its highlight.
 *
 * Screenshots go to PLANNOTATOR_PAGES_ONLY_SHOTS when it is set.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-pages-only.spec.ts`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_PAGES_ONLY_SHOTS ?? '';

// A 2×2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwnwEKGAA9yAH/2Y2kfwAAAABJRU5ErkJggg==', 'base64');

/** A stand-in for the web: answers every request with the PNG and remembers its path. */
async function webServer(root: string, tls: boolean): Promise<{ origin: string; hits: string[]; server: Server }> {
  const hits: string[] = [];
  const answer = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    hits.push(new URL(req.url ?? '/', 'http://x').pathname);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
    res.end(PNG);
  };
  let server: Server;
  if (tls) {
    const key = join(root, 'web-key.pem');
    const cert = join(root, 'web-cert.pem');
    const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, answer) as unknown as Server;
  } else {
    server = createHttpServer(answer);
  }
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { origin: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`, hits, server };
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

test('an attached page shows its web pictures; the window asks the web for none, and the page still takes comments', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-pages-only-e2e-');
  const secure = await webServer(root, true);
  const plain = await webServer(root, false);
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
  };
  let agent: SimAgent | null = null;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    rememberInboxOf(dataDir);
    const url = started.stdout.trim();
    expect(url).not.toContain(':59812');

    const project = scratchProject(join(root, 'src'), 'pictures');
    const far = join(root, 'elsewhere');
    mkdirSync(join(project, 'pages'), { recursive: true });
    mkdirSync(far, { recursive: true });
    writeFileSync(join(far, 'far.png'), PNG);
    writeFileSync(
      join(project, 'pages', 'page.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>Pictures</title>
<style>body{font:15px/1.5 system-ui;margin:32px;color:#222;background:#fff}img{width:120px;height:80px;display:inline-block;margin:6px;background:#eee;image-rendering:pixelated}</style></head><body>
<h1>Pictures from the web</h1>
<p id="target">This paragraph takes a comment.</p>
<img id="web" alt="web" src="${secure.origin}/page-web.png">
<img id="plain" alt="plain http" src="${plain.origin}/page-http.png">
<img id="far" alt="another folder" src="${far}/far.png">
</body></html>`,
    );
    agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
    const body = [
      'Web pictures in the text of this message.',
      '',
      '```mermaid',
      'flowchart LR',
      `  A@{ img: "${secure.origin}/mermaid-img-shape.png", label: "img shape", pos: "t", w: 60, h: 60, constraint: "off" }`,
      '  A --> Z',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      `  B["<img src='${secure.origin}/mermaid-label-img.png' width='30'> label img"]`,
      '  B --> Y',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      `  C["<span style='background-image:url(${secure.origin}/mermaid-label-style.png)'>styled span</span>"]`,
      '  C --> X',
      '```',
      '',
      `![markdown https](${secure.origin}/md-https.png)`,
      '',
      `![markdown http](${plain.origin}/md-http.png)`,
      '',
      `![protocol relative](${plain.origin.replace('http:', '')}/md-protocol.png)`,
      '',
      `<p><img src="${secure.origin}/raw-img.png" alt="raw img"></p>`,
    ].join('\n');
    const text = await agent.send({ project_path: project, subject: 'Web pictures in text', body });
    const page = await agent.send({ project_path: project, subject: 'An attached page', body: 'The page names a web picture.', attachments: ['pages/page.html'] });
    const pageId = (page.attachments as { id: string; name: string }[])[0]!.id;

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', ignoreHTTPSErrors: true });
    try {
      const tab = await context.newPage();

      // The window's own policy, as served.
      const window = await context.request.get(url);
      expect(window.headers()['content-security-policy']).toContain("img-src 'self' data: blob:;");

      // (b) The message: every diagram draws, and the web hears nothing.
      await tab.goto(`${url}#thread=${text.thread_id}`);
      await expect(tab.getByText('Web pictures in the text of this message.').first()).toBeVisible();
      await expect(tab.locator('svg').filter({ hasText: 'styled span' }).first()).toBeVisible();
      await expect(tab.locator('svg').filter({ hasText: 'label img' }).first()).toBeVisible();
      // Mermaid measures an image node's picture before it draws: refused, it says so in place of the diagram.
      await expect(tab.locator('svg').filter({ hasText: 'img shape' }).or(tab.getByText('The source image cannot be decoded')).first()).toBeVisible();
      await tab.waitForTimeout(2_000);
      expect(secure.hits).toEqual([]);
      expect(plain.hits).toEqual([]);
      await shot(tab, 'pages-only-2-message-web-picture-blocked');

      // (a) The attached page: its https picture is fetched and drawn, its http one is not, and its far one loads.
      await tab.goto(`${url}#thread=${page.thread_id}`);
      await tab.locator(`button[data-attachment-id="${pageId}"]`).first().click();
      const frameEl = tab.locator('.ib-htmlframe iframe');
      await expect(frameEl).toHaveAttribute('src', /^\/api\/inbox\/pages\/[0-9a-f]{32}$/);
      await expect(frameEl).toHaveAttribute('sandbox', 'allow-scripts allow-modals');
      const frame = tab.frameLocator('.ib-htmlframe iframe');
      await expect(frame.locator('h1')).toHaveText('Pictures from the web');
      const width = (id: string) => frame.locator(`#${id}`).evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : -1));
      await expect.poll(() => width('web')).toBe(2);
      await expect.poll(() => width('far')).toBe(2);
      expect(await width('plain')).toBe(0);
      expect(secure.hits).toEqual(['/page-web.png']);
      expect(plain.hits).toEqual([]);
      await shot(tab, 'pages-only-1-attached-page-web-picture');

      // (c) Annotation in the served page: a click pins the paragraph, the comment saves, the page marks it.
      const interact = tab.locator('[data-full-view-pen][aria-pressed="false"]');
      if (await interact.isVisible()) await interact.click();
      await frame.locator('#target').click();
      const composer = tab.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await composer.locator('textarea').fill('This paragraph reads well.');
      await composer.locator('textarea').press('ControlOrMeta+Enter');
      await expect(composer).toHaveCount(0);
      const saved = async () => {
        const res = await context.request.get(new URL(`/api/inbox/threads/${page.thread_id}/attachments`, url).href);
        const answer = (await res.json()) as { annotations: { annotation: { text?: string } }[] };
        return answer.annotations.map((a) => a.annotation.text);
      };
      await expect.poll(saved).toEqual(['This paragraph reads well.']);
      // The page draws the comment's marker: the bridge got the annotation back from the window.
      await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(1);
      await shot(tab, 'pages-only-3-attached-page-comment-pinned');

      // Still nothing from the window itself.
      expect(secure.hits).toEqual(['/page-web.png']);
      expect(plain.hits).toEqual([]);
    } finally {
      await context.close();
    }
  } finally {
    await agent?.close().catch(() => {});
    secure.server.close();
    plain.server.close();
    await removeInboxScratch(root);
  }
});
