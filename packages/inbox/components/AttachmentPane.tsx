import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { inboxAttachmentKindLabel, isInboxTextKind, type InboxAnnotationRecord, type InboxAttachmentState, type InboxProjectRepo } from '@plannotator/core/inbox-types';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { useConfigValue } from '@plannotator/ui/config';
import type { Annotation, EditorMode, InputMethod } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { groupAnnotationsByDocument, type AnnotationScope } from '@plannotator/ui/utils/annotationScope';
import { InboxApiError, inboxApi, type AttachmentView } from '../api';
import {
  annotationOf,
  attachmentBlocks,
  attachmentDownloadUrl,
  CODE_HIGHLIGHT_MAX_CHARS,
  CODE_WRAP_LINE_CHARS,
  hasLineLongerThan,
  attachmentLabel,
  codeAnnotationOf,
  codeCommentAnnotation,
  codeCommentBlocks,
  codeRangeMatches,
  codeRangeOf,
  inboxViewKind,
} from '../attachments';
import { whenTime, formatBytes } from '../format';
import { titleIfClipped } from '../clipTitle';
import { useRefRepo } from '../links';
import { ImageAttachmentView } from './ImageAttachmentView';
import { AttachmentStepper, type StepSource } from './AttachmentStepper';
import { FIRST_NOTE, LAST_NOTE, stepAnnouncement, stepKeyIntent, type AttachmentStep } from '../stepping';
import { Icon } from '../icons';
import { FileName } from './FileName';
import { useNarrowerThan } from '../narrower';

/**
 * The pane width below which the 300 px comments panel folds into the
 * header's Comments button and opens over the file (as a phone's sheet does):
 * beside it the file would keep under 480 px. A file beside the thread at
 * 1280 px and wider, and a full-screen file, keep the panel docked.
 */
export const FOLD_PANEL_BELOW = 780;

export interface AttachmentPaneProps {
  attachment: InboxAttachmentState;
  /** Every attachment of the thread, for the panel's files and the strip. */
  attachments: readonly InboxAttachmentState[];
  /** The thread's annotations waiting for a Send. */
  records: readonly InboxAnnotationRecord[];
  agent: string;
  projectName: string;
  projectRoot: string;
  /** The project's git `origin`: bare `#123` refs in a markdown file link into it. */
  repo?: InboxProjectRepo | null;
  version: 'current' | 'sent';
  onVersion: (version: 'current' | 'sent') => void;
  full: boolean;
  /** Full screen is the only way the window can show the file (a phone, a narrow window: stack.ts), so there is no toggle. */
  fullLocked?: boolean;
  onToggleFull: () => void;
  /** An annotation to select when the file opens (from the chip's list). */
  focusId: string | null;
  readOnly: boolean;
  onSaved: (record: InboxAnnotationRecord) => void;
  onRemoved: (id: string) => void;
  /** Open another attachment (a card of another file in the panel). */
  onOpenAt: (attachmentId: string, version: 'current' | 'sent', annotationId: string) => void;
  onClose: () => void;
  /** Full screen's strip: what rides the next Send, and the way back. */
  strip: { picks: number; annotations: number; onBack: () => void; onWriteReply: () => void };
  /**
   * Bumped each time the person opens a file (its tile, or a link to it in
   * a message): keyboard focus moves into the pane, so a file opened full
   * screen is not left behind the control that opened it.
   */
  focusRequest?: number;
  /**
   * Every attachment of the thread in thread order (stepping.ts). With two or
   * more the bar under the file steps through them; one file keeps today's pane.
   */
  steps?: readonly AttachmentStep[];
  /**
   * Open another file of the thread in this pane, in the frame it is in now
   * (full screen stays full screen). The route is replaced, not pushed, so
   * Back returns to the thread in one press.
   */
  onStep?: (attachmentId: string, version: 'current' | 'sent') => void;
  /**
   * A phone (phone.ts): the file takes the whole window, the header leads
   * with Back to the thread, Previous / Next sit in the bar under it with a
   * swipe on a fitted image, and the annotations open as a sheet from the
   * header's Comments button instead of a column beside the file.
   */
  phone?: boolean;
}

/**
 * What the thread asks of an open pane: leave it (open another file, or close
 * it) once nothing unsaved would be lost. A typed comment raises the question
 * row first; `go` runs after "Save it and go on" or "Discard".
 */
export interface AttachmentPaneHandle {
  leave: (to: string | null, go: () => void) => void;
}

/**
 * A composer in the open file with words (or a drawing) not yet saved, or an
 * existing comment being edited whose words differ from the saved ones: its
 * textarea. `savedText` answers an annotation's saved words by id.
 */
