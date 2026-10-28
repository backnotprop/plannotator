import React, { useState } from 'react';
import type { UpdateInfo } from '../hooks/useUpdateCheck';
import type { Origin } from '@plannotator/core/agents';
import { isWindows } from '../utils/platform';
import { copyTextToClipboard } from '../utils/clipboard';
import { requestUpdateNow } from '../utils/updateNotice';

/** The command when the server sent none (an advert always carries one). */
function fallbackCommand(origin?: Origin | null, isWSL = false): string {
  if (origin === 'pi') return 'pi update --extensions';
  return isWindows && !isWSL
    ? 'irm https://plannotator.ai/install.ps1 | iex'
    : 'curl -fsSL https://plannotator.ai/install.sh | bash';
}

/** "Oct 26, 9:14 AM", from the server's ISO time. */
function failingSince(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

interface MenuVersionSectionProps {
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  origin?: Origin | null;
  isWSL: boolean;
  closeMenu: () => void;
}

/**
 * The Options menu's version section: the running version and, when the
 * machine knows of a newer release, "X is available · What's new" with the
 * command for this host (remembered install flags included) and, for the
 * binary the install script manages, Update now.
 */
export const MenuVersionSection: React.FC<MenuVersionSectionProps> = ({
  appVersion,
  updateInfo,
  origin,
  isWSL,
  closeMenu,
}) => {
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState<'idle' | 'starting' | 'started' | string>('idle');
  const hasUpdate = !!updateInfo?.updateAvailable;
  // Checking for updates has failed for hours: a quiet line and the command (no dot, no toast).
  const checkFailing = updateInfo?.checkFailing ?? null;
  const command = updateInfo?.command ?? fallbackCommand(origin, isWSL);

  const handleCopy = async () => {
    if (await copyTextToClipboard(command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleUpdate = async () => {
    setUpdating('starting');
    const result = await requestUpdateNow();
    setUpdating('error' in result ? result.error : 'started');
  };

  return (
    <div className="px-3 py-2 space-y-2" data-menu-version="">
      <div className="flex items-center justify-between gap-3">
        <a
          href="https://github.com/backnotprop/plannotator"
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          className="text-[10px] font-semibold tracking-wide text-muted-foreground hover:text-foreground transition-colors"
        >
          Plannotator
        </a>
        <span className="text-[10px] font-mono text-muted-foreground/70">
          v{appVersion}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1 text-[11px]">
        <span className="flex items-center gap-1.5">
          {hasUpdate && (
            <>
              <span className="font-medium text-foreground">{updateInfo!.latestVersion} is available</span>
              <span className="text-muted-foreground/40">·</span>
            </>
          )}
          <a
            href={hasUpdate ? updateInfo!.releaseUrl : 'https://github.com/backnotprop/plannotator/releases'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {hasUpdate ? "What's new" : 'Release notes'}
          </a>
        </span>
        {!hasUpdate && checkFailing && (
          <span className="text-muted-foreground" data-menu-update-check-failing="">
            Can&apos;t check for updates since {failingSince(checkFailing.since)} ({checkFailing.error}). To update now:
          </span>
        )}
        {(hasUpdate || checkFailing) && (
          <div className="w-full mt-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1" data-menu-update-command="">
            {/* Shown whole when checking fails (it is the only way forward there); one scrolling line beside an update, as before. */}
            <code
              className={`flex-1 min-w-0 font-mono text-[10px] text-foreground ${hasUpdate ? 'overflow-x-auto whitespace-nowrap' : 'whitespace-pre-wrap break-all'}`}
            >
              {command}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium border border-border hover:bg-muted transition-colors"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
        {hasUpdate && (
          <>
            {updateInfo!.action === 'script' && (
              <button
                onClick={handleUpdate}
                disabled={updating === 'starting' || updating === 'started'}
                className="w-full mt-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {updating === 'started' ? `Updating to ${updateInfo!.latestVersion}…` : updating === 'starting' ? 'Starting…' : 'Update now'}
              </button>
            )}
            {updating !== 'idle' && updating !== 'starting' && updating !== 'started' && (
              <span className="text-[10px] text-destructive">{updating}</span>
            )}
          </>
        )}
      </div>
    </div>
  );
};
