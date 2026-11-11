import type { TreeScope } from '@plannotator/ui/hooks/useTreeScope';
import { inboxUrl } from '../inboxUrl';

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-background';

const pill = (active: boolean) =>
  `h-6 flex items-center gap-1 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors ${FOCUS} ${
    active ? 'bg-[var(--sidebar-fill-strong)] text-foreground' : 'text-muted-foreground hover:bg-[var(--sidebar-fill)] hover:text-foreground'
  }`;

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

/** Maps the review app's repo-file reads onto the Inbox's routes for one PR. Anything else is refused, never fetched. */
export function pullRepoFetch(key: string): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const asked = /^\/api\/(repo-files|repo-file)\?(.*)$/.exec(url);
    if (!asked) return Promise.reject(new Error('The repository could not be listed.'));
    return globalThis.fetch(inboxUrl(`/pulls/${asked[1]}`, `key=${encodeURIComponent(key)}&${asked[2]}`), init);
  }) as typeof fetch;
}
