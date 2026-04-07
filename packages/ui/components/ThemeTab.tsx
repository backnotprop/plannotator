import React from 'react';
import { useTheme, type Mode } from './ThemeProvider';
import { SunIcon, MoonIcon, SystemIcon } from './icons/themeIcons';

export const ThemeTab: React.FC = () => {
  const { mode, setMode, colorTheme, setColorTheme, availableThemes, resolvedMode } = useTheme();

  return (
    <>
      {/* Mode */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mode</label>
        <div className="flex gap-1">
          {(['dark', 'light', 'system'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === m
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
          ))}
        </div>
      </div>

      {/* Theme */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Theme</label>
        <div className="grid grid-cols-3 gap-2 overflow-y-auto pr-1">
          {availableThemes.map(theme => {
            const isSelected = colorTheme === theme.id;
            const colors = theme.colors[resolvedMode];
            return (
              <button
                key={theme.id}
                onClick={() => setColorTheme(theme.id)}
                className={`relative p-2 rounded-md border text-left transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30'
                }`}
              >
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
