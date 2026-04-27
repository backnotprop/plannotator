import React, { useState, useCallback, useEffect } from 'react';
import { SearchableSelect } from '@plannotator/ui/components/SearchableSelect';
import { PullRequestIcon } from '@plannotator/ui/components/PullRequestIcon';
import type { PRListItem } from '@plannotator/shared/pr-provider';

type PRItem = PRListItem;

const stateColors: Record<PRItem['state'], string> = {
  open: 'text-success',
  merged: 'text-accent',
  closed: 'text-muted-foreground/60',
};

const stateLabels: Record<PRItem['state'], string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

interface PRSelectorProps {
  mrNumberLabel: string;
  prTitle: string;
  currentNumber: number;
  onSelect: (url: string) => void;
  disabled?: boolean;
}

export function PRSelector({ mrNumberLabel, prTitle, currentNumber, onSelect, disabled }: PRSelectorProps) {
  const [prs, setPrs] = useState<PRItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const selectedId = String(currentNumber);

  useEffect(() => { setPrs([]); setFetched(false); }, [currentNumber]);

  const handleOpen = useCallback((open: boolean) => {
    if (open && !fetched) {
      setLoading(true);
      fetch('/api/pr-list')
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch');
          return res.json();
        })
        .then((data: { prs?: PRItem[] }) => {
          setPrs(data.prs ?? []);
          setFetched(true);
        })
        .catch(() => setPrs([]))
        .finally(() => setLoading(false));
    }
  }, [fetched]);

  return (
    <SearchableSelect
      items={prs}
      selectedId={selectedId}
      onSelect={(item) => {
        if (item.number !== currentNumber) {
          onSelect(item.url);
        }
      }}
      filterFn={(item, q) => {
        const lower = q.toLowerCase();
        return (
          item.title.toLowerCase().includes(lower) ||
          String(item.number).includes(lower) ||
          item.author.toLowerCase().includes(lower)
        );
      }}
      placeholder="Search pull requests..."
      emptyMessage={loading ? 'Loading...' : 'No pull requests found'}
      align="start"
      width="w-80"
      onOpenChange={handleOpen}
      renderTrigger={({ open }) => (
        <button
          type="button"
          disabled={disabled}
          className="text-xs text-accent/80 hover:text-accent inline-flex items-center gap-1 truncate max-w-[340px] rounded px-1 -mx-1 transition-colors hover:bg-muted/20 disabled:opacity-60 disabled:cursor-wait"
          title={prTitle}
        >
          <PullRequestIcon className="w-3 h-3 flex-shrink-0" />
          <span className="font-mono whitespace-nowrap">{mrNumberLabel}</span>
          <span className="truncate hidden md:inline">{prTitle}</span>
          <svg
            className={`w-2.5 h-2.5 flex-shrink-0 text-muted-foreground/30 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
      renderItem={(item, { isSelected }) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className={`font-mono ${isSelected ? 'text-foreground font-medium' : 'text-foreground/80'}`}>
              #{item.number}
            </span>
            <span className={`text-[10px] ${stateColors[item.state]}`}>
              {stateLabels[item.state]}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground/60">
            <span className="truncate">{item.title}</span>
            <span className="flex-shrink-0">@{item.author}</span>
          </div>
        </div>
      )}
    />
  );
}
