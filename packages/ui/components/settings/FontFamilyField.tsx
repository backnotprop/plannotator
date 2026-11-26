/**
 * A font row (#851, shared by Code Font and Document font): a select of the
 * built-in choices plus "Custom…", which opens a field for the family name of
 * any font installed on this machine. The typed name is saved after a short
 * pause (configStore.set writes the cookie and may POST /api/config), flushed
 * on unmount, and dropped when a built-in is picked mid-pause.
 *
 * Moved out of Settings.tsx so Settings → Reviews (Code Font) and Settings →
 * Display (Document font) share its behaviour. Its look is the host's: without
 * `controls` it draws Settings → Display's own controls, exactly as before the
 * move (plan review and annotate's Document font row); Settings → Reviews
 * passes its controls and draws its preview without a box.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isFontInstalled } from '../../utils/fontDetect';
import { MAX_FONT_FAMILY_LENGTH, normalizeFontFamilyName } from '../../utils/cssFontFamily';
import type { ReviewSettingsControls, ReviewSettingsNoteProps, ReviewSettingsSelectProps, ReviewSettingsTextFieldProps } from './reviewSettingsControls';

/** Sentinel for the "Custom…" select option — never persisted as a font name. */
const CUSTOM_FONT_SENTINEL = '__custom__';

/** Inline style rendering a control in the chosen font (quoted and escaped: free text). */
function stackStyle(stack: string): React.CSSProperties | undefined {
  return stack ? { fontFamily: stack } : undefined;
}

function stackFamily(stack: string): string | undefined {
  return stack || undefined;
}

type FontFieldControls = Pick<ReviewSettingsControls, 'Select' | 'TextField' | 'Note'>;

// Settings → Display's controls (the Document font row in plan review and
// annotate). Their markup and classes must not change with Settings → Reviews.
function DisplaySelect<T extends string>({ label, value, options, onChange, fontFamily }: ReviewSettingsSelectProps<T>) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground"
      style={fontFamily ? { fontFamily } : undefined}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function DisplayTextField({ label, value, onChange, placeholder, fontFamily, autoFocus, maxLength }: ReviewSettingsTextFieldProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      maxLength={maxLength}
      autoFocus={autoFocus}
      spellCheck={false}
      className="w-full px-3 py-1.5 text-sm rounded-md bg-muted/50 border border-border text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
      style={fontFamily ? { fontFamily } : undefined}
    />
  );
}

const DISPLAY_NOTE_TONE = { muted: 'text-muted-foreground', warning: 'text-warning', success: 'text-success' } as const;

function DisplayNote({ tone = 'muted', ...rest }: ReviewSettingsNoteProps) {
  return <span {...rest} className={DISPLAY_NOTE_TONE[tone]} />;
}

const DISPLAY_FONT_CONTROLS: FontFieldControls = { Select: DisplaySelect, TextField: DisplayTextField, Note: DisplayNote };

export const FontFamilyField: React.FC<{
  label: string;
  description?: string;
  /** Draw the label and description above the select. Default true; false where the host's row draws them. */
  showLabel?: boolean;
  /**
   * The select, text field and status line of Settings → Reviews (its host's
   * set). Without it: Settings → Display's own look, with an 11px status line
   * and the preview in a light box.
   */
  controls?: FontFieldControls;
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
}> = ({ label, description, showLabel = true, controls, value, onSave, options, previewStack, previewText, customAriaLabel, customPlaceholder, notFoundText, loadFont, previewClassName = '' }) => {
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

  const displayLook = !controls;
  const { Select, TextField, Note } = controls ?? DISPLAY_FONT_CONTROLS;
  return (
    <div className="space-y-2">
      {showLabel && (
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      )}
      <Select
        value={customActive ? CUSTOM_FONT_SENTINEL : value}
        label={label}
        options={[...options, { value: CUSTOM_FONT_SENTINEL, label: 'Custom…' }]}
        onChange={(next) => {
          if (next === CUSTOM_FONT_SENTINEL) {
            setCustomFontMode(true);
          } else {
            // Cancel any in-flight debounced custom save so a stale timer
            // can't overwrite this selection.
            cancelPendingFontSave();
            setCustomFontMode(false);
            setCustomFontDraft('');
            onSave(next);
          }
        }}
        fontFamily={value && !customActive ? stackFamily(previewStack(value)) : undefined}
      />
      {customActive && (
        <div className="space-y-1">
          <TextField
            value={customFontDraft}
            onChange={handleCustomFontInput}
            placeholder={customPlaceholder}
            label={customAriaLabel}
            maxLength={MAX_FONT_FAMILY_LENGTH}
            autoFocus={!customFontDraft}
            fontFamily={stackFamily(previewStack(customFontDraft))}
          />
          <div className={displayLook ? 'text-[11px]' : undefined} aria-live="polite">
            {!normalizeFontFamilyName(customFontDraft) ? (
              <Note>Any font installed on this machine works — type its family name.</Note>
            ) : customFontInstalled === true ? (
              <Note tone="success">✓ Found on this machine</Note>
            ) : customFontInstalled === false ? (
              <Note tone="warning">{notFoundText}</Note>
            ) : null}
          </div>
        </div>
      )}
      {/* Settings → Reviews' preview is plain text in the chosen font; Display's keeps its box. */}
      {value && (
        <div
          className={`text-xs text-muted-foreground ${displayLook ? 'px-1 py-1 rounded bg-muted/30 ' : ''}${previewClassName}`}
          style={stackStyle(previewStack(value))}
        >
          {previewText}
        </div>
      )}
    </div>
  );
};
