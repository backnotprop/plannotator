import React, { useState } from 'react';
import { ActionMenuSectionLabel } from './ActionMenu';
import type { UpdateInfo } from '../hooks/useUpdateCheck';
import type { Origin } from '@plannotator/shared/agents';
import { isWindows } from '../utils/platform';

const PI_INSTALL_COMMAND = 'pi install npm:@plannotator/pi-extension';

function getInstallCommand(origin?: Origin | null, isWSL = false): string {
  if (origin === 'pi') return PI_INSTALL_COMMAND;
  return isWindows && !isWSL
    ? 'powershell -c "irm https://plannotator.ai/install.ps1 | iex"'
    : 'curl -fsSL https://plannotator.ai/install.sh | bash';
}

interface MenuVersionSectionProps {
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  origin?: Origin | null;
  isWSL: boolean;
  closeMenu: () => void;
}

export const MenuVersionSection: React.FC<MenuVersionSectionProps> = ({
  appVersion,
  updateInfo,
  origin,
  isWSL,
  closeMenu,
}) => {
  const [copied, setCopied] = useState(false);
  const hasUpdate = !!updateInfo?.updateAvailable;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getInstallCommand(origin, isWSL));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  return (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <ActionMenuSectionLabel>Plannotator</ActionMenuSectionLabel>
        <span className="text-[10px] font-mono text-muted-foreground/70">
          v{appVersion}
        </span>
      </div>
      {hasUpdate && (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-primary/10 border border-primary/20">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-medium text-foreground">
              {updateInfo!.latestVersion} available
            </div>
            {updateInfo!.featureHighlight && (
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {updateInfo!.featureHighlight.title}
              </div>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="flex-shrink-0 px-2 py-1 text-[10px] font-medium bg-primary text-primary-foreground rounded hover:opacity-90 transition-opacity"
          >
            {copied ? 'Copied!' : 'Install'}
          </button>
        </div>
      )}
      <div className="flex flex-col items-start gap-1 text-[11px]">
        {hasUpdate ? (
          <a
            href={updateInfo!.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
            className="text-primary hover:text-primary/80 transition-colors"
          >
            Release notes
          </a>
        ) : (
          <a
            href="https://github.com/backnotprop/plannotator/releases"
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Release notes
          </a>
        )}
        <a
          href="https://github.com/backnotprop/plannotator"
          target="_blank"
          rel="noopener noreferrer"
          onClick={closeMenu}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          Project repo
        </a>
      </div>
    </div>
  );
};
