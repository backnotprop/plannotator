// The Plannotator Inbox page and post are hidden until launch behind one
// switch, INBOX_LAUNCHED in src/lib/inbox-launch.ts. This builds the real site
// twice: as committed (switch off) and with the switch flipped on by a Vite
// transform of that one line. Off: no Inbox link anywhere, the page and the
// post noindex and out of the sitemap, the RSS feed and the blog index. On: the
// Nav and the Footer link the page, the page is indexable, both are in the
// sitemap and the post is listed.
// Both: no comma in any h1, h2, h3 or button, and every image resolves.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
const switchFile = join(marketingRoot, 'src/lib/inbox-launch.ts');
const switchOff = 'export const INBOX_LAUNCHED = false;';
const postPath = 'blog/the-age-of-the-inbox/index.html';

let temporaryRoot = '';
const dist = { off: '', on: '' };

async function build(name: 'off' | 'on'): Promise<string> {
  const outDir = join(temporaryRoot, name);
  const configPath = join(temporaryRoot, `astro.${name}.config.mjs`);
  let configUrl = pathToFileURL(join(marketingRoot, 'astro.config.mjs')).href;
  if (name === 'on') {
    // astro.config.mjs reads the switch before any Vite plugin runs (the
    // sitemap filter), so the flipped build loads a copy of the config that
    // imports a flipped copy of the switch file.
    const flippedSwitch = join(temporaryRoot, 'inbox-launch.on.ts');
    const source = await readFile(switchFile, 'utf8');
    expect(source).toContain(switchOff);
    await writeFile(flippedSwitch, source.replace(switchOff, 'export const INBOX_LAUNCHED = true;'));
    const configSource = await readFile(join(marketingRoot, 'astro.config.mjs'), 'utf8');
    const switchImport = "'./src/lib/inbox-launch.ts'";
    expect(configSource).toContain(switchImport);
    const flippedConfig = join(temporaryRoot, 'astro.on.base.mjs');
    await writeFile(flippedConfig, configSource.replace(switchImport, JSON.stringify(flippedSwitch)));
    configUrl = pathToFileURL(flippedConfig).href;
  }
  const flip =
    name === 'on'
      ? `vite: { ...config.vite, plugins: [...config.vite.plugins, {
          name: 'flip-inbox-launched',
          enforce: 'pre',
          transform(code, id) {
            if (id.split('?')[0] !== ${JSON.stringify(switchFile)}) return;
            if (!code.includes(${JSON.stringify(switchOff)})) throw new Error('switch line not found');
            return code.replace(${JSON.stringify(switchOff)}, 'export const INBOX_LAUNCHED = true;');
          },
        }] },`
      : '';
  await writeFile(
    configPath,
    `import config from ${JSON.stringify(configUrl)};\n` +
      `export default { ...config, ${flip} outDir: ${JSON.stringify(outDir)} };\n`,
  );
  const proc = Bun.spawn(
    [process.execPath, join(marketingRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--config', relative(marketingRoot, configPath)],
    {
      cwd: marketingRoot,
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', GITHUB_TOKEN: '', GH_TOKEN: '' },
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
const robots = (html: string) => html.match(/<meta name="robots" content="([^"]*)"/)?.[1];

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
    expect(await readFile(switchFile, 'utf8')).toContain(switchOff);
  });

  test('off: no page links to /inbox/ and the page and post stay out of search', async () => {
    const pages = new Bun.Glob('**/*.html').scanSync({ cwd: dist.off });
    for (const page of pages) {
      expect(inboxLinks(await read(dist.off, page)), page).toEqual([]);
    }
    expect(robots(await read(dist.off, 'inbox/index.html'))).toBe('noindex, nofollow');
    expect(robots(await read(dist.off, postPath))).toBe('noindex, nofollow');
    const sitemap = await read(dist.off, 'sitemap-0.xml');
    expect(sitemap).not.toContain('/inbox/');
    expect(sitemap).not.toContain('the-age-of-the-inbox');
    expect(await read(dist.off, 'rss.xml')).not.toContain('the-age-of-the-inbox');
    expect(await read(dist.off, 'blog/index.html')).not.toContain('the-age-of-the-inbox');
  });

  test('on: the Nav and the Footer link the page and the post is listed', async () => {
    const home = inboxLinks(await read(dist.on, 'index.html')).map(text);
    expect(home).toEqual(['Inbox', 'Inbox']);
    const inbox = await read(dist.on, 'inbox/index.html');
    const navLink = inboxLinks(inbox)[0];
    expect(navLink).toContain('text-foreground font-medium');
    expect(robots(inbox)).toBe('index, follow');
    expect(robots(await read(dist.on, postPath))).toBe('index, follow');
    expect(await read(dist.on, 'rss.xml')).toContain('/blog/the-age-of-the-inbox/');
    expect(await read(dist.on, 'blog/index.html')).toContain('/blog/the-age-of-the-inbox/');
    const sitemap = await read(dist.on, 'sitemap-0.xml');
    expect(sitemap).toContain('<loc>https://plannotator.ai/inbox/</loc>');
    expect(sitemap).toContain('<loc>https://plannotator.ai/blog/the-age-of-the-inbox/</loc>');
  });

  for (const state of ['off', 'on'] as const) {
    test(`${state}: no comma in any h1 h2 h3 or button on the page and the post`, async () => {
      for (const path of ['inbox/index.html', postPath]) {
        const html = await read(dist[state], path);
        const elements = html.match(/<(h1|h2|h3|button)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
        expect(elements.length).toBeGreaterThan(0);
        for (const element of elements) {
          const label = element.match(/^<[^>]*aria-label="([^"]*)"/)?.[1] ?? '';
          expect(`${text(element)} ${label}`, path).not.toContain(',');
        }
      }
    });

    test(`${state}: every image on the page and the post resolves`, async () => {
      for (const path of ['inbox/index.html', postPath]) {
        const html = await read(dist[state], path);
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
          if (/\.(webp|png|jpe?g|svg)$/.test(url)) expect(existsSync(join(dist[state], url)), `${path}: ${url}`).toBe(true);
        }
      }
    });
  }

  test('the page title and the OG image of the page and the post', async () => {
    const og = '<meta property="og:image" content="https://plannotator.ai/assets/inbox/inbox-og.jpg">';
    const html = await read(dist.off, 'inbox/index.html');
    expect(html).toContain('<title>Plannotator Inbox</title>');
    expect(html).toContain(og);
    expect(await read(dist.off, postPath)).toContain(og);
  });
});
