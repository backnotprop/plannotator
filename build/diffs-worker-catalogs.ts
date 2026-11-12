const CATALOGS = new Set(['shiki/langs', '@pierre/theming/themes']);
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
