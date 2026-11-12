import path from 'node:path';
import type { Plugin } from 'vite';

const STUBS: Array<[target: string, stub: string]> = [
  ['packages/review-editor/components/ToolbarHost.tsx', 'viewer/stubs/ToolbarHost.tsx'],
  ['packages/ui/components/CommentPopover.tsx', 'viewer/stubs/CommentPopover.tsx'],
  ['packages/ui/utils/generateIdentity.ts', 'viewer/stubs/generateIdentity.ts'],
  ['packages/review-editor/components/InlineAnnotation.tsx', 'viewer/stubs/InlineAnnotation.tsx'],
  ['packages/review-editor/components/FileCommentBanner.tsx', 'viewer/stubs/FileCommentBanner.tsx'],
  ['packages/ui/components/OpenInAppButton.tsx', 'viewer/stubs/OpenInAppButton.tsx'],
];

export function readOnlyStubsPlugin(): Plugin {
  const root = path.resolve(__dirname, '../../..');
  const app = path.resolve(__dirname, '..');
  const map = new Map(STUBS.map(([target, stub]) => [path.join(root, target), path.join(app, stub)]));
  return {
    name: 'guides-show-read-only-stubs',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith('\0')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const stub = map.get(resolved.id.split('?')[0]);
      return stub ? { id: stub } : null;
    },
  };
}
