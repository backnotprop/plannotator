/**
 * Keeps `@pierre/diffs`' lazy language and theme catalogs out of its highlight
 * worker. Wired as a WORKER plugin (`worker.plugins`), never a main-build one:
 * the main thread needs these catalogs.
 *
 * Since 1.6, Pierre's worker (`@pierre/diffs/worker/worker.js`) keeps three
 * dynamic imports it never runs in a worker:
 *
 *   - `shiki/langs` (every Shiki grammar), behind `resolveLanguage`, which
 *     throws in a worker first ("Languages must be pre-resolved on the main
 *     thread and passed to the worker");
 *   - `@pierre/highlights/themes/loader` and `@pierre/theming/themes` (every
 *     Zed and TextMate theme), behind the theme resolver's fallback loader,
 *     which throws in a worker first ("Themes must be pre-resolved on the main
 *     thread").
 *
 * Plannotator builds the worker with `inlineDynamicImports` (the single-file
 * apps inline it as a string in the entry chunk), so those catalogs were
 * inlined too: about 11 MB more in the review app's entry chunk, which loads
 * up front. 1.5.2's worker had none of them. Each id resolves to a module
 * whose exports (`bundledLanguages`, `themes`) throw on any use, so a future
 * Pierre that needs one in the worker fails loudly instead of rendering wrong.
 * The module itself must evaluate cleanly: `inlineDynamicImports` runs every
 * inlined module when the worker starts.
 *
 * A plain object, not typed against `vite`: apps/guides-show's tsconfig checks
 * its Vite config, and `vite` does not resolve from this root folder.
 */
const CATALOGS = new Set(['shiki/langs', '@pierre/highlights/themes/loader', '@pierre/theming/themes']);
const PREFIX = '\0diffs-worker-catalog:';

export function diffsWorkerCatalogs() {
  return {
    name: 'plannotator:diffs-worker-catalogs',
    enforce: 'pre' as const,
    resolveId(id: string) {
      return CATALOGS.has(id) ? PREFIX + id : null;
    },
    load(id: string) {
      if (!id.startsWith(PREFIX)) return null;
      const message = `${id.slice(PREFIX.length)} is not bundled in Plannotator's highlight worker: Pierre resolves languages and themes on the main thread (build/diffs-worker-catalogs.ts).`;
      return [
        `const fail = () => { throw new Error(${JSON.stringify(message)}); };`,
        'const unavailable = new Proxy({}, { get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });',
        'export const bundledLanguages = unavailable;',
        'export const themes = unavailable;',
        '',
      ].join('\n');
    },
  };
}
