/**
 * A part of the window that throws while it draws fails alone. Without a
 * boundary React unmounts the whole root on a render error, and the person is
 * left with a blank page and nothing to report (the Firefox "+" report,
 * 2026-11-24). Around a region (a diff, a thread pane, the guide reader, an
 * app's root) this shows, in the region's place, what happened and the ways
 * out: Try again (the region mounts afresh), Reload, Copy error, and, where the
 * host can close the region (a thread pane), a way back to the list.
 *
 * Copy error copies the error's name, message and stack as the browser gives
 * them, the region's name, the app's version and the browser. A message can
 * quote what the page held (a line of a diff, a file's path), and a stack names
 * the page's addresses: each address keeps its origin, path and line:column,
 * and loses its query and hash (`stripAddressQueries`).
 *
 * Reload first sends the saves that wait for a pause in typing
 * (`utils/beforeReload.ts`). An open comment box's words are kept in memory
 * only, so the notice never says the person's work is saved.
 *
 * The error counts as an uncaught error for the page (`reportError`), so a
 * browser test that fails on `pageerror` still fails on one, and the console
 * shows it once: an app's root passes `onCaughtRenderError` to `createRoot`, so
 * React does not log a second copy of an error a region caught.
 *
 * Under React's act environment (the DOM tests) the boundary lets the error
 * through, so a test that draws something broken still fails as it did; a test
 * of the boundary itself turns catching on (`catchRenderErrorsInTests`).
 *
 * A browser proof can make a region fail on purpose: it puts the region's name
 * in `window.__plannotatorBreakRegionForTests` (an init script, before the
 * page's own code). Nothing in the page or its address sets it.
 */
import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';
import { reloadAfterFlush } from '../utils/beforeReload';
import { pageBuild } from '../utils/pageBuild';

export interface RegionBoundaryProps {
  /** The region, in the copied report ("Diff", "Thread pane"). */
  name: string;
  children: ReactNode;
  /** Classes for the box the notice draws in, so it takes the region's place (a pane). */
  className?: string;
  /** An app's root: the notice in the middle of the page. */
  page?: boolean;
  /** A failed region tries again by itself when this changes (another thread opens in the pane). */
  resetKey?: unknown;
  /**
   * Try again calls this before the region mounts afresh: the host clears what it holds for the region that can make
   * it fail again (the selection a diff's "+" set, kept above the diff).
   */
  onRetry?: () => void;
  /** A region the host can close (a thread pane): a fourth button, `closeLabel`, closes it. */
  onClose?: () => void;
  /** The close button's words, as the host's own back control says them ("Back to Inbox"). */
  closeLabel?: string;
}

let catchInTests = false;

/** Tests of a boundary: catch under React's act environment too. Returns the restore. */
export function catchRenderErrorsInTests(): () => void {
  const was = catchInTests;
  catchInTests = true;
  return () => {
    catchInTests = was;
  };
}

