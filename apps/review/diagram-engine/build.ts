/**
 * Builds code review's diagram engine as three files beside the single-file
 * review page (owner approval "review-diagrams-on-demand"):
 *
 *   dist/diagram-engine/engine.js    ui's DiagramBlock path (React layer,
 *                                     renderer slot, sanitizer, anchors)
 *   dist/diagram-engine/mermaid.js   the Mermaid runtime (ELK, its own KaTeX)
 *   dist/diagram-engine/graphviz.js  @viz-js/viz (Emscripten, wasm inlined)
 *
 * The review page never carries any of them (tests/entry-assets.test.ts): the
 * review server serves them under content-hashed URLs and the page imports
 * the engine by URL only when a Markdown preview or a guide overview holds a
 * diagram fence. Run after the page build (`vite build` empties dist/).
 *
 * The engine shares React and ui's stateful modules with the page instead of
 * bundling copies (DIAGRAM_ENGINE_SHARED_MODULES): each import of one of them
 * becomes a module that reads the page's instance from the host object the
 * page installs before the import. The runtimes are fetched by the engine
 * from the host's `runtimeUrls`, so the page never names them either.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { build, normalizePath, transformWithEsbuild, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import {
  DIAGRAM_ENGINE_HOST_KEY,
  DIAGRAM_ENGINE_SHARED_MODULES,
} from '../../../packages/review-editor/utils/diagramEngineContract';

// Vite's module ids use `/` on every platform; every path compared with one
// goes through normalizePath, or nothing matches on Windows.
const here = normalizePath(import.meta.dir);
const repoRoot = normalizePath(path.resolve(here, '../../..'));
const uiRoot = normalizePath(path.join(repoRoot, 'packages/ui'));
const outDir = path.resolve(here, '../dist/diagram-engine');

const HOST = `globalThis[${JSON.stringify(DIAGRAM_ENGINE_HOST_KEY)}]`;
const VIRTUAL = '\0pn-diagram-host:';

const BARE_SHARED = new Set<string>(DIAGRAM_ENGINE_SHARED_MODULES.filter((key) => !key.startsWith('ui:')));
/** Absolute path of a ui file (no extension) → its shared key. */
const UI_SHARED = new Map<string, string>(
  DIAGRAM_ENGINE_SHARED_MODULES.filter((key) => key.startsWith('ui:')).map((key) => [normalizePath(path.join(uiRoot, key.slice(3))), key]),
);

const stripExt = (id: string) => id.replace(/\?.*$/, '').replace(/\.(tsx?|jsx?|mjs)$/, '');

/** Imports of the shared modules read the page's instances from the host. */
function hostModules(): Plugin {
  return {
    name: 'pn-diagram-host-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source.startsWith(VIRTUAL)) return source;
      if (BARE_SHARED.has(source)) return VIRTUAL + source;
      if (!importer || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return resolved;
      const key = UI_SHARED.get(stripExt(resolved.id));
      return key ? VIRTUAL + key : resolved;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const key = JSON.stringify(id.slice(VIRTUAL.length));
      // A CommonJS package's namespace (react) carries its exports on
      // `default`; an ES module's carries them directly. Both are merged so a
      // named import finds either. Named imports resolve against
      // `__pnHostModule` (Rollup's syntheticNamedExports).
      return {
        code: [
          `const host = ${HOST};`,
          `const ns = host && host.modules && host.modules[${key}];`,
          `if (!ns) throw new Error("Plannotator diagram engine: the page did not provide " + ${key});`,
          `const base = ns.default && (typeof ns.default === 'object' || typeof ns.default === 'function') ? ns.default : null;`,
          `export const __pnHostModule = Object.assign({}, base, ns);`,
          `export default ns.default;`,
        ].join('\n'),
        syntheticNamedExports: '__pnHostModule',
      };
    },
  };
}

/** The renderer slots' default `import('mermaid')` / `import('@viz-js/viz')`
 * become imports of the URLs the page hands over. Exactly one site each, or
 * the build fails (a moved import must not silently bundle a runtime). */
function runtimeUrls(): Plugin {
  const sites: Record<string, { runtime: 'mermaid' | 'graphviz'; pattern: RegExp }> = {
    [normalizePath(path.join(uiRoot, 'utils/mermaid.ts'))]: { runtime: 'mermaid', pattern: /(?<![`'"])import\(\s*['"]mermaid['"]\s*\)/g },
    [normalizePath(path.join(uiRoot, 'utils/graphviz.ts'))]: { runtime: 'graphviz', pattern: /(?<![`'"])import\(\s*['"]@viz-js\/viz['"]\s*\)/g },
  };
  const seen = new Set<string>();
  return {
    name: 'pn-diagram-runtime-urls',
    enforce: 'pre',
    transform(code, id) {
      const site = sites[id.replace(/\?.*$/, '')];
      if (!site) return null;
      const count = code.match(site.pattern)?.length ?? 0;
      if (count !== 1) this.error(`expected exactly one import of the ${site.runtime} runtime in ${id}, found ${count}`);
      seen.add(site.runtime);
      return code.replace(site.pattern, `import(/* @vite-ignore */ ${HOST}.runtimeUrls.${site.runtime})`);
    },
    buildEnd(error) {
      if (error) return;
      for (const runtime of ['mermaid', 'graphviz']) {
        if (!seen.has(runtime)) this.error(`the ${runtime} runtime import was never rewritten`);
      }
    },
  };
}

/** Code review never edits a diagram's source (no `onSave`), so the Source
 * pane and its CodeMirror (~280 KB) stay out of the engine. */
