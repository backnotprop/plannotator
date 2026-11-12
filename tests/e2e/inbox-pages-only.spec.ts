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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP4z8DwnwEKGAA9yAH/2Y2kfwAAAABJRU5ErkJggg==', 'base64');
const MP4 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAALqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAACgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAACgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAAoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAAAgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMAyDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAArwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAAOAAAAAQAAABRzdGNvAAAAAAAAAAEAAAMaAAAAPXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAFm1kYXQAAAAKZYiECvJigACnvg==';

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
<style>body{font:15px/1.5 system-ui;margin:32px;color:#222;background:#fff}img{width:120px;height:80px;display:inline-block;margin:6px;background:#eee;image-rendering:pixelated}</style>
<script>window.cspViolations=[];document.addEventListener('securitypolicyviolation',(e)=>window.cspViolations.push(e.effectiveDirective+' '+e.blockedURI));</script></head><body>
<h1>Pictures from the web</h1>
<p id="target">This paragraph takes a comment.</p>
<img id="web" alt="web" src="${secure.origin}/page-web.png">
<img id="plain" alt="plain http" src="${plain.origin}/page-http.png">
<img id="far" alt="another folder" src="${far}/far.png">
<video id="clip" muted preload="auto" width="32" height="32" src="data:video/mp4;base64,${MP4}"></video>
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

      const window = await context.request.get(url);
      expect(window.headers()['content-security-policy']).toContain("img-src 'self' data: blob:;");

      const pagesUrl = new URL('/api/inbox/pages', url).href;
      for (const origin of ['https://evil.example', 'null']) {
        const refused = await context.request.post(pagesUrl, { headers: { Origin: origin }, data: { html: '<p>from elsewhere</p>' } });
        expect(refused.status(), `Origin: ${origin}`).toBe(403);
      }

      await tab.goto(`${url}#thread=${text.thread_id}`);
      await expect(tab.getByText('Web pictures in the text of this message.').first()).toBeVisible();
      await expect(tab.locator('svg').filter({ hasText: 'styled span' }).first()).toBeVisible();
      await expect(tab.locator('svg').filter({ hasText: 'label img' }).first()).toBeVisible();
      await expect(tab.locator('svg').filter({ hasText: 'img shape' }).or(tab.getByText('The source image cannot be decoded')).first()).toBeVisible();
      await tab.waitForTimeout(2_000);
      expect(secure.hits).toEqual([]);
      expect(plain.hits).toEqual([]);
      await shot(tab, 'pages-only-2-message-web-picture-blocked');

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
      await expect.poll(() => width('plain')).toBe(2);
      expect(secure.hits).toEqual(['/page-web.png']);
      expect(plain.hits).toEqual(['/page-http.png']);
      const clip = frame.locator('#clip');
      if (await clip.evaluate((v: HTMLVideoElement) => v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '')) {
        await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
        expect(await clip.evaluate((v: HTMLVideoElement) => v.error?.code ?? 0)).toBe(0);
      }
      expect(await frame.locator('body').evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
      await shot(tab, 'pages-only-1-attached-page-web-picture');

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
      await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(1);
      await shot(tab, 'pages-only-3-attached-page-comment-pinned');

      expect(secure.hits).toEqual(['/page-web.png']);
      expect(plain.hits).toEqual(['/page-http.png']);
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
