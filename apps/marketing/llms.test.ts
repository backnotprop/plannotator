// The agent pages (/llms.txt, /llms/inbox.md, /llms/cli.md, /llms/agents/<slug>.md)
// as the real site build emits them: every agent the site has a page for
// reaches them, every plannotator.ai link they give resolves, every command
// they name is one the CLI has, and the deploy serves them as UTF-8.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LISTED_AGENTS } from './src/lib/inbox-agents';
import { SUBCOMMAND_HELP, SUBCOMMAND_HELP_ALIASES } from '../hook/server/cli';

const marketingRoot = fileURLToPath(new URL('.', import.meta.url));
let temporaryRoot = '';
let dist = '';

const read = (path: string) => readFile(join(dist, path), 'utf8');
const files = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: dist })];
const agentPages = () => files('llms/agents/*.md').sort();
const llmsPages = () => ['llms.txt', 'llms/inbox.md', 'llms/cli.md', ...agentPages()];

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(marketingRoot, '.astro-llms-'));
  dist = join(temporaryRoot, 'dist');
  const configPath = join(temporaryRoot, 'astro.config.mjs');
  const configUrl = pathToFileURL(join(marketingRoot, 'astro.config.mjs')).href;
  await writeFile(configPath, `import config from ${JSON.stringify(configUrl)};\nexport default { ...config, outDir: ${JSON.stringify(dist)} };\n`);
  const proc = Bun.spawn(
    [process.execPath, join(marketingRoot, 'node_modules/astro/bin/astro.mjs'), 'build', '--config', relative(marketingRoot, configPath)],
    { cwd: marketingRoot, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', GITHUB_TOKEN: '', GH_TOKEN: '' }, stdout: 'pipe', stderr: 'pipe' },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(code, out + err).toBe(0);
}, 120_000);

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
});

