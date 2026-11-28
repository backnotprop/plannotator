import { useCallback, useEffect, useState } from 'react';
import type { SavedGuideListEntry } from '@plannotator/shared/guide';

export interface SavedGuides {
  guides: SavedGuideListEntry[] | null;
  refresh: () => void;
  rename: (id: string, title: string) => Promise<string | null>;
  remove: (id: string) => void;
}

export function useSavedGuides(enabled: boolean, refreshKey: unknown): SavedGuides {
  const [guides, setGuides] = useState<SavedGuideListEntry[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch('/api/guides')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        if (alive && Array.isArray(data)) setGuides(data as SavedGuideListEntry[]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled, nonce, refreshKey]);

  const rename = useCallback(async (id: string, title: string) => {
    const next = title.trim();
    if (!next) return 'A title cannot be empty.';
    const previous = guides;
    setGuides((list) => list?.map((g) => (g.id === id ? { ...g, title: next } : g)) ?? list);
    try {
      const res = await fetch(`/api/guides/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setGuides(previous);
      return data.error ?? 'Could not rename the guide.';
    } catch {
      setGuides(previous);
      return 'Could not rename the guide.';
    }
  }, [guides]);

  const remove = useCallback((id: string) => {
    setGuides((list) => list?.filter((g) => g.id !== id) ?? list);
    void fetch(`/api/guides/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  return { guides, refresh, rename, remove };
}
