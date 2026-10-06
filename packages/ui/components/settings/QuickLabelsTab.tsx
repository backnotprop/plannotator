import React, { useLayoutEffect, useRef, useState } from 'react';
import { isMac, isWindows, altKey } from '../../utils/platform';
import {
  type QuickLabel,
  DEFAULT_QUICK_LABELS,
  LABEL_COLOR_MAP,
  emojiFromFieldInput,
  getLabelColors,
  getQuickLabels,
  moveQuickLabel,
  quickLabelShortcutDigit,
  resetQuickLabels,
  saveQuickLabels,
} from '../../utils/quickLabels';

/** Most labels the tab lets a person keep (only the first ten get a key). */
const MAX_QUICK_LABELS = 12;

/**
 * One editable row. `key` is a session-only identity, never persisted: the
 * saved shape stays exactly `QuickLabel[]`. A label's `id` cannot serve here —
 * it is re-derived from the text on every keystroke and two labels with the
 * same text share it — and position cannot either, because moving a row must
 * not move the open tip editor, an emoji draft, or focus onto a neighbour
 * (the #829 bug class, #1736).
 */
interface QuickLabelRow {
  key: string;
  label: QuickLabel;
}

let rowKeySeq = 0;
const nextRowKey = () => `quick-label-row-${++rowKeySeq}`;
const toRows = (labels: readonly QuickLabel[]): QuickLabelRow[] =>
  labels.map((label) => ({ key: nextRowKey(), label }));

const shortcutHint = (digit: string) => `${altKey}${isMac ? '' : '+'}${digit}`;
const shortcutWords = (digit: string) => `${isMac ? 'Option' : 'Alt'}+${digit}`;
const labelName = (label: QuickLabel) => label.text.trim() || 'label';

const EMOJI_HINT = isMac
  ? 'Enter one emoji. Control-Command-Space opens the emoji picker.'
  : isWindows
    ? 'Enter one emoji. Windows+period opens the emoji picker.'
    : 'Enter one emoji.';

const ChevronIcon: React.FC<{ up: boolean }> = ({ up }) => (
  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d={up ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} />
  </svg>
);

