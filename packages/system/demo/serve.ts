// A page for screenshots of the drawing at rest: plannotator's own committed
// drawing, drawn by SystemThumb and SystemView in the Inbox's tokens. Not
// shipped; run it with `bun run demo` and open the printed address.
//
//   ?shot=thumb                       the card picture in a message card
//   ?shot=view&sheet=C-001&reading=simple&layout=window|pane
//   &mode=light|dark                  the theme mode (dark by default)
//   &keys=off                         the single-key shortcuts off, as the Inbox passes them
//
// The drawing is read from disk here and handed to the page as files; the page
// loads them with the browser entry's loadFiles. The sheets are served as they
// are, not bundled: the Inbox's sheet uses CSS that Bun's CSS parser rejects.
import { readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { readFiles } from '../src/node/index.ts';
import page from './index.html';

const pkg = join(import.meta.dir, '..');
const dir = join(pkg, '..', '..', '.plannotator', 'system');
const port = Number(process.env.PORT || 5893);
const fontDir = (name: string) => dirname(Bun.resolveSync(`@fontsource-variable/${name}/index.css`, pkg));

/** The folders the page's stylesheets come from, by URL prefix. */
const ROOTS: Record<string, string> = {
  '/css/inter/': fontDir('inter'),
  '/css/geist-mono/': fontDir('geist-mono'),
  '/css/themes/': join(pkg, '..', 'ui', 'themes'),
  '/css/inbox/': join(pkg, '..', 'inbox'),
  '/css/system/': join(pkg, 'src'),
  '/css/demo/': import.meta.dir,
};

/** Every stylesheet and face the page may load, as fixed routes made at start: no path is ever read from a request. */
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
    ...files,
  },
  fetch: () => new Response('not found', { status: 404 }),
});
console.log(`System demo on ${server.url}`);