const actEnvironment = () => (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT === true;

export function RegionBoundary(props: RegionBoundaryProps) {
  if (actEnvironment() && !catchInTests) return <>{props.children}</>;
  return <Boundary {...props} />;
}

/**
 * For `createRoot`'s `onCaughtError` in an app's root: React's own console line for an error a region caught is left
 * out (the region's `reportError` already puts it in the console once); any other caught error is logged as React does.
 */
export function onCaughtRenderError(error: unknown, info: { errorBoundary?: unknown }): void {
  if (info.errorBoundary instanceof Boundary) return;
  console.error(error);
}

/** A browser proof's switch (the header): the region named there throws as it draws. */
function Tripwire({ name }: { name: string }) {
  if ((globalThis as { __plannotatorBreakRegionForTests?: unknown }).__plannotatorBreakRegionForTests === name) {
    throw new Error(`${name}: failed on purpose for a browser proof`);
  }
  return null;
}

interface BoundaryState {
  error: unknown;
  failed: boolean;
  /** What had focus when the region threw: still in the page afterwards, it was not in the region. */
  focused: Element | null;
}

class Boundary extends React.Component<RegionBoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, failed: false, focused: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    // Before React takes the region's nodes away: what has focus now.
    return { error, failed: true, focused: typeof document === 'undefined' ? null : document.activeElement };
  }

  componentDidCatch(error: unknown) {
    // The page's own uncaught-error report (the console, devtools, a browser test's `pageerror`), as an unmounted
    // root made it. The one console line: React's own is left out by `onCaughtRenderError`.
    if (!actEnvironment() && typeof globalThis.reportError === 'function') {
      try {
        globalThis.reportError(error);
      } catch {
        // Nothing more to tell.
      }
    }
  }

  componentDidUpdate(previous: RegionBoundaryProps) {
    if (this.state.failed && !Object.is(previous.resetKey, this.props.resetKey)) this.setState({ error: null, failed: false, focused: null });
  }

  private tryAgain = () => {
    this.props.onRetry?.();
    this.setState({ error: null, failed: false, focused: null });
  };

  render() {
    if (!this.state.failed) {
      return (
        <>
          <Tripwire name={this.props.name} />
          {this.props.children}
        </>
      );
    }
    const { focused } = this.state;
    return (
      <div className={this.props.page ? 'pn-rf-page' : this.props.className}>
        <RegionFailed
          name={this.props.name}
          error={this.state.error}
          focusWasIn={() => !!focused && focused !== document.body && !focused.isConnected}
          onTryAgain={this.tryAgain}
          close={this.props.onClose ? { label: this.props.closeLabel ?? 'Close', onClose: this.props.onClose } : null}
        />
      </div>
    );
  }
}

function appVersion(): string {
  return pageBuild() || 'unknown';
}

/** An address with a query or a hash (any scheme, `blob:http:` too), up to a space, a quote or a bracket. */
const ADDRESS_WITH_QUERY = /((?:[a-z][a-z0-9+.-]*:)+\/\/[^\s()?#'"<>]*)([?#][^\s()'"<>]*)/gi;

/**
 * Every address in `text` without its query and hash: origin, path and the line:column a stack frame puts after it
 * (`review.js?v=3#top:10:5` → `review.js:10:5`) stay.
 */
export function stripAddressQueries(text: string): string {
  return text.replace(ADDRESS_WITH_QUERY, (_match, address: string, tail: string) => address + (/(?::\d+){1,2}$/.exec(tail)?.[0] ?? ''));
}

/** What Copy error copies: the error as the browser tells it (addresses without their queries), where, the version and the browser. */
export function renderErrorReport(error: unknown, where: string, version: string = appVersion(), userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const err = error instanceof Error ? error : null;
  const head = err ? `${err.name}: ${err.message}` : String(error);
  const stack = (err?.stack ?? '').trimEnd();
  // V8 starts the stack with the name and message; Firefox and Safari give the frames only.
  const body = !stack ? head : stack.startsWith(head) ? stack : `${head}\n${stack}`;
  return `${stripAddressQueries(body)}\n\nWhere: ${where}\nPlannotator ${version}\n${userAgent}`;
}

/**
 * The notice's own look, in a sheet it adds to the page itself. An app's root box is drawn when the app failed before
 * its theme was set (the theme's tokens, `--background` and the rest, come from a class the app's ThemeProvider puts
 * on <html>), and it cannot lean on classes the failed app would have drawn. So it reads the theme's tokens where they
 * are set, and falls back to Plannotator's default palette, light or dark as the system is, where they are not.
 *
 * On a phone a closable part's four buttons do not fit one row at 360 px: Reload goes (the browser's own reload is
 * there), so Try again, Copy error and the way back stay on one row.
 */
const STYLE_ID = 'pn-region-failed-style';
const STYLE = `
.pn-rf, .pn-rf-page {
  --pn-rf-bg: var(--background, oklch(0.97 0.005 260));
  --pn-rf-fg: var(--foreground, oklch(0.18 0.02 260));
  --pn-rf-muted: var(--muted, oklch(0.92 0.01 260));
  --pn-rf-muted-fg: var(--muted-foreground, oklch(0.40 0.02 260));
  --pn-rf-border: var(--border, oklch(0.88 0.01 260));
  --pn-rf-icon: oklch(0.666 0.179 58.318);
}
@media (prefers-color-scheme: dark) {
  .pn-rf, .pn-rf-page {
    --pn-rf-bg: var(--background, oklch(0.15 0.02 260));
    --pn-rf-fg: var(--foreground, oklch(0.90 0.01 260));
    --pn-rf-muted: var(--muted, oklch(0.26 0.02 260));
    --pn-rf-muted-fg: var(--muted-foreground, oklch(0.72 0.02 260));
    --pn-rf-border: var(--border, oklch(0.35 0.02 260));
    --pn-rf-icon: oklch(0.828 0.189 84.429);
  }
}
.pn-rf-page { box-sizing: border-box; display: flex; min-height: 100dvh; align-items: center; justify-content: center; padding: 24px; background: var(--pn-rf-bg); }
.pn-rf { display: flex; gap: 10px; padding: 12px 14px; text-align: left; font-family: var(--font-sans, 'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif); font-size: 12.5px; line-height: 1.375; color: var(--pn-rf-fg); }
.pn-rf-icon { flex: none; margin-top: 2px; color: var(--pn-rf-icon); }
.pn-rf-body { min-width: 0; flex: 1 1 0%; }
.pn-rf-title { font-weight: 600; color: var(--pn-rf-fg); }
.pn-rf-detail { margin-top: 2px; color: var(--pn-rf-muted-fg); }
.pn-rf-row { margin-top: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.pn-rf-btn { box-sizing: border-box; height: 28px; margin: 0; padding: 0 10px; border: 1px solid var(--pn-rf-border); border-radius: calc(var(--radius, 0.625rem) - 2px); background: var(--pn-rf-bg); color: var(--pn-rf-fg); font: inherit; font-size: 11.5px; font-weight: 500; line-height: 1; white-space: nowrap; cursor: pointer; }
@media (hover: hover) { .pn-rf-btn:hover { background: var(--pn-rf-muted); } }
@media (max-width: 480px) {
  .pn-rf { gap: 8px; padding: 12px 6px; }
  .pn-rf-row { gap: 4px 8px; }
  .pn-rf-btn { padding: 0 8px; }
  .pn-rf-row[data-closable] [data-region-reload] { display: none; }
}
`;

/** The sheet, once per page, before the notice is first painted. */
function useNoticeStyle(): void {
  useLayoutEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const sheet = document.createElement('style');
    sheet.id = STYLE_ID;
    sheet.textContent = STYLE;
    document.head.appendChild(sheet);
  }, []);
}

