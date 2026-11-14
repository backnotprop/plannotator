import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { SavedGuideListEntry } from '@plannotator/shared/guide';
import {
  GUIDE_SEARCH_THRESHOLD,
  groupSavedGuides,
  guideMismatchText,
  guideProgressText,
  savedAgo,
} from '../../utils/guidesListModel';
import { GuideRowMenu } from './GuideRowMenu';

function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      autoFocus
      value={value}
      maxLength={200}
      aria-label="Guide title"
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(value)}
      className="block w-full rounded border border-border bg-background px-1 text-[13px] leading-5 text-foreground outline-none focus:border-ring"
    />
  );
}

function GuideRow({
  entry,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: SavedGuideListEntry;
  onOpen: () => void;
  onRename: (title: string) => Promise<string | null>;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = guideMismatchText(entry);
  const meta = [
    (entry.where ?? 'other') === 'other' ? entry.label : null,
    guideProgressText(entry.progress),
  ].filter(Boolean).join(' · ');
  return (
    <li
      className="group flex items-start gap-1 rounded-md px-1 py-1.5 hover:bg-muted/50 focus-within:bg-muted/50"
      data-saved-guide={entry.id}
      data-guide-where={entry.where ?? 'other'}
    >
      <div className="min-w-0 flex-1">
        {renaming ? (
          <RenameField
            initial={entry.title}
            onDone={async (title) => {
              setRenaming(false);
              if (title === null || title.trim() === entry.title) return;
              setError(await onRename(title));
            }}
          />
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className="block w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={entry.title}
          >
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{entry.title}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{savedAgo(entry.savedAt)}</span>
            </span>
            {meta && <span className="block truncate text-[12px] text-muted-foreground" data-guide-progress="">{meta}</span>}
            {mismatch && <span className="block truncate text-[12px] text-muted-foreground" data-guide-mismatch="">{mismatch}</span>}
          </button>
        )}
        {error && <p className="text-[12px] text-muted-foreground" role="alert">{error}</p>}
      </div>
      <GuideRowMenu id={entry.id} title={entry.title} onRename={() => setRenaming(true)} onDelete={onDelete} />
    </li>
  );
}

export function GuidesList({
  guides,
  prMode,
  onOpen,
  onRename,
  onDelete,
  onStart,
}: {
  guides: SavedGuideListEntry[] | null;
  prMode: boolean;
  onOpen: (savedJobId: string) => void;
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string) => void;
  onStart?: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchable = (guides?.length ?? 0) > GUIDE_SEARCH_THRESHOLD;
  const groups = useMemo(
    () => groupSavedGuides(guides ?? [], { prMode, query: searchable ? query : '' }),
    [guides, prMode, query, searchable],
  );
  if (guides === null) return null;

  return (
    <section aria-label="Guided Reviews" className="mt-2 border-t border-border/60" data-guides-list="">
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <h3 className="text-[12px] font-medium text-muted-foreground">Guided Reviews</h3>
        {guides.length > 0 && <span className="text-[12px] tabular-nums text-muted-foreground">{guides.length}</span>}
      </div>
      {guides.length === 0 ? (
        <div className="px-4 pb-2" data-guides-empty="">
          <p className="text-[12px] leading-5 text-muted-foreground">
            A guided review orders this change into short chapters, the core of it first, with the code beside each one.
          </p>
          {onStart && (
            <button
              type="button"
              onClick={onStart}
              className="mt-2 inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-[12px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Start a Guided Review
            </button>
          )}
        </div>
      ) : (
        <>
          {searchable && (
            <label className="mx-3 mb-1 flex h-7 items-center gap-2 rounded-md border border-border/60 bg-background px-2 focus-within:border-ring">
              <Search size={12} className="shrink-0 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search guides"
                aria-label="Search guides"
                className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
          )}
          {groups.length === 0 && <p className="px-4 py-2 text-[12px] text-muted-foreground">No guide matches “{query.trim()}”.</p>}
          {groups.map((group) => (
            <div key={group.key} data-guide-group={group.key}>
              <h4 className="px-4 pb-0.5 pt-2 text-[12px] text-muted-foreground">{group.label}</h4>
              <ul className="px-3">
                {group.entries.map((entry) => (
                  <GuideRow
                    key={entry.id}
                    entry={entry}
                    onOpen={() => onOpen(`saved:${entry.id}`)}
                    onRename={(title) => onRename(entry.id, title)}
                    onDelete={() => onDelete(entry.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