/** Settings → Labels: the Quick Labels editor (plan review and annotate). */
export const QuickLabelsTab: React.FC = () => {
  const [rows, setRows] = useState<QuickLabelRow[]>(() => toRows(getQuickLabels()));
  const [editingTipKey, setEditingTipKey] = useState<string | null>(null);
  const [editingTipValue, setEditingTipValue] = useState('');
  /** Emoji fields whose current text is not (yet) one emoji, by row key. */
  const [emojiDrafts, setEmojiDrafts] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ key: string; target: 'up' | 'down' | 'text' } | null>(null);

  const commit = (next: QuickLabelRow[]) => {
    setRows(next);
    saveQuickLabels(next.map((row) => row.label));
  };

  const updateLabel = (key: string, patch: Partial<QuickLabel>) => {
    commit(rows.map((row) => (row.key === key ? { ...row, label: { ...row.label, ...patch } } : row)));
  };

  const setEmojiDraft = (key: string, value: string | null) => {
    setEmojiDrafts((drafts) => {
      if (value === null) {
        if (!(key in drafts)) return drafts;
        const { [key]: _dropped, ...rest } = drafts;
        return rest;
      }
      return { ...drafts, [key]: value };
    });
  };

  const move = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= rows.length) return;
    const row = rows[index];
    commit(moveQuickLabel(rows, index, to));
    pendingFocus.current = { key: row.key, target: delta < 0 ? 'up' : 'down' };
    const digit = quickLabelShortcutDigit(to);
    setAnnouncement(
      `Moved ${labelName(row.label)} to position ${to + 1} of ${rows.length}, ${digit ? shortcutWords(digit) : 'no shortcut key'}.`,
    );
  };

  // Moving a row re-orders DOM nodes, which can drop focus from the button
  // that was pressed; put it back on the same row's button so repeated
  // presses keep walking the same label. At either end the pressed button is
  // disabled, so focus goes to the other direction instead.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-quick-label-row="${pending.key}"]`);
    if (!row) return;
    if (pending.target === 'text') {
      const input = row.querySelector<HTMLInputElement>('[data-quick-label-text]');
      input?.focus();
      input?.select();
      return;
    }
    const other = pending.target === 'up' ? 'down' : 'up';
    const wanted = row.querySelector<HTMLButtonElement>(`[data-quick-label-move="${pending.target}"]`);
    const fallback = row.querySelector<HTMLButtonElement>(`[data-quick-label-move="${other}"]`);
    (wanted && !wanted.disabled ? wanted : fallback)?.focus();
  }, [rows]);

  const saveTip = (key: string) => {
    updateLabel(key, { tip: editingTipValue || undefined });
    setEditingTipKey(null);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium flex items-center gap-2">Quick Labels</div>
          <div className="text-xs text-muted-foreground">
            Preset annotations for one-click feedback
          </div>
        </div>
        <button
          onClick={() => {
            resetQuickLabels();
            setRows(toRows(DEFAULT_QUICK_LABELS));
            setEditingTipKey(null);
            setEmojiDrafts({});
          }}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Reset to defaults
        </button>
      </div>

      <style>{`
        @keyframes tip-slide-open {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div ref={listRef} className="space-y-1.5">
        {rows.map((row, index) => {
          const { key, label } = row;
          const colors = getLabelColors(label.color);
          const hasTip = !!label.tip;
          const isEditingTip = editingTipKey === key;
          const digit = quickLabelShortcutDigit(index);
          const name = labelName(label);
          const emojiDraft = emojiDrafts[key];
          const emojiInvalid = emojiDraft !== undefined;
          const emojiErrorId = `${key}-emoji-error`;
          return (
            <div
              key={key}
              data-quick-label-row={key}
              className="rounded-lg overflow-hidden"
              style={{ backgroundColor: colors.bg }}
            >
              {/* Main row. On a narrow dialog the controls after the text
                  field wrap onto a second line instead of being clipped by
                  the row's overflow-hidden. */}
              <div className="flex flex-wrap items-center gap-2 p-2">
                <input
                  type="text"
                  data-quick-label-emoji
                  value={emojiDraft ?? label.emoji}
                  aria-label={`Emoji for ${name}`}
                  aria-invalid={emojiInvalid || undefined}
                  aria-describedby={emojiInvalid ? emojiErrorId : undefined}
                  title="Change emoji"
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => {
                    const picked = emojiFromFieldInput(e.target.value, label.emoji);
                    if (!picked) {
                      setEmojiDraft(key, e.target.value);
                      return;
                    }
                    setEmojiDraft(key, null);
                    if (picked !== label.emoji) updateLabel(key, { emoji: picked });
                  }}
                  onBlur={() => setEmojiDraft(key, null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && emojiInvalid) {
                      e.preventDefault();
                      e.stopPropagation();
                      setEmojiDraft(key, null);
                    }
                  }}
                  className="w-8 py-1 bg-background/80 rounded text-sm text-center leading-none focus:outline-none focus:ring-1 focus:ring-primary/50 flex-shrink-0"
                  style={emojiInvalid ? { boxShadow: '0 0 0 1px var(--destructive)' } : undefined}
                />
                <input
                  type="text"
                  data-quick-label-text
                  value={label.text}
                  aria-label={`Label text, position ${index + 1}`}
                  onChange={(e) => {
                    updateLabel(key, {
                      text: e.target.value,
                      id: e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
                    });
                  }}
                  className="flex-1 min-w-0 px-2 py-1 bg-background/80 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                  // The basis is what makes the controls wrap: a row that
                  // cannot give the text this much room moves them below.
                  style={{ flexBasis: '8rem' }}
                />
                <div className="flex items-center gap-2 ml-auto">
                  {/* Tip indicator button */}
                  <button
                    data-quick-label-tip-toggle
                    onClick={() => {
                      if (isEditingTip) {
                        setEditingTipKey(null);
                      } else {
                        setEditingTipKey(key);
                        setEditingTipValue(label.tip || '');
                      }
                    }}
                    className={`relative p-1 rounded transition-all flex-shrink-0 ${
                      hasTip
                        ? 'bg-foreground/10 text-foreground/70 hover:text-foreground border border-foreground/15'
                        : 'text-muted-foreground/30 hover:text-muted-foreground/60 border border-dashed border-muted-foreground/20 hover:border-muted-foreground/40'
                    }`}
                    title={hasTip ? `Tip: ${label.tip}` : 'Add AI instruction tip'}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    {hasTip && (
                      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-foreground/50" />
                    )}
                  </button>
                  <select
                    value={label.color}
                    aria-label={`Colour for ${name}`}
                    onChange={(e) => updateLabel(key, { color: e.target.value })}
                    className="px-1.5 py-1 bg-background/80 rounded text-[10px] focus:outline-none focus:ring-1 focus:ring-primary/50"
                  >
                    {Object.keys(LABEL_COLOR_MAP).map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <span
                    data-quick-label-shortcut
                    // Hidden below sm: touch devices that narrow rarely have an Alt key.
                    className="hidden sm:block text-[10px] text-muted-foreground/50 font-mono w-8 text-center flex-shrink-0"
                  >
                    {digit ? shortcutHint(digit) : ''}
                  </span>
                  {/* Reorder: position decides which Alt/⌥ digit applies the label. */}
                  <button
                    type="button"
                    data-quick-label-move="up"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={`Move ${name} up`}
                    title="Move up"
                    className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronIcon up />
                  </button>
                  <button
                    type="button"
                    data-quick-label-move="down"
                    disabled={index === rows.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={`Move ${name} down`}
                    title="Move down"
                    className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ChevronIcon up={false} />
                  </button>
                  <button
                    onClick={() => {
                      commit(rows.filter((r) => r.key !== key));
                      setEmojiDraft(key, null);
                      if (editingTipKey === key) setEditingTipKey(null);
                    }}
                    aria-label={`Remove ${name}`}
                    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
                    title="Remove label"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              {emojiInvalid && (
                <div id={emojiErrorId} className="px-2 pb-2 text-[10px] text-destructive">
                  {EMOJI_HINT}
                </div>
              )}
              {/* Tip editor — slides open below the row */}
              {isEditingTip && (
                <div
                  className="flex items-center gap-1.5 px-2 pb-2 pt-0"
                  style={{ animation: 'tip-slide-open 0.15s ease-out' }}
                >
                  <svg className="w-3 h-3 text-muted-foreground/40 flex-shrink-0 ml-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                  <input
                    type="text"
                    data-quick-label-tip
                    value={editingTipValue}
                    aria-label={`AI instruction tip for ${name}`}
                    onChange={(e) => setEditingTipValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveTip(key);
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditingTipKey(null);
                      }
                    }}
                    placeholder="AI instruction tip..."
                    className="flex-1 px-2 py-1 bg-background/60 rounded text-[10px] text-muted-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    autoFocus
                    onFocus={(e) => { e.target.setSelectionRange(0, 0); e.target.scrollLeft = 0; }}
                  />
                  <button
                    onClick={() => saveTip(key)}
                    className="p-1 rounded text-muted-foreground/50 hover:text-green-500 hover:bg-green-500/10 transition-colors flex-shrink-0"
                    title="Save tip"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      {rows.length < MAX_QUICK_LABELS && (
        <button
          onClick={() => {
            const row: QuickLabelRow = {
              key: nextRowKey(),
              label: {
                id: `custom-${Date.now()}`,
                emoji: '📌',
                text: 'New label',
                color: 'blue',
              },
            };
            commit([...rows, row]);
            pendingFocus.current = { key: row.key, target: 'text' };
          }}
          className="w-full py-1.5 text-xs text-muted-foreground hover:text-foreground border border-dashed border-border rounded-lg hover:border-foreground/30 transition-colors"
        >
          + Add label
        </button>
      )}

      <div className="text-[10px] text-muted-foreground/70">
        Use {shortcutHint('1')} through {shortcutHint('0')} when the annotation toolbar is visible to apply a label instantly. The order of the list decides the key; use the arrows to move a label, and click its emoji to change it.
      </div>
    </>
  );
};