/** The notice, drawn as ui's ProblemNotice draws one (the errors system): icon, bold line, muted line, the next steps. */
function RegionFailed({ name, error, focusWasIn, onTryAgain, close }: {
  name: string;
  error: unknown;
  /** After the region's nodes went: whether focus had been in them. */
  focusWasIn: () => boolean;
  onTryAgain: () => void;
  close: { label: string; onClose: () => void } | null;
}) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const timer = useRef<number | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  useNoticeStyle();
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  // Focus was in the region (a reply box, a comment box): it goes to the notice, never to the page's body.
  useLayoutEffect(() => {
    if (focusWasIn()) first.current?.focus();
    // On the notice's arrival only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const copy = async () => {
    const ok = await copyTextToClipboard(renderErrorReport(error, name));
    setCopied(ok ? 'yes' : 'no');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="pn-rf" data-region-failed={name}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="pn-rf-icon">
        <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.5a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z" />
        <path d="M8 6.25v3M8 11.4v.1" />
      </svg>
      <div className="pn-rf-body">
        {/* Said once, as the notice arrives; the buttons and what Copy error says after are not part of it. */}
        <div role="alert">
          <div className="pn-rf-title">This part didn't load</div>
          <div className="pn-rf-detail">Something went wrong drawing it.</div>
        </div>
        <div className="pn-rf-row" data-closable={close ? '' : undefined}>
          <button ref={first} type="button" className="pn-rf-btn" onClick={onTryAgain} data-region-try-again="">
            Try again
          </button>
          <button type="button" className="pn-rf-btn" onClick={() => void reloadAfterFlush()} data-region-reload="">
            Reload
          </button>
          <button type="button" className="pn-rf-btn" onClick={() => void copy()} data-region-copy="">
            {/* Only this word is said when it changes ("Copied"), politely. */}
            <span aria-live="polite">{copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : 'Copy error'}</span>
          </button>
          {close && (
            <button type="button" className="pn-rf-btn" onClick={close.onClose} data-region-close="">
              {close.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
