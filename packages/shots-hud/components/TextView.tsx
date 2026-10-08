/**
 * View text: a Snapshot's accessibility text in place of the image, before
 * it is sent. Lines can be selected and removed (they never reach the agent),
 * or the text can be left out entirely.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Shot } from '@plannotator/shared/shots/types';
import { Icon } from '../icons';

interface Props {
  shot: Shot;
  text: string | null;
  onRemoveLines: (lines: number[]) => void;
  onRestoreLines: (lines: number[]) => void;
  onInclude: (include: boolean) => void;
  onTurnOnAccessibility: () => void;
}

function highlight(line: string, query: string) {
  if (!query) return line || ' ';
  const parts: React.ReactNode[] = [];
  const lower = line.toLowerCase();
  let from = 0;
  let index = lower.indexOf(query, from);
  while (index >= 0) {
    parts.push(line.slice(from, index), <mark key={index}>{line.slice(index, index + query.length)}</mark>);
    from = index + query.length;
    index = lower.indexOf(query, from);
  }
  parts.push(line.slice(from));
  return parts;
}

export function TextView({ shot, text, onRemoveLines, onRestoreLines, onInclude, onTurnOnAccessibility }: Props) {
  const lines = useMemo(() => (text ?? '').split('\n'), [text]);
  const removed = useMemo(() => new Set(shot.text?.removedLines ?? []), [shot.text?.removedLines]);
  const [selection, setSelection] = useState<{ anchor: number; head: number } | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => {
    if (!selection) return [] as number[];
    const [a, b] = [Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }, [selection]);
  const removedChars = useMemo(() => [...removed].reduce((sum, n) => sum + (lines[n]?.length ?? 0) + 1, 0), [removed, lines]);
  const selectedChars = selected.reduce((sum, n) => sum + (lines[n]?.length ?? 0) + 1, 0);
  const allSelectedRemoved = selected.length > 0 && selected.every((n) => removed.has(n));

  const removeSelection = () => {
    if (selected.length === 0) return;
    if (allSelectedRemoved) onRestoreLines(selected);
    else onRemoveLines(selected);
    setSelection(null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        searchRef.current?.focus();
      } else if ((event.key === 'Backspace' || event.key === 'Delete') && selected.length > 0 && document.activeElement !== searchRef.current) {
        event.preventDefault();
        event.stopPropagation();
        removeSelection();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  useEffect(() => {
    if (!query) return;
    const first = lines.findIndex((line) => line.toLowerCase().includes(query));
    if (first >= 0) bodyRef.current?.querySelector(`[data-line="${first}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [query, lines]);

  const title = [shot.source?.app, shot.source?.windowTitle].filter(Boolean).join(' — ') || 'Window';
  const include = shot.text?.include ?? false;

  return (
    <div className="textview">
      <div className="tv-head">
        <Icon name="text" />
        <span>
          <b>{title}</b> · {(text ?? '').length.toLocaleString('en-US')} characters · from accessibility · includes text outside the visible area
        </span>
        <label className="search">
          <Icon name="search" size={13} />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value.toLowerCase())} placeholder="Find in text  ⌘F" aria-label="Find in text" onKeyDown={(e) => e.stopPropagation()} />
        </label>
      </div>
      {text === null ? (
        <div className="tv-body">
          {shot.text?.unavailable === 'Accessibility is off' ? (
            <div className="tv-off">
              <h4>Accessibility is off</h4>
              <button type="button" className="perm-btn" onClick={onTurnOnAccessibility}>
                Turn On
              </button>
            </div>
          ) : (
            <div className="tv-empty">{shot.text?.unavailable ? `No window text: ${shot.text.unavailable}.` : 'This shot has no window text.'}</div>
          )}
        </div>
      ) : (
        <div className="tv-body" ref={bodyRef} role="listbox" aria-multiselectable="true" aria-label="Window text, one option per line">
          {lines.map((line, index) => (
            <div
              key={index}
              data-line={index}
              role="option"
              aria-selected={selected.includes(index)}
              className={`tv-line${selected.includes(index) ? ' sel' : ''}${removed.has(index) ? ' gone' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                setSelection((current) => (event.shiftKey && current ? { anchor: current.anchor, head: index } : { anchor: index, head: index }));
              }}
              onMouseEnter={(event) => {
                if (event.buttons === 1) setSelection((current) => (current ? { anchor: current.anchor, head: index } : current));
              }}
            >
              {highlight(line, query)}
            </div>
          ))}
        </div>
      )}
      <div className="tv-foot">
        <button type="button" className="pill-btn danger" disabled={selected.length === 0} onClick={removeSelection}>
          {allSelectedRemoved ? 'Restore selection' : 'Remove selection'} <span className="k">⌫</span>
        </button>
        <span>
          {selected.length > 0 ? `${selected.length} line${selected.length === 1 ? '' : 's'} selected (${selectedChars} characters) · ` : ''}
          {removedChars > 0 ? `${removedChars.toLocaleString('en-US')} characters removed so far` : 'Nothing removed'}
        </span>
        <button type="button" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }} onClick={() => onInclude(!include)} disabled={text === null} aria-pressed={include}>
          Send text with this shot <span className={`toggle${include ? ' on' : ''}`} />
        </button>
      </div>
    </div>
  );
}
