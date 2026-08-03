import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Copy, MoreHorizontal } from 'lucide-react';
import { AppIcon } from './icons/AppIcon';
import { getLastOpenInApp, setLastOpenInApp } from '../utils/storage';
import type { OpenInKind } from '@plannotator/core/open-in-apps';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';

/**
 * OpenInAppButton — split button + file-actions menu.
 *
 * When the file is launchable (local session, resolvable path), the left half
 * opens it in the last-selected app and the chevron drops down the detected
 * apps (file manager, then editors, then terminals) — picking one persists it
 * AND opens immediately. The menu also carries Copy path and (review only)
 * Copy file diff.
 *
 * When launching is unavailable (remote session, or PR review with no local
 * checkout), the app actions are hidden but the copy actions remain behind a
 * `⋯` overflow button — so e.g. Copy file diff never disappears. Renders
 * nothing when there is neither an app to open nor a diff to copy.
 */

interface DetectedApp {
  id: string;
  label: string;
  kind: OpenInKind;
  icon: string;
}

interface OpenInAppButtonProps {
  filePath: string | null | undefined;
  base?: string | null;
  /** Diff/patch text for the "Copy file diff" menu action (review only). */
  diffText?: string | null;
  /**
   * When false, hide the app-launch actions (e.g. PR review with no local
   * checkout, where files aren't resolvable on disk) but keep copy actions.
   */
  canOpen?: boolean;
  /** When true, render the primary label text alongside the icon. */
  showLabel?: boolean;
  disabled?: boolean;
}

// The host app catalog is static for the session, but the all-files view
// renders one OpenInAppButton per file — so fetch /api/open-in/apps once and
// share the promise across every instance instead of N identical requests.
interface OpenInAppsResponse {
  available: boolean;
  apps: DetectedApp[];
}
let openInAppsPromise: Promise<OpenInAppsResponse> | null = null;
function loadOpenInApps(): Promise<OpenInAppsResponse> {
  if (!openInAppsPromise) {
    openInAppsPromise = fetch('/api/open-in/apps')
      .then((r) => r.json())
      .then((data: OpenInAppsResponse) => ({
        available: !!data.available,
        apps: Array.isArray(data.apps) ? data.apps : [],
      }))
      .catch(() => {
        openInAppsPromise = null; // don't memoize failure — let the next mount retry
        return { available: false, apps: [] };
      });
  }
  return openInAppsPromise;
}

export const OpenInAppButton: React.FC<OpenInAppButtonProps> = ({
  filePath,
  base,
  diffText,
  canOpen = true,
  showLabel = false,
  disabled = false,
}) => {
  const [apps, setApps] = useState<DetectedApp[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [currentId, setCurrentId] = useState<string>(() => getLastOpenInApp());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadOpenInApps().then((data) => {
      if (cancelled) return;
      setAvailable(data.available);
      setApps(data.apps);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);

  const list = apps ?? [];
  // Apps are launchable: server says available, the surface allows it, the path
  // is resolvable, and at least one app was detected.
  const openable =
    available === true && canOpen && !!filePath && list.length > 0;

  // Nothing to do: can't open AND nothing to copy. Also preserve the
  // "hide when unavailable" behavior for surfaces whose only copy action is the
  // path (annotate in a remote session) — show the standalone menu only when
  // there's a diff to copy.
  if (!openable && !diffText) return null;

  // Resolve the active app: last-used if still detected, else reveal, else first.
  const resolvedId = list.some((a) => a.id === currentId)
    ? currentId
    : list.some((a) => a.id === 'reveal')
      ? 'reveal'
      : (list[0]?.id ?? 'reveal');
  const currentApp = list.find((a) => a.id === resolvedId) ?? list[0];

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 4000);
  };

  const open = async (appId: string) => {
    if (!filePath || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/open-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, base: base ?? null, appId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string }
        | null;
      if (!res.ok || !data || data.ok === false) {
        flashError(data?.error || 'Failed to open');
      }
    } catch {
      flashError('Failed to open');
    } finally {
      setBusy(false);
    }
  };

  const selectApp = (appId: string) => {
    setLastOpenInApp(appId);
    setCurrentId(appId);
    setMenuOpen(false);
    void open(appId);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
    setMenuOpen(false);
  };

  // Menu groups: file manager first, then editors, then terminals.
  const grouped = [
    list.filter((a) => a.kind === 'file-manager'),
    list.filter((a) => a.kind === 'editor'),
    list.filter((a) => a.kind === 'terminal'),
  ].filter((g) => g.length > 0);

  const Spinner = (
    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );

  const isDisabled = disabled || busy;

  return (
    <div className="flex items-center gap-1">
      <div className="flex items-center rounded overflow-hidden">
        {/* Primary: open in the current app (only when launchable). */}
        {openable && currentApp && (
          <button
            type="button"
            onClick={() => open(resolvedId)}
            disabled={isDisabled}
            className={`text-xs flex items-center gap-1 py-1 transition-colors text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed ${
              showLabel ? 'pl-2 pr-1.5' : 'px-1.5'
            }`}
            title={error ?? currentApp.label}
            aria-label={`Open in ${currentApp.label}`}
          >
            {busy ? Spinner : <AppIcon id={currentApp.icon} className="w-3.5 h-3.5" />}
            {showLabel && <span className="whitespace-nowrap">{currentApp.label}</span>}
          </button>
        )}
        {/* Chevron (with primary) or standalone overflow (copy-only). */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                disabled={isDisabled}
                className={`text-xs flex items-center py-1 transition-colors text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed ${
                  openable ? 'px-1 border-l border-border/50' : 'px-1.5'
                }`}
                title={openable ? 'Open in…' : 'File actions'}
                aria-label={openable ? 'Choose app to open in' : 'File actions'}
              />
            }
          >
            {openable ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <MoreHorizontal className="w-3.5 h-3.5" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={6}
            className="min-w-[12rem]"
            // Don't snap focus (and its focus ring) back onto the trigger when
            // the menu closes — that left-edge bar reads as a stray artifact.
            finalFocus={false}
          >
            {openable &&
              grouped.map((group, gi) => (
                <React.Fragment key={group[0].kind}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  {group.map((app) => (
                    <DropdownMenuItem
                      key={app.id}
                      closeOnClick={false}
                      onClick={() => selectApp(app.id)}
                      className="text-xs"
                    >
                      <AppIcon id={app.icon} className="w-4 h-4" />
                      <span className="flex-1 truncate">{app.label}</span>
                      {app.id === resolvedId && <Check className="w-3.5 h-3.5 text-foreground" />}
                    </DropdownMenuItem>
                  ))}
                </React.Fragment>
              ))}
            {openable && (filePath || diffText) && <DropdownMenuSeparator />}
            {filePath && (
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => void copyText(filePath)}
                className="text-xs"
              >
                <Copy className="w-4 h-4" />
                <span className="flex-1">Copy path</span>
              </DropdownMenuItem>
            )}
            {diffText && (
              <DropdownMenuItem
                closeOnClick={false}
                onClick={() => void copyText(diffText)}
                className="text-xs"
              >
                <Copy className="w-4 h-4" />
                <span className="flex-1">Copy file diff</span>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {error && (
        <span
          role="status"
          aria-live="polite"
          className="text-xs text-destructive truncate max-w-[12rem]"
        >
          {error}
        </span>
      )}
    </div>
  );
};
