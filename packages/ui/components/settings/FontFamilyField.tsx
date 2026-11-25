/**
 * A font row (#851, shared by Code Font and Document font): a select of the
 * built-in choices plus "Custom…", which opens a field for the family name of
 * any font installed on this machine. The typed name is saved after a short
 * pause (configStore.set writes the cookie and may POST /api/config), flushed
 * on unmount, and dropped when a built-in is picked mid-pause.
 *
 * Moved unchanged from Settings.tsx so Settings → Reviews (Code Font) and
 * Settings → Display (Document font) share it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isFontInstalled } from '../../utils/fontDetect';
import { MAX_FONT_FAMILY_LENGTH, normalizeFontFamilyName } from '../../utils/cssFontFamily';

/** Sentinel for the "Custom…" select option — never persisted as a font name. */
const CUSTOM_FONT_SENTINEL = '__custom__';

/** Inline style rendering a control in the chosen font (quoted and escaped: free text). */
function stackStyle(stack: string): React.CSSProperties | undefined {
  return stack ? { fontFamily: stack } : undefined;
}

export const FontFamilyField: React.FC<{
  label: string;
  description: string;
  value: string;
  onSave: (value: string) => void;
  options: readonly { value: string; label: string }[];
  /** The `font-family` the controls preview a value in. */
  previewStack: (value: string) => string;
  previewText: string;
  customAriaLabel: string;
  customPlaceholder: string;
  notFoundText: string;
  /** Load a built-in's web font for the preview, if it has one. */
  loadFont?: (value: string) => void;
  previewClassName?: string;
}> = ({ label, description, value, onSave, options, previewStack, previewText, customAriaLabel, customPlaceholder, notFoundText, loadFont, previewClassName = '' }) => {
  const isBuiltIn = (v: string) => options.some((opt) => opt.value === v);
  // Custom font: progressive disclosure. customFontMode keeps the input open
  // while the user picks "Custom…" or has a non-built-in font saved.
  const [customFontMode, setCustomFontMode] = useState(() => !!value && !isBuiltIn(value));
  const [customFontDraft, setCustomFontDraft] = useState(() => (value && !isBuiltIn(value) ? value : ''));
  const customFontSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Pending debounced value. Non-null means "typed but not yet saved" — it is
  // flushed (not discarded) on unmount, and cancelled when a built-in is
  // picked so a stale timer can't overwrite the new selection.
  const pendingFontSave = useRef<string | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const customActive = customFontMode || (!!value && !isBuiltIn(value));
  // Width-measurement check — deterministic per machine, no permissions.
  const customFontInstalled = useMemo(
    () => (normalizeFontFamilyName(customFontDraft) ? isFontInstalled(customFontDraft) : null),
    [customFontDraft],
  );

  // Load font for the preview swatch
  useEffect(() => {
    if (value) loadFont?.(value);
  }, [value, loadFont]);

  // Adopt external changes (late server hydration, edits from elsewhere) into
  // the draft — but never clobber typing that hasn't been saved yet.
  useEffect(() => {
    if (pendingFontSave.current !== null) return;
    if (value && !isBuiltIn(value) && value !== normalizeFontFamilyName(customFontDraft)) {
      setCustomFontDraft(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const cancelPendingFontSave = () => {
    clearTimeout(customFontSaveTimer.current);
    pendingFontSave.current = null;
  };

  // Flush a pending save on unmount so closing the panel mid-debounce
  // doesn't lose the typed font.
  useEffect(() => () => {
    clearTimeout(customFontSaveTimer.current);
    if (pendingFontSave.current !== null) {
      onSaveRef.current(pendingFontSave.current);
    }
  }, []);

  const handleCustomFontInput = (next: string) => {
    setCustomFontDraft(next);
    // Debounce the save — per-keystroke writes would spam the cookie and
    // /api/config.
    clearTimeout(customFontSaveTimer.current);
    pendingFontSave.current = normalizeFontFamilyName(next);
    customFontSaveTimer.current = setTimeout(() => {
      if (pendingFontSave.current !== null) {
        onSaveRef.current(pendingFontSave.current);
        pendingFontSave.current = null;
      }
    }, 400);
  };

  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <select
        value={customActive ? CUSTOM_FONT_SENTINEL : value}
        aria-label={label}
        onChange={(e) => {
          if (e.target.value === CUSTOM_FONT_SENTINEL) {
            setCustomFontMode(true);
          } else {
            // Cancel any in-flight debounced custom save so a stale timer
            // can't overwrite this selection.
            cancelPendingFontSave();
            setCustomFontMode(false);
            setCustomFontDraft('');
            onSave(e.target.value);
          }
        }}
        className="w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground"
        style={value && !customActive ? stackStyle(previewStack(value)) : undefined}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
        <option value={CUSTOM_FONT_SENTINEL}>Custom…</option>
      </select>
      {customActive && (
        <div className="space-y-1">
          <input
            type="text"
            value={customFontDraft}
            onChange={(e) => handleCustomFontInput(e.target.value)}
            placeholder={customPlaceholder}
            aria-label={customAriaLabel}
            maxLength={MAX_FONT_FAMILY_LENGTH}
            autoFocus={!customFontDraft}
            spellCheck={false}
            className="w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            style={stackStyle(previewStack(customFontDraft))}
          />
          <div className="text-[11px]" aria-live="polite">
            {!normalizeFontFamilyName(customFontDraft) ? (
              <span className="text-muted-foreground">Any font installed on this machine works — type its family name.</span>
            ) : customFontInstalled === true ? (
              <span className="text-success">✓ Found on this machine</span>
            ) : customFontInstalled === false ? (
              <span className="text-warning">{notFoundText}</span>
            ) : null}
          </div>
        </div>
      )}
      {value && (
        <div
          className={`text-xs text-muted-foreground px-1 py-1 rounded bg-muted/30 ${previewClassName}`}
          style={stackStyle(previewStack(value))}
        >
          {previewText}
        </div>
      )}
    </div>
  );
};
