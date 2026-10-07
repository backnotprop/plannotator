// The Plannotator Inbox page, post and images ship only once the Inbox
// launches, behind one switch, INBOX_LAUNCHED in src/lib/inbox-launch.ts. This
// builds the real site twice: as committed (switch off) and with the switch on
// through its INBOX_LAUNCHED=true environment override. Off: no /inbox/ page,
// no post, no Inbox image and no reference to any of them anywhere in dist. On:
// the page, the post and the images are built, the Nav and the Footer link the
// page, the sitemap and the listings carry both, no comma in any h1, h2, h3 or
// button, and every image resolves.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
const switchFile = join(marketingRoot, 'src/lib/inbox-launch.ts');
const postPath = 'blog/the-age-of-the-inbox/index.html';

let temporaryRoot = '';
const dist = { off: '', on: '' };

async function build(name: 'off' | 'on'): Promise<string> {
  const outDir = join(temporaryRoot, name);
  const configPath = join(temporaryRoot, `astro.${name}.config.mjs`);
  const configUrl = pathToFileURL(join(marketingRoot, 'astro.config.mjs')).href;
  await writeFile(
    configPath,
    `import config from ${JSON.stringify(configUrl)};\n` +
      `export default { ...config, outDir: ${JSON.stringify(outDir)} };\n`,
  );
  const proc = Bun.spawn(
    [process.execPath, join(marketingRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--config', relative(marketingRoot, configPath)],
    {
      cwd: marketingRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: '1',
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        INBOX_LAUNCHED: name === 'on' ? 'true' : '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, out + err).toBe(0);
  return outDir;
}

const read = (root: string, path: string) => readFile(join(root, path), 'utf8');
const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const inboxLinks = (html: string) => html.match(/<a\b[^>]*href="\/inbox\/"[^>]*>[\s\S]*?<\/a>/g) ?? [];
const files = (root: string) => [...new Bun.Glob('**/*').scanSync({ cwd: root })];

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(marketingRoot, '.astro-inbox-launch-'));
  dist.off = await build('off');
  dist.on = await build('on');
}, 120_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
});

describe('Plannotator Inbox launch switch', () => {
  test('the switch is committed off', async () => {
    expect(await readFile(switchFile, 'utf8')).toContain('export const INBOX_LAUNCHED = false ||');
  });

  test('off: dist has no Inbox page, post, image or reference to them', async () => {
    expect(existsSync(join(dist.off, 'inbox'))).toBe(false);
    expect(existsSync(join(dist.off, 'blog/the-age-of-the-inbox'))).toBe(false);
    expect(existsSync(join(dist.off, 'assets/inbox'))).toBe(false);
    for (const file of files(dist.off).filter((f) => /\.(html|xml|txt|js|json)$/.test(f))) {
      const body = await read(dist.off, file);
      expect(inboxLinks(body), file).toEqual([]);
      expect(body, file).not.toContain('the-age-of-the-inbox');
      expect(body, file).not.toContain('/assets/inbox/');
    }
  });

  test('on: the page, the post and the images are built and linked', async () => {
    expect(files(join(dist.on, 'assets/inbox')).length).toBe(33);
    const home = inboxLinks(await read(dist.on, 'index.html')).map(text);
    expect(home).toEqual(['Inbox', 'Inbox']);
    const inbox = await read(dist.on, 'inbox/index.html');
    expect(inboxLinks(inbox)[0]).toContain('text-foreground font-medium');
    expect(inbox).toContain('<title>Plannotator Inbox</title>');
    const og = '<meta property="og:image" content="https://plannotator.ai/assets/inbox/inbox-og.jpg">';
    expect(inbox).toContain(og);
    expect(await read(dist.on, postPath)).toContain(og);
    expect(await read(dist.on, 'rss.xml')).toContain('/blog/the-age-of-the-inbox/');
    expect(await read(dist.on, 'blog/index.html')).toContain('/blog/the-age-of-the-inbox/');
    const sitemap = await read(dist.on, 'sitemap-0.xml');
    expect(sitemap).toContain('<loc>https://plannotator.ai/inbox/</loc>');
    expect(sitemap).toContain('<loc>https://plannotator.ai/blog/the-age-of-the-inbox/</loc>');
  });

  test('on: no comma in any h1 h2 h3 or button on the page and the post', async () => {
    for (const path of ['inbox/index.html', postPath]) {
      const html = await read(dist.on, path);
      const elements = html.match(/<(h1|h2|h3|button)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
      expect(elements.length).toBeGreaterThan(0);
      for (const element of elements) {
        const label = element.match(/^<[^>]*aria-label="([^"]*)"/)?.[1] ?? '';
        expect(`${text(element)} ${label}`, path).not.toContain(',');
      }
    }
  });

  test('on: every image on the page and the post resolves', async () => {
    for (const path of ['inbox/index.html', postPath]) {
      const html = await read(dist.on, path);
      const urls = new Set<string>();
      for (const [, attr, value] of html.matchAll(/\b(src|srcset|data-lightbox-dark|data-lightbox-light|content)="([^"]*)"/g)) {
        if (attr === 'content' && !value.includes('/assets/')) continue;
        for (const part of attr === 'srcset' ? value.split(',') : [value]) {
          const url = part.trim().split(/\s+/)[0];
          if (url.startsWith('/') || url.startsWith('https://plannotator.ai/')) urls.add(url.replace('https://plannotator.ai', ''));
        }
      }
      expect(urls.size).toBeGreaterThan(path === postPath ? 3 : 30);
      for (const url of urls) {
        if (/\.(webp|png|jpe?g|svg)$/.test(url)) expect(existsSync(join(dist.on, url)), `${path}: ${url}`).toBe(true);
      }
    }
  });
});
