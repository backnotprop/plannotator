import React from 'react';

/**
 * Full-width skeleton section cards mirroring GuideSectionCard's two-column
 * layout — shown while a guide is generating and while a completed guide is
 * being fetched, so the page always reads as "sections are coming".
 */
export function GuideSectionSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="mt-6 space-y-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border/40 bg-card">
          <div className="md:grid md:grid-cols-[440px_minmax(0,1fr)]">
            <div className="space-y-3 border-b border-border/40 px-6 py-5 md:border-b-0 md:border-r">
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted/40" />
              <div className="h-3 w-28 animate-pulse rounded bg-muted/30" />
              <div className="space-y-2 pt-2">
                <div className="h-3 w-full animate-pulse rounded bg-muted/25" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-muted/25" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted/25" />
              </div>
              <div className="h-7 w-full animate-pulse rounded-md bg-muted/20" />
            </div>
            <div className="bg-muted/[0.07] px-4 py-4">
              <div className="h-[200px] animate-pulse rounded-lg bg-muted/20" style={{ animationDelay: `${i * 120}ms` }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
