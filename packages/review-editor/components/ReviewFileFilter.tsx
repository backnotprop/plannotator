import React, { useCallback, useId, useSyncExternalStore } from 'react';
import { ListFilter } from 'lucide-react';
import type { ReviewFileFilterInput } from '../hooks/useReviewFileFilter';

export function ReviewFileFilterControls({ input, active, children }: {
  input: ReviewFileFilterInput;
  active: boolean;
  children: (toggle: React.ReactNode) => React.ReactNode;
}) {
  const { draft, open } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const id = useId();
  const handleFieldChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = event.currentTarget;
    if (name === 'include' || name === 'exclude') input.updateField(name, value);
  }, [input]);

  const toggle = (
    <button
      type="button"
      aria-label={active ? 'Filter files (active)' : 'Filter files'}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      title="Filter files"
      onClick={input.toggle}
      className={`relative grid size-7 shrink-0 place-items-center rounded-md hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary ${active ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
    >
      <ListFilter className="size-4" aria-hidden="true" />
      {active && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
    </button>
  );

  return (
    <>
      {children(toggle)}
      {open && (
        <div id={id} className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {(['include', 'exclude'] as const).map((kind) => (
            <React.Fragment key={kind}>
              <label htmlFor={`${id}-${kind}`} className="capitalize">{kind}</label>
              <input
                id={`${id}-${kind}`}
                name={kind}
                type="text"
                value={draft[kind]}
                placeholder={kind === 'include' ? 'src/**' : '**/*.md'}
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                onChange={handleFieldChange}
                className="h-7 min-w-0 rounded-md border border-border bg-background px-2 font-mono text-foreground focus-visible:outline-2 focus-visible:outline-primary"
              />
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
}

export function NoMatchingReviewFiles({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-2 py-6 text-center text-xs text-muted-foreground">
      <div role="status">No files match</div>
      <button type="button" onClick={onClear} className="text-primary underline underline-offset-2">Clear filter</button>
    </div>
  );
}