describe('the agent pages', () => {
  // The site's own agent pages are the list: an agent that gets a page under
  // /inbox/agents/ must also get its line in llms.txt, its section in
  // /llms/inbox.md and its own /llms/agents/<slug>.md, with its setup commands.
  test('every agent with a page on the site reaches llms.txt, the Inbox page and its own page', async () => {
    const slugs = files('inbox/agents/*/index.html').map((f) => f.split('/')[2]).sort();
    expect(slugs.length).toBeGreaterThan(10);
    expect(agentPages()).toEqual(slugs.map((slug) => `llms/agents/${slug}.md`));
    const root = await read('llms.txt');
    const inbox = await read('llms/inbox.md');
    for (const slug of slugs) {
      const agent = LISTED_AGENTS.find((a) => a.slug === slug);
      expect(agent, slug).toBeDefined();
      expect(root, slug).toContain(`[${agent!.name}](https://plannotator.ai/llms/agents/${slug}.md): `);
      const section = inbox.split(`\n#### ${agent!.name}\n`)[1]?.split('\n#')[0] ?? '';
      expect(section, slug).toContain(`https://plannotator.ai/llms/agents/${slug}.md`);
      const page = await read(`llms/agents/${slug}.md`);
      for (const step of agent!.setup) if (step.code) for (const line of step.code.split('\n')) expect(section, slug).toContain(line);
      const codes = [...agent!.setup, ...agent!.other.flatMap((o) => o.steps), agent!.check, ...agent!.trouble].map((s) => s.code).filter(Boolean) as string[];
      for (const code of codes) for (const line of code.split('\n')) expect(page, slug).toContain(line);
    }
  });

  // The install prompt a person pastes names every agent's own steps around
  // `plannotator inbox`, from the steps marked `prompt` in inbox-agents.ts.
  test('the install prompt gives every agent with a page its own steps and its page', async () => {
    const prompt = await read('inbox/prompt.md');
    expect(prompt).not.toContain('{{');
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(13 * 1024);
    for (const slug of files('inbox/agents/*/index.html').map((f) => f.split('/')[2])) {
      const agent = LISTED_AGENTS.find((a) => a.slug === slug)!;
      expect(prompt, slug).toContain(`[${agent.name}](https://plannotator.ai/llms/agents/${slug}.md)`);
      const marked = agent.setup.filter((s) => s.prompt);
      for (const step of marked) if (step.code) for (const line of step.code.split('\n')) expect(prompt, slug).toContain(line);
      // `plannotator inbox` turns a plugin's tool on only when the plugin is there, and has no way to connect an agent marked MCP by hand.
      if (agent.tier === 'plugin') expect(marked.some((s) => s.prompt === 'before' && s.code), slug).toBe(true);
      if (agent.inbox.tool.label === 'MCP by hand') expect(marked.some((s) => s.prompt === 'after'), slug).toBe(true);
    }
  });

  test('every plannotator.ai link they give is a file the build emits', async () => {
    for (const path of [...llmsPages(), 'inbox/prompt.md']) {
      const text = await read(path);
      const links = [...text.matchAll(/https:\/\/plannotator\.ai(\/[^\s)`"'>\]]*)/g)].map(([, p]) => p.replace(/[.,:;]+$/, ''));
      expect(links.length, path).toBeGreaterThan(0);
      for (const link of links) {
        const file = link.endsWith('/') ? `${link}index.html` : link;
        expect(existsSync(join(dist, file)), `${path} links ${link}`).toBe(true);
      }
    }
  });

  // llmstxt.org: the root is an index an agent reads first. The full
  // reference lives on the pages it links.
  test('llms.txt is an index under 8 KB that leads with the Inbox', async () => {
    const root = await read('llms.txt');
    expect(new TextEncoder().encode(root).length).toBeLessThan(8 * 1024);
    expect(root.startsWith('# Plannotator\n\n> ')).toBe(true);
    const firstLink = root.match(/\]\((https:[^)]+)\)/)?.[1];
    expect(firstLink).toBe('https://plannotator.ai/llms/inbox.md');
  });

  // An agent that runs a command from these pages runs one the CLI has: the
  // subcommand exists and every flag is in its usage. /llms/cli.md is the
  // plannotator skill, which apps/hook/server/plannotator-skill-reference.test.ts
  // already holds to the CLI.
  test('every plannotator command they name is a real subcommand with real flags', async () => {
    const usageOf = (sub: string) => SUBCOMMAND_HELP[SUBCOMMAND_HELP_ALIASES[sub] ?? sub];
    for (const path of llmsPages().filter((p) => p !== 'llms/cli.md')) {
      const text = await read(path);
      const spans = [...text.matchAll(/`([^`\n]+)`/g)].map(([, s]) => s);
      const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap(([, body]) => body.split('\n').map((l) => l.trim()));
      const commands = [...spans, ...fenced].filter((s) => /^plannotator( |$)/.test(s));
      expect(commands.length, path).toBeGreaterThan(0);
      for (const command of commands) {
        const [, sub = ''] = command.split(/\s+/);
        if (sub === '' || sub === '--version' || sub === '--help') continue;
        if (sub.startsWith('<')) continue;
        const usage = usageOf(sub);
        expect(usage, `${path}: ${command}`).toBeDefined();
        for (const flag of command.match(/(?<=\s)--[a-z][a-z-]*/g) ?? []) {
          if (flag === '--help') continue;
          expect(usage, `${path}: ${command}`).toContain(flag);
        }
      }
    }
  });

  // The sync uploads .md as text/markdown and .txt as text/plain with no
  // charset; the step after it must give every such file the UTF-8 type.
  test('the deploy gives every .md and .txt the build emits a UTF-8 content type', async () => {
    const workflow = await readFile(join(marketingRoot, '../../.github/workflows/deploy.yml'), 'utf8');
    const uploads = [...workflow.matchAll(/aws s3 cp apps\/marketing\/dist\/ s3:\/\/plannotator-marketing\/ --recursive[^\n]*\n\s*--exclude "\*" --include "\*\.(\w+)"[^\n]*\n\s*--content-type "([^"]+)"/g)].map(([, ext, type]) => [ext, type]);
    const typeOf = new Map(uploads as [string, string][]);
    expect(typeOf.get('md')).toBe('text/markdown; charset=utf-8');
    expect(typeOf.get('txt')).toBe('text/plain; charset=utf-8');
    const emitted = files('**/*.{md,txt}');
    expect(emitted).toContain('llms.txt');
    expect(emitted).toContain('llms/inbox.md');
    for (const file of emitted) expect(typeOf.has(file.split('.').at(-1)!), file).toBe(true);
  });
});
