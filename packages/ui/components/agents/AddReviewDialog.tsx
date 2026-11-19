import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';

interface CatalogSkill {
  name: string;
  root: string;
  sourcePath: string;
  enabled: boolean;
}

export function AddReviewDialog({
  onClose,
  onEnabled,
}: {
  onClose: () => void;
  onEnabled: (name: string) => void;
}) {
  const [skills, setSkills] = useState<CatalogSkill[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/agents/skills')
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSkills(Array.isArray(d.skills) ? d.skills : []);
      })
      .catch(() => {
        if (alive) setSkills([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? [])
      .filter((s) => !s.enabled)
      .filter((s) => (q ? s.name.toLowerCase().includes(q) : true));
  }, [skills, query]);

  const enable = async (name: string) => {
    setBusy(name);
    setError(null);
    try {
      const res = await fetch('/api/agents/review-skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? 'Could not add review.');
      }
      onEnabled(name);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add review.');
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-xl bg-card shadow-[var(--card-shadow)] ring-1 ring-border/20">
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
          <span className="text-[12px] font-medium text-foreground">Add a review</span>
          <button type="button" onClick={onClose} className="text-muted-foreground/50 hover:text-foreground">
            <X size={13} />
          </button>
        </div>

        <div className="border-b border-border/40 p-2">
          <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-surface-1/30 px-2.5 py-1.5">
            <Search className="shrink-0 text-muted-foreground/40" size={12} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter your skills"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground/90 outline-none placeholder:text-muted-foreground/40"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {skills === null ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground/40">
              <Loader2 className="animate-spin" size={14} />
            </div>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-8 text-center text-[11px] text-muted-foreground/40">
              {query ? 'No matching skills.' : 'No skills left to add.'}
            </p>
          ) : (
            candidates.map((s) => (
              <button
                key={`${s.root}:${s.name}`}
                type="button"
                disabled={busy !== null}
                onClick={() => enable(s.name)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-1/50 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">{s.name}</span>
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/40">{s.root}</span>
                {busy === s.name ? <Loader2 className="shrink-0 animate-spin" size={11} /> : <Plus className="shrink-0 text-muted-foreground/40" size={11} />}
              </button>
            ))
          )}
        </div>

        {error && <p className="border-t border-border/40 px-3 py-2 text-[10px] text-red-500">{error}</p>}
      </div>
    </div>
  );
}
