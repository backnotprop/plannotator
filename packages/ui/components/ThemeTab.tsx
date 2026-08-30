import React, { useEffect, useState } from 'react';
import { useTheme } from './ThemeProvider';
import { THEME_MODES } from './themeModes';
import { themesForHalf, type ThemeHalf } from '../utils/themeRegistry';
import { configStore, useConfigValue } from '../config';
import { faviconDataUrl, type FaviconStyle } from '@plannotator/core/favicon';
import { FONT_CATALOG, getFontLoadStatus, isSafeCustomFontFamily, loadFont, resolveFontFamily, type FontCatalogRole, type FontLoadStatus } from '../utils/typography';
import type { FontSelection, TypographyRole, TypographySurface } from '@plannotator/core/config-types';

interface ThemeTabProps {
  onPreview?: () => void;
  compact?: boolean;
  typographySurface?: TypographySurface;
}

const HALVES: { id: ThemeHalf; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
const TYPOGRAPHY_SURFACES: { id: TypographySurface; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'annotate', label: 'Annotate' },
  { id: 'review', label: 'Review' },
];
const FAVICON_STYLES: { id: FaviconStyle; label: string }[] = [
  { id: 'totman', label: 'Totman' },
  { id: 'classic', label: 'Classic P' },
];

const SyntaxLinesIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h7" />
  </svg>
);

const FaviconStyleControl: React.FC<{ selected: FaviconStyle }> = ({ selected }) => (
  <div className="flex gap-1" role="group" aria-label="Favicon style">
    {FAVICON_STYLES.map(({ id, label }) => (
      <button
        key={id}
        type="button"
        aria-pressed={selected === id}
        onClick={() => configStore.set('faviconStyle', id)}
        className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
          selected === id
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground hover:text-foreground'
        }`}
      >
        <span className="flex items-center gap-1.5">
          <img src={faviconDataUrl(id)} alt="" className="w-5 h-5 rounded-sm shrink-0" />
          {label}
        </span>
      </button>
    ))}
  </div>
);

export const ThemeTab: React.FC<ThemeTabProps> = ({ onPreview, compact, typographySurface: forcedTypographySurface }) => {
  const {
    mode,
    setMode,
    lightTheme,
    darkTheme,
    setHalfTheme,
    availableThemes,
    preferredMode,
    manageFavicon,
  } = useTheme();
  const faviconStyle = useConfigValue('faviconStyle');

  // Which half the grid assigns to. Follows the mode you are actually seeing,
  // so opening Settings in dark mode edits the dark half first.
  const typography = useConfigValue('typography');
  const [typographySurface, setTypographySurface] = useState<TypographySurface>(forcedTypographySurface ?? 'plan');
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
        {!compact && manageFavicon && (
          <div className="space-y-1.5 pt-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Favicon</label>
            <FaviconStyleControl selected={faviconStyle} />
          </div>
        )}
        {!compact && (
          <p className="text-[11px] text-muted-foreground/70">
            System follows your OS and switches between the two themes below.
          </p>
        )}
        {compact && (
          <>
            {manageFavicon && <FaviconStyleControl selected={faviconStyle} />}
            <div className="ml-auto">{summary}</div>
          </>
        )}
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

      {!compact && (
        <TypographySettings
          surface={forcedTypographySurface ?? typographySurface}
          setSurface={setTypographySurface}
          showSurfacePicker={!forcedTypographySurface}
          typography={typography}
        />
      )}
    </div>
  );
};

function TypographySettings({ surface, setSurface, typography, showSurfacePicker }: {
  surface: TypographySurface;
  setSurface: (surface: TypographySurface) => void;
  typography: ReturnType<typeof useConfigValue<'typography'>>;
  showSurfacePicker: boolean;
}) {
  const setRole = (role: TypographyRole, selection: FontSelection | undefined) => {
    const current = configStore.get('typography');
    const nextSurface = { ...current[surface], ...(selection ? { [role]: selection } : {}) };
    if (!selection) delete nextSurface[role];
    configStore.set('typography', { ...current, [surface]: nextSurface });
  };
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Typography</label>
          <p className="mt-1 text-[11px] text-muted-foreground/70">Set the reading and code face for this surface.</p>
        </div>
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">{surface}</span>
      </div>
      {showSurfacePicker && <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5">
        {TYPOGRAPHY_SURFACES.map(item => <button key={item.id} onClick={() => setSurface(item.id)} className={`flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${surface === item.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{item.label}</button>)}
      </div>}
      <FontControl label="Display font" role="display" selection={typography[surface]?.display} onChange={setRole} />
      <FontControl label="Code font" role="mono" selection={typography[surface]?.mono} onChange={setRole} />
    </section>
  );
}

