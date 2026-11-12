// The Plannotator Inbox page, post and images ship behind one switch,
// INBOX_LAUNCHED in src/lib/inbox-launch.ts, committed on since launch. This
// builds the real site as committed: the page, the post and the images are
// built, the Nav and the Footer link the page, the sitemap and the listings
// carry both, no comma in any h1, h2, h3 or button, and every image resolves.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENTS, COLUMNS, TIERS, cellOf } from './src/lib/inbox-agents';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
const switchFile = join(marketingRoot, 'src/lib/inbox-launch.ts');
const postPath = 'blog/the-age-of-the-inbox/index.html';
const agentsPath = 'inbox/agents/index.html';
const agentPaths = AGENTS.map((a) => `inbox/agents/${a.slug}/index.html`);

let temporaryRoot = '';
const dist = { on: '' };

async function build(name: 'on'): Promise<string> {
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
  dist.on = await build('on');
}, 120_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
});

describe('Plannotator Inbox launch switch', () => {
  test('the switch is committed on', async () => {
    expect(await readFile(switchFile, 'utf8')).toContain('export const INBOX_LAUNCHED = true;');
  });

  test('on: the page, the post and the images are built and linked', async () => {
    expect(files(join(dist.on, 'assets/inbox')).length).toBe(53);
    const home = inboxLinks(await read(dist.on, 'index.html')).map(text);
    // Nav, the announcement bar (src/components/landing/AnnounceBar.astro), Footer.
    expect(home).toHaveLength(3);
    expect([home[0], home[2]]).toEqual(['Inbox', 'Inbox']);
    expect(home[1]).toContain('See the Inbox');
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
    for (const path of ['inbox/index.html', postPath, agentsPath, ...agentPaths]) {
      const html = await read(dist.on, path);
      const elements = html.match(/<(h1|h2|h3|button)\b[^>]*>[\s\S]*?<\/\1>/g) ?? [];
      expect(elements.length).toBeGreaterThan(0);
      for (const element of elements) {
        const label = element.match(/^<[^>]*aria-label="([^"]*)"/)?.[1] ?? '';
        expect(`${text(element)} ${label}`, path).not.toContain(',');
      }
    }
  });

  // "Copy install prompt" copies the text inlined in the page; /inbox/prompt.md
  // serves the file. Both come from src/lib/inbox-prompt.md and must not drift.
  // ASCII only because S3 serves .md as text/markdown without a charset.
  test('on: the install prompt is served and inlined from one source', async () => {
    const source = await readFile(join(marketingRoot, 'src/lib/inbox-prompt.md'), 'utf8');
    expect(source).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(await read(dist.on, 'inbox/prompt.md')).toBe(source);
    const inbox = await read(dist.on, 'inbox/index.html');
    const inlined = inbox.match(/<script type="application\/json" id="ib-install-prompt">([\s\S]*?)<\/script>/)?.[1];
    expect(inlined && JSON.parse(inlined)).toBe(source);
  });

  test('on: the cloud agent setup page is served as plain ASCII markdown at /inbox/cloud-agent.md', async () => {
    const source = await readFile(join(marketingRoot, 'src/lib/inbox-cloud-agent.md'), 'utf8');
    expect(source).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
    expect(await read(dist.on, 'inbox/cloud-agent.md')).toBe(source);
  });

  test('on: every image on the page and the post resolves', async () => {
    for (const path of ['inbox/index.html', postPath, agentsPath, ...agentPaths]) {
      const html = await read(dist.on, path);
      const urls = new Set<string>();
      for (const [, attr, value] of html.matchAll(/\b(src|srcset|data-lightbox-dark|data-lightbox-light|content)="([^"]*)"/g)) {
        if (attr === 'content' && !value.includes('/assets/')) continue;
        for (const part of attr === 'srcset' ? value.split(',') : [value]) {
          const url = part.trim().split(/\s+/)[0];
          if (url.startsWith('/') || url.startsWith('https://plannotator.ai/')) urls.add(url.replace('https://plannotator.ai', ''));
        }
      }
      expect(urls.size).toBeGreaterThan(path === 'inbox/index.html' ? 30 : 0);
      for (const url of urls) {
        if (/\.(webp|png|jpe?g|svg)$/.test(url)) expect(existsSync(join(dist.on, url)), `${path}: ${url}`).toBe(true);
      }
    }
  });

  // The agents overview and every agent's setup page read
  // src/lib/inbox-agents.ts: each agent has its page, a row under its tier in
  // the overview linking to it with its difference line, a place in the
  // sitemap, and every command its page names behind a copy button.
  test('on: the agents overview and one page per agent are built from one list', async () => {
    const overview = await read(dist.on, agentsPath);
    expect(overview).toContain('<title>Set up your agent with the Plannotator Inbox</title>');
    expect(await read(dist.on, 'inbox/index.html')).toContain('href="/inbox/agents/"');
    const sitemap = await read(dist.on, 'sitemap-0.xml');
    expect(sitemap).toContain('<loc>https://plannotator.ai/inbox/agents/</loc>');
    const rows = overview.match(/<li class="ag-row[^"]*"[^>]*>[\s\S]*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(AGENTS.length);
    const ordered = TIERS.flatMap((t) => AGENTS.filter((a) => a.tier === t.id));
    ordered.forEach((agent, i) => {
      const href = `/inbox/agents/${agent.slug}/`;
      expect(rows[i]).toContain(`href="${href}"`);
      expect(text(rows[i].match(/<p\b[\s\S]*?<\/p>/)?.[0] ?? '')).toBe(agent.diff);
      expect(sitemap).toContain(`<loc>https://plannotator.ai${href}</loc>`);
    });
    for (const [i, path] of agentPaths.entries()) {
      const html = await read(dist.on, path);
      expect(text(html.match(/<h1\b[\s\S]*?<\/h1>/)?.[0] ?? '')).toBe(AGENTS[i].name);
      const copies = [...html.matchAll(/data-copy="([^"]*)"/g)].map(([, v]) =>
        v.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      );
      const a = AGENTS[i];
      const codes = [...a.setup, ...a.other.flatMap((o) => o.steps), a.check, ...a.trouble].map((s) => s.code).filter(Boolean);
      expect(codes.length, path).toBeGreaterThan(0);
      for (const code of codes) expect(copies, path).toContain(code);
    }
  });

  // Each tier's line on the overview says what every agent in it has. The
  // keys behind it must be exactly the columns where none of the tier's
  // agents answers no, so the words can't claim what one of them lacks.
  test('every tier baseline is what all of its agents have', () => {
    const cols = [...COLUMNS.inbox, ...COLUMNS.plannotator].map((c) => c.key);
    for (const tier of TIERS) {
      const agents = AGENTS.filter((a) => a.tier === tier.id);
      expect(agents.length, tier.id).toBeGreaterThan(0);
      const shared = cols.filter((k) => agents.every((a) => cellOf(a, k).level !== 'no'));
      expect([...tier.has].sort(), tier.id).toEqual([...shared].sort());
    }
  });
});
