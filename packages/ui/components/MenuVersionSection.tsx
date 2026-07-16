import React, { useState } from 'react';
import { TextShimmer } from './TextShimmer';
import type { UpdateInfo } from '../hooks/useUpdateCheck';
import type { Origin } from '@plannotator/core/agents';
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
          <a
            href={hasUpdate ? updateInfo!.releaseUrl : 'https://github.com/backnotprop/plannotator/releases'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            Release notes
          </a>
          {hasUpdate && (
            <>
              <span className="text-muted-foreground/40">·</span>
              <TextShimmer className="text-[10px] font-medium" duration={2.5} spread={1.5}>
                New update available!
              </TextShimmer>
            </>
          )}
        </span>
        {hasUpdate && (
          <button
            onClick={handleCopy}
            className="w-full mt-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
          >
            {copied ? 'Copied!' : 'Copy update command'}
          </button>
        )}
      </div>
    </div>
  );
};