export function unsavedComposer(pane: HTMLElement | null, savedText: (id: string) => string | undefined = () => undefined): HTMLTextAreaElement | null {
  const typed = (area: HTMLTextAreaElement) => area.value.trim() !== '';
  // Plannotator's comment popover (text, HTML pinpoint, code lines) draws in a portal on the page.
  for (const area of document.querySelectorAll<HTMLTextAreaElement>('[data-comment-popover] textarea')) {
    if (typed(area)) return area;
  }
  if (!pane) return null;
  for (const area of pane.querySelectorAll<HTMLTextAreaElement>('[data-diagram-composer] textarea, [data-image-composer] textarea')) {
    if (typed(area)) return area;
  }
  // An image drawn on but not yet commented.
  const drawn = pane.querySelector<HTMLElement>('[data-image-composer] .ib-markup');
  if (drawn) return pane.querySelector<HTMLTextAreaElement>('[data-image-composer] textarea');
  // A comment being edited (the annotation panel's card, a code line's inline comment, which Pierre may draw in its shadow root).
  const roots: ParentNode[] = [pane];
  for (const container of pane.querySelectorAll('diffs-container')) if (container.shadowRoot) roots.push(container.shadowRoot);
  for (const scope of roots) {
    for (const area of scope.querySelectorAll<HTMLTextAreaElement>('[data-annotation-id] textarea, [data-code-annotation-id] textarea')) {
      const owner = area.closest('[data-annotation-id], [data-code-annotation-id]');
      const id = owner?.getAttribute('data-annotation-id') ?? owner?.getAttribute('data-code-annotation-id') ?? '';
      if (area.value.trim() !== (savedText(id) ?? '').trim()) return area;
    }
  }
  return null;
}

/** The element that scrolls the open file (a document, code, or an image at its own size). */
function scrollerOf(pane: HTMLElement | null): HTMLElement | null {
  if (!pane) return null;
  const doc = pane.querySelector<HTMLElement>('.ib-docscroll');
  if (doc) return doc;
  const code = pane.querySelector('.ib-codeview diffs-container')?.shadowRoot?.querySelector<HTMLElement>('[data-code]');
  if (code) return code;
  return pane.querySelector<HTMLElement>('.ib-imgstage');
}

/** What the pane keeps per file until it closes: the version chosen, where it was read to, and the image's size. */
interface FileMemory {
  version?: 'current' | 'sent';
  scroll?: { top: number; left: number };
  fit?: 'fit' | 'actual';
}

const recordKey = (path: string, version: string) => (version === 'current' ? path : `${path}#${version.slice(0, 12)}`);

/**
 * An attachment opened (record 2.2 to 2.5): beside the thread for markdown,
 * diagrams and code (read-only, one highlighted code block), full screen for
 * HTML, with Plannotator's viewers and its annotation panel. The changed line offers the version the agent sent.
 */
