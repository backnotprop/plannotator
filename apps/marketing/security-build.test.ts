import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ossMenu, readOssStars } from './src/lib/oss-stars';
import { PLAN_CARDS } from './src/lib/spaces-pricing';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
const hostileWaitlistUrl =
  'https://example.invalid/%3C%2Fscript%3E</ScRiPt ><img id="astro-define-vars-probe" src=x onerror=alert(1)>';

let temporaryRoot = '';
let outputRoot = '';
let buildOutput = '';

async function listFiles(directory: string, relative = ''): Promise<string[]> {
  const files: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryRelative = join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(join(directory, entry.name), entryRelative));
    } else {
      files.push(entryRelative);
    }
  }

  return files;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(marketingRoot, '.astro-security-'));
  outputRoot = join(temporaryRoot, 'dist');

  const configPath = join(temporaryRoot, 'astro.config.mjs');
  const configUrl = pathToFileURL(join(marketingRoot, 'astro.config.mjs')).href;
  const astroCli = join(marketingRoot, 'node_modules/astro/bin/astro.mjs');

  await writeFile(
    configPath,
    `import config from ${JSON.stringify(configUrl)};\n` +
      `export default { ...config, outDir: ${JSON.stringify(outputRoot)} };\n`,
  );

  const build = Bun.spawn(
    [process.execPath, astroCli, 'build', '--config', relative(marketingRoot, configPath)],
    {
      cwd: marketingRoot,
      env: {
        ...process.env,
        ASTRO_TELEMETRY_DISABLED: '1',
        GITHUB_TOKEN: '',
        GH_TOKEN: '',
        PUBLIC_TURNSTILE_SITEKEY: '',
        PUBLIC_WAITLIST_URL: hostileWaitlistUrl,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  buildOutput = stdout + stderr;

  expect(exitCode, buildOutput).toBe(0);
}, 30_000);

afterAll(async () => {
  if (temporaryRoot) {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

describe('marketing security build', () => {
  test('escapes define:vars values that contain HTML script terminators', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/index.html'), 'utf8');

    expect(html).toContain('astro-define-vars-probe');
    expect(html).toContain('\\u003c/ScRiPt >\\u003cimg');
    expect(html).not.toContain('</ScRiPt >');
    expect(html).not.toContain('<img id="astro-define-vars-probe"');
  });

  test('emits only the expected static-site artifact shape', async () => {
    const files = await listFiles(outputRoot);
    const plainBuildOutput = stripAnsi(buildOutput);

    expect(plainBuildOutput).toContain('output: "static"');
    expect(plainBuildOutput).toContain('mode: "static"');
    expect(files, buildOutput).toContain('index.html');
    expect(files).toContain('code-review/index.html');
    expect(files).toContain('workspaces/index.html');
    // The install script opens this page after an update (src/lib/plugin-update.ts).
    expect(files).toContain('plugin-update/index.html');
    // The Inbox's posted decisions comment loads its banner from these paths (packages/shared/inbox/decision-post.ts,
    // DECISION_POST_BANNER): moving them breaks every comment already posted.
    expect(files).toContain('assets/decisions/v1/banner-dark.png');
    expect(files).toContain('assets/decisions/v1/banner-light.png');
    expect(files).toContain('rss.xml');
    expect(files).toContain('sitemap-index.xml');
    expect(files.some((file) => file.startsWith('server/'))).toBe(false);
    expect(files.some((file) => file.startsWith('_server-islands/'))).toBe(false);
    expect(files.some((file) => /(^|\/)manifest(?:\.|$)/.test(file))).toBe(false);
    expect(files.some((file) => /\.(?:cjs|mjs)$/.test(file))).toBe(false);
  });

  test('indexes live root blog pages without indexing migrated redirects', async () => {
    const sitemap = await readFile(join(outputRoot, 'sitemap-0.xml'), 'utf8');

    expect(sitemap).toContain('<loc>https://plannotator.ai/blog/</loc>');
    expect(sitemap).toContain(
      '<loc>https://plannotator.ai/blog/an-interactive-ui-for-the-grill-me-skill/</loc>',
    );
    expect(sitemap).not.toContain(
      '<loc>https://plannotator.ai/blog/annotate-any-web-page-or-html-file/</loc>',
    );
    expect(sitemap).not.toContain(
      '<loc>https://plannotator.ai/blog/sharing-plans-with-your-team/</loc>',
    );
  });

  test('keeps the installer help page out of search', async () => {
    const sitemap = await readFile(join(outputRoot, 'sitemap-0.xml'), 'utf8');
    const html = await readFile(join(outputRoot, 'plugin-update/index.html'), 'utf8');

    expect(sitemap).not.toContain('https://plannotator.ai/plugin-update/');
    expect(html).toContain('<meta name="robots" content="noindex, follow">');
  });
});

describe('the Spaces header on the built pages', () => {
  const BOOK_CALL =
    'https://cal.com/plannotator/workspaces?utm_source=plannotator&utm_medium=website&utm_campaign=founder_call&utm_content=header';
  const REPOS = [
    'https://github.com/backnotprop/plannotator',
    'https://github.com/plannotator/effective-html',
    'https://github.com/plannotator/herdr-annotate',
    'https://github.com/plannotator/artifact-server',
    'https://github.com/plannotator/plannotator-tui',
    'https://github.com/plannotator/talkto',
    'https://github.com/plannotator',
  ];

  async function header(page: string) {
    const html = await readFile(join(outputRoot, page), 'utf8');
    const found = /<header class="nav">[\s\S]*?<\/header>/.exec(html);
    expect(found, page).not.toBeNull();
    const markup = found![0];
    const links = [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attrs, inner]) => ({
      href: (/\bhref="([^"]*)"/.exec(attrs)?.[1] ?? '').replaceAll('&amp;', '&'),
      attrs,
      text: inner.replace(/<[^>]+>/g, '').trim(),
    }));
    return { html, markup, links };
  }

  for (const page of ['workspaces/index.html', 'workspaces/pricing/index.html']) {
    test(`${page}: home, Pricing, Book a call and the repositories, at their addresses`, async () => {
      const { links } = await header(page);
      const to = (text: string) => links.filter((link) => link.text === text).map((link) => link.href);
      expect(links.find((link) => link.attrs.includes('class="act home"'))?.href).toBe('/workspaces/');
      expect(to('Pricing')).toEqual(['/workspaces/pricing/', '/workspaces/pricing/']);
      expect(to('Book a call')).toEqual([BOOK_CALL, BOOK_CALL]);
      // Each repository is in the drop-down and again in the phone menu, opening in a new tab.
      const repos = links.filter((link) => link.href.startsWith('https://github.com/'));
      expect(repos.map((link) => link.href)).toEqual([...REPOS, ...REPOS]);
      for (const link of repos) {
        expect(link.attrs).toContain('target="_blank"');
        expect(link.attrs).toContain('rel="noreferrer"');
      }
    });

    test(`${page}: no Sign in`, async () => {
      const { markup } = await header(page);
      expect(markup).not.toMatch(/sign in/i);
      expect(markup).not.toContain('/auth/login');
    });

    test(`${page}: the star count is the committed snapshot's`, async () => {
      const { markup } = await header(page);
      const menu = ossMenu(readOssStars(await readFile(join(marketingRoot, 'src/data/oss-stars.json'), 'utf8')));
      expect(menu.count).not.toBeNull();
      expect(markup).toContain(`<span class="lk-c">${menu.count}</span>`);
      expect(markup).toContain(`aria-label="${menu.label}"`);
    });
  }

  test('only the pricing page marks Pricing as the current page', async () => {
    const pricing = await header('workspaces/pricing/index.html');
    const front = await header('workspaces/index.html');
    const current = (links: { attrs: string; text: string }[]) =>
      links.filter((link) => link.attrs.includes('aria-current="page"')).map((link) => link.text);
    expect(current(pricing.links)).toEqual(['Pricing', 'Pricing']);
    expect(current(front.links)).toEqual([]);
  });

  test('the pricing page, now linked from the header, is indexable and in the sitemap', async () => {
    const sitemap = await readFile(join(outputRoot, 'sitemap-0.xml'), 'utf8');
    const { html } = await header('workspaces/pricing/index.html');
    expect(sitemap).toContain('<loc>https://plannotator.ai/workspaces/pricing/</loc>');
    expect(html).toContain('<meta name="robots" content="index, follow">');
  });
});

