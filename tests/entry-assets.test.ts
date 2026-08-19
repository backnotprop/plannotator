import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('review entry assets', () => {
  test.each(['apps/portal/index.html', 'apps/hook/index.html', 'apps/review/index.html'])(
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
  test.each(['apps/hook/index.html', 'apps/review/index.html', 'apps/portal/index.html'])(
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

    // Syntax highlighting is the bundled Shiki instance @pierre/diffs already
    // runs (JavaScript regex engine, no WASM, no network). A CDN-loaded
    // highlighter or a runtime wasm fetch would break the single-file builds.
    const codeBlock = read('packages/ui/components/blocks/CodeBlock.tsx');
    expect(codeBlock).toContain("from '../../utils/codeHighlight'");

    const highlighter = read('packages/ui/utils/codeHighlight.ts');
    expect(highlighter).toContain("import('@pierre/diffs')");
    expect(highlighter).toContain("preferredHighlighter: 'shiki-js'");
    expect(highlighter).not.toMatch(/https?:\/\//);
  });

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
  // dist/ is gitignored, so this skips cleanly on an unbuilt checkout. The CI
  // job that builds the bundles runs this file right after the build so the
  // assertion is not silently optional there.
  const bundles = ['apps/review/dist/index.html', 'apps/hook/dist/index.html'];
  test.each(bundles)('%s ships no inlined WebAssembly (skipped if unbuilt)', (path) => {
    const full = resolve(root, path);
    if (!existsSync(full)) return;
    // Asserted on a boolean, not the string: these bundles are ~20MB and a
    // `toContain` failure would print all of it.
    const inlinedWasm = readFileSync(full, 'utf8').includes('AGFzbQ');
    expect({ path, inlinedWasm }).toEqual({ path, inlinedWasm: false });
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
