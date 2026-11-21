import React, { useEffect, useState } from 'react';

/**
 * A part of the page that a code-split build loads as its own chunk (a
 * diagram, an HTML or SVG embed, the diagram popout, the Markdown preview)
 * can fail to arrive: a flaky link, a server that has stopped, or a tab older
 * than the server's build, whose chunk names no longer exist. React.lazy then
 * throws, and without a boundary React unmounts the whole app, taking the
 * user's unsent comments and edits off the screen with it.
 *
 * This boundary keeps the failure in place of that one part. The caller's
 * `fallback` gets a small notice with a Reload action (`LazyLoadNotice`) and
 * draws it beside whatever it can still show, usually the block's source.
 * The rest of the page stays mounted. Nothing reloads by itself.
 *
 * With no error it renders its children and nothing else.
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

/**
 * The URL of the chunk a failed dynamic import asked for, when the error names
 * one on this page's origin. Chromium and Firefox put it in the message
 * ("Failed to fetch dynamically imported module: http://…/assets/x.js");
 * Safari does not, and then the notice says the general thing.
 */
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

/**
 * One quiet line: why the part is missing, and Reload. A chunk the server
 * answers with 404 is a tab older than the server's build (the server was
 * updated on the same port), so the line says that instead. Finding out costs
 * one HEAD request, made only after a failure.
 */
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
      {/* The hit area is padding cancelled by a negative margin, so the line
          looks the same: 24px tall everywhere, 44px on a touch screen. On
          touch it grows upward into the block's top margin, never down over
          the source under it. */}
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