describe('the Spaces pricing page as built', () => {
  test('every card carries both prices for the switch and shows the monthly one first', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/pricing/index.html'), 'utf8');
    const cards = [...html.matchAll(/<article class="pp-card"([^>]*)>([\s\S]*?)<\/article>/g)];
    expect(cards.map(([, attrs]) => /data-plan="([^"]*)"/.exec(attrs)?.[1])).toEqual(PLAN_CARDS.map((card) => card.id));
    for (const [index, [, attrs, inner]] of cards.entries()) {
      const plan = PLAN_CARDS[index]!;
      const month = plan.price('month');
      const year = plan.price('year');
      expect(attrs).toContain(`data-month-amount="${month.amount}"`);
      expect(attrs).toContain(`data-year-amount="${year.amount}"`);
      if (year.per !== null) expect(attrs).toContain(`data-year-per="${year.per}"`);
      expect(inner).toContain(`<b aria-hidden="true">${month.amount}</b>`);
    }
  });

  test('Monthly is the checked choice, and without scripts the switch is not shown', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/pricing/index.html'), 'utf8');
    const group = /<div class="pp-sw" role="radiogroup"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const radios = [...group.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
      label,
      checked: /aria-checked="true"/.test(attrs),
    }));
    expect(radios).toEqual([
      { label: 'Monthly', checked: true },
      { label: 'Yearly', checked: false },
    ]);
    const noscript = [...html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map(([, inner]) => inner).join('');
    expect(noscript).toMatch(/\.pp-sw\{display:none\}/);
  });
});
