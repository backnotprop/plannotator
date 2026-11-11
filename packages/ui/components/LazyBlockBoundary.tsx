import React, { useEffect, useState } from 'react';

/**
 * React.lazy then throws, and without a boundary React unmounts the whole app, taking the user's
 * unsent comments and edits off the screen with it.
 */
export class LazyBlockBoundary extends React.Component<
  { fallback: (notice: React.ReactNode) => React.ReactNode; children: React.ReactNode },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown) {
    console.error('[plannotator] A part of the page could not load:', error);
  }

  render() {
    if (this.state.failed) return this.props.fallback(<LazyLoadNotice error={this.state.error} />);
    return this.props.children;
  }
}

/** The URL of the chunk a failed dynamic import asked for, when the error names one on this page's origin. */
export function failedChunkUrl(error: unknown): string | null {
  if (typeof window === 'undefined') return null;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /(https?:\/\/[^\s'"]+|\/assets\/[^\s'"]+)/.exec(message);
  if (!match) return null;
  try {
    const url = new URL(match[1], window.location.href);
    return url.origin === window.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

/** One quiet line: why the part is missing, and Reload. */
export const LazyLoadNotice: React.FC<{ error: unknown }> = ({ error }) => {
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    const url = failedChunkUrl(error);
    if (url === null || typeof fetch !== 'function') return;
    let live = true;
    fetch(url, { method: 'HEAD', cache: 'no-store' }).then(
      (response) => {
        if (live && response.status === 404) setUpdated(true);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [error]);

  return (
    <div
      role="status"
      data-lazy-load-failed={updated ? 'updated' : ''}
      className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
    >
      <span>{updated ? 'This page was updated.' : "Couldn't load this view."}</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="relative -mx-1 -my-1 px-1 py-1 font-medium text-foreground underline-offset-2 hover:underline [@media(pointer:coarse)]:-mb-1.5 [@media(pointer:coarse)]:-mt-[22px] [@media(pointer:coarse)]:pb-1.5 [@media(pointer:coarse)]:pt-[22px]"
      >
        {updated ? 'Reload to see this' : 'Reload'}
      </button>
    </div>
  );
};