function noSourcePane(): Plugin {
  const pane = normalizePath(path.join(uiRoot, 'components/diagram/DiagramSourcePane'));
  const STUB = '\0pn-diagram-no-source-pane';
  return {
    name: 'pn-diagram-no-source-pane',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === STUB) return STUB;
      if (!importer || !source.includes('DiagramSourcePane')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && stripExt(resolved.id) === pane ? STUB : null;
    },
    load(id) {
      return id === STUB ? 'export const DiagramSourcePane = () => null;' : null;
    },
  };
}

/** The proof the sharing is complete. The engine must not carry a second
 * copy of a stateful ui module: the config store and its settings, cookie
 * storage, the theme registry, the identity and math slots, or any
 * repository module that defines a React context (its consumers would read
 * an empty copy, not the page's provider). The engine's own context
 * (anchorClaims) is provided and read inside the engine only. React and the
 * runtimes must not be bundled either. */
function guardBundle(): Plugin {
  const ownContexts = new Set([normalizePath(path.join(uiRoot, 'components/diagram/anchorClaims.ts'))]);
  const stateful = [
    'config/',
    'utils/storage.ts',
    'utils/themeRegistry.ts',
    'utils/identity.ts',
    'utils/generateIdentity.ts',
    'utils/math.ts',
    'components/ThemeProvider.tsx',
  ].map((entry) => normalizePath(path.join(uiRoot, entry)));
  return {
    name: 'pn-diagram-guard',
    generateBundle() {
      const problems: string[] = [];
      for (const id of this.getModuleIds()) {
        if (id.startsWith('\0')) continue;
        const file = id.replace(/\?.*$/, '');
        if (/[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?(?:mermaid|@viz-js|katex|react|react-dom|scheduler|@codemirror)[\\/]/.test(file)) {
          problems.push(`${file} (React and the runtimes come from the page and the runtime files)`);
          continue;
        }
        if (!file.startsWith(`${repoRoot}/`) || file.includes('/node_modules/')) continue;
        const rel = path.relative(repoRoot, file);
        if (stateful.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))) {
          problems.push(`${rel} (stateful: share it, DIAGRAM_ENGINE_SHARED_MODULES)`);
          continue;
        }
        if (ownContexts.has(file)) continue;
        let source = '';
        try {
          source = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        if (/\bcreateContext\s*[<(]/.test(source)) problems.push(`${rel} (defines a React context: share it, DIAGRAM_ENGINE_SHARED_MODULES)`);
      }
      if (problems.length > 0) this.error(`the diagram engine would carry its own copy of:\n  ${problems.join('\n  ')}`);
    },
  };
}

/** The runtimes are dependencies of packages/ui; resolve them from there. */
function runtimeFromUi(): Plugin {
  const importer = path.join(uiRoot, 'utils/mermaid.ts');
  return {
    name: 'pn-runtime-from-ui',
    resolveId(source, from, options) {
      if (source !== 'mermaid' && source !== '@viz-js/viz') return null;
      if (!from || !from.startsWith(here)) return null;
      return this.resolve(source, importer, { ...options, skipSelf: true });
    },
  };
}

/** Mermaid typesets `$$` labels through its own `import("katex")`. Here that
 * import goes to ui's mermaid-math-slot, which renders with the PAGE's math
 * renderer (shared `ui:utils/math`, filled by the page's math-eager), so the
 * runtime file carries no second KaTeX. */
function mermaidKatexFromPage(): Plugin {
  const slot = normalizePath(path.join(uiRoot, 'utils/mermaid-math-slot.ts'));
  return {
    name: 'pn-mermaid-katex-from-page',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source !== 'katex' || !importer) return null;
      return /[\\/]node_modules[\\/]mermaid[\\/]/.test(importer) ? slot : null;
    },
  };
}

/** Vite keeps whitespace in an ES library build; these files are served to
 * a browser, never consumed by another bundler, so minify them fully. */
function minifyChunks(): Plugin {
  return {
    name: 'pn-diagram-minify',
    async renderChunk(code, chunk) {
      const result = await transformWithEsbuild(code, chunk.fileName, { minify: true, format: 'esm', target: 'esnext', legalComments: 'none', charset: 'utf8' });
      return { code: result.code, map: null };
    },
  };
}

const common = {
  configFile: false as const,
  logLevel: 'warn' as const,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@plannotator/shared': path.join(repoRoot, 'packages/shared'),
      '@plannotator/ui': uiRoot,
    },
  },
};

async function buildOne(name: string, entry: string, plugins: PluginOption[]) {
  await build({
    ...common,
    root: here,
    plugins,
    build: {
      target: 'esnext',
      // Minified by minifyChunks (Vite keeps whitespace in an ES library).
      minify: false,
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 100_000_000,
      assetsInlineLimit: 100_000_000,
      lib: { entry, formats: ['es'], fileName: () => `${name}.js` },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await buildOne('engine', path.join(here, 'engine.tsx'), [hostModules(), runtimeUrls(), noSourcePane(), react(), guardBundle(), minifyChunks()]);
await buildOne('mermaid', path.join(here, 'runtime-mermaid.ts'), [runtimeFromUi(), mermaidKatexFromPage(), hostModules(), minifyChunks()]);
await buildOne('graphviz', path.join(here, 'runtime-graphviz.ts'), [runtimeFromUi(), minifyChunks()]);

for (const name of ['engine', 'mermaid', 'graphviz']) {
  const file = path.join(outDir, `${name}.js`);
  const bytes = readFileSync(file);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  console.log(`diagram-engine/${name}.js  ${(statSync(file).size / 1024).toFixed(1)} kB  ${hash}`);
}