function FontChoice({ selected, onClick, label, preview, detail, family }: {
  selected: boolean;
  onClick: () => void;
  label: string;
  preview: string;
  detail: string;
  family?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`relative rounded-md border p-2 text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/30 hover:bg-muted/30'}`}
      style={{ fontFamily: family }}
    >
      <span className="mb-1.5 block text-lg leading-none text-foreground">{preview}</span>
      <span className="block truncate text-xs text-foreground">{label}</span>
      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{detail}</span>
      {selected && <svg className="absolute bottom-2 right-2 size-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
    </button>
  );
}

function FontControl({ label, role, selection, onChange }: {
  label: string;
  role: TypographyRole;
  selection: FontSelection | undefined;
  onChange: (role: TypographyRole, selection: FontSelection | undefined) => void;
}) {
  const [custom, setCustom] = useState(selection?.source === 'custom' ? selection.family ?? '' : '');
  const [editingCustom, setEditingCustom] = useState(selection?.source === 'custom');
  const [customError, setCustomError] = useState<string | null>(null);
  const [status, setStatus] = useState<FontLoadStatus>(() => selection?.source === 'catalog' ? getFontLoadStatus(selection.family as never) : 'idle');
  useEffect(() => {
    setCustom(selection?.source === 'custom' ? selection.family ?? '' : '');
    setEditingCustom(selection?.source === 'custom');
    setCustomError(null);
  }, [selection]);
  const fonts = FONT_CATALOG.filter(font => (font.roles as readonly FontCatalogRole[]).includes(role as FontCatalogRole));
  useEffect(() => {
    let active = true;
    void loadFont(selection).then(next => { if (active) setStatus(next); });
    setStatus(selection?.source === 'catalog' ? getFontLoadStatus(selection.family as never) : 'idle');
    return () => { active = false; };
  }, [selection?.family, selection?.source]);
  const preview = resolveFontFamily(selection);
  const isSelected = (id: string) => selection?.source === 'catalog' && selection.family === id;
  const choose = (font: typeof fonts[number]) => {
    setEditingCustom(false);
    onChange(role, { family: font.id, source: 'catalog' });
  };
  return (
    <section className="space-y-2.5 rounded-lg border border-border/80 bg-background/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{label}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{role === 'mono' ? 'Code, diffs, and shortcuts' : 'Reading and interface text'}</p>
        </div>
        {selection && <button type="button" onClick={() => { setEditingCustom(false); onChange(role, undefined); }} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Use theme</button>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <FontChoice selected={!selection} onClick={() => { setEditingCustom(false); onChange(role, undefined); }} label="Theme default" preview="Aa" detail="Follow palette" />
        {fonts.map(font => <FontChoice key={font.id} selected={isSelected(font.id)} onClick={() => choose(font)} label={font.label} preview="Aa" detail="Font family" family={font.family} />)}
        <FontChoice selected={editingCustom} onClick={() => setEditingCustom(open => !open)} label="Custom local" preview="+" detail="CSS stack" />
      </div>
      {editingCustom && (
        <>
          <input autoFocus value={custom} onChange={event => { setCustom(event.target.value); setCustomError(null); }} onBlur={() => {
            const value = custom.trim();
            if (!value) { onChange(role, undefined); return; }
            if (!isSafeCustomFontFamily(value)) { setCustomError('Use a font-family stack without braces or semicolons.'); return; }
            onChange(role, { family: value, source: 'custom' });
          }} placeholder={'e.g. "Berkeley Mono", monospace'} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          {customError && <p className="text-[11px] text-destructive">{customError}</p>}
        </>
      )}
      <div className="border-t border-border/60 pt-2 text-sm text-foreground" style={{ fontFamily: preview }}>
        {role === 'mono' ? 'const font = "preview";' : 'The quick brown fox jumps over the lazy dog.'}
      </div>
      {selection?.source === 'catalog' && <p className="text-[11px] text-muted-foreground/70">{status === 'loading' ? 'Loading font…' : status === 'error' ? 'Could not load font; using fallback.' : status === 'ready' ? 'Loaded' : 'Waiting to load'}</p>}
    </section>
  );
}
