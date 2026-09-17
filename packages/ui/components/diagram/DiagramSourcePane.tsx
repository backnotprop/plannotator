import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import React, { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import type { DiagramSourceDraft } from './useDiagramSourceDraft';

/**
 * The Source pane beside the canvas (owner ruling: source and diagram are
 * one view; the pane opens beside the canvas and never replaces it). It
 * opens on the LEFT of the canvas on the desktop row and stacks UNDER it on
 * the phone; the caller (DiagramViewer) owns that placement through this
 * component's `className`. A plain-text CodeMirror buffer, read-only
 * without edit access and never hidden. Save, Discard, "Draft · unsaved"
 * and the Reload strip live here; the canvas is the live preview. The
 * selected comment's source line shows as a line mark.
 *
 * Not the package MarkdownEditor (markdown extensions, continuous save):
 * the draft is local until Save.
 */

const LINE_MARK_CLASS = 'cm-diagram-comment-line';

const paneTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--card)',
    color: 'var(--card-foreground)',
    fontFamily: 'var(--font-mono)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  '.cm-gutters': {
    backgroundColor: 'var(--card)',
    color: 'var(--muted-foreground)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-content': { padding: '8px 0' },
  '.cm-line': { padding: '0 12px' },
  [`.${LINE_MARK_CLASS}`]: { backgroundColor: 'color-mix(in oklab, var(--primary) 18%, transparent)' },
});

function lineMarks(state: EditorState, range: readonly [number, number] | null): DecorationSet {
  if (range === null) return Decoration.none;
  const first = Math.max(1, Math.min(range[0], state.doc.lines));
  const last = Math.max(first, Math.min(range[1], state.doc.lines));
  const marks = [];
  for (let n = first; n <= last; n += 1) {
    marks.push(Decoration.line({ class: LINE_MARK_CLASS }).range(state.doc.line(n).from));
  }
  return Decoration.set(marks);
}

function Strip({
  tone,
  title,
  children,
  action,
  dataAttr,
}: {
  tone: 'accent' | 'destructive';
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  dataAttr: string;
}) {
  return (
    <div
      {...{ [dataAttr]: '' }}
      role={tone === 'destructive' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs',
        tone === 'destructive' ? 'border-destructive/40 bg-destructive/5 text-destructive' : 'border-primary/30 bg-primary/5 text-foreground',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {children !== undefined && <div className="mt-0.5 text-muted-foreground">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function DiagramSourcePane({
  draft,
  editable,
  markedLines,
  className,
}: {
  draft: DiagramSourceDraft;
  editable: boolean;
  /** The selected comment's source line range, marked in the gutter. */
  markedLines: readonly [number, number] | null;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableCompartment = useRef(new Compartment());
  const marksCompartment = useRef(new Compartment());
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // One view for the pane's life; props reconfigure compartments.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const editableExtensions = (on: boolean): Extension => [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: draftRef.current.draft,
        extensions: [
          lineNumbers(),
          history(),
          EditorView.lineWrapping,
          paneTheme,
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void draftRef.current.save();
                return true;
              },
            },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          editableCompartment.current.of(editableExtensions(editable)),
          marksCompartment.current.of(EditorView.decorations.of(Decoration.none)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) draftRef.current.setDraft(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial doc and editable value seed the state; later values
    // flow through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editableCompartment.current.reconfigure([EditorView.editable.of(editable), EditorState.readOnly.of(!editable)]),
    });
  }, [editable]);

  // Discard and Reload replace the buffer from outside; typing never
  // round-trips (the listener above already reported it).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === draft.draft) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: draft.draft },
    });
  }, [draft.draft]);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: marksCompartment.current.reconfigure(EditorView.decorations.of(lineMarks(view.state, markedLines))),
    });
    if (markedLines !== null && markedLines[0] <= view.state.doc.lines) {
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.line(markedLines[0]).from, { y: 'center' }),
      });
    }
  }, [markedLines]);

  return (
    <section
      data-diagram-source-pane=""
      aria-label="Diagram source"
      className={cn('flex min-h-0 flex-col bg-card', className)}
      // Escape LEAVES the buffer; it never reaches whatever is behind
      // the pane. In a popout that outer handler closes it, and one
      // keystroke mid-draft would take the pane, the preview and the
      // person's place with it.
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        viewRef.current?.contentDOM.blur();
      }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-medium text-foreground">Source</span>
        {editable && draft.dirty && (
          <span data-diagram-draft-state="" className="text-[10px] text-muted-foreground">
            Draft · unsaved
          </span>
        )}
        {!editable && <span className="text-[10px] text-muted-foreground">Read only</span>}
        <span className="flex-1" />
        {editable && (
          <>
            <Button type="button" variant="ghost" size="xs" disabled={!draft.dirty || draft.saving} onClick={draft.discard}>
              Discard
            </Button>
            <Button type="button" size="xs" disabled={!draft.dirty || draft.saving || draft.stale} onClick={() => void draft.save()}>
              {draft.saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      </div>
      {draft.stale && (
        <div className="shrink-0 border-b border-border p-2">
          <Strip
            tone="accent"
            dataAttr="data-diagram-reload-strip"
            title="Changed since you opened"
            action={
              <Button variant="outline" size="xs" onClick={draft.reload}>
                Reload
              </Button>
            }
          >
            {draft.dirty
              ? 'Someone saved a newer version. Reload to see it; your draft stays in the pane and Save is held until you do.'
              : 'Someone saved a newer version. Reload to see it.'}
          </Strip>
        </div>
      )}
      {draft.saveError !== null && (
        <div className="shrink-0 border-b border-border p-2">
          <Strip tone="destructive" dataAttr="data-diagram-save-error" title="The diagram was not saved">
            {draft.saveError}
          </Strip>
        </div>
      )}
      <div ref={hostRef} data-diagram-source-editor="" className="min-h-0 flex-1 overflow-hidden text-xs" />
    </section>
  );
}
