// A page for screenshots of the drawing at rest: plannotator's own drawing
// (the test fixture in test/fixtures/plannotator), drawn by SystemThumb and
// SystemView in the Inbox's tokens. Not shipped; run it with `bun run demo` and open the printed address.
//
//   ?shot=thumb                       the card picture in a message card
//   ?shot=view&sheet=C-001&reading=simple&layout=window|pane
//   ?shot=card&pr=2543|2563           the review card with the change picture (&gate=1: the gate only; &open=1: PR 2563 open)
//   ?shot=change&pr=2543&view=before|after|steps   the full System view of a PR (&gate=1, &open=1 as above)
//   ?shot=plan                        a plan drawn dashed, as Shape's System (plan) tab
//   ?shot=touches&layout=pane|window  three open PRs on the drawing at rest, each touched part labelled (&lead=1: a "‹ Reviews" control leads the bar)
//   &mode=light|dark                  the theme mode (dark by default)
//   &keys=off                         the single-key shortcuts off, as the Inbox passes them
//
// The drawing is read from disk here and handed to the page as files; the page
// loads them with the browser entry's loadFiles. The sheets are served as they
// are, not bundled: the Inbox's sheet uses CSS that Bun's CSS parser rejects.
import { readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { readFiles } from '../src/node/index.ts';
import { before2563, OPEN_2563, PLAN, prFiles, REMOVES, TOUCHES } from '../test/fixtures/change.ts';
import page from './index.html';

const pkg = join(import.meta.dir, '..');
const dir = join(pkg, 'test', 'fixtures', 'plannotator');
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
    // the change fixtures: each PR's real files and counts, PR 2563 as it was while open, a plan
    '/change.json': async () => {
      const files = (await readFiles(dir)).files;
      return Response.json({ prs: { 2543: prFiles(2543), 2563: prFiles(2563) }, before2563: before2563(files), open2563: OPEN_2563, plan: PLAN, removes: REMOVES, touches: TOUCHES });
    },
    ...files,
  },
  fetch: () => new Response('not found', { status: 404 }),
});
console.log(`System demo on ${server.url}`);
