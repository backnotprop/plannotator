/**
 * A part of the window that throws while it draws fails alone. Without a
 * boundary React unmounts the whole root on a render error, and the person is
 * left with a blank page and nothing to report (the Firefox "+" report,
 * 2026-11-24). Around a region (a diff, a thread pane, the guide reader, an
 * app's root) this shows, in the region's place, what happened and the ways
 * out: Try again (the region mounts afresh), Reload, and Copy error (the
 * error's name, message and stack, the app's version and the browser, for a
 * bug report: nothing the person wrote, no file's contents).
 *
 * The error still reaches the console, and still counts as an uncaught error
 * for the page (`reportError`), so a browser test that fails on `pageerror`
 * still fails on one.
 *
 * Under React's act environment (the DOM tests) the boundary lets the error
 * through, so a test that draws something broken still fails as it did; a test
 * of the boundary itself turns catching on (`catchRenderErrorsInTests`).
 *
 * "Your work is saved." is said only with `saved`, where nothing typed in the
 * region can be lost by a reload: an open comment box's words are kept only in
 * memory, so a region that can hold one does not say it.
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';

declare const __APP_VERSION__: string | undefined;

export interface RegionBoundaryProps {
  /** The region, in the console line and the copied report ("Diff", "Thread pane"). */
  name: string;
  children: ReactNode;
  /** Say "Your work is saved." Only where a reload loses nothing the person typed. */
  saved?: boolean;
  /** Classes for the box the notice draws in, so it takes the region's place (a pane). */
  className?: string;
  /** An app's root: the notice in the middle of the page. */
  page?: boolean;
  /** A failed region tries again by itself when this changes (another thread opens in the pane). */
  resetKey?: unknown;
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

class Boundary extends React.Component<RegionBoundaryProps, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[plannotator] ${this.props.name} failed to draw:`, error, info.componentStack ?? '');
    // The page's own uncaught-error report (devtools, a browser test's `pageerror`), as an unmounted root made it.
    if (!actEnvironment() && typeof globalThis.reportError === 'function') {
      try {
        globalThis.reportError(error);
      } catch {
        // Nothing more to tell.
      }
    }
  }

  componentDidUpdate(previous: RegionBoundaryProps) {
    if (this.state.failed && !Object.is(previous.resetKey, this.props.resetKey)) this.setState({ error: null, failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.page ? 'flex min-h-dvh items-center justify-center bg-background p-6' : this.props.className}>
        <RegionFailed
          name={this.props.name}
          error={this.state.error}
          saved={this.props.saved === true}
          onTryAgain={() => this.setState({ error: null, failed: false })}
        />
      </div>
    );
  }
}

function appVersion(): string {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'unknown';
}

/** What Copy error copies: the error as the browser tells it, where, the version and the browser. */
export function renderErrorReport(error: unknown, where: string, version: string = appVersion(), userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const err = error instanceof Error ? error : null;
  const head = err ? `${err.name}: ${err.message}` : String(error);
  const stack = (err?.stack ?? '').trimEnd();
  // V8 starts the stack with the name and message; Firefox and Safari give the frames only.
  const body = !stack ? head : stack.startsWith(head) ? stack : `${head}\n${stack}`;
  return `${body}\n\nWhere: ${where}\nPlannotator ${version}\n${userAgent}`;
}

const BUTTON = 'h-7 px-2.5 rounded-md border border-border bg-background text-[11.5px] font-medium text-foreground hover:bg-muted';

/** The notice, drawn as ui's ProblemNotice draws one (the errors system): icon, bold line, muted line, the next steps. */
function RegionFailed({ name, error, saved, onTryAgain }: { name: string; error: unknown; saved: boolean; onTryAgain: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    const ok = await copyTextToClipboard(renderErrorReport(error, name));
    setCopied(ok ? 'yes' : 'no');
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(null), 2000);
  };
  return (
    <div className="flex gap-2.5 px-3.5 py-3 text-left text-[12.5px] leading-snug" role="alert" data-region-failed={name}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] flex-none text-amber-600 dark:text-amber-400">
        <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.5a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5z" />
        <path d="M8 6.25v3M8 11.4v.1" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-foreground">This part didn't load</div>
        <div className="mt-0.5 text-muted-foreground">Something went wrong drawing it.{saved ? ' Your work is saved.' : ''}</div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" className={BUTTON} onClick={onTryAgain} data-region-try-again="">
            Try again
          </button>
          <button type="button" className={BUTTON} onClick={() => window.location.reload()} data-region-reload="">
            Reload
          </button>
          <button type="button" className={BUTTON} onClick={() => void copy()} data-region-copy="">
            {copied === 'yes' ? 'Copied' : copied === 'no' ? "Couldn't copy" : 'Copy error'}
          </button>
        </div>
      </div>
    </div>
  );
}
