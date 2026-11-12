import { readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { readFiles } from '../src/node/index.ts';
import { before2563, OPEN_2563, PLAN, prFiles, REMOVES, TOUCHES } from '../test/fixtures/change.ts';
import page from './index.html';

const pkg = join(import.meta.dir, '..');
const dir = join(pkg, 'test', 'fixtures', 'plannotator');
const port = Number(process.env.PORT || 5893);
const fontDir = (name: string) => dirname(Bun.resolveSync(`@fontsource-variable/${name}/index.css`, pkg));

const ROOTS: Record<string, string> = {
  '/css/inter/': fontDir('inter'),
  '/css/geist-mono/': fontDir('geist-mono'),
  '/css/themes/': join(pkg, '..', 'ui', 'themes'),
  '/css/inbox/': join(pkg, '..', 'inbox'),
  '/css/system/': join(pkg, 'src'),
  '/css/demo/': import.meta.dir,
};

// Fixed routes made at start: no path is ever read from a request.
const files: Record<string, () => Response> = {};
for (const [prefix, root] of Object.entries(ROOTS)) {
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.(css|woff2)$/.test(rel) || rel.split(sep).includes('node_modules')) continue;
    const abs = join(root, rel);
    files[prefix + rel.split(sep).join('/')] = () => new Response(Bun.file(abs));
  }
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  development: true,
  routes: {
    '/': page,
    '/files.json': async () => Response.json((await readFiles(dir)).files),
    '/change.json': async () => {
      const files = (await readFiles(dir)).files;
      return Response.json({ prs: { 2543: prFiles(2543), 2563: prFiles(2563) }, before2563: before2563(files), open2563: OPEN_2563, plan: PLAN, removes: REMOVES, touches: TOUCHES });
    },
    ...files,
  },
  fetch: () => new Response('not found', { status: 404 }),
});
console.log(`System demo on ${server.url}`);
