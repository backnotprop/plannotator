import React, { useCallback, useId, useSyncExternalStore } from 'react';
import { ListFilter } from 'lucide-react';
import type { ReviewFileFilterInput } from '../hooks/useReviewFileFilter';

const FIELD = 'h-7 min-w-0 rounded border-0 bg-foreground/[0.06] px-[7px] font-mono text-[13px] text-foreground placeholder:text-muted-foreground/50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-0 focus-visible:outline-primary/50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base';

export function ReviewFileFilterControls({ input, active, renderRow, shown, total }: {
  input: ReviewFileFilterInput;
  active: boolean;
  renderRow?: (toggle: React.ReactNode) => React.ReactNode;
  shown?: number;
  total?: number;
}) {
  const { draft, open } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const id = useId();
  const showSummary = active && !!shown && total !== undefined;
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
      title={active && shown !== undefined && total !== undefined ? `Filter files: ${shown} of ${total} shown` : 'Filter files'}
      onClick={input.toggle}
      className={`relative col-start-2 row-start-1 grid size-7 shrink-0 place-items-center self-center rounded-md focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:size-11 ${
        open || active ? 'bg-primary/15 text-primary hover:bg-primary/20' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      <ListFilter className="size-4" aria-hidden="true" />
      {active && <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" aria-hidden="true" />}
    </button>
  );

  return (
    <>
      {renderRow ? renderRow(toggle) : toggle}
      {(open || showSummary) && (
        <div id={id} className={`col-span-full row-start-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 pe-1.5 text-xs text-muted-foreground ${open ? 'mt-2 mb-3' : 'mt-1.5 mb-1'}`}>
          {open && (['include', 'exclude'] as const).map((kind) => (
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
                className={FIELD}
              />
            </React.Fragment>
          ))}
          {showSummary && (
            <div className="col-span-full flex items-center gap-2" data-review-file-filter-summary="">
              <span role="status" className="tabular-nums">{shown} of {total} files</span>
              <button type="button" onClick={input.clear} className="text-primary hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-primary rounded-sm">Clear</button>
            </div>
          )}
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

/** Stop native events before they reach the shadow tree's focus handlers. */
export function ReviewTreeSearchAccessory({ children }: { children: React.ReactNode }) {
  return <div className="contents" ref={isolateTreeEvents}>{children}</div>;
}

function isolateTreeEvents(element: HTMLDivElement | null) {
  if (!element) return;
  const stop = (event: Event) => event.stopPropagation();
  element.addEventListener('focusin', stop);
  element.addEventListener('keydown', stop);
  return () => {
    element.removeEventListener('focusin', stop);
    element.removeEventListener('keydown', stop);
  };
}
