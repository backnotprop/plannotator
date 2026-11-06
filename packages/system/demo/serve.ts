// A page for screenshots of the drawing at rest: plannotator's own committed
// drawing, drawn by SystemThumb and SystemView in the Inbox's tokens. Not
// shipped; run it with `bun run demo` and open the printed address.
//
//   ?shot=thumb                       the card picture in a message card
//   ?shot=view&sheet=C-001&reading=simple&layout=window|pane
//   &mode=light|dark                  the theme mode (dark by default)
//
// The drawing is read from disk here and handed to the page as files; the page
// loads them with the browser entry's loadFiles. The sheets are served as they
// are, not bundled: the Inbox's sheet uses CSS that Bun's CSS parser rejects.
import { dirname, join, normalize } from 'node:path';
import { readFiles } from '../src/node/index.ts';
import page from './index.html';

const pkg = join(import.meta.dir, '..');
const dir = join(pkg, '..', '..', '.plannotator', 'system');
const port = Number(process.env.PORT || 5893);
const fontDir = (name: string) => dirname(Bun.resolveSync(`@fontsource-variable/${name}/index.css`, pkg));

/** The folders the page's stylesheets are served from, by prefix. */
const ROOTS: Record<string, string> = {
  '/css/inter/': fontDir('inter'),
  '/css/geist-mono/': fontDir('geist-mono'),
  '/css/themes/': join(pkg, '..', 'ui', 'themes'),
  '/css/inbox/': join(pkg, '..', 'inbox'),
  '/css/system/': join(pkg, 'src'),
  '/css/demo/': import.meta.dir,
};

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  development: true,
  routes: {
    '/': page,
    '/files.json': async () => Response.json((await readFiles(dir)).files),
  },
  fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname);
    for (const [prefix, root] of Object.entries(ROOTS)) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(join(root, path.slice(prefix.length)));
      if (!file.startsWith(root + '/') || !/\.(css|woff2)$/.test(file)) break;
      return new Response(Bun.file(file));
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`System demo on ${server.url}`);
