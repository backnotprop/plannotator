import React from 'react';
import { useTheme, type Mode } from './ThemeProvider';
import { SunIcon, MoonIcon, SystemIcon } from './icons/themeIcons';

interface ThemeTabProps {
  onPreview?: () => void;
  compact?: boolean;
}

export const ThemeTab: React.FC<ThemeTabProps> = ({ onPreview, compact }) => {
  const { mode, setMode, colorTheme, setColorTheme, availableThemes, resolvedMode } = useTheme();

  return (
    <>
      {/* Mode */}
      <div className={compact ? 'flex items-center gap-3 mb-2' : 'space-y-2'}>
        {!compact && <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mode</label>}
        <div className="flex gap-1">
          {(['dark', 'light', 'system'] as Mode[]).map(m => {
            const isActive = mode === m;
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'dark' && (
                  <span className="flex items-center gap-1.5">
                    <MoonIcon className="w-3 h-3" />
                    Dark
                  </span>
                )}
                {m === 'light' && (
                  <span className="flex items-center gap-1.5">
                    <SunIcon className="w-3 h-3" />
                    Light
                  </span>
                )}
                {m === 'system' && (
                  <span className="flex items-center gap-1.5">
                    <SystemIcon className="w-3 h-3" />
                    System
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {compact && (
          <span className="text-[10px] text-muted-foreground/60 ml-auto flex items-center gap-1">
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            syntax match
          </span>
        )}
      </div>

      {/* Theme */}
      <div className={compact ? '' : 'space-y-2'}>
        {!compact && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Theme</label>
              {onPreview && (
                <button
                  onClick={onPreview}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:border-primary/40 transition-colors"
                >
                  Launch Preview Mode
                </button>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
              </svg>
              = matched syntax colors in diffs
            </span>
          </div>
        )}
        <div className={`grid gap-2 overflow-y-auto pr-1 ${compact ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {availableThemes.map(theme => {
            const isSelected = colorTheme === theme.id;
            const colors = theme.colors[resolvedMode];
            const modeUnavailable =
              (resolvedMode === 'light' && theme.modeSupport === 'dark-only') ||
              (resolvedMode === 'dark' && theme.modeSupport === 'light-only');
            return (
              <button
                key={theme.id}
                onClick={() => setColorTheme(theme.id)}
                className={`relative p-2 rounded-md border text-left transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : modeUnavailable
                      ? 'border-border/50 opacity-45'
                      : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30'
                }`}
              >
                {/* Syntax highlighting badge */}
                {theme.syntaxHighlighting && (
                  <div className="absolute top-1 right-1" title="Matched syntax highlighting in diffs">
                    <svg className="w-2.5 h-2.5 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                  </div>
                )}
                {/* Color swatches */}
                <div className="flex gap-1 mb-1.5">
                  {[colors.primary, colors.secondary, colors.accent, colors.background, colors.foreground].map((color, i) => (
                    <div
                      key={i}
                      className="w-3 h-3 rounded-full border border-border/50"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
                {/* Name + checkmark */}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-foreground truncate">{theme.name}</span>
                  {isSelected && (
                    <svg className="w-3 h-3 text-primary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
};
