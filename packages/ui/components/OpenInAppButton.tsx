import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Copy, MoreHorizontal } from 'lucide-react';
import { AppIcon } from './icons/AppIcon';
import { useOpenInApps, useRememberedOpenInApp } from '../hooks/useOpenInApps';
import { copyTextToClipboard } from '../utils/clipboard';
import { noteServerSessionMismatch, withServerSession } from '../utils/serverSession';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './ui/dropdown-menu';

interface OpenInAppButtonProps {
  filePath: string | null | undefined;
  base?: string | null;
  diffText?: string | null;
  canOpen?: boolean;
  showLabel?: boolean;
  disabled?: boolean;
}

const OPEN_IN_APPS_URL = '/api/open-in/apps';

export const OpenInAppButton: React.FC<OpenInAppButtonProps> = ({
  filePath,
  base,
  diffText,
  canOpen = true,
  showLabel = false,
  disabled = false,
}) => {
  const detected = useOpenInApps(OPEN_IN_APPS_URL);
  const apps = detected?.apps ?? null;
  const available = detected ? detected.available : null;
  const [storedId, rememberApp] = useRememberedOpenInApp();
  const currentId = storedId ?? 'reveal';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, []);

  const list = apps ?? [];
  const openable =
    available === true && canOpen && !!filePath && list.length > 0;

  if (!openable && !diffText) return null;

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
        body: JSON.stringify(withServerSession({ filePath, base: base ?? null, appId })),
      });
      if (await noteServerSessionMismatch(res)) {
        flashError('This review was replaced. Reload the page.');
        return;
      }
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
    rememberApp(appId);
    setMenuOpen(false);
    void open(appId);
  };

  const copyText = async (text: string) => {
    await copyTextToClipboard(text);
    setMenuOpen(false);
  };

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
