import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
});
