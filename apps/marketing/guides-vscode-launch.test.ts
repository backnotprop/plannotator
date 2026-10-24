// The Guided Reviews for VS Code page and its images ship behind one switch,
// GUIDES_VSCODE_LAUNCHED in src/lib/guides-vscode-launch.ts, committed off until
// the extension release ships. This builds the site both ways: off, the deployed
// site has no /vscode/, no screens and no Footer link; on (the env override used
// for review), the page is built, linked, comma-free in its headings and buttons,
// and every image it names resolves.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  guidesVscodeAssetsIntegration,
  guidesVscodeDevMiddleware,
  resolveGuidesVscodeAsset,
} from './src/lib/guides-vscode-assets';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
const switchFile = join(marketingRoot, 'src/lib/guides-vscode-launch.ts');

let temporaryRoot = '';
const dist = { on: '', off: '' };

async function build(name: 'on' | 'off'): Promise<string> {
  const outDir = join(temporaryRoot, name);
  const configPath = join(temporaryRoot, `astro.${name}.config.mjs`);
  const configUrl = pathToFileURL(join(marketingRoot, 'astro.config.mjs')).href;
  await writeFile(
    configPath,
    `import config from ${JSON.stringify(configUrl)};\n` +
      `export default { ...config, outDir: ${JSON.stringify(outDir)} };\n`,
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  };
  delete env.GUIDES_VSCODE_LAUNCHED;
  if (name === 'on') env.GUIDES_VSCODE_LAUNCHED = 'true';
  const proc = Bun.spawn(
    [process.execPath, join(marketingRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--config', relative(marketingRoot, configPath)],
    { cwd: marketingRoot, env, stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, out + err).toBe(0);
  return outDir;
}

const read = (root: string, path: string) => readFile(join(root, path), 'utf8');
const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(marketingRoot, '.astro-guides-vscode-'));
  dist.off = await build('off');
  dist.on = await build('on');
}, 240_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
});

describe('Guided Reviews for VS Code launch switch', () => {
  test('the switch is committed off', async () => {
    expect(await readFile(switchFile, 'utf8')).toContain(
      "export const GUIDES_VSCODE_LAUNCHED = false || process.env.GUIDES_VSCODE_LAUNCHED === 'true';",
    );
  });

  test('off: no page, no screens, no link', async () => {
    expect(existsSync(join(dist.off, 'vscode/index.html'))).toBe(false);
    expect(existsSync(join(dist.off, 'assets/guides-vscode'))).toBe(false);
    expect(await read(dist.off, 'index.html')).not.toContain('href="/vscode/"');
    expect(await read(dist.off, 'sitemap-0.xml')).not.toContain('/vscode/');
  });

  test('on: the page is built and linked from the Footer', async () => {
    const page = await read(dist.on, 'vscode/index.html');
    expect(page).toContain('<title>Guided Reviews for VS Code</title>');
    expect(await read(dist.on, 'index.html')).toContain('href="/vscode/"');
  });

  test('on: no comma in any h1 h2 h3 or button', async () => {
    const html = await read(dist.on, 'vscode/index.html');
    const elements = html.match(/<(h1|h2|h3|button)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      const label = element.match(/^<[^>]*aria-label="([^"]*)"/)?.[1] ?? '';
      expect(`${text(element)} ${label}`).not.toContain(',');
    }
  });

  test('on: every image on the page resolves', async () => {
    const html = await read(dist.on, 'vscode/index.html');
    const urls = new Set<string>();
    for (const [, attr, value] of html.matchAll(/\b(src|srcset|poster|data-lightbox-src|content)="([^"]*)"/g)) {
      if (attr === 'content' && !value.includes('/assets/')) continue;
      for (const part of attr === 'srcset' ? value.split(',') : [value]) {
        const url = part.trim().split(/\s+/)[0];
        if (url.startsWith('/') || url.startsWith('https://plannotator.ai/')) urls.add(url.replace('https://plannotator.ai', ''));
      }
    }
    expect(urls.size).toBeGreaterThan(12);
    for (const url of urls) {
      if (/\.(webp|png|jpe?g|svg)$/.test(url)) expect(existsSync(join(dist.on, url)), url).toBe(true);
    }
  });
});

describe('Guided Reviews for VS Code screens in astro dev', () => {
  const assetsDir = join(marketingRoot, 'guides-vscode-assets');

  test('off: dev adds no route; on: it adds one', () => {
    const uses = { on: 0, off: 0 };
    for (const name of ['on', 'off'] as const) {
      const integration = guidesVscodeAssetsIntegration(name === 'on', assetsDir);
      integration.hooks['astro:server:setup']({ server: { middlewares: { use: () => void uses[name]++ } } });
    }
    expect(uses).toEqual({ on: 1, off: 0 });
  });

  test('serves a screen with an image content type', async () => {
    const file = await resolveGuidesVscodeAsset(assetsDir, '/assets/guides-vscode/chapter-diff@2x.webp?v=1');
    expect(file?.type).toBe('image/webp');
    expect((await resolveGuidesVscodeAsset(assetsDir, '/assets/guides-vscode/guides-vscode-og.jpg'))?.type).toBe('image/jpeg');

    const body = new PassThrough();
    const chunks: Buffer[] = [];
    body.on('data', (c) => chunks.push(c));
    const headers: Record<string, string> = {};
    const res = Object.assign(body, {
      statusCode: 0,
      setHeader: (k: string, v: string) => void (headers[k.toLowerCase()] = v),
    }) as unknown as ServerResponse;
    await new Promise<void>((done, fail) => {
      body.on('finish', done);
      guidesVscodeDevMiddleware(assetsDir)(
        { method: 'GET', url: '/assets/guides-vscode/generating.webp' } as IncomingMessage,
        res,
        () => fail(new Error('passed on')),
      );
    });
    expect(headers['content-type']).toBe('image/webp');
    expect(Buffer.concat(chunks).length).toBe(Number(headers['content-length']));
    expect(Buffer.concat(chunks).length).toBeGreaterThan(1000);
  });

  test('nothing outside the folder, and nothing it does not know', async () => {
    const outside = await mkdtemp(join(marketingRoot, '.guides-vscode-dev-'));
    try {
      const dir = join(outside, 'assets');
      await mkdir(dir);
      await writeFile(join(outside, 'secret.png'), 'secret');
      await writeFile(join(dir, 'notes.txt'), 'text');
      await symlink(join(outside, 'secret.png'), join(dir, 'link.png'));
      for (const url of [
        '/assets/guides-vscode/../secret.png',
        '/assets/guides-vscode/%2e%2e/secret.png',
        '/assets/guides-vscode/%2e%2e%2fsecret.png',
        '/assets/guides-vscode/..%5csecret.png',
        '/assets/guides-vscode/link.png',
        '/assets/guides-vscode/notes.txt',
        '/assets/guides-vscode/',
        '/assets/guides-vscode/%E0%A4%A.png',
        '/assets/other/secret.png',
      ]) {
        expect(await resolveGuidesVscodeAsset(dir, url), url).toBeNull();
      }
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
