import React, { useEffect, useState } from 'react';
import { useTheme } from './ThemeProvider';
import { THEME_MODES } from './themeModes';
import { themesForHalf, type ThemeHalf } from '../utils/themeRegistry';

interface ThemeTabProps {
  onPreview?: () => void;
  compact?: boolean;
}

const HALVES: { id: ThemeHalf; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const SyntaxLinesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h7" />
  </svg>
);

export const ThemeTab: React.FC<ThemeTabProps> = ({ onPreview, compact }) => {
  const {
    mode,
    setMode,
    lightTheme,
    darkTheme,
    setHalfTheme,
    availableThemes,
    preferredMode,
  } = useTheme();

  // Which half the grid assigns to. Follows the mode you are actually seeing,
  // so opening Settings in dark mode edits the dark half first.
  const [half, setHalf] = useState<ThemeHalf>(preferredMode);
  useEffect(() => setHalf(preferredMode), [preferredMode]);

  const pair: Record<ThemeHalf, string> = { light: lightTheme, dark: darkTheme };
  const themes = themesForHalf(availableThemes, half);
  const nameOf = (id: string) => availableThemes.find(theme => theme.id === id)?.name ?? id;

  const summary = (
    <div className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${compact ? '' : 'flex-wrap'}`}>
      {HALVES.map(({ id, label }, index) => (
        <React.Fragment key={id}>
          {index > 0 && <span className="text-muted-foreground/40">·</span>}
          <button
            onClick={() => setHalf(id)}
            title={`Assign the ${label.toLowerCase()} theme`}
            className={`rounded px-1 py-0.5 transition-colors hover:bg-muted ${
              half === id ? 'text-foreground' : ''
            }`}
          >
            <span className="text-muted-foreground/70">{label}: </span>
            <span className="font-medium">{nameOf(pair[id])}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <div className={compact ? '' : 'space-y-5'}>
      {/* Mode */}
      <div className={compact ? 'flex items-center gap-3 mb-2' : 'space-y-2'}>
        {!compact && <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mode</label>}
        <div className="flex gap-1">
          {THEME_MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                mode === id
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <Icon className="w-3 h-3" />
                {label}
              </span>
            </button>
          ))}
        </div>
        {!compact && (
          <p className="text-[11px] text-muted-foreground/70">
            System follows your OS and switches between the two themes below.
          </p>
        )}
        {compact && <div className="ml-auto">{summary}</div>}
      </div>

      {/* Theme pair */}
      <div className={compact ? 'space-y-2' : 'space-y-3'}>
        {!compact && (
          <>
            <div className="flex items-center justify-between border-t border-border pt-5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Theme</label>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-muted-foreground/70 flex items-center gap-1">
                  <SyntaxLinesIcon className="w-2.5 h-2.5" />
                  = matched syntax colors
                </span>
                {onPreview && (
                  <button
                    onClick={onPreview}
                    className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 hover:border-primary/40 transition-colors"
                  >
                    Preview Mode
                  </button>
                )}
              </div>
            </div>
            {summary}
          </>
        )}

        {/* Which half the grid assigns to */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/70">Assigning</span>
          <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
            {HALVES.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setHalf(id)}
                aria-pressed={half === id}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  half === id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {label} theme
              </button>
            ))}
          </div>
        </div>

        <div className={`grid gap-2 overflow-y-auto pr-1 ${compact ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {themes.map(theme => {
            const isSelected = pair[half] === theme.id;
            const colors = theme.colors[half];
            return (
              <button
                key={theme.id}
                onClick={() => setHalfTheme(half, theme.id)}
                className={`relative p-2 rounded-md border text-left transition-colors ${
                  isSelected
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30'
                }`}
              >
                {/* Syntax highlighting badge */}
                {theme.syntaxHighlighting && (
                  <div className="absolute top-1 right-1" title="Matched syntax highlighting in diffs">
                    <SyntaxLinesIcon className="w-2.5 h-2.5 text-muted-foreground/50" />
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
    </div>
  );
};
