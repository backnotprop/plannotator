import {
  dirnameBrowserPath,
  normalizeBrowserPath,
} from '@plannotator/shared/browser-paths';

export {
  dirnameBrowserPath,
  normalizeBrowserPath,
  pathIsInsideDir,
} from '@plannotator/shared/browser-paths';

export interface SourceWatchSubscription {
  query: string;
  dirs: string[];
  key: string;
}

export function buildSourceWatchSubscription(paths: string[]): SourceWatchSubscription {
  const normalizedPaths = [...new Set(paths.map(normalizeBrowserPath).filter(Boolean))].sort();
  const params = new URLSearchParams();
  for (const path of normalizedPaths) params.append('filePath', path);

  return {
    query: params.toString(),
    dirs: [...new Set(normalizedPaths.map(dirnameBrowserPath))].sort(),
    key: normalizedPaths.join('\n'),
  };
}
