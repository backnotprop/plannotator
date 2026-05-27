import React, { useState } from 'react';
import { getIdentity, regenerateIdentity, setCustomIdentity } from '../../utils/identity';
import { getAutoCloseDelay, setAutoCloseDelay, AUTO_CLOSE_OPTIONS, type AutoCloseDelay } from '../../utils/storage';
import { GitUser } from '../../icons/GitUser';
import { ToggleSwitch } from './shared';

interface GeneralTabProps {
  gitUser?: string;
  onIdentityChange?: (oldIdentity: string, newIdentity: string) => void;
  legacyTabMode?: boolean;
  onLegacyTabModeChange?: (enabled: boolean) => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({ gitUser, onIdentityChange, legacyTabMode, onLegacyTabModeChange }) => {
  const [identity, setIdentity] = useState(() => getIdentity());
  const [autoClose, setAutoClose] = useState<AutoCloseDelay>(() => getAutoCloseDelay());

  const handleIdentitySave = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === identity) return;
    const oldIdentity = identity;
    setCustomIdentity(trimmed);
    setIdentity(trimmed);
    onIdentityChange?.(oldIdentity, trimmed);
  };

  const handleRegenerateIdentity = () => {
    const oldIdentity = identity;
    const newIdentity = regenerateIdentity();
    setIdentity(newIdentity);
    onIdentityChange?.(oldIdentity, newIdentity);
  };

  const handleUseGitName = () => {
    if (gitUser) handleIdentitySave(gitUser);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="text-sm font-medium">Your Identity</div>
        <div className="text-xs text-muted-foreground">
          Used when sharing annotations with others
        </div>
        <div className="flex items-center gap-2">
          <input
            key={identity}
            type="text"
            defaultValue={identity}
            onBlur={(e) => handleIdentitySave(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleIdentitySave((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono truncate border border-transparent focus:border-primary/50 focus:outline-none"
            placeholder="Enter your name…"
          />
          {gitUser && (
            <button
              type="button"
              onClick={handleUseGitName}
              onMouseDown={(e) => e.preventDefault()}
              className="p-2 rounded-lg bg-muted text-muted-foreground hover:text-foreground"
              title={`Use git identity: ${gitUser}`}
            >
              <GitUser className="w-5 h-5" />
            </button>
          )}
          <button
            type="button"
            onClick={handleRegenerateIdentity}
            onMouseDown={(e) => e.preventDefault()}
            className="p-2 rounded-lg bg-muted text-muted-foreground hover:text-foreground"
            title="Regenerate random identity"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      <div className="border-t border-border" />

      <div className="space-y-2">
        <div className="text-sm font-medium">Auto-close Tab</div>
        <select
          value={autoClose}
          onChange={(e) => {
            const next = e.target.value as AutoCloseDelay;
            setAutoClose(next);
            setAutoCloseDelay(next);
          }}
          className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
        >
          {AUTO_CLOSE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div className="text-[10px] text-muted-foreground">
          {AUTO_CLOSE_OPTIONS.find(o => o.value === autoClose)?.description}
        </div>
      </div>

      {onLegacyTabModeChange && (
        <>
          <div className="border-t border-border" />
          <ToggleSwitch
            checked={legacyTabMode ?? false}
            onChange={onLegacyTabModeChange}
            label="Open sessions in new tabs"
            description="Each session opens in a separate browser tab with auto-close, like the classic Plannotator experience"
          />
        </>
      )}
    </div>
  );
};