export const AttachmentPane = forwardRef<AttachmentPaneHandle, AttachmentPaneProps>(function AttachmentPane(props, ref) {
  const { attachment, version } = props;
  const [view, setView] = useState<AttachmentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The text grew past what the window reads whole (413): the Download card instead.
  const [tooLarge, setTooLarge] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(props.focusId);
  const [unanchored, setUnanchored] = useState<ReadonlySet<string>>(new Set());
  const [inputMethod, setInputMethod] = useState<InputMethod>('drag');
  const [mode, setMode] = useState<EditorMode>('selection');
  const [armed, setArmed] = useState(true);
  const [scope, setScope] = useState<AnnotationScope>('all');
  const viewerRef = useRef<ViewerHandle>(null);
  // Plannotator's plan look (Settings, "Grid" or "Clean"), read from the same registry and cookie as its windows.
  const gridEnabled = useConfigValue('gridEnabled');

  // The current file cannot be read (gone, or no longer the file that was sent): the sent version opens.
  const currentUnavailable = attachment.unavailable !== null;
  const effectiveVersion = currentUnavailable ? 'sent' : version;
  // Data and log files are drawn as code (inboxViewKind).
  const kind = inboxViewKind(attachment.kind, attachment.name);
  // Text kinds read through the view route; an image draws from its own route, a PDF or a file downloads.
  const readsText = isInboxTextKind(kind);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setTooLarge(false);
    setError(null);
    setUnanchored(new Set());
    if (!readsText) return;
    inboxApi
      .view(attachment.id, effectiveVersion)
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof InboxApiError && cause.code === 'attachment_too_large') setTooLarge(true);
        else setError(cause instanceof InboxApiError ? cause.message : 'The file could not be opened.');
      });
    return () => {
      cancelled = true;
    };
    // A changed file on disk (a new hash) reads again.
  }, [attachment.id, effectiveVersion, attachment.current?.sha256, readsText]);

  useEffect(() => setSelectedId(props.focusId), [props.focusId, attachment.id]);

  // Below FOLD_PANEL_BELOW the comments panel folds into the header's button (a file beside the thread at about 920 to 1220 px).
  const [sectionRef, narrowPane] = useNarrowerThan<HTMLElement>(FOLD_PANEL_BELOW, false);
  useEffect(() => {
    if (props.focusRequest) sectionRef.current?.focus({ preventScroll: true });
  }, [props.focusRequest]);

  // ── Stepping (design record "inbox-attachment-stepping", v2) ──────────────
  const steps = props.steps ?? [];
  const index = steps.findIndex((s) => s.attachment.id === attachment.id);
  const multi = steps.length > 1 && index >= 0;
  const phone = props.phone === true;
  const [menuOpen, setMenuOpen] = useState(false);
  /** The panel folded (a phone, or a narrow pane): the header's button opens it as a sheet (inbox.css; a phone draws the panel's touch presentation inside it). */
  const folded = phone || narrowPane;
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  /** Close the sheet from inside it (its close, Escape): focus goes back to the button that opened it. */
  const closeSheet = () => {
    setSheet(false);
    sheetButtonRef.current?.focus({ preventScroll: true });
  };
  const [endNote, setEndNote] = useState<string | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [announced, setAnnounced] = useState('');
  const announce = useCallback((text: string) => {
    setAnnounced('');
    setTimeout(() => setAnnounced(text), 30);
  }, []);
  useEffect(
    () => () => {
      if (endTimer.current) clearTimeout(endTimer.current);
    },
    [],
  );
  /** The question row: a typed comment would be lost by what the person just did. */
  const [guard, setGuard] = useState<{ to: string | null; go: () => void } | null>(null);
  /** "Save it and go on" is waiting for the save to answer. */
  const [guardSaving, setGuardSaving] = useState(false);
  /** Every save the pane makes, counted, with the last one's answer: the question row waits on it. */
  const saves = useRef<{ count: number; last: Promise<boolean> | null }>({ count: 0, last: null });
  /** An annotation's saved words by id (an edit box differs from them when it holds unsaved words). */
  const savedTextRef = useRef<(id: string) => string | undefined>(() => undefined);
  savedTextRef.current = (id) => {
    const record = props.records.find((r) => r.id === id);
    if (!record) return undefined;
    const text = (record.annotation as { text?: unknown }).text;
    return typeof text === 'string' ? text : '';
  };
  const guardRef = useRef<HTMLDivElement>(null);
  const memory = useRef(new Map<string, FileMemory>());
  const remember = (id: string, patch: FileMemory) => memory.current.set(id, { ...memory.current.get(id), ...patch });
  /** How the last step was asked for, so focus lands in the right place once the next file is in. */
  const pendingStep = useRef<StepSource | null>(null);

  const rememberPlace = () => {
    const scroller = scrollerOf(sectionRef.current);
    if (scroller) remember(attachment.id, { scroll: { top: scroller.scrollTop, left: scroller.scrollLeft } });
  };
  /** Leave the open file for `to` (a name), or close it (null), unless a typed comment would be lost. */
  const leave = (to: string | null, go: () => void) => {
    if (!props.readOnly && unsavedComposer(sectionRef.current, savedTextRef.current)) {
      setMenuOpen(false);
      setGuard({ to, go });
      return;
    }
    rememberPlace();
    go();
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useImperativeHandle(ref, () => ({ leave: (to, go) => leaveRef.current(to, go) }), []);

  const showEnd = (text: string) => {
    setEndNote(text);
    announce(text);
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = setTimeout(() => setEndNote(null), 1800);
  };
  const goTo = (target: number, source: StepSource) => {
    const next = steps[target];
    if (!next || target === index) {
      setMenuOpen(false);
      return;
    }
    leave(next.attachment.name, () => {
      pendingStep.current = source;
      setMenuOpen(false);
      props.onStep?.(next.attachment.id, memory.current.get(next.attachment.id)?.version ?? 'current');
    });
  };
  const step = (dir: 1 | -1, source: StepSource) => {
    if (!multi) return;
    const target = index + dir;
    if (target < 0 || target >= steps.length) {
      showEnd(dir > 0 ? LAST_NOTE : FIRST_NOTE);
      return;
    }
    goTo(target, source);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  // Each file opens armed (Annotate) and without the last file's note; a step is announced once.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  useEffect(() => {
    setArmed(true);
    setEndNote(null);
    setGuard(null);
    setSheet(false);
    const source = pendingStep.current;
    pendingStep.current = null;
    if (!source) return;
    const at = stepsRef.current.findIndex((s) => s.attachment.id === attachment.id);
    if (at >= 0) announce(stepAnnouncement(stepsRef.current, at));
    // A key pressed in the document (or the HTML page) leaves focus on the pane; a bar button keeps it.
    if (source === 'key') sectionRef.current?.focus({ preventScroll: true });
  }, [attachment.id, announce]);

  // `]` `[` `→` `←` (stepping.ts has the rules for when they stand down).
  const full = props.full;
  const blocked = guard !== null || menuOpen;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  useEffect(() => {
    if (!multi) return;
    const onKey = (event: KeyboardEvent) => {
      const pane = sectionRef.current;
      // An image at its own size that overflows scrolls with the arrows.
      if (event.key.startsWith('Arrow') && pane?.querySelector('[data-claims-arrows="true"]')) return;
      const dir = stepKeyIntent(event, { full, pane, blocked });
      if (dir === null) return;
      event.preventDefault();
      stepRef.current(dir, 'key');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [multi, full, blocked]);

  // The question row takes focus on its first choice.
  useEffect(() => {
    if (guard) guardRef.current?.querySelector<HTMLButtonElement>('[data-guard-save]')?.focus();
  }, [guard]);
  const focusComposer = () => {
    const area = unsavedComposer(sectionRef.current, savedTextRef.current);
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }
  };
  const keepWriting = () => {
    setGuard(null);
    focusComposer();
  };
  /**
   * Save the typed comment, then go on only once the save answered. Every
   * composer saves on Cmd/Ctrl+Enter (the comment popover, the diagram's, the
   * image's own, an edit box). Nothing saved (the composer refused it): the
   * row stays and the words get focus. A failed save stays on the file with
   * the error.
   */
  const saveAndGo = async () => {
    const pending = guard;
    if (!pending || guardSaving) return;
    const area = unsavedComposer(sectionRef.current, savedTextRef.current);
    const before = saves.current.count;
    area?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }));
    setGuardSaving(true);
    // The composer submits and React draws its answer before the save is read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = saves.current.count > before ? saves.current.last : null;
    const ok = started ? await started : false;
    setGuardSaving(false);
    if (!started) {
      // Still typed and not saved: never lost. The row stays open over the words.
      if (unsavedComposer(sectionRef.current, savedTextRef.current)) {
        focusComposer();
        return;
      }
      setGuard(null);
      rememberPlace();
      pending.go();
      return;
    }
    setGuard(null);
    if (!ok) {
      focusComposer();
      return;
    }
    rememberPlace();
    pending.go();
  };
  const discardAndGo = () => {
    const pending = guard;
    if (guardSaving) return;
    setGuard(null);
    if (pending) {
      rememberPlace();
      pending.go();
    }
  };

  // Back on a file read before in this pane: where it was read to.
  useEffect(() => {
    const saved = memory.current.get(attachment.id)?.scroll;
    if (!saved || (readsText && !view)) return;
    let frames = 0;
    let id = 0;
    const apply = () => {
      const scroller = scrollerOf(sectionRef.current);
      if (scroller && scroller.scrollHeight - scroller.clientHeight >= saved.top) {
        scroller.scrollTop = saved.top;
        scroller.scrollLeft = saved.left;
        return;
      }
      if (++frames < 30) id = requestAnimationFrame(apply);
      else if (scroller) scroller.scrollTop = saved.top;
    };
    id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [attachment.id, view, readsText]);

  const annotationVersion = view?.version ?? (effectiveVersion === 'sent' ? attachment.sent_sha256 : 'current');
  const isHtml = kind === 'html';
  const isText = kind === 'markdown' || kind === 'text';
  const isCode = kind === 'code';
  const isImage = kind === 'image';
  // A PDF, any other file, and a kind this window does not know: offered as a download.
  const isDownload = kind === 'pdf' || kind === 'file' || tooLarge;
  const fileRecords = useMemo(
    () => props.records.filter((r) => r.path === attachment.path && r.version === annotationVersion),
    [props.records, attachment.path, annotationVersion],
  );
  const annotations = useMemo(() => fileRecords.map(annotationOf), [fileRecords]);
  // The document's blocks keep their identity across saves (the Viewer re-renders on a new array);
  // only code comments, which carry their own lines, derive blocks from the annotations.
  const documentBlocks = useMemo(() => (view && !isCode ? attachmentBlocks(kind, view.text, attachment.name) : []), [view, kind, isCode, attachment.name]);
  const commentBlocks = useMemo(() => (isCode ? codeCommentBlocks(annotations) : []), [isCode, annotations]);
  const blocks = isCode ? commentBlocks : documentBlocks;
  const refRepo = useRefRepo(props.repo);
  const wrapCode = useMemo(() => view !== null && isCode && hasLineLongerThan(view.text, CODE_WRAP_LINE_CHARS), [view, isCode]);
  // Code comments drawn under their lines; one whose lines no longer read as they did is unanchored, and so is a text
  // comment left on a data or log file before it was drawn as code (inboxViewKind).
  const codeAnnotations = useMemo(
    () => (isCode ? annotations.map((a) => codeAnnotationOf(a, attachment.name)).filter((a): a is NonNullable<typeof a> => a !== null) : []),
    [isCode, annotations, attachment.name],
  );
  useEffect(() => {
    if (!isCode || !view) return;
    const lines = view.text.split('\n');
    const moved = new Set<string>();
    for (const annotation of annotations) {
      const range = codeRangeOf(annotation);
      if (range ? !codeRangeMatches(range, lines.slice(range.lineStart - 1, range.lineEnd).join('\n')) : annotationOwnsHighlight(annotation)) moved.add(annotation.id);
    }
    setUnanchored(moved);
  }, [isCode, view, annotations]);

  // Paint the stored text highlights once per document read; a new comment paints itself.
  const painted = useRef<string | null>(null);
  useEffect(() => {
    if (!view || isHtml || isCode) return;
    const key = `${attachment.id}\0${view.version}\0${view.text.length}`;
    if (painted.current === key) return;
    painted.current = key;
    const id = requestAnimationFrame(() => viewerRef.current?.applySharedAnnotations(annotations.filter(annotationOwnsHighlight)));
    return () => cancelAnimationFrame(id);
  }, [view, attachment.kind, attachment.id, annotations]);

  const save = useCallback(
    (annotation: Annotation): Promise<boolean> => {
      const answer = (async () => {
        try {
          const result = await inboxApi.saveAnnotation(attachment.id, annotationVersion, annotation);
          props.onSaved(result.annotation);
          return true;
        } catch (cause) {
          setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
          return false;
        }
      })();
      saves.current = { count: saves.current.count + 1, last: answer };
      return answer;
    },
    [attachment.id, annotationVersion, props.onSaved],
  );

  const remove = async (id: string) => {
    viewerRef.current?.removeHighlight(id);
    try {
      await inboxApi.removeAnnotation(id);
      props.onRemoved(id);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not removed.');
    }
  };

  const edit = (id: string, updates: Partial<Annotation>) => {
    const record = props.records.find((r) => r.id === id);
    if (record) void save({ ...annotationOf(record), ...updates });
  };

  // The panel lists the thread's other files too, each under its own name (record 2.4).
  const documents = useMemo(() => {
    const byKey = new Map<string, { path: string; label: string; annotations: Annotation[] }>();
    for (const record of props.records) {
      const owner = props.attachments.find((a) => a.id === record.attachment_id) ?? attachment;
      const key = recordKey(record.path, record.version);
      const entry = byKey.get(key) ?? {
        path: key,
        label: `${attachmentLabel(owner, props.projectRoot)}${record.version === 'current' ? '' : ' (sent)'}`,
        annotations: [],
      };
      entry.annotations.push(annotationOf(record));
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }, [props.records, props.attachments, props.projectRoot, attachment]);
  const currentKey = recordKey(attachment.path, annotationVersion);
  const otherFiles = documents.some((d) => d.path !== currentKey);
  // A PDF or any other download takes no comments: no panel (nor a Comments button) unless other files have comments to list.
  const hasPanel = !isDownload || otherFiles;
  const groups = useMemo(() => groupAnnotationsByDocument(documents, currentKey), [documents, currentKey]);
  const openInDocument = (_path: string, id: string) => {
    const record = props.records.find((r) => r.id === id);
    if (!record) return;
    if (recordKey(record.path, record.version) === currentKey) setSelectedId(id);
    else {
      const owner = props.attachments.find((a) => a.id === record.attachment_id);
      leave(owner?.name ?? 'that file', () => props.onOpenAt(record.attachment_id, record.version === 'current' ? 'current' : 'sent', id));
    }
  };

  const chooseVersion = (next: 'current' | 'sent') => {
    remember(attachment.id, { version: next });
    props.onVersion(next);
  };
  const close = () => leave(null, props.onClose);

  const sentAt = whenTime(attachment.sent_at);
  let line: React.ReactNode = null;
  if (currentUnavailable) {
    line = (
      <>
        {attachment.unavailable!.message} This is the version {props.agent} sent at {sentAt}.
      </>
    );
  } else if (effectiveVersion === 'sent') {
    line = (
      <>
        The version {props.agent} sent at {sentAt}.
        <button type="button" className="ib-vlink" onClick={() => chooseVersion('current')}>
          Open the file as it is now
        </button>
      </>
    );
  } else if ((view?.attachment ?? attachment).changed_since_sent) {
    const current = (view?.attachment ?? attachment).current;
    line = (
      <>
        Changed since {props.agent} sent it at {sentAt}.{current ? ` Edited ${whenTime(current.mtime)}.` : ''}
        <button type="button" className="ib-vlink" onClick={() => chooseVersion('sent')}>
          Open the version it sent
        </button>
      </>
    );
  }

  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of props.records) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
    return counts;
  }, [props.records]);

  const chipText = [
    props.strip.picks > 0 ? `${props.strip.picks} pick${props.strip.picks === 1 ? '' : 's'}` : null,
    `${props.strip.annotations} annotation${props.strip.annotations === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <section
      ref={sectionRef}
      onPointerOver={titleIfClipped}
      tabIndex={-1}
      className={`ib-view${full ? ' ib-full' : ''}${phone ? ' ib-phone' : ''}${folded && !phone ? ' ib-fold' : ''}${hasPanel ? '' : ' ib-nopanel'}${folded && sheet ? ' ib-panel-open' : ''}`}
      aria-label={multi ? `${attachment.name}, attachment ${index + 1} of ${steps.length}` : attachment.name}
      data-attachment-pane={attachment.id}
      data-version={effectiveVersion}
    >
      <div className="ib-vhead">
        {/* A phone's way back to the thread (through the unsaved-comment guard, as the desktop's close). */}
        {phone && (
          <button type="button" className="ib-pback" onClick={close} aria-label="Back to the thread" data-phone-back="">
            <Icon name="chevL" size={18} />
          </button>
        )}
        {/* With more than one file the bar under the file names it (a phone's bar has no room for the name). */}
        {(!multi || phone) && (
          <span className="ib-fn" data-header-name="">
            <FileName name={attachment.name} />
          </span>
        )}
        <span className="ib-from">
          from {props.agent} in {props.projectName}
        </span>
        <span className="ib-sp" />
        {isHtml && <HtmlSurfaceControls armed={armed} onToggleArmed={props.readOnly ? undefined : () => setArmed((v) => !v)} />}
        <a
          className="ib-btn ib-sm ib-ghost"
          href={attachmentDownloadUrl(attachment, effectiveVersion)}
          download={attachment.name}
          title={`Download ${attachment.name}${effectiveVersion === 'sent' ? ' (the version it sent)' : ''}`}
          aria-label={phone ? `Download ${attachment.name}` : undefined}
          data-attachment-download=""
        >
          <Icon name="download" size={14} />
          {!phone && 'Download'}
        </a>
        {folded && hasPanel && (
          <button
            type="button"
            ref={sheetButtonRef}
            className={`ib-btn ib-sm ib-vcomments${sheet ? ' ib-on' : ''}`}
            onClick={() => setSheet((v) => !v)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && sheet && !event.defaultPrevented) {
                event.preventDefault();
                closeSheet();
              }
            }}
            aria-expanded={sheet}
            aria-controls={sheetId}
            aria-label={`Comments, ${annotations.length}`}
            title="Comments"
            data-annotations-sheet=""
          >
            <Icon name="comment" size={15} />
            {annotations.length}
          </button>
        )}
        {!phone && (
          <>
            {!props.fullLocked && (
              <button type="button" className="ib-btn ib-sm" onClick={props.onToggleFull}>
                <Icon name={props.full ? 'collapse' : 'expand'} size={14} />
                {props.full ? 'Exit full screen' : 'Full screen'}
              </button>
            )}
            <button type="button" className="ib-iconbtn" onClick={close} aria-label={`Close ${attachment.name}`} title="Close">
              <Icon name="x" />
            </button>
          </>
        )}
      </div>
      {line ? (
        <div className="ib-changed" data-changed-line="">
          <Icon name="info" size={14} />
          {line}
        </div>
      ) : (
        <div />
      )}
      <div className="ib-vbody">
        <div className={`ib-docarea${isHtml ? ' ib-html' : ''}`}>
          {error && (
            <div className="ib-error ib-view-error" role="alert">
              {error}
            </div>
          )}
          {view && isHtml && view.html !== null && (
            <div className="ib-htmlframe">
            <HtmlViewer
              key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
              rawHtml={view.html}
              title={attachment.name}
              annotations={annotations}
              onAddAnnotation={(annotation) => void save(annotation)}
              onSelectAnnotation={setSelectedId}
              selectedAnnotationId={selectedId}
              mode="selection"
              inputMethod="pinpoint"
              annotateModeActive={armed}
              onAnnotateModeExit={() => setArmed(false)}
              onAnnotateModeToggle={() => setArmed((v) => !v)}
              // A plain ] or [ pressed in the page while armed (the bridge forwards nothing in Interact).
              onStep={multi ? (dir) => !blockedRef.current && armed && stepRef.current(dir, 'key') : undefined}
              onOpenLink={(href) => {
                if (/^https?:\/\//i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
              }}
              onUnanchoredChange={(ids) => setUnanchored(new Set(ids))}
              fullViewport
              hideControls
              maxAdditionalTargets={0}
              readOnly={props.readOnly}
            />
            </div>
          )}
          {view && isText && !props.readOnly && (
            <div className="ib-toolstrip">
              <AnnotationToolstrip
                inputMethod={inputMethod}
                onInputMethodChange={setInputMethod}
                mode={mode}
                onModeChange={setMode}
                showHelpLink={false}
                hideQuickLabel
                compact
              />
            </div>
          )}
          {isImage && (
            <ImageAttachmentView
              // Its own comment box per file: typed text never carries over to the next image.
              key={attachment.id}
              attachment={attachment}
              version={effectiveVersion}
              annotations={annotations}
              selectedId={selectedId}
              readOnly={props.readOnly}
              onSave={save}
              onError={setError}
              initialFit={memory.current.get(attachment.id)?.fit}
              onFitChange={(fit) => remember(attachment.id, { fit })}
              onSwipe={multi ? (dir) => step(dir, 'key') : undefined}
            />
          )}
          {isDownload && (
            <div className="ib-docscroll" data-download-card="">
              <div className="ib-att-t ib-dlcard">
                <span className="ib-fi">
                  <Icon name={kind === 'pdf' ? 'doc' : 'cube'} size={18} />
                </span>
                <span className="ib-att-text">
                  <FileName name={attachment.name} className="ib-nm" wrap />
                  <span className="ib-kd">
                    {inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type)}, {formatBytes(attachment.current?.size ?? attachment.size)}. {tooLarge ? 'It is too large to show here; download it to open it.' : 'Plannotator does not show this kind of file; download it to open it.'}
                  </span>
                </span>
                <a className="ib-btn ib-pri" href={attachmentDownloadUrl(attachment, effectiveVersion)} download={attachment.name}>
                  <Icon name="download" size={14} />
                  Download
                </a>
              </div>
            </div>
          )}
          {view && isCode && (
            <div className="ib-codeview" data-code-view="">
              {!props.readOnly && <div className="ib-codehint">Click a line number, drag across lines, or select code to comment.</div>}
              <CodeFileView
                key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
                filepath={attachment.name}
                contents={view.text}
                annotations={codeAnnotations}
                selectedAnnotationId={selectedId}
                onSelectAnnotation={setSelectedId}
                onAddAnnotation={
                  props.readOnly
                    ? undefined
                    : (input) =>
                        void save(
                          codeCommentAnnotation({
                            id: `ann-code-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36)}`,
                            lineStart: input.lineStart,
                            lineEnd: input.lineEnd,
                            text: input.text,
                            code: input.originalCode,
                          }),
                        )
                }
                onEditAnnotation={props.readOnly ? undefined : (id, updates) => edit(id, { text: updates.text })}
                onDeleteAnnotation={props.readOnly ? undefined : (id) => void remove(id)}
                allowImages={false}
                lang={view.text.length > CODE_HIGHLIGHT_MAX_CHARS ? 'text' : undefined}
                // A minified file's one line wraps (no toggle: a line this long is never read by scrolling sideways).
                overflow={wrapCode ? 'wrap' : undefined}
                className="ib-codebody"
              />
            </div>
          )}
          {view && !isHtml && !isCode && (
            <div className={`ib-docscroll ${gridEnabled ? 'bg-grid' : 'bg-card'}`} data-look={gridEnabled ? 'grid' : 'clean'}>
              <Viewer
                key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
                ref={viewerRef}
                blocks={blocks}
                markdown={view.text}
                annotations={annotations}
                onAddAnnotation={(annotation) => void save(annotation)}
                onSelectAnnotation={setSelectedId}
                selectedAnnotationId={selectedId}
                mode={isText ? mode : 'comment'}
                inputMethod={isText ? inputMethod : 'drag'}
                taterMode={false}
                gridEnabled={gridEnabled}
                maxWidth={full ? 760 : 640}
                stickyActions={false}
                disableCodePathValidation
                copyLabel="Copy file"
                allowImages={false}
                refRepo={refRepo}
                readOnly={props.readOnly}
                onRestoreReport={(report) => setUnanchored(new Set(report.unanchored))}
              />
            </div>
          )}
        </div>
        <div
          className="ib-apanel"
          id={sheetId}
          role={folded ? 'region' : undefined}
          aria-label={folded ? 'Comments' : undefined}
          onKeyDown={(event) => {
            // Escape closes the open sheet, unless something inside (an edit box) already used it.
            if (event.key === 'Escape' && folded && sheet && !event.defaultPrevented) {
              event.preventDefault();
              closeSheet();
            }
          }}
        >
          {/* The folded panel's sheet: its own title and close (a phone's touch presentation has neither). */}
          {folded && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{annotations.length}</span>
              <span className="ib-sp" />
              <button type="button" className="ib-iconbtn" onClick={closeSheet} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          <AnnotationPanel
            // A folded panel draws its timeline inside the sheet, under the sheet's own title and close (and a phone's window-wide overlay below 768 px would have no close here).
            presentation={folded ? 'embedded' : undefined}
            emptyHint={isImage ? 'Comment below the image' : isCode ? 'Click a line to comment' : undefined}
            isOpen
            annotations={annotations}
            blocks={blocks}
            onSelect={(id) => {
              setSelectedId(id);
              // A folded panel steps aside to show the comment in the file.
              if (folded) setSheet(false);
            }}
            onDelete={(id) => void remove(id)}
            onEdit={edit}
            selectedId={selectedId}
            width="100%"
            readOnly={props.readOnly}
            unanchoredIds={unanchored}
            annotationScope={otherFiles ? scope : undefined}
            onAnnotationScopeChange={otherFiles ? setScope : undefined}
            documentGroups={otherFiles ? groups : undefined}
            onSelectInDocument={openInDocument}
            onDeleteInDocument={(_path, id) => void remove(id)}
            onEditInDocument={(_path, id, updates) => edit(id, updates)}
          />
        </div>
      </div>
      {guard ? (
        <div
          className="ib-stepguard"
          role="group"
          aria-labelledby="ib-guard-text"
          ref={guardRef}
          data-step-guard=""
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            keepWriting();
          }}
        >
          <Icon name="comment" size={15} />
          <span className="ib-gt" id="ib-guard-text">
            Your comment on <b>{attachment.name}</b> is not saved yet.
          </span>
          <button type="button" className="ib-btn ib-sm ib-pri" onClick={() => void saveAndGo()} disabled={guardSaving} aria-busy={guardSaving || undefined} data-guard-save="">
            {guard.to === null ? 'Save it and close' : 'Save it and go on'}
          </button>
          <button type="button" className="ib-btn ib-sm" onClick={discardAndGo} disabled={guardSaving} data-guard-discard="">
            {guard.to === null ? 'Discard and close the file' : <span className="ib-gto">Discard and go to <FileName name={guard.to} /></span>}
          </button>
          <button type="button" className="ib-btn ib-sm ib-ghost" onClick={keepWriting} data-guard-keep="">
            Keep writing
          </button>
        </div>
      ) : (
        <div />
      )}
      {props.full || multi || phone ? (
        <div className={`ib-vfoot${phone ? ' ib-vfoot-phone' : ''}`} data-view-foot="">
          {multi && (
            <AttachmentStepper
              steps={steps}
              index={index}
              phone={phone}
              menuOpen={menuOpen}
              onMenuOpenChange={setMenuOpen}
              onStep={step}
              onGo={(target) => goTo(target, 'menu')}
              endNote={endNote}
              annotationCounts={annotationCounts}
            />
          )}
          {phone ? (
            <div className="ib-vfoot-row" data-view-strip="">
              <span className="ib-rchip" data-strip-chip="">
                {chipText}
              </span>
              <span className="ib-l ib-sp">ride your next Send</span>
              <button type="button" className="ib-btn ib-pri ib-sm" onClick={() => leave(null, props.strip.onWriteReply)}>
                <Icon name="reply" size={14} />
                Write the reply
              </button>
            </div>
          ) : (
            <>
              <span className="ib-sp" />
              {props.full && (
                <span className="ib-vreply" data-view-strip="">
                  <span className="ib-l">Reply to {props.agent}</span>
                  <span className="ib-rchip" data-strip-chip="">
                    {chipText}
                  </span>
                  <span className="ib-l">ride your next Send.</span>
                  <button type="button" className="ib-btn" onClick={() => leave(null, props.strip.onBack)}>
                    <Icon name="back" size={15} />
                    Back to the thread
                  </button>
                  <button type="button" className="ib-btn ib-pri" onClick={() => leave(null, props.strip.onWriteReply)}>
                    <Icon name="reply" size={15} />
                    Write the reply
                  </button>
                </span>
              )}
            </>
          )}
        </div>
      ) : (
        <div />
      )}
      <div className="ib-sr" aria-live="polite" data-step-live="">
        {announced}
      </div>
    </section>
  );
});
