import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openPackedApp, PACKED_ASSETS_MARKER } from '../packages/shared/packed-app';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('review entry assets', () => {
  test.each(['apps/portal/index.html', 'apps/hook/index.html', 'apps/review/index.html', 'apps/inbox/index.html', 'apps/inbox/surface.html'])(
    '%s has no externally hosted startup scripts or styles',
    (path) => {
      expect(read(path)).not.toMatch(
        /<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i,
      );
    },
  );

  // The portal mounts the same @plannotator/editor App as the hook, so it needs
  // the identical shell: without it the mobile layout's safe-area tokens are
  // inert and the document scrolls behind the app's own scroll ownership.
  test.each(['apps/hook/index.html', 'apps/review/index.html', 'apps/portal/index.html', 'apps/inbox/index.html'])(
    '%s leaves scrolling to the visible-viewport application shell',
    (path) => {
      const html = read(path);
      expect(html).toContain('viewport-fit=cover');
      expect(html).toContain('<body class="overflow-hidden overscroll-none antialiased">');
      expect(html).toContain('<div id="root" class="h-full overflow-hidden"></div>');
      expect(html).not.toContain('min-h-screen');
    },
  );

  test('the plan surface extends its active canvas behind mobile browser controls', () => {
    const editor = read('packages/editor/App.tsx');
    const theme = read('packages/ui/theme.css');

    expect(editor).toContain("const browserCanvas = isHtmlSurface || gridEnabled ? 'background' : 'card';");
    expect(editor).toContain('data-pn-browser-canvas={browserCanvas}');
    expect(editor).toContain("data-pn-document-scroll={usesDocumentScroll ? 'true' : undefined}");
    expect(editor).toContain('sticky={!usesDocumentScroll}');
    expect(editor).toContain('stickyActions={uiPrefs.stickyActionsEnabled && !usesDocumentScroll}');
    expect(editor).toContain("overflowY={usesDocumentScroll ? 'visible' : 'auto'}");
    expect(theme).toContain('html:has([data-pn-browser-canvas="card"])');
    expect(theme).toContain('html:has([data-pn-document-scroll="true"])');
    expect(theme).toContain('background-color: var(--card);');
  });

  test('the app bundles its default fonts and syntax highlighting', () => {
    const editorCss = read('packages/editor/index.css');
    expect(editorCss).toContain('@import "@fontsource-variable/inter";');
    expect(editorCss).toContain('@import "@fontsource-variable/geist-mono";');

    const theme = read('packages/ui/themes/plannotator.css');
    expect(theme).toContain("--font-sans: 'Inter Variable'");
    expect(theme).toContain("--font-mono: 'Geist Mono Variable'");

    // Syntax highlighting is the bundled highlighter @pierre/diffs already
    // runs, on the backend @plannotator/core/code-highlighter names (Highlights,
    // whose WASM is inlined in its script, or Shiki's JavaScript regex engine);
    // never a CDN or a runtime wasm fetch, which would break the single-file
    // builds. The artifact checks below hold the WASM to Highlights' own.
    const codeBlock = read('packages/ui/components/blocks/CodeBlock.tsx');
    expect(codeBlock).toContain("from '../../utils/codeHighlight'");

    const highlighter = read('packages/ui/utils/codeHighlight.ts');
    expect(highlighter).toContain("import('@pierre/diffs')");
    expect(highlighter).toContain('preferredHighlighter: CODE_HIGHLIGHTER');
    expect(read('packages/core/code-highlighter.ts')).toMatch(/export const CODE_HIGHLIGHTER: CodeHighlighter = '(highlights|shiki-js)';/);
    expect(highlighter).not.toMatch(/https?:\/\//);
  });

  // @plannotator/ui loads KaTeX and the username dictionary through slots
  // (utils/math.ts, utils/generateIdentity.ts) so hosts that bundle by route
  // can leave them out of a document read. Plannotator's parity rests on two
  // side-effect imports per app entry: without them, plans with math would
  // paint TeX for a frame in every runtime and identities would come from the
  // 16-word fallback pool, with no error anywhere. Both apps must carry both.
  test.each(['packages/editor/App.tsx', 'packages/review-editor/App.tsx'])(
    '%s registers the eager math renderer and identity dictionary',
    (path) => {
      const source = read(path);
      expect(source).toContain("import '@plannotator/ui/utils/math-eager';");
      expect(source).toContain("import '@plannotator/ui/utils/identity-tater';");
    },
  );

  // Mermaid is LAZY in both apps by policy since Mermaid 12: the runtime (ELK
  // layout by default, ~1.8 MB more than 11) loads on the first diagram
  // through utils/mermaid's own import('mermaid'), so a plan with no diagram
  // never pays for it in a chunked build (the share portal). Re-adding the
  // eager entry to either app would put the whole runtime back into that
  // entry chunk with no error anywhere; the review editor draws diagrams only
  // through the separately served engine (below).
  test('neither app registers the eager Mermaid runtime', () => {
    expect(read('packages/editor/App.tsx')).not.toContain('mermaid-eager');
    expect(read('packages/review-editor/App.tsx')).not.toContain('mermaid-eager');
  });

  // The review app draws Mermaid and Graphviz fences (Markdown preview, guide
  // overviews) ONLY through the engine the review server serves as separate
  // files (apps/review/diagram-engine; approval "review-diagrams-on-demand",
  // honoring the 2026-10-12 rule that diagrams return to code review only
  // through true lazy loading, never by bundling). A lazy import does not
  // help here: the single-file build inlines every dynamic import, so naming
  // a diagram engine anywhere in the review page's graph puts ~6.7 MB of
  // runtimes into every review page. The built-bundle markers below are the
  // proof; this names the culprit. The engine's own sources live in
  // apps/review/diagram-engine and are reached only by its build script.
  test('the review app imports no diagram engine, not even lazily', () => {
    const diagramModule = /(?:from\s+|import\s*\(?\s*)['"](?:[^'"]*(?:components\/(?:MermaidBlock|GraphvizBlock|DiagramBlock|Viewer)|components\/diagram\/[^'"]*|utils\/(?:mermaid|graphviz|diagram-render)[^'"\/]*)|mermaid|@viz-js\/viz)['"]/;
    const engineSources = /(?:from\s+|import\s*\(?\s*)['"][^'"]*diagram-engine\/(?:engine|runtime-[a-z]+)(?:\.tsx?)?['"]/;
    const walk = (dir: string): string[] =>
      readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === 'node_modules' || entry.name === 'dist' ? [] : walk(`${dir}/${entry.name}`)
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
      );
    const pageSources = ['packages/review-editor', 'packages/guide-viewer', 'apps/review']
      .flatMap(walk)
      .filter((path) => !path.startsWith('apps/review/diagram-engine/'));
    expect(pageSources.filter((path) => diagramModule.test(read(path)))).toEqual([]);
    expect(pageSources.filter((path) => engineSources.test(read(path)))).toEqual([]);
    // The page reaches the engine only by URL, from the one loader, and only
    // a diagram fence asks it to load (so a review without diagrams never
    // requests it).
    const urlImports = pageSources.filter((path) => /\bimport\(\s*\/\*\s*@vite-ignore\s*\*\/\s*url\s*\)/.test(read(path)));
    expect(urlImports).toEqual(['packages/review-editor/utils/diagramEngine.ts']);
    const loaders = pageSources.filter((path) => path !== 'packages/review-editor/utils/diagramEngine.ts' && /\bloadDiagramEngine\b/.test(read(path)));
    expect(loaders).toEqual(['packages/review-editor/components/ReviewDiagramFence.tsx']);
    // The engine build rewrites the renderer slots' runtime imports to the
    // served URLs and fails unless it finds exactly one each.
    const build = read('apps/review/diagram-engine/build.ts');
    expect(build).toContain("path.join(uiRoot, 'utils/mermaid.ts')");
    expect(build).toContain("path.join(uiRoot, 'utils/graphviz.ts')");
    expect(read('apps/review/package.json')).toContain('"build": "vite build && bun diagram-engine/build.ts"');
  });

  // The other half of the optimization: the renderers must stay OFF the
  // static import graph of the components, otherwise a host's bundler puts
  // them back into every document read and the slots become decoration.
  test('renderer runtimes are not statically imported by the components', () => {
    const staticImport = (spec: string) => new RegExp(`^import\\s+(?!type\\b)[^;]*from\\s+['"]${spec}['"]`, 'm');
    expect(read('packages/ui/components/blocks/MathBlock.tsx')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/components/InlineMarkdown.tsx')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/utils/math.ts')).not.toMatch(staticImport('katex'));
    // The default `import('katex')` lives in its own module so a host that
    // registers a loader can alias it away; math.ts must not grow a second
    // site, or the alias stops dropping the chunk.
    // (Comments name the call in prose, so this is matched as code: a call
    // that starts a line or an expression, never a backtick-quoted mention.)
    expect(read('packages/ui/utils/math.ts')).not.toMatch(/[^`'"]import\(['"]katex['"]\)/);
    expect(read('packages/ui/utils/math.ts')).toContain("from './math-default-loader'");
    expect(read('packages/ui/utils/math-default-loader.ts')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/utils/math-default-loader.ts')).toContain("import('katex')");
    // The alias target for Mermaid's own `import("katex")` renders through
    // the slot; if it ever named katex itself, a host's redirect would
    // re-create the chunk it removes.
    expect(read('packages/ui/utils/mermaid-math-slot.ts')).not.toMatch(staticImport('katex'));
    expect(read('packages/ui/utils/mermaid-math-slot.ts')).not.toMatch(/[^`'"]import\(['"]katex['"]\)/);
    expect(read('packages/ui/components/MermaidBlock.tsx')).not.toMatch(staticImport('mermaid'));
    expect(read('packages/ui/utils/mermaid.ts')).not.toMatch(staticImport('mermaid'));
    expect(read('packages/ui/utils/mermaid.ts')).toContain("import('mermaid')");
    expect(read('packages/ui/components/GraphvizBlock.tsx')).not.toMatch(staticImport('@viz-js/viz'));
    expect(read('packages/ui/components/DiagramBlock.tsx')).not.toMatch(staticImport('@viz-js/viz'));
    expect(read('packages/ui/utils/diagram-render.ts')).not.toMatch(staticImport('@viz-js/viz'));
    expect(read('packages/ui/utils/graphviz.ts')).not.toMatch(staticImport('@viz-js/viz'));
    expect(read('packages/ui/utils/graphviz.ts')).toContain("import('@viz-js/viz')");
    expect(read('packages/ui/utils/generateIdentity.ts')).not.toMatch(staticImport('unique-username-generator'));
  });

  // The Inbox window's guided review (PLAN step 5) reaches the guide chain and
  // review-editor's diff renderer through lazyParts.tsx's one dynamic import of
  // `#guide-reader` (packages/inbox/guide/GuideReader.tsx). That import is
  // where the window's build splits (build/pack-inbox.ts), so the reader's
  // bytes load on the first Open, never at page load (#2593). A static import
  // elsewhere would make the window depend on the reader directly, and that
  // boundary would be gone.
  // The surface a phone hosts (PLAN step S1) has no network at all: every
  // byte arrives over the bridge. Its policy is the boundary, so it is pinned.
  // The one https origin it names is the Android shell's asset origin, the
  // virtual host the shell intercepts and never fetches (contract section 10).
  test('the surface forbids every connection and loads nothing from outside', () => {
    const html = read('apps/inbox/surface.html');
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp.replaceAll(' https://appassets.androidplatform.net;', ';').replaceAll(' https://appassets.androidplatform.net ', ' ')).not.toMatch(/https?:|wss?:|\*/);
    // Wherever iOS's asset scheme is allowed, Android's asset origin is too, and nowhere else.
    for (const directive of csp.split(';').map((d) => d.trim())) {
      expect(directive.includes('https://appassets.androidplatform.net')).toBe(directive.includes('plannotator-asset:'));
    }
  });

  test('the Inbox window mounts the guide viewer only through its dynamic import', () => {
    const heavy = /^import\s+(?!type\b)[^;]*from\s+['"](?:@plannotator\/guide-viewer|@plannotator\/review-editor|#guide-reader)[^'"]*['"]/m;
    const walk = (dir: string): string[] =>
      readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === 'node_modules' ? [] : walk(`${dir}/${entry.name}`)
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
      );
    // Shape's board (its Code view is a guided review) is the same kind of lazy module: `#shape-board`. So is the
    // Post to GitHub/GitLab dialog of a pull request's review (the review app's own): `#platform-post`. The PR page's
    // All files (the review app's tree and file view) rides the reader's chunk, re-exported by GuideReader.tsx.
    const readers = ['packages/inbox/guide/GuideReader.tsx', 'packages/inbox/guide/SurfaceGuideReader.tsx', 'packages/inbox/shape/ShapeBoard.tsx', 'packages/inbox/guide/PlatformPost.tsx', 'packages/inbox/guide/PullRepoParts.tsx'];
    const eager = walk('packages/inbox').filter((path) => !readers.includes(path) && heavy.test(read(path)));
    expect(eager).toEqual([]);
    // The window's parts (lazyParts.tsx): fetched in idle time, each through its dynamic import only.
    expect(read('packages/inbox/lazyParts.tsx')).toContain("lazyPart(() => import('#guide-reader'))");
    // The surface's reader (one section per screen) and its diagram engine wait the same way.
    expect(read('packages/inbox/surface/SurfaceGuide.tsx')).toContain("lazy(() => import('#surface-guide-reader'))");
    expect(read('packages/inbox/surface/SurfaceDocument.tsx')).toContain("lazy(() => import('./SurfaceDiagram'))");
    expect(read('packages/inbox/lazyParts.tsx')).toContain("lazyPart(() => import('#shape-board'))");
    // The posting dialog waits for the review's ending, and nothing else imports it.
    expect(read('packages/inbox/lazyParts.tsx')).toContain("lazyPart(() => import('#platform-post'))");
    const post = /^import\s+(?!type\b)[^;]*from\s+['"](?:#platform-post|[^'"]*guide\/PlatformPost(?:\.tsx)?)['"]/m;
    expect(walk('packages/inbox').filter((path) => post.test(read(path)))).toEqual([]);
    // The board itself (ShapeSurface, through the shape index) reaches the window only through #shape-board.
    const board = /^import\s+(?!type\b)[^;]*from\s+['"]@plannotator\/ui\/components\/shape(?:\/ShapeSurface)?['"]/m;
    expect(walk('packages/inbox').filter((path) => path !== 'packages/inbox/shape/ShapeBoard.tsx' && board.test(read(path)))).toEqual([]);
  });

  // Inbox search's palette (the approved "inbox-search" design: "the palette
  // body is lazy, mounted on the first open ... so it never rides the window's
  // first paint") reaches the window only through SearchHost's one dynamic
  // import of `#search-palette`. A type-only import is erased; any other
  // import of the palette module would put it back on the first paint.
  test('the Inbox window mounts the search palette only through its dynamic import', () => {
    const palette = /^import\s+(?!type\b)[^;]*from\s+['"](?:#search-palette|[^'"]*search\/SearchPalette(?:\.tsx)?)['"]/m;
    const walk = (dir: string): string[] =>
      readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? entry.name === 'node_modules' ? [] : walk(`${dir}/${entry.name}`)
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : [],
      );
    const eager = [...walk('packages/inbox'), ...walk('apps/inbox')].filter((path) => palette.test(read(path)));
    expect(eager).toEqual([]);
    expect(read('packages/inbox/lazyParts.tsx')).toContain("lazyPart(() => import('#search-palette'))");
    expect(read('packages/inbox/package.json')).toContain('"#search-palette": "./search/SearchPalette.tsx"');
  });

  // Built-artifact check: a lost eager import would still type-check and pass
  // every unit test, so the built single-file bundles are read directly.
  // Two different kinds of marker, deliberately:
  //
  // - Registration markers, which only reach a bundle when the eager module is
  //   evaluated in it: the source tags `math-eager` and `mermaid-eager` pass
  //   to their slots, and the dictionary's exported function name (the
  //   dictionary is imported ONLY by identity-tater). These are the guards for
  //   a dropped or tree-shaken side-effect import (a future
  //   `"sideEffects": false` would let Vite discard `import '.../math-eager'`,
  //   the slot would stay empty and every runtime would paint TeX for a frame).
  //   Proven by removing each import and rebuilding: the registration marker
  //   count drops to zero while the presence markers stay. The Mermaid
  //   registration marker is asserted ABSENT from both bundles: since Mermaid
  //   12 the plan editor loads the runtime lazily by policy, and an eager
  //   import creeping back in would only show up as a bigger portal entry
  //   chunk. The review bundle carries no Mermaid and no Graphviz at all: its
  //   diagrams come from the separately served engine files (see the import
  //   guard above, and the engine files checked below), so both presence
  //   markers are asserted absent there.
  // - Presence markers (a KaTeX class name, a Mermaid diagram id, an
  //   Emscripten symbol from Graphviz, the bridge global), which only say the
  //   runtime is still packed into the bundle. KaTeX is packed
  //   through utils/math-default-loader.ts's import('katex') whether or not it is registered,
  //   so `katex-display` cannot prove registration and is not asked to; the
  //   Mermaid diagram id in the plan bundle likewise proves packing only.
  //
  // dist/ is gitignored, so this is skipped on an unbuilt checkout; the CI job
  // that builds the bundles runs it right after.
  const REGISTRATION_MARKERS = ['plannotator-math-eager', 'uniqueUsernameGenerator'];
  const markerExpectations: Array<[bundle: string, present: string[], absent: string[]]> = [
    ['apps/hook/dist/index.html', [...REGISTRATION_MARKERS, 'katex-display', 'flowchart-v2', 'viz_set_y_invert', '__plannotatorLiveConfig'], ['plannotator-mermaid-eager']],
    ['apps/review/dist/index.html', [...REGISTRATION_MARKERS, 'katex-display', '__plannotatorLiveConfig'], ['plannotator-mermaid-eager', 'flowchart-v2', 'viz_set_y_invert']],
  ];
  for (const [path, present, absent] of markerExpectations) {
    test.skipIf(!existsSync(resolve(root, path)))(`${path} carries the eager registration and renderer markers`, () => {
      const html = readFileSync(resolve(root, path), 'utf8');
      // Asserted per marker on a boolean so a failure never prints the 20MB bundle.
      const missing = present.filter((marker) => !html.includes(marker));
      const unexpected = absent.filter((marker) => html.includes(marker));
      expect({ path, missing, unexpected }).toEqual({ path, missing: [], unexpected: [] });
    });
  }

  // The engine files the review server serves, built beside the page by
  // `apps/review`'s build (diagram-engine/build.ts) and copied by build:hook.
  // Each runtime lives in its own file, the engine carries neither, and the
  // engine brings no React of its own: every module it shares with the page
  // is read from the host the page installs (no bare import survives).
  const ENGINE_DIRS = ['apps/review/dist/diagram-engine', 'apps/hook/dist/diagram-engine'];
  for (const dir of ENGINE_DIRS) {
    test.skipIf(!existsSync(resolve(root, dir)))(`${dir} holds the engine and both runtimes, apart`, () => {
      const file = (name: string) => readFileSync(resolve(root, dir, `${name}.js`), 'utf8');
      const engine = file('engine');
      const mermaid = file('mermaid');
      const graphviz = file('graphviz');
      const facts = {
        dir,
        engineHasMermaid: engine.includes('flowchart-v2'),
        engineHasGraphviz: engine.includes('viz_set_y_invert'),
        engineReadsHost: engine.includes('__plannotatorDiagramEngineHost'),
        // Every import the engine names (statements and literal dynamic
        // imports); the runtimes are imported by URL from the host, never by name.
        engineImports: new Bun.Transpiler({ loader: 'js' }).scanImports(engine).map((entry) => entry.path),
        mermaidRuntime: mermaid.includes('flowchart-v2'),
        graphvizRuntime: graphviz.includes('viz_set_y_invert'),
        mermaidCarriesKatex: mermaid.includes('katex-display'),
      };
      expect(facts).toEqual({
        dir,
        engineHasMermaid: false,
        engineHasGraphviz: false,
        engineReadsHost: true,
        engineImports: [],
        mermaidRuntime: true,
        graphvizRuntime: true,
        mermaidCarriesKatex: false,
      });
    });
  }

  // The HTML viewer bridge stays INLINE in Plannotator's bundles: the
  // `bridgeScriptUrl` seam is host-only, so the built HTML must carry the
  // bridge literal exactly once (the srcdoc injection's string constant),
  // never zero (a `bridge-script.lite` alias leaking into an app build) and
  // never twice (a second copy riding in through the generated asset). The
  // marker is the bridge's test-introspection global, which appears once in
  // the literal and nowhere else in either app.
  for (const path of ['apps/hook/dist/index.html', 'apps/review/dist/index.html']) {
    test.skipIf(!existsSync(resolve(root, path)))(`${path} inlines the HTML viewer bridge exactly once`, () => {
      const html = readFileSync(resolve(root, path), 'utf8');
      const literalCount = html.split('__plannotatorBridgeInternals').length - 1;
      expect({ path, literalCount }).toEqual({ path, literalCount: 1 });
    });
  }

  test('nothing depends on highlight.js any more', () => {
    for (const manifest of ['packages/ui/package.json', 'packages/review-editor/package.json']) {
      expect(read(manifest)).not.toContain('highlight.js');
    }
  });

  test('the dead Oniguruma WASM is aliased out of every bundled app', () => {
    for (const config of [
      'apps/review/vite.config.ts',
      'apps/hook/vite.config.ts',
      'apps/portal/vite.config.ts',
      'apps/inbox/vite.config.ts',
    ]) {
      expect(read(config)).toContain("'shiki/wasm': path.resolve(");
    }
  });

  // The alias assertions above only read SOURCE. A future @pierre/diffs bump
  // could reach the same inlined blob through a different import specifier and
  // every source check would still pass, so this reads the ARTIFACT: a base64
  // WASM module always starts `\0asm\x01\0\0\0`, which encodes with the
  // `AGFzbQ` prefix regardless of how it got inlined.
  //
  // The one module allowed is Pierre's Highlights (the code highlighter,
  // @plannotator/core/code-highlighter): it ships as base64 inside its own
  // script, and every build carries it. Each inlined module must open with
  // that module's bytes, read from the installed package, so the Oniguruma
  // blob (or any other) still fails.
  //
  // dist/ is gitignored, so this skips cleanly on an unbuilt checkout. The CI
  // job that builds the bundles runs this file right after the build so the
  // assertion is not silently optional there.
  const pierreDiffs = dirname(dirname(Bun.resolveSync('@pierre/diffs', resolve(root, 'packages/ui'))));
  const highlightsWasm = readFileSync(resolve(pierreDiffs, '../highlights/dist/highlights.wasm.mjs'), 'utf8');
  const highlightsHead = highlightsWasm.slice(highlightsWasm.indexOf('AGFzbQ'), highlightsWasm.indexOf('AGFzbQ') + 64);
  const bundles = ['apps/review/dist/index.html', 'apps/hook/dist/index.html', 'apps/hook/dist/inbox.html', 'apps/hook/dist/surface.html', 'apps/hook/dist/shape.html'];
  for (const path of bundles) {
    test.skipIf(!existsSync(resolve(root, path)))(`${path} ships no inlined WebAssembly but Highlights'`, () => {
      // Asserted on a count, not the string: these bundles are ~20MB and a
      // `toContain` failure would print all of it.
      const bundle = readFileSync(resolve(root, path), 'utf8');
      let otherWasm = 0;
      for (let at = bundle.indexOf('AGFzbQ'); at !== -1; at = bundle.indexOf('AGFzbQ', at + 1)) {
        if (bundle.slice(at, at + highlightsHead.length) !== highlightsHead) otherWasm++;
      }
      expect({ path, otherWasm }).toEqual({ path, otherWasm: 0 });
    });
  }

  // The plan and review bundles are packed (build/pack-app.ts) so a session's
  // first load moves only the page, its entry chunk and its stylesheet; the
  // lazy chunks (Shiki grammars, Mermaid, ELK, Graphviz, KaTeX, fonts) stay in
  // the pack until something imports them. Re-inlining them
  // (`inlineDynamicImports`, vite-plugin-singlefile) builds and passes
  // everything else while quietly restoring the ~25 MB first load over a
  // tailnet or tunnel, so this reads the ARTIFACT.
  const packedBundles = ['apps/review/dist/index.html', 'apps/hook/dist/index.html', 'apps/hook/dist/review.html'];
  for (const path of packedBundles) {
    test.skipIf(!existsSync(resolve(root, path)))(`${path} loads only its entry chunk and stylesheet up front`, async () => {
      const bundle = readFileSync(resolve(root, path), 'utf8');
      const app = openPackedApp(bundle);
      const upFront = [...app.html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
      let bytes = app.html.length;
      for (const asset of upFront) {
        const answer = await app.answer(asset, 'GET', null, false);
        expect({ asset, status: answer.status }).toEqual({ asset, status: 200 });
        bytes += answer.body.length;
      }
      expect(upFront.length).toBeGreaterThan(0);
      expect(bytes / bundle.length).toBeLessThan(1 / 3);
    });

    // Packing before vite:build-import-analysis has rewritten the chunks ships
    // its placeholder, and the app then throws on its first dynamic import.
    test.skipIf(!existsSync(resolve(root, path)))(`${path} packs finished chunks`, () => {
      const preloadPlaceholder = readFileSync(resolve(root, path), 'utf8').includes('__VITE_PRELOAD__');
      expect({ path, preloadPlaceholder }).toEqual({ path, preloadPlaceholder: false });
    });

    // Vite emits KaTeX's woff and ttf fallbacks before katexWoff2Only strips
    // their url()s, so only the plugin's own prune keeps ~1.1 MB of fonts no
    // browser reads out of each packed bundle (#1617).
    test.skipIf(!existsSync(resolve(root, path)))(`${path} packs no KaTeX woff or ttf fallback`, () => {
      const fallback = /\/assets\/KaTeX_[^"]*\.(?:woff|ttf)"/.test(readFileSync(resolve(root, path), 'utf8'));
      expect({ path, fallback }).toEqual({ path, fallback: false });
    });
  }

  // The phone's surface and the Shape page stay one self-contained page each
  // (vite-plugin-singlefile): a native shell loads the surface with no server
  // and no network behind it, and the Shape page's server serves it whole, with
  // no asset route behind it.
  for (const path of ['apps/hook/dist/surface.html', 'apps/hook/dist/shape.html']) {
    test.skipIf(!existsSync(resolve(root, path)))(`${path} stays single-file`, () => {
      const html = readFileSync(resolve(root, path), 'utf8');
      const facts = { path, packed: html.includes(PACKED_ASSETS_MARKER), linksAssets: /(?:src|href)="\/assets\//.test(html) };
      expect(facts).toEqual({ path, packed: false, linksAssets: false });
    });
  }

  // The Inbox window (#2593) is one file whose scripts are packed behind the
  // page (build/pack-inbox.ts) and served by the Inbox. Inlined, every lazy
  // part was parsed and run at page load and held for the tab's life (~150 MB
  // for an empty Inbox). Going back to vite-plugin-singlefile or
  // `inlineDynamicImports`, a static import of a lazy part, or a non-ASCII
  // character in a script (V8 then keeps that script at two bytes per
  // character) builds and passes everything else, so this reads the ARTIFACT.
  const inboxWindow = 'apps/hook/dist/inbox.html';
  /** One marker per part that must wait for first use, and so must be in the pack but not up front. */
  const INBOX_LAZY_MARKERS: Record<string, string> = {
    'guide viewer (#guide-reader)': 'data-guide-code-view-mounted',
    'Shiki TypeScript grammar': '"scopeName":"source.ts"',
    Mermaid: 'flowchart-v2',
    Graphviz: 'viz_set_y_invert',
    KaTeX: 'katex-display',
  };
  test.skipIf(!existsSync(resolve(root, inboxWindow)))(`${inboxWindow} loads its entry script up front and the review, diagrams and grammars on first use`, async () => {
    const bundle = readFileSync(resolve(root, inboxWindow), 'utf8');
    const app = openPackedApp(bundle);
    const markerAt = bundle.indexOf(PACKED_ASSETS_MARKER);
    expect(markerAt).toBeGreaterThan(0);
    const indexAt = markerAt + PACKED_ASSETS_MARKER.length;
    const packed = Object.keys(JSON.parse(bundle.slice(indexAt, bundle.indexOf('\n', indexAt))) as Record<string, unknown>);
    const text = async (asset: string) => {
      const answer = await app.answer(asset, 'GET', null, false);
      expect({ asset, status: answer.status }).toEqual({ asset, status: 200 });
      return answer.body.toString();
    };
    // Up front: the page and what it links (its entry script, any module preloads), with the static imports they make.
    const upFront = new Map<string, string>();
    const load = async (asset: string): Promise<void> => {
      if (upFront.has(asset)) return;
      const code = await text(asset);
      upFront.set(asset, code);
      for (const entry of new Bun.Transpiler({ loader: 'js' }).scanImports(code)) {
        if (entry.kind === 'import-statement') await load(new URL(entry.path, `http://inbox${asset}`).pathname);
      }
    };
    for (const m of app.html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) await load(m[1]!);
    const all = new Map<string, string>();
    for (const asset of packed) all.set(asset, await text(asset));
    const has = (codes: Iterable<string>, marker: string) => [...codes].some((code) => code.includes(marker));
    const upFrontBytes = app.html.length + [...upFront.values()].reduce((n, code) => n + code.length, 0);
    const facts = {
      // The stylesheet stays in the page, so it paints as the single-file page did; only scripts are packed.
      stylesheetInline: app.html.includes('<style') && !/<link rel="stylesheet"/.test(app.html),
      onlyScriptsPacked: packed.every((asset) => asset.endsWith('.js')),
      entryScripts: [...app.html.matchAll(/<script type="module"[^>]*\ssrc="\/assets\//g)].length,
      preloadPlaceholder: bundle.includes('__VITE_PRELOAD__'),
      lazyPartsPacked: Object.entries(INBOX_LAZY_MARKERS).filter(([, marker]) => !has(all.values(), marker)).map(([part]) => part),
      lazyPartsUpFront: Object.entries(INBOX_LAZY_MARKERS).filter(([, marker]) => has(upFront.values(), marker)).map(([part]) => part),
      nonAsciiScripts: [...all].filter(([, code]) => /[^\x00-\x7f]/.test(code)).map(([asset]) => asset),
      upFrontUnderAThird: upFrontBytes / bundle.length < 1 / 3,
    };
    expect(facts).toEqual({
      stylesheetInline: true,
      onlyScriptsPacked: true,
      entryScripts: 1,
      preloadPlaceholder: false,
      lazyPartsPacked: [],
      lazyPartsUpFront: [],
      nonAsciiScripts: [],
      upFrontUnderAThird: true,
    });
  });
});

describe('marketing embeds', () => {
  const youtubePosts = [
    'apps/marketing/src/content/blog/local-diff-review-for-coding-agents.md',
    'apps/marketing/src/content/blog/plan-diff-see-what-changed.md',
    'apps/marketing/src/content/blog/plannotator-meets-pi.md',
    'apps/marketing/src/content/blog/sharing-plans-with-your-team.md',
    'apps/marketing/src/content/blog/welcome.md',
  ];

  test.each(youtubePosts)('%s uses YouTube privacy-enhanced embeds', (path) => {
    const content = read(path);
    expect(content).not.toContain('www.youtube.com/embed/');
    expect(content).toContain('www.youtube-nocookie.com/embed/');
  });

  test('the in-app help dialog uses YouTube privacy-enhanced embeds', () => {
    const toolstrip = read('packages/ui/components/AnnotationToolstrip.tsx');
    expect(toolstrip).not.toContain('www.youtube.com/embed/');
    expect(toolstrip).toContain('www.youtube-nocookie.com/embed/');
  });
});
