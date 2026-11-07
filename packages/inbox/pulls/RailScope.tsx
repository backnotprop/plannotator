/**
 * The PR page rail's Changes | All files (the owner's take A on #2639): the review app's switch over its file tree
 * (review-editor's `ScopeSwitch`, its classes and words), at the head of the rail. Changes is the PR's own files
 * (`RailTree`); All files the repository at the head the patch on screen was read at, from the Inbox's
 * `/api/inbox/pulls/repo-files`, drawn by the review app's own tree (`guide/PullRepoParts.tsx`).
 */
import type { TreeScope } from '@plannotator/ui/hooks/useTreeScope';
import { inboxUrl } from '../inboxUrl';

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background';

const pill = (active: boolean) =>
  `h-6 flex items-center gap-1 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors ${FOCUS} ${
    active ? 'bg-[var(--sidebar-fill-strong)] text-foreground' : 'text-muted-foreground hover:bg-[var(--sidebar-fill)] hover:text-foreground'
  }`;

/** The review app's Changes | All files pills: Changes with its count, All files without. */
export function RailScopeSwitch({ scope, changed, onSelect }: { scope: TreeScope; changed: number; onSelect: (scope: TreeScope) => void }) {
  return (
    <div className="flex min-w-0 items-center ib-prp-scope" role="group" aria-label="Files shown in the tree" data-tree-scope-switch="">
      <button
        type="button"
        aria-pressed={scope === 'changes'}
        onClick={() => onSelect('changes')}
        data-tree-scope="changes"
        title="The files this review changes"
        className={`flex-shrink-0 px-2 ${pill(scope === 'changes')}`}
      >
        <span>Changes</span>
        <span className="tabular-nums text-[11px] font-normal text-muted-foreground">{changed.toLocaleString('en-US')}</span>
      </button>
      <button
        type="button"
        aria-pressed={scope === 'all'}
        onClick={() => onSelect('all')}
        data-tree-scope="all"
        title="Every file of the repository at the revision the diff reads"
        className={`relative min-w-0 pl-1.5 pr-3 ${pill(scope === 'all')}`}
      >
        <span className="truncate">All files</span>
      </button>
    </div>
  );
}

/**
 * The review app's reads (`/api/repo-files?…`, `/api/repo-file?…`, as its `useRepoFiles` and `useRepoFileText` ask)
 * sent to the Inbox's routes for one PR, the rest of the query as it was. Anything else is refused, never fetched.
 */
export function pullRepoFetch(key: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const asked = /^\/api\/(repo-files|repo-file)\?(.*)$/.exec(url);
    if (!asked) return Promise.reject(new Error('The repository could not be listed.'));
    return globalThis.fetch(inboxUrl(`/pulls/${asked[1]}`, `key=${encodeURIComponent(key)}&${asked[2]}`), init);
  }) as typeof fetch;
}
