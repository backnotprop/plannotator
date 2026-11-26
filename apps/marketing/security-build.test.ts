import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ossMenu, readOssStars } from './src/lib/oss-stars';
import { PLAN_CARDS, YEARLY_PERCENT_OFF } from './src/lib/spaces-pricing';

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

describe('the Decide together row as built', () => {
  async function decideFigure() {
    const html = await readFile(join(outputRoot, 'workspaces/index.html'), 'utf8');
    const section = /<section class="sec blk dev row" data-job="decide">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    const figure = /<figure\b([^>]*)>([\s\S]*?)<\/figure>/.exec(section);
    expect(figure, 'the decide row has a figure').not.toBeNull();
    return { attrs: figure![1], inner: figure![2] };
  }

  test('a screen reader gets one labelled image; the drawn scenes are hidden and nothing in them takes focus', async () => {
    const { attrs, inner } = await decideFigure();
    expect(attrs).toContain('role="img"');
    expect(/aria-label="([^"]+)"/.exec(attrs)?.[1]).toContain('Keep both');
    const scenes = [...inner.matchAll(/<div class="dsn( dsn-phone)?"([^>]*)>/g)];
    expect(scenes).toHaveLength(2);
    for (const [, , sceneAttrs] of scenes) expect(sceneAttrs).toContain('aria-hidden="true"');
    expect(inner).not.toMatch(/<(?:a|button|input|select|textarea)\b|\btabindex=|\bcontenteditable\b/);
  });

  function decisions(markup: string) {
    return [...markup.matchAll(
      /<div class="dsn-dec( dsn-end)?"><span class="dsn-face" style="--tone: ([^;]+);">[^<]*<\/span><span class="dsn-dq">([^<]*)<\/span><span class="dsn-da">([^<]*)<\/span><span class="dsn-dw">([^<]*)<time>([^<]*)<\/time>/g,
    )].map(([, end, tone, question, answer, who, time]) => ({ end: Boolean(end), tone, question, answer, who, time }));
  }

  test('the newest decision is the question just answered, and the rail ends on the oldest row', async () => {
    const { inner } = await decideFigure();
    const [wide] = inner.split('<div class="dsn dsn-phone"');
    const rows = decisions(wide);
    expect(rows.length).toBeGreaterThan(4);
    const asked = /<div class="dsn-q">([^<]*)<\/div><div class="dsn-opt"><span class="dsn-radio"><\/span>([^<]*)<\/div>/.exec(wide);
    expect(asked).not.toBeNull();
    // The scene picks the card's first option, so the top row must be that question with that answer.
    expect([rows[0].question, rows[0].answer]).toEqual([asked![1], asked![2]]);
    expect(rows.map((row) => row.end)).toEqual(rows.map((_, index) => index === rows.length - 1));
  });

  test("each rail dot is a decider's face from the page bar", async () => {
    const { inner } = await decideFigure();
    const pile = /<span class="dsn-pile">([\s\S]*?)<\/span><\/span>/.exec(inner)?.[1] ?? '';
    const faces = new Set([...pile.matchAll(/--tone: ([^;]+);/g)].map(([, tone]) => tone));
    expect(faces.size).toBeGreaterThan(0);
    for (const row of decisions(inner)) expect(faces, row.question).toContain(row.tone);
  });

  test('the phone shows the first rows of the same list, in the same order', async () => {
    const { inner } = await decideFigure();
    const [wide, phone] = inner.split('<div class="dsn dsn-phone"');
    const strip = ({ end: _end, ...row }: ReturnType<typeof decisions>[number]) => row;
    const phoneRows = decisions(phone ?? '');
    expect(phoneRows.length).toBeGreaterThan(0);
    expect(phoneRows.map(strip)).toEqual(decisions(wide).slice(0, phoneRows.length).map(strip));
    expect(phoneRows.at(-1)?.end).toBe(true);
  });

  test('the pencil note under the frame is decoration, hidden from a screen reader', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/index.html'), 'utf8');
    const section = /<section class="sec blk dev row" data-job="decide">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    const note = /<div class="ask dsn-ask"([^>]*)>/.exec(section);
    expect(note).not.toBeNull();
    expect(note![1]).toContain('aria-hidden="true"');
  });
});

describe("the first screen's third card as built", () => {
  test('the cycling agent name starts on the name a visit without scripts or motion shows', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/index.html'), 'utf8');
    const name = /<b class="hn" data-names="([^"]+)"><span>([^<]*)<\/span><\/b>/.exec(html);
    expect(name).not.toBeNull();
    const names = name![1].split('|');
    expect(names.length).toBeGreaterThan(1);
    expect(names[0]).toBe(name![2]);
  });

  test('where its last line may wrap, the line always holds two lines, so the card keeps one height while the name cycles', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/index.html'), 'utf8');
    const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+\.css)"/g)].map((m) => m[1]);
    const css = (await Promise.all(sheets.map((file) => readFile(join(outputRoot, file), 'utf8')))).join('\n');
    const lineHeight = /\.sheet\{[^}]*\bline-height:(\d+)px/.exec(css);
    expect(lineHeight).not.toBeNull();
    const wrapping = [...css.matchAll(/\.sheet\.mock \.q\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => /white-space:normal/.test(body));
    expect(wrapping.length).toBeGreaterThan(0);
    for (const body of wrapping) {
      expect(body).toContain(`min-height:${2 * Number(lineHeight![1])}px`);
    }
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

  test('Monthly is the checked choice, Yearly carries its saving, and without scripts the switch is not shown', async () => {
    const html = await readFile(join(outputRoot, 'workspaces/pricing/index.html'), 'utf8');
    const group = /<div class="pp-sw" role="radiogroup"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const radios = [...group.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attrs, inner]) => ({
      text: inner.replace(/<[^>]*>/g, ''),
      name: /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? null,
      checked: /aria-checked="true"/.test(attrs),
    }));
    expect(radios).toEqual([
      { text: 'Monthly', name: null, checked: true },
      { text: `Yearly ${YEARLY_PERCENT_OFF}`, name: `Yearly, ${YEARLY_PERCENT_OFF}`, checked: false },
    ]);
    expect(html).not.toContain('class="pp-saving"');
    const noscript = [...html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map(([, inner]) => inner).join('');
    expect(noscript).toMatch(/\.pp-pick\{display:none\}/);
  });
});
