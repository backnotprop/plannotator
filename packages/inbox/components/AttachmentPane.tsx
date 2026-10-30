import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MentionSource } from '@plannotator/ui/utils/mentions';
import {
  formatInboxVideoTime,
  inboxAttachmentKindLabel,
  inboxVideoMeta,
  isInboxTextKind,
  readInboxVideoTime,
  type InboxAnnotationRecord,
  type InboxAttachmentState,
  type InboxProjectRepo,
} from '@plannotator/core/inbox-types';
import { CodeFileView } from '@plannotator/ui/components/CodeFilePopout';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { HtmlViewer } from '@plannotator/ui/components/html-viewer';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import type { Annotation, EditorMode, InputMethod } from '@plannotator/ui/types';
import { annotationOwnsHighlight } from '@plannotator/ui/utils/annotationOwnsHighlight';
import { groupAnnotationsByDocument, type AnnotationScope } from '@plannotator/ui/utils/annotationScope';
import { InboxApiError, type AttachmentView, type LinkedPageView } from '../api';
import { selectionOnPhrase, useInboxFileSource } from '../fileSource';
import { folderOf, resolveInboxHtmlLink } from '../htmlLinks';
import { htmlAssetRouteFromDocument } from '@plannotator/ui/utils/htmlLinkNavigation';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import {
  annotationOf,
  attachmentBlocks,

  CODE_HIGHLIGHT_MAX_CHARS,
  CODE_WRAP_LINE_CHARS,
  hasLineLongerThan,
  attachmentLabel,
  codeAnnotationOf,
  codeCommentAnnotation,
  codeCommentBlocks,
  codeRangeMatches,
  codeRangeOf,
  compareVideoTimes,
  inboxViewKind,
} from '../attachments';
import { whenTime, formatBytes } from '../format';
import { useRefRepo } from '../links';
import { inboxMarkdownImageBase } from '../images';
import { ImageAttachmentView, type ImageSwipeEdges } from './ImageAttachmentView';
import type { WheelHintGate } from '@plannotator/ui/components/ImageZoomStage';
import { VideoAttachmentView, type VideoAttachmentViewHandle } from './VideoAttachmentView';
import { OpenInControl, type OpenInSurface } from './OpenIn';
import { AttachmentStepper, type StepSource } from './AttachmentStepper';
import { FIRST_NOTE, LAST_NOTE, stepAnnouncement, stepIndexOf, stepKeyIntent, type AttachmentStep } from '../stepping';
import { Icon } from '../icons';
import { FileName } from './FileName';
import { useNarrowerThan } from '../narrower';
import { FullViewBar, type FullViewBarHandle, type ToolbarState } from './FullViewBar';
import { FullScreenComposer, FullScreenComposerContext, type FullScreenComposerValue } from './FullScreenComposer';
import { pickComposerMode, setComposerMinimized } from '../fullScreenComposer';
import { FilePeek, peekSheetHost } from './AttachmentStepper';
import { FullScreenMore } from './OpenIn';
import { fileSwipeMode, prefersReducedMotion, useFileSwipe } from '../fileSwipe';
import { FileSwipeCard } from './FileSwipeCard';
import { ImageSwipePeek, isImageStep } from './ImageSwipePeek';
import { OptionCaption } from './OptionCaption';
import { FIRST_OPTION_NOTE, LAST_OPTION_NOTE, optionAnnouncement, type OptionSet } from '../optionSets';
import { createPortal } from 'react-dom';
import type { Notice } from './Markup';
import { MarkupPicture } from './Markup';
import { isWordlessMarkup, MARKUP_ONLY_TEXT } from '../markup';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { inboxFileViewerShortcuts } from '../shortcuts/fileViewer.shortcuts';
import { ShortcutHint, withShortcut } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { escapeRung, type EscapeRung } from '../escapeLadder';
import { storage } from '@plannotator/ui/utils/storage';
import { Tip } from './Tip';
import { CopyFileButton } from './CopyFileButton';

/**
 * The pane width below which the 300 px comments panel beside the thread
 * folds into the header's Comments button and opens over the file (as a
 * phone's sheet does): beside it the file would keep under 480 px. A file
 * beside the thread at 1280 px and wider keeps the panel docked; full screen
 * has its own drawer.
 */
export const FOLD_PANEL_BELOW = 780;

/** How long the note says why a link in an attached page opened nothing. */
export const LINK_NOTE_MS = 5000;

/** A page an attached HTML page links to, shown read-only over it: its path in the page's folder and the fragment its link named. */
type LinkedPage = LinkedPageView & { relative: string; hash: string; attachmentId: string };

/** The route's `linked=` value: the page's path in the folder, then `#fragment`. */
export function linkedValue(relative: string, hash: string): string {
  return hash ? `${relative}#${hash}` : relative;
}

export function splitLinked(value: string): { relative: string; hash: string } {
  const at = value.indexOf('#');
  return at < 0 ? { relative: value, hash: '' } : { relative: value.slice(0, at), hash: value.slice(at + 1) };
}

/** The space between full screen's changed note and the code's top row, which grows under the note (Copy file stays clear of it). */
export const CODE_ROW_BELOW_NOTE = 8;

/** How long full screen's step chip names the new file. */
export const FULL_VIEW_CHIP_MS = 1600;

/** What sits at a file's foot in full screen (an image's or a film's comment row, a phone's "Comment at"): the toolbar, the chips and the toast keep above it. */
export const FILE_FOOT_ROW = '[data-image-composer], [data-file-foot]';

/**
 * The file's foot row as drawn: the first FILE_FOOT_ROW that is not hidden (full screen's composer keeps
 * the comment row drawn but `hidden` while the card is minimized, and the pill is then the foot).
 */
export function fileFootRow(section: ParentNode): HTMLElement | null {
  for (const row of section.querySelectorAll<HTMLElement>(FILE_FOOT_ROW)) if (!row.closest('[hidden]')) return row;
  return null;
}

/** Hide / Show tools: the html-annotate scope's existing chord (⌘⇧X), HTML files only, through the file viewer's scope. */
const TOOLS_CHORD = inboxFileViewerShortcuts.shortcuts.toggleTools.bindings[0]!;

/**
 * Composers that close on Escape and would drop what was typed: a comment
 * popover (text, HTML pinpoint, a code line's new comment), a diagram's
 * composer, and an existing comment being edited (the panel's card, a code
 * line's inline comment).
 */
const CLOSING_COMPOSERS = '[data-comment-popover], [data-diagram-composer], [data-annotation-id], [data-code-annotation-id]';

/** Drafts that close themselves on this same Escape (their own window listener): the selection toolbar, the quick-label picker. */
const SELF_CLOSING_DRAFTS = '[data-pn-annotation-toolbar-row], [data-quick-label-picker]';

/** Escapes the pane sends to a composer itself (to close it): never asked about, never a rung of their own. */
const paneEscapes = new WeakSet<Event>();

/** The element a node lives under in the page: its shadow host when it is inside a shadow root (Pierre's code view). */
function hostOf(node: Node): Node {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : node;
}

/**
 * Whether full screen's comments drawer was left open (approval
 * "inbox-one-fullscreen": remembered, never opened by itself). Cookie only.
 */
export const COMMENTS_DRAWER_COOKIE = 'plannotator-inbox-file-comments';

export interface AttachmentPaneProps {
  attachment: InboxAttachmentState;
  /** The file is in the person's own message (an image their reply shows): the header and the changed line say "You", not the agent. */
  fromPerson?: boolean;
  /** Every attachment of the thread, for the panel's files and the strip. */
  attachments: readonly InboxAttachmentState[];
  /** The thread's annotations waiting for a Send. */
  records: readonly InboxAnnotationRecord[];
  /**
   * Tag agents with `@` in a comment (approval "inbox-tag-agents"): markdown, text and HTML files. The
   * image, video, code and diagram comment boxes take none yet.
   */
  mentionSource?: MentionSource;
  agent: string;
  projectName: string;
  projectRoot: string;
  /** The project's git `origin`: bare `#123` refs in a markdown file link into it. */
  repo?: InboxProjectRepo | null;
  version: 'current' | 'sent';
  onVersion: (version: 'current' | 'sent') => void;
  /**
   * Full screen (approval "inbox-one-fullscreen"): the file fills the window
   * and one floating toolbar is left (FullViewBar), with the comments in a
   * drawer beside the page. Otherwise the file sits beside the thread with
   * its header.
   */
  full: boolean;
  /** Full screen is the only way the window can show the file (a phone, a narrow window: stack.ts): the toolbar leads with Back to the thread instead of Side by side. */
  fullLocked?: boolean;
  /**
   * × and Escape's last rung close the file, back to the thread (fullScreenOrigin.ts): a full screen opened from
   * the thread alone, and wherever the file can only be full screen. False: they put the file back beside the
   * thread, where it was before full screen. Absent: only where it can only be full screen.
   */
  exitCloses?: boolean;
  /**
   * The name of the file × and Escape's last rung go back to when it is another file than this one (a full screen
   * opened over a file beside the thread): leaving this file, they ask first about a comment not saved yet.
   */
  exitLeavesFor?: string | null;
  /** `pick`: the person chose with a button (remembered); Escape's last rung is not a pick. */
  onToggleFull: (pick: boolean) => void;
  /** The view switch's pressed half: the view on screen becomes the remembered one; the frame stays. */
  onKeepView?: () => void;
  /** An annotation to select when the file opens (from the chip's list). */
  focusId: string | null;
  readOnly: boolean;
  onSaved: (record: InboxAnnotationRecord) => void;
  onRemoved: (id: string) => void;
  /** Open another attachment (a card of another file in the panel). */
  onOpenAt: (attachmentId: string, version: 'current' | 'sent', annotationId: string) => void;
  onClose: () => void;
  /** Full screen's comments foot: what rides the next Send, and the way to the reply. */
  strip: { picks: number; annotations: number; onWriteReply: () => void };
  /**
   * Full screen's composer (approval "inbox-fullscreen-composer"): the thread's
   * reply, and the file's comment row, in one card floating at the foot of an
   * image, a film or an HTML page. Null or absent: none (the thread is
   * archived, or the file is beside the thread).
   */
  composer?: FullScreenComposerValue | null;
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
   * Every file of the thread, when `steps` is fewer (a question's picture
   * choices, `optionSet`): the pill's sheet and the stepper's peek list these,
   * so the thread's other files are a tap away. Absent: `steps`.
   */
  allSteps?: readonly AttachmentStep[];
  /**
   * The question's picture choices `steps` are (optionSets.ts, approval
   * "inbox-image-swipe"): full screen captions the choice on screen, and the
   * ends say "Last option" / "First option". Absent: the thread's files.
   */
  optionSet?: OptionSet | null;
  /**
   * A phone (phone.ts): always full screen; the toolbar sits bottom right
   * with 44 px targets and leads with Back to the thread, its `4/9 ⌄` pill
   * opens every file of the thread, a sideways swipe on the file steps
   * (fileSwipe.ts; an image too: approval "inbox-image-swipe"), and the comments open as a
   * bottom sheet instead of a drawer.
   */
  phone?: boolean;
  /**
   * A link in an attached HTML page names another file of the thread: open it
   * in this pane as a new history entry (Back returns to the page), in the
   * frame it is in now. Absent: `onStep`.
   */
  onOpenLinked?: (attachmentId: string) => void;
  /**
   * The page the attached HTML page links to that is on screen (the route's
   * `linked=`: its path in the page's folder, `#fragment` kept), or null.
   */
  linked?: string | null;
  /** Show another linked page (null: the attached page). `back`: the browser's Back when it leads there; `replace`: no new entry. */
  onLinked?: (linked: string | null, options?: { back?: boolean; replace?: boolean }) => void;
  /**
   * "Open in" (OpenIn.tsx): the split button on this computer (`apps`), the
   * new-tab icon through the tailnet or on a phone (`tab`). Absent: neither.
   */
  openIn?: OpenInSurface;
  /** The window's toast: a drawing added to the reply says so, with Undo. */
  onToast?: Notice;
}

/**
 * What the thread asks of an open pane: leave it (open another file, or close
 * it) once nothing unsaved would be lost. A typed comment raises the question
 * row first; `go` runs after "Save it and go on" or "Discard".
 */
export interface AttachmentPaneHandle {
  leave: (to: string | null, go: () => void) => void;
  /** Out of full screen the way × goes (back beside the thread, or the file closes), asking first about a typed comment. */
  exitFull: () => void;
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

/**
 * A comment box's suggestion (the tour's, FileSuggestion) for words selected in a text file: offered when
 * the selection is on its phrase (selectionOnPhrase); a stray selection, a single word of it included, opens an empty box.
 */
export function suggestionFor(_text: string, suggestion: { phrase?: string; comment: string }, selected: string): string | undefined {
  return suggestion.phrase && selectionOnPhrase(suggestion.phrase, selected) ? suggestion.comment : undefined;
}

/** What the pane keeps per file until it closes: the version chosen, where it was read to, and the image's size. */
interface FileMemory {
  version?: 'current' | 'sent';
  scroll?: { top: number; left: number };
  fit?: 'fit' | 'actual';
}

const NO_ANNOTATIONS: Annotation[] = [];
const noop = () => {};

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
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const source = useInboxFileSource();
  const suggestion = source.suggestion?.(attachment) ?? null;

  // The current file cannot be read (gone, or no longer the file that was sent): the sent version opens.
  const currentUnavailable = attachment.unavailable !== null;
  const effectiveVersion = currentUnavailable ? 'sent' : version;
  // Images in a Markdown file load relative to its folder, for the version on screen (#2228); one
  // that cannot load is drawn as its alt text, as in a message body (Thread.tsx).
  const imageBaseDir = inboxMarkdownImageBase(attachment.id, effectiveVersion);
  const resolveImage = useCallback<ImageResolver>(
    (src) => ({ kind: 'src', src: /^(https?:|data:|blob:)/i.test(src) ? src : getImageSrc(src, imageBaseDir) }),
    [imageBaseDir],
  );
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
    source
      .view(attachment, effectiveVersion)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment.id, effectiveVersion, attachment.current?.sha256, readsText, source]);

  useEffect(() => setSelectedId(props.focusId), [props.focusId, attachment.id]);

  // Below FOLD_PANEL_BELOW the comments panel folds into the header's button (a file beside the thread at about 920 to 1220 px).
  const [sectionRef, narrowPane] = useNarrowerThan<HTMLElement>(FOLD_PANEL_BELOW, false);
  useEffect(() => {
    if (props.focusRequest) sectionRef.current?.focus({ preventScroll: true });
  }, [props.focusRequest]);

  // ── Stepping (design record "inbox-attachment-stepping", v2) ──────────────
  const steps = props.steps ?? [];
  const index = stepIndexOf(steps, attachment.id);
  const multi = steps.length > 1 && index >= 0;
  /** A question's picture choices (optionSets.ts): what the pane steps through; the sheet still lists `allSteps`. */
  const optionSet = multi && props.optionSet ? props.optionSet : null;
  const optionSetRef = useRef(optionSet);
  optionSetRef.current = optionSet;
  const allSteps = props.allSteps ?? steps;
  const allIndex = stepIndexOf(allSteps, attachment.id);
  const phone = props.phone === true;
  const [menuOpen, setMenuOpen] = useState(false);
  /** Full screen (approval "inbox-one-fullscreen"): the file fills the window under one floating toolbar. */
  const full = props.full;
  /** Full screen's composer: an image, a film and an HTML page draw it (the comment row of the first two goes inside it). */
  const hasComposer = full && !!props.composer && (kind === 'image' || kind === 'video' || kind === 'html');
  /** The toolbar: showing (pinned), tucked into its corner handle, or out for a moment (revealed). Every opening of full screen starts showing. */
  const [toolbar, setToolbar] = useState<ToolbarState>('pinned');
  const barRef = useRef<FullViewBarHandle>(null);
  /** ⋯ is open (a popover of the toolbar: it does not tuck while open). */
  const [moreOpen, setMoreOpen] = useState(false);
  /** Beside the thread in a narrow pane: the header's button opens the panel as a sheet over the file (inbox.css). */
  const folded = !full && (phone || narrowPane);
  /** Full screen on a desktop: the comments are a drawer beside the page, which narrows (not covered). */
  const drawerMode = full && !phone;
  /** Where the panel is a sheet over the file: folded beside the thread, or full screen on a phone (a bottom sheet). */
  const sheetMode = folded || (full && phone);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    if (!sheetMode) setSheet(false);
  }, [sheetMode]);
  /** The drawer: remembered open or closed, never opened by itself (a new comment only bumps the count). */
  const [drawer, setDrawerOpen] = useState(() => storage.getItem(COMMENTS_DRAWER_COOKIE) === 'open');
  const setDrawer = (open: boolean) => {
    setDrawerOpen(open);
    storage.setItem(COMMENTS_DRAWER_COOKIE, open ? 'open' : 'closed');
  };
  /** The panel is open: the drawer in full screen on a desktop, else the sheet. */
  const panelOpen = drawerMode ? drawer : sheetMode && sheet;
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  /** Focus back on what opens the panel: the count (or, with the toolbar tucked, its handle), else the header's button. */
  const focusPanelButton = () => {
    const button = sheetButtonRef.current;
    const target = button && !button.closest('[inert]') ? button : full ? sectionRef.current?.querySelector<HTMLElement>('[data-full-view-handle]') : null;
    target?.focus({ preventScroll: true });
  };
  /** Close the panel from inside it (its close, Escape): focus goes back to the button that opened it. */
  const closeSheet = () => {
    if (drawerMode) setDrawer(false);
    else setSheet(false);
    focusPanelButton();
    // A phone's toolbar is hidden under its open sheet: focus lands once it shows again.
    if (phone) requestAnimationFrame(focusPanelButton);
  };
  const togglePanel = () => {
    setMenuOpen(false);
    if (drawerMode) setDrawer(!drawer);
    else setSheet((v) => !v);
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
  const [guard, setGuard] = useState<{ to: string | null; go: () => void; escape?: HTMLTextAreaElement } | null>(null);
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
  // The image viewer's "⌘ + scroll to zoom" hint shows once while the pane is open, not once per file (#2127).
  const wheelHint = useRef<WheelHintGate>({ shown: false }).current;
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
  const exitFullRef = useRef<() => void>(() => {});
  useImperativeHandle(ref, () => ({ leave: (to, go) => leaveRef.current(to, go), exitFull: () => exitFullRef.current() }), []);

  const showEnd = (text: string) => {
    setEndNote(text);
    announce(text);
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = setTimeout(() => setEndNote(null), 1800);
    // In a set of picture choices the caption says it (it stays on screen); else the chip.
    if (fullRef.current && !optionSetRef.current) showChip(text);
  };

  // ── Full screen (approval "inbox-one-fullscreen", Drawer) ─────────────────
  const fullRef = useRef(full);
  fullRef.current = full;
  /** The step chip: names the file for a moment after a step in full screen (there is no bar under the file), with the end note at the ends. */
  const [chip, setChip] = useState<{ note: string | null; at: number } | null>(null);
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showChip = (note: string | null) => {
    setChip({ note, at: Date.now() });
    if (chipTimer.current) clearTimeout(chipTimer.current);
    chipTimer.current = setTimeout(() => setChip(null), FULL_VIEW_CHIP_MS);
  };
  const showChipRef = useRef(showChip);
  showChipRef.current = showChip;
  useEffect(
    () => () => {
      if (chipTimer.current) clearTimeout(chipTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!full) {
      setChip(null);
      setMoreOpen(false);
      // Leaving full screen forgets a tucked toolbar: the next entry draws it showing from its first frame (no tucked frame, no slide-in, focus never lands on something inert).
      setToolbar('pinned');
    }
  }, [full]);
  // An image's or a film's comment row (a phone's "Comment at" button for a film) stays at the file's foot in full screen: the chip and a phone's toolbar sit above it.
  useEffect(() => {
    const section = sectionRef.current;
    if (!full || !section || (kind !== 'image' && kind !== 'video' && !(kind === 'html' && hasComposer))) return;
    const place = () => {
      const row = fileFootRow(section);
      section.style.setProperty('--ib-fvfoot', `${row ? Math.round(row.getBoundingClientRect().height) : 0}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    const mutations = new MutationObserver(() => {
      place();
      const row = fileFootRow(section);
      if (row && observer) observer.observe(row);
    });
    mutations.observe(section, { childList: true, subtree: true });
    const row = fileFootRow(section);
    if (row && observer) observer.observe(row);
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      section.style.removeProperty('--ib-fvfoot');
    };
  }, [full, attachment.id, kind, hasComposer]);
  const fullViewPeekId = `ib-fvpeek-${useId().replace(/:/g, '')}`;
  /** A phone's position in the Comments sheet's foot: its peek is the bottom sheet, drawn in the Inbox's root. */
  const phonePosRef = useRef<HTMLButtonElement>(null);
  /** What opened a phone's peek sheet (the toolbar's pill, or the position in the comments sheet's foot): focus goes back there. */
  const peekOpener = useRef<'pill' | 'foot'>('pill');
  /** Focus back on what opened a phone's peek sheet (the toolbar's pill, or the position in the comments sheet), else the toolbar's handle. */
  const focusPeekOpener = () => {
    const pill = sectionRef.current?.querySelector<HTMLElement>('[data-full-view-bar] [data-full-view-position]');
    const usable = (el: HTMLElement | null | undefined) => !!el && el.isConnected && !el.closest('[inert]');
    const opener = peekOpener.current === 'foot' && usable(phonePosRef.current) ? phonePosRef.current : usable(pill) ? pill : sectionRef.current?.querySelector<HTMLElement>('[data-full-view-handle]');
    opener?.focus({ preventScroll: true });
  };
  /** A step was taken from the sheet's Previous / Next: once the next file is in, focus goes back to the sheet's opener. */
  const steppedFromSheet = useRef(false);
  const phonePeekHost = phone && menuOpen ? peekSheetHost(sectionRef.current) : null;
  /** The person moved in or out of full screen with a button: focus follows once the frame is drawn. */
  const toggledFull = useRef(false);
  const toggleFull = (pick = true) => {
    toggledFull.current = true;
    setMenuOpen(false);
    setSheet(false);
    setMoreOpen(false);
    props.onToggleFull(pick);
  };
  const wasFull = useRef(false);
  useEffect(() => {
    const was = wasFull.current;
    wasFull.current = full;
    const toggled = toggledFull.current;
    toggledFull.current = false;
    if (full === was) return;
    if (full) {
      // Every opening of full screen starts with the toolbar showing.
      setToolbar('pinned');
      if (toggled) {
        // The header that held Full screen is gone: focus on the toolbar's first button.
        sectionRef.current?.querySelector<HTMLElement>('[data-full-view-bar] button')?.focus({ preventScroll: true });
        announce('Full screen. Side by side is in the toolbar.');
      }
      // A one-file thread has no step to name the file: the chip names it once as full screen starts.
      if (stepsRef.current.length < 2) showChipRef.current(null);
    } else if (toggled) {
      // The switch's pressed part, Side by side, which the person just chose (or Escape chose for them).
      sectionRef.current?.querySelector<HTMLElement>('.ib-vhead [data-view-side]')?.focus({ preventScroll: true });
      announce('Side by side: the file is beside the thread.');
    }
  }, [full, announce]);
  /** Open the file at `target` in `list` (the files stepped through; the sheet's `allSteps`). */
  const goTo = (target: number, source: StepSource, list: readonly AttachmentStep[] = steps) => {
    const next = list[target];
    if (!next || next.attachment.id === attachment.id) {
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
      showEnd(optionSet ? (dir > 0 ? LAST_OPTION_NOTE : FIRST_OPTION_NOTE) : dir > 0 ? LAST_NOTE : FIRST_NOTE);
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
    const at = stepIndexOf(stepsRef.current, attachment.id);
    const set = optionSetRef.current;
    if (at >= 0) announce(set ? optionAnnouncement(set, at) : stepAnnouncement(stepsRef.current, at));
    // Full screen keeps on through a step; with no bar under the file, a chip names the file for a moment (a set's caption names the choice).
    if (fullRef.current && !set) showChipRef.current(null);
    // A key pressed in the document (or the HTML page) leaves focus on the pane; a bar button keeps it.
    if (source === 'key') sectionRef.current?.focus({ preventScroll: true });
    // The sheet's Previous / Next closed the sheet with the step: focus back on what opened it.
    if (steppedFromSheet.current) {
      steppedFromSheet.current = false;
      requestAnimationFrame(focusPeekOpener);
    }
  }, [attachment.id, announce]);

  // `]` `[` `→` `←` (stepping.ts has the rules for when they stand down).
  const blocked = guard !== null || menuOpen || moreOpen;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  // A phone's swipe over the file (fileSwipe.ts): documents, text, code, PDFs, the download card and images follow the finger.
  // It is heard on the body around the file (`bodyRef`), which never moves, so a finger that comes back while the last
  // step is still sliding is heard; what moves is the file area, or for an image only the picture (`swipeMoves`).
  const docAreaRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The controls a drag down fades (the dock, the caption, the size bar, the comment box), found once when it starts. */
  const dismissFades = useRef<HTMLElement[]>([]);
  const swipeMode = fileSwipeMode(kind, tooLarge);
  // An image (approval "inbox-image-swipe"): a zoomed image or a panorama pans to its edge first, the next image
  // peeks in beside it, and a drag down closes, even with one file.
  const imageEdges = useRef<ImageSwipeEdges | null>(null);
  const isImageFile = kind === 'image';
  const swipeOn = full && phone && (multi || isImageFile) && swipeMode === 'follow' && !blocked && !sheet;
  /** The neighbour that way is an image drawn whole beside this one (ImageSwipePeek), not the "Next · name" card. */
  const peeks = (dir: 1 | -1) => {
    const neighbour = steps[index + dir];
    return isImageFile && multi && neighbour !== undefined && isImageStep(neighbour) && !prefersReducedMotion() && memory.current.get(neighbour.attachment.id)?.fit !== 'actual';
  };
  const canStepTo = (dir: 1 | -1) => index + dir >= 0 && index + dir < steps.length;
  /**
   * What follows the finger. An image stepping to the image beside it, resisting at an end, or dragged down: only the
   * picture (and the neighbours drawn beside it), so its size bar and comment box stay put (approval
   * "inbox-image-swipe", mock 2). Toward a file that is not an image, and for every other file: the whole file area.
   */
  const swipeMoves = (gesture: 'step' | 'dismiss', dir: 1 | -1): HTMLElement[] => {
    const area = docAreaRef.current;
    if (!area) return [];
    const picture = isImageFile ? area.querySelector<HTMLElement>('.ib-imgstage > .ib-zoomstage') : null;
    if (!picture) return [area];
    if (gesture === 'dismiss') return [picture];
    if (!peeks(dir) && canStepTo(dir)) return [area];
    const beside = area.querySelector<HTMLElement>('.ib-imgpeeks');
    return beside ? [picture, beside] : [picture];
  };
  const swipe = useFileSwipe(bodyRef, {
    enabled: swipeOn,
    canStep: canStepTo,
    move: swipeMoves,
    onStep: (dir) => stepRef.current(dir, 'key'),
    wouldAsk: () => !props.readOnly && unsavedComposer(sectionRef.current, savedTextRef.current) !== null,
    // One image alone has nowhere to step: a sideways drag is the image's own.
    keeps: isImageFile ? (dir) => !multi || (imageEdges.current?.keeps(dir) ?? false) : undefined,
    peek: peeks,
    dismiss: isImageFile
      ? {
          can: () => imageEdges.current?.canDismiss() ?? false,
          onDismiss: () => closeRef.current(),
          // The backdrop fades with the drag (`--ib-dismiss`, registered as not inherited, so the pane's contents are not
          // restyled on every move) and the controls fade faster, by their own opacity.
          onProgress: (share) => {
            const pane = sectionRef.current;
            if (!pane) return;
            if (share > 0) {
              if (!pane.hasAttribute('data-dismissing')) {
                pane.setAttribute('data-dismissing', '');
                dismissFades.current = Array.from(pane.querySelectorAll<HTMLElement>('.ib-fvdock, .ib-optcap, .ib-imgbar, .ib-imgcompose, .ib-fcomp, .ib-fcomp-pillwrap'));
              }
              pane.style.setProperty('--ib-dismiss', share.toFixed(3));
              const opacity = Math.max(0, 1 - share * 2.5).toFixed(3);
              for (const control of dismissFades.current) control.style.opacity = opacity;
            } else {
              pane.removeAttribute('data-dismissing');
              pane.style.removeProperty('--ib-dismiss');
              for (const control of dismissFades.current) control.style.opacity = '';
              dismissFades.current = [];
            }
          },
        }
      : undefined,
  });
  const closeRef = useRef<() => void>(() => {});
  // A file a swipe cannot step (`swipeMode === 'none'`: HTML pages, diagrams, videos; and code that scrolls sideways)
  // steps through the sheet the pill opens: its ‹ Previous and Next › (the owner's answer; no floating tabs), shown for
  // every file so the sheet is the same everywhere (the phone's FilePeek below, `onStep`).

  const stepWhen = (dir: 1 | -1) => (event: KeyboardEvent) => {
    if (!multi) return false;
    const pane = sectionRef.current;
    // An element that uses the arrows itself (a focused video) keeps them; a zoomed image does not: ← → always step.
    if (event.key.startsWith('Arrow') && pane?.querySelector('[data-claims-arrows="true"]')) return false;
    return stepKeyIntent(event, { full, pane, blocked }) === dir;
  };

  // The question row takes focus on its first choice.
  useEffect(() => {
    if (guard) guardRef.current?.querySelector<HTMLButtonElement>('[data-guard-save]')?.focus();
  }, [guard]);
  const focusComposer = () => {
    const area = unsavedComposer(sectionRef.current, savedTextRef.current);
    if (!area) return;
    const focusAt = (field: HTMLTextAreaElement) => {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    };
    // The comment row kept hidden in full screen's composer (the card on Reply, or minimized): the card
    // comes back on its Comment tab, and focus goes to the words once it is drawn.
    const threadId = props.composer?.threadId;
    if (threadId && area.closest('[data-fcomp-comment-slot][hidden]')) {
      pickComposerMode(threadId, 'comment');
      setComposerMinimized(threadId, false);
      requestAnimationFrame(() => {
        const shown = unsavedComposer(sectionRef.current, savedTextRef.current);
        if (shown) focusAt(shown);
      });
      return;
    }
    focusAt(area);
  };
  const keepWriting = () => {
    steppedFromSheet.current = false;
    setGuard(null);
    focusComposer();
  };
  /**
   * Close a composer the way its own Escape does (the pane sends the key to
   * it): a comment popover hands focus back to what opened it; anything that
   * leaves focus nowhere puts it on the pane.
   */
  const dismissComposer = (area: HTMLTextAreaElement) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true, composed: true });
    paneEscapes.add(event);
    area.dispatchEvent(event);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) sectionRef.current?.focus({ preventScroll: true });
    });
  };
  /** Escape on a composer holding typed words: never lost, the question row asks first (Save it, Discard it, Keep writing). */
  const askBeforeEscape = (area: HTMLTextAreaElement) => {
    setMenuOpen(false);
    setMoreOpen(false);
    setGuard({ to: null, go: () => {}, escape: area });
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
    if (pending.escape) {
      // Escape asked: the composer saved (and closed) or refused; nothing else to go to.
      if (!started && unsavedComposer(sectionRef.current, savedTextRef.current)) {
        focusComposer();
        return;
      }
      setGuard(null);
      if (started && !ok) focusComposer();
      else announce('Comment saved.');
      return;
    }
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
    if (pending?.escape) {
      dismissComposer(pending.escape);
      announce('Comment discarded.');
      return;
    }
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
  // The open file's keys (shortcuts/fileViewer.shortcuts.ts). `]` `[` `→` `←` step (stepping.ts has the rules for
  // when they stand down); ⌘⇧X tucks or shows the full-screen toolbar on an HTML file (the page forwards it from
  // inside the frame through onToolsToggle).
  useShortcutScope({
    scope: inboxFileViewerShortcuts,
    handlers: {
      next: { when: stepWhen(1), handle: () => stepRef.current(1, 'key') },
      previous: { when: stepWhen(-1), handle: () => stepRef.current(-1, 'key') },
      toggleTools: {
        // Never while typing (a comment), nor under a modal dialog.
        when: (event) => isHtml && full && !modalOpen() && !isEditableTarget(keyTarget(event)),
        handle: () => barRef.current?.toggle(),
      },
    },
  });
  // Escape on a composer holding typed words, before the composer's own Escape drops them (capture): the question row asks.
  const escapeAsk = useRef<HTMLTextAreaElement | null>(null);
  useShortcutScope({
    scope: inboxFileViewerShortcuts,
    capture: true,
    handlers: {
      escape: {
        when: (event) => {
          escapeAsk.current = props.readOnly || paneEscapes.has(event) || isComposingKey(event) ? null : composerAskedAbout(keyTarget(event));
          return escapeAsk.current !== null;
        },
        handle: (event) => {
          event.stopPropagation();
          if (escapeAsk.current) askBeforeEscape(escapeAsk.current);
        },
      },
    },
  });
  // The ladder (escapeLadder.ts): after the focused control had its turn (bubble, on the document: before the
  // window's listeners, the HTML viewer's own Annotate rung among them, which then sees the key used).
  const escapeNext = useRef<EscapeRung | null>(null);
  useShortcutScope({
    scope: inboxFileViewerShortcuts,
    target: 'document',
    handlers: {
      escape: {
        when: (event) => {
          escapeNext.current = event.defaultPrevented || paneEscapes.has(event) || isComposingKey(event) ? null : ladderRung(keyTarget(event));
          return escapeNext.current !== null;
        },
        handle: () => {
          if (escapeNext.current) climb(escapeNext.current);
        },
      },
    },
  });

  // Beside the thread, an Escape nothing else used closes the file (approval "inbox-keyboard-shortcuts": Escape
  // takes off the top layer). Last of all: on the window, bubbling, after the ladder, the thread and every control.
  useShortcutScope({
    scope: inboxFileViewerShortcuts,
    handlers: {
      escape: {
        when: (event) => {
          if (full || props.fullLocked || linkedTop || event.defaultPrevented || paneEscapes.has(event) || isComposingKey(event) || modalOpen()) return false;
          if (document.querySelector(SELF_CLOSING_DRAFTS)) return false;
          const target = keyTarget(event);
          return !(target && (isEditableTarget(target) || inOverlay(target) || target.closest('[role="menu"], [role="listbox"], [aria-expanded="true"]')));
        },
        handle: () => close(),
      },
    },
  });

  /** The textarea of a composer this pane owns that holds unsaved words, when the key came from inside that composer. */
  function composerAskedAbout(target: Element | null): HTMLTextAreaElement | null {
    const container = target?.closest(CLOSING_COMPOSERS);
    if (!container) return null;
    const area = target instanceof HTMLTextAreaElement && container.contains(target) ? target : container.querySelector('textarea');
    // A skill or mention menu open in the composer takes this Escape first.
    if (!area || area.getAttribute('aria-expanded') === 'true') return null;
    // A comment popover draws on the page (a portal); everything else is in the pane (Pierre's code view in its shadow root).
    if (!container.matches('[data-comment-popover]') && !sectionRef.current?.contains(hostOf(container))) return null;
    if (container.matches('[data-comment-popover], [data-diagram-composer]')) return area.value.trim() !== '' ? area : null;
    const id = container.getAttribute('data-annotation-id') ?? container.getAttribute('data-code-annotation-id') ?? '';
    return area.value.trim() !== (savedTextRef.current(id) ?? '').trim() ? area : null;
  }

  /** An open comment composer of this file (a comment popover, a diagram's composer): its textarea. */
  function openComposer(): HTMLTextAreaElement | null {
    return document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea') ?? sectionRef.current?.querySelector<HTMLTextAreaElement>('[data-diagram-composer] textarea') ?? null;
  }

  /**
   * What this Escape does in full screen (escapeLadder.ts), or null when it is
   * not the pane's: not full screen, a dialog or the image annotator over the
   * window, a draft that closes itself on this same key (the selection
   * toolbar), or a text field that keeps its own Escape. `target` is where the
   * key came from (null: from inside the HTML page).
   */
  function ladderRung(target: Element | null): EscapeRung | null {
    if (modalOpen()) return null;
    if (!full) {
      // Beside the thread the one rung is a linked page, for a key from inside the pane (or the page).
      if (!linkedTop || document.querySelector(SELF_CLOSING_DRAFTS)) return null;
      if (target && (!sectionRef.current?.contains(target) || isEditableTarget(target) || inOverlay(target))) return null;
      return 'linked';
    }
    if (document.querySelector(SELF_CLOSING_DRAFTS)) return null;
    const inField = !!target && isEditableTarget(target) && !!target.closest('[data-image-composer], [data-fcomp-field]') && !!sectionRef.current?.contains(target);
    if (target && !inField && (isEditableTarget(target) || inOverlay(target))) return null;
    return escapeRung({
      full: true,
      popoverOpen: menuOpen || moreOpen,
      composerOpen: !props.readOnly && openComposer() !== null,
      inField,
      panelOpen: panelOpen,
      linkedOpen: linkedTop !== null,
      annotating: isHtml && armed && !props.readOnly,
      questionOpen: guard !== null,
    });
  }

  /**
   * Take one rung, saying what happened and leaving focus somewhere sensible.
   * From inside the page, focus stays in the page (the person is reading it).
   */
  function climb(rung: EscapeRung, fromPage = false) {
    switch (rung) {
      case 'popover': {
        setMenuOpen(false);
        setMoreOpen(false);
        // The peek hands focus back to N/M itself; a menu whose item held focus leaves it on ⋯.
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body || !active.isConnected) sectionRef.current?.querySelector<HTMLElement>('[data-full-view-more], [data-full-view-position]')?.focus({ preventScroll: true });
        });
        return;
      }
      case 'composer': {
        const area = openComposer();
        if (!area) return;
        if (area.value.trim() !== '') {
          askBeforeEscape(area);
          return;
        }
        dismissComposer(area);
        announce('Comment closed.');
        return;
      }
      case 'field': {
        const fromReply = !!document.activeElement?.closest('[data-fcomp-field]');
        sectionRef.current?.focus({ preventScroll: true });
        announce(fromReply ? 'Left the reply box. Your words are kept.' : 'Left the comment box.');
        return;
      }
      case 'drawer':
        if (fromPage) {
          if (drawerMode) setDrawer(false);
          else setSheet(false);
        } else closeSheet();
        announce('Comments closed.');
        return;
      case 'linked':
        linkedBack();
        return;
      case 'annotate':
        setArmed(false);
        announce('Interact: clicks reach the page.');
        return;
      case 'question':
        keepWriting();
        return;
      case 'leave':
        if (exitCloses) close();
        else exitFull();
        return;
    }
  }

  /**
   * An Escape from inside the HTML page: Annotate's last rung (the bridge's
   * annotate-exit), or, in Interact, one the page did not use. In full screen
   * it climbs the same ladder; returns whether it did.
   */
  function escapeFromPage(): boolean {
    const rung = ladderRung(null);
    if (!rung) return false;
    climb(rung, true);
    return true;
  }

  // ── Links inside an attached HTML page (htmlLinks.ts) ─────────────────────
  /**
   * Pages the person followed from the attached page, not attached themselves:
   * shown read-only over it, newest last. The route holds the page on screen
   * (`linked=`, one history entry each, so Back and a phone's swipe back step
   * through them); this stack follows it and remembers what came before.
   */
  const [linkedStack, setLinkedStack] = useState<readonly LinkedPage[]>([]);
  const linkedStackRef = useRef(linkedStack);
  linkedStackRef.current = linkedStack;
  const linkedLast = linkedStack.at(-1);
  const linkedTop = linkedLast && linkedLast.attachmentId === attachment.id ? linkedLast : null;
  /** Why a link opened nothing, for a moment. */
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const linkNoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A local image a link names that is not attached: the lightbox, through the page's asset route. */
  const [linkImage, setLinkImage] = useState<{ src: string; alt: string } | null>(null);
  /** The fragment a link named on an attached page it opened (`SHEET.html#pr1`): cleared once used. */
  const [linkFragment, setLinkFragment] = useState<{ id: string; hash: string } | null>(null);
  useEffect(() => {
    setLinkNote(null);
    setLinkImage(null);
  }, [attachment.id, effectiveVersion]);
  useEffect(
    () => () => {
      if (linkNoteTimer.current) clearTimeout(linkNoteTimer.current);
    },
    [],
  );
  const showLinkNote = (text: string) => {
    setLinkNote(text);
    announce(text);
    if (linkNoteTimer.current) clearTimeout(linkNoteTimer.current);
    linkNoteTimer.current = setTimeout(() => setLinkNote(null), LINK_NOTE_MS);
  };
  const showLinkNoteRef = useRef(showLinkNote);
  showLinkNoteRef.current = showLinkNote;
  const onLinkedRef = useRef(props.onLinked);
  onLinkedRef.current = props.onLinked;
  /** A page just opened from a link: its Back takes focus once drawn. */
  const focusLinkedBack = useRef(false);
  const linkedBackRef = useRef<HTMLButtonElement>(null);
  // Another file or version: its own page, no stack.
  useEffect(() => {
    setLinkedStack([]);
    focusLinkedBack.current = false;
  }, [attachment.id, effectiveVersion]);
  // The page the route names: back to one already in the stack, or read and pushed.
  const linkedRequest = isHtml ? (props.linked ?? null) : null;
  useEffect(() => {
    if (!linkedRequest) {
      setLinkedStack([]);
      focusLinkedBack.current = false;
      return;
    }
    const { relative, hash } = splitLinked(linkedRequest);
    // Only this file's pages count: a Back may land on another file's linked page with the same name.
    const at = linkedStackRef.current.findIndex((page) => page.attachmentId === attachment.id && page.relative === relative);
    if (at >= 0) {
      setLinkedStack((stack) => [...stack.slice(0, at), { ...stack[at]!, hash }]);
      return;
    }
    let cancelled = false;
    source
      .linkedPage(attachment, relative)
      .then((page) => {
        if (cancelled) return;
        setLinkedStack((stack) => [...stack.filter((p) => p.attachmentId === attachment.id), { ...page, relative, hash, attachmentId: attachment.id }]);
        announce(`${page.name}. It is not attached, so comments are off.`);
        // Back takes focus once React has drawn it (the layout effect below), never on a guessed frame.
        focusLinkedBack.current = true;
      })
      .catch((cause) => {
        if (cancelled) return;
        showLinkNoteRef.current(cause instanceof InboxApiError ? cause.message : `${relative} could not be opened.`);
        // The address names a page that does not open: it goes back to what is on screen.
        const top = linkedStackRef.current.at(-1);
        onLinkedRef.current?.(top ? linkedValue(top.relative, top.hash) : null, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [linkedRequest, attachment.id, announce]);
  // A page just opened from a link: focus goes to its Back, after the commit that draws it (a frame
  // callback could run first, find no button, and leave focus behind). The page can be drawn well after
  // it was read (a deep link or reload names it before the file's view is read), so focus the person
  // moved into a field meanwhile (the reply box) stays there.
  useLayoutEffect(() => {
    if (!focusLinkedBack.current || !linkedTop || !view) return;
    const back = linkedBackRef.current;
    if (!back) return;
    focusLinkedBack.current = false;
    if (isEditableTarget(document.activeElement)) return;
    back.focus({ preventScroll: true });
  }, [linkedTop, view]);
  // A fragment is replayed once: cleared after the page had time to take it, so a remount does not scroll again and the same #hash works twice.
  useEffect(() => {
    if (!linkFragment || linkFragment.id !== attachment.id || !view) return;
    const timer = setTimeout(() => setLinkFragment(null), 1500);
    return () => clearTimeout(timer);
  }, [linkFragment, attachment.id, view]);
  /** Full screen floats the band over the page: the page starts below it (`--ib-linkband-h`), so its top is never covered. */
  const linkBandRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const band = linkBandRef.current;
    const host = band?.parentElement;
    if (!band || !host) return;
    const place = () => host.style.setProperty('--ib-linkband-h', `${Math.ceil(band.getBoundingClientRect().height)}px`);
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(band);
    return () => observer?.disconnect();
  }, [linkedTop, full]);
  /** Every file of the thread a link may name: its attachments and the images its messages show. */
  const linkables = useMemo(() => {
    const byId = new Map<string, InboxAttachmentState>();
    for (const a of props.attachments) byId.set(a.id, a);
    for (const s of props.steps ?? []) byId.set(s.attachment.id, s.attachment);
    return [...byId.values()];
  }, [props.attachments, props.steps]);
  /** The attached page's folder: links never leave it. */
  const pageFolder = folderOf(attachment.path);
  const pageAssetRoute = isHtml ? htmlAssetRouteFromDocument(view?.html) : null;
  /** One page back (Back, Escape): the browser's Back when the entry on screen was opened from there. */
  const linkedBack = () => {
    const stack = linkedStackRef.current;
    if (stack.length === 0) return;
    const before = stack.length > 1 ? stack[stack.length - 2]! : null;
    announce(`Back on ${before ? before.name : attachment.name}.`);
    props.onLinked?.(before ? linkedValue(before.relative, before.hash) : null, { back: true });
    requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
  };
  /** A link the page's bridge handed over (a plain click, armed or not; ⌘/Ctrl-click while armed pins it instead). `baseDir`: the folder of the page it is in. */
  const followLink = (href: string, baseDir: string) => {
    const link = resolveInboxHtmlLink(href, {
      folder: pageFolder,
      baseDir,
      attachments: linkables,
      assetRoute: pageAssetRoute,
      serverOrigin: window.location.origin,
    });
    switch (link.kind) {
      case 'ignored':
        return;
      case 'external':
        window.open(link.url, '_blank', 'noopener,noreferrer');
        return;
      case 'image':
        setLinkImage({ src: link.url, alt: link.name });
        return;
      case 'refused':
        showLinkNote(link.note);
        return;
      case 'attachment': {
        if (link.id === attachment.id) {
          // The attached page itself (a linked page's way home): a new entry, as any link followed.
          if (link.hash) setLinkFragment({ id: link.id, hash: link.hash });
          announce(`Back on ${attachment.name}.`);
          props.onLinked?.(null);
          return;
        }
        leave(link.name, () => {
          if (link.hash) setLinkFragment({ id: link.id, hash: link.hash });
          pendingStep.current = 'key';
          if (props.onOpenLinked) props.onOpenLinked(link.id);
          else props.onStep?.(link.id, 'current');
        });
        return;
      }
      case 'page':
        // A typed comment on the attached page asks first, as for any file it would leave.
        leave(link.name, () => props.onLinked?.(linkedValue(link.relative, link.hash)));
        return;
    }
  };
  const followLinkRef = useRef(followLink);
  followLinkRef.current = followLink;

  const isText = kind === 'markdown' || kind === 'text';
  const isCode = kind === 'code';
  const isImage = kind === 'image';
  const isVideo = kind === 'video';
  const composerValue = useMemo<FullScreenComposerValue | null>(
    () => (hasComposer && props.composer ? { ...props.composer, tucked: toolbar !== 'pinned' } : null),
    [hasComposer, props.composer, toolbar],
  );
  const videoRef = useRef<VideoAttachmentViewHandle>(null);
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
          const record = await source.saveAnnotation(attachment, annotationVersion, annotation);
          props.onSaved(record);
          return true;
        } catch (cause) {
          setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not saved.');
          return false;
        }
      })();
      saves.current = { count: saves.current.count + 1, last: answer };
      return answer;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attachment.id, annotationVersion, props.onSaved, source],
  );

  const remove = async (id: string) => {
    viewerRef.current?.removeHighlight(id);
    try {
      await source.removeAnnotation(id);
      props.onRemoved(id);
    } catch (cause) {
      setError(cause instanceof InboxApiError ? cause.message : 'The annotation was not removed.');
    }
  };

  const edit = (id: string, updates: Partial<Annotation>) => {
    const record = props.records.find((r) => r.id === id);
    if (!record) return;
    const annotation = annotationOf(record);
    // A drawing's words emptied again: the agent's stand-in comes back.
    const text = updates.text !== undefined && updates.text.trim() === '' && isWordlessMarkup(annotation) ? MARKUP_ONLY_TEXT : updates.text;
    void save({ ...annotation, ...updates, ...(text !== undefined ? { text } : {}) });
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
  closeRef.current = close;
  /** Where × and Escape's last rung go: the thread (the file closes), or back beside it. */
  const exitCloses = props.exitCloses ?? props.fullLocked === true;
  /** × and Escape's last rung back beside the thread: through `leave` when that shows another file (a typed comment is asked about). */
  const exitFull = () => {
    const to = props.exitLeavesFor ?? null;
    if (to !== null) leave(to, () => toggleFull(false));
    else toggleFull(false);
  };
  exitFullRef.current = () => {
    if (!props.full || props.fullLocked) return;
    if (exitCloses) close();
    else exitFull();
  };

  const sentAt = whenTime(attachment.sent_at);
  /** An image the message's text shows (approval "inbox-image-viewer"). */
  const inline = attachment.ref !== undefined;
  /** Its copy was taken the first time the thread was read (a message sent before capture), not when it was sent. */
  const onOpen = attachment.captured === 'on_open';
  /** Who sent the message the file is in: the agent, or the person themself. */
  const sender = props.fromPerson ? 'you' : props.agent;
  const firstOpened = whenTime(attachment.captured_at ?? attachment.sent_at);
  let line: React.ReactNode = null;
  if (currentUnavailable) {
    line = (
      <>
        {attachment.unavailable!.message} {onOpen ? `This is the copy taken when you first opened it, ${firstOpened}.` : `This is the version ${sender} sent at ${sentAt}.`}
      </>
    );
  } else if (effectiveVersion === 'sent') {
    line = (
      <>
        {onOpen ? `The copy taken when you first opened it, ${firstOpened}.` : `The version ${sender} sent at ${sentAt}.`}
        <button type="button" className="ib-vlink" onClick={() => chooseVersion('current')}>
          Open the file as it is now
        </button>
      </>
    );
  } else if ((view?.attachment ?? attachment).changed_since_sent) {
    const current = (view?.attachment ?? attachment).current;
    line = (
      <>
        {onOpen ? 'Changed since you first opened it.' : `Changed since ${sender} sent it at ${sentAt}.`}
        {current ? ` Edited ${whenTime(current.mtime)}.` : ''}
        <button type="button" className="ib-vlink" onClick={() => chooseVersion('sent')}>
          {onOpen ? 'Open the version you first saw' : props.fromPerson ? 'Open the version you sent' : 'Open the version it sent'}
        </button>
      </>
    );
  }
  /**
   * The changed line, compact, for full view (which drops the line): the same
   * facts and actions as a persistent chip at the file's top left, so a file
   * that opens in full view still says it changed, or which version is shown.
   */
  let versionChip: { text: string; action: { label: string; to: 'current' | 'sent' } | null; full: string } | null = null;
  if (currentUnavailable) {
    versionChip = {
      text: attachment.unavailable!.code === 'attachment_missing' ? 'The file is gone; showing the sent copy' : 'The file is not that kind any more; showing the sent copy',
      action: null,
      full: `${attachment.unavailable!.message} ${onOpen ? `This is the copy taken when you first opened it, ${firstOpened}.` : `This is the version ${sender} sent at ${sentAt}.`}`,
    };
  } else if (effectiveVersion === 'sent') {
    versionChip = {
      text: onOpen ? 'Showing the copy from when you first opened it' : 'Showing the sent version',
      action: { label: 'Open the file as it is now', to: 'current' },
      full: onOpen ? `The copy taken when you first opened it, ${firstOpened}.` : `The version ${sender} sent at ${sentAt}.`,
    };
  } else if ((view?.attachment ?? attachment).changed_since_sent) {
    versionChip = {
      text: onOpen ? 'Changed since you first opened it' : 'Changed since sent',
      action: { label: onOpen ? 'Open the version you first saw' : props.fromPerson ? 'Open the version you sent' : 'Open the version it sent', to: 'sent' },
      full: onOpen ? 'Changed since you first opened it.' : `Changed since ${sender} sent it at ${sentAt}.`,
    };
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
  /** The thread's annotations on files other than this one (the foot of the drawer says so). */
  const elsewhere = props.records.filter((r) => recordKey(r.path, r.version) !== currentKey).length;
  /** Full screen's ⋯ offers the other version, as the changed chip does. */
  const versionAction = versionChip?.action ? { label: versionChip.action.label, onSelect: () => chooseVersion(versionChip!.action!.to) } : null;
  /** The file changed since it was sent, or is gone: the tucked handle carries an amber dot. */
  const changedSinceSent = currentUnavailable || (view?.attachment ?? attachment).changed_since_sent;

  /**
   * Full screen's changed note floats at the file's top left, where a code file's top row starts (Copy file, the hint):
   * the row grows under the note, measured, so the note never covers it. Null: nothing to clear.
   */
  const noteShown = full && versionChip !== null && !linkedTop;
  const [codeClear, setCodeClear] = useState<number | null>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const note = noteShown && isCode && view ? section?.querySelector<HTMLElement>('[data-full-view-changed]') : null;
    const code = note ? section?.querySelector<HTMLElement>('[data-code-view]') : null;
    if (!note || !code) {
      setCodeClear(null);
      return;
    }
    const place = () => {
      const below = Math.ceil(note.getBoundingClientRect().bottom - code.getBoundingClientRect().top) + CODE_ROW_BELOW_NOTE;
      setCodeClear(below > CODE_ROW_BELOW_NOTE ? below : null);
    };
    place();
    // The note wraps onto more lines as the window narrows (a phone).
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(note);
    observer?.observe(code);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [noteShown, isCode, view]);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={`ib-view${full ? ' ib-full ib-fullview' : ''}${phone ? ' ib-phone' : ''}${folded && !phone ? ' ib-fold' : ''}${hasPanel ? '' : ' ib-nopanel'}${sheetMode && sheet ? ' ib-panel-open' : ''}${drawerMode && drawer && hasPanel ? ' ib-drawer' : ''}`}
      aria-label={multi ? `${attachment.name}, ${optionSet ? 'option' : 'file'} ${index + 1} of ${steps.length}` : attachment.name}
      data-attachment-pane={attachment.id}
      data-version={effectiveVersion}
      data-full-view={full ? '' : undefined}
      // Hide (») hides what else floats over the file with the toolbar (inbox.css): the size chip, the composer.
      data-tools={full ? toolbar : undefined}
    >
      <FullScreenComposerContext.Provider value={composerValue}>
      {full ? (
        <FullViewBar
          ref={barRef}
          phone={phone}
          state={toolbar}
          onState={setToolbar}
          announce={announce}
          armed={armed}
          // A linked page takes no comments: no pen while it is shown.
          onToggleArmed={isHtml && !props.readOnly && !linkedTop ? () => setArmed((v) => !v) : undefined}
          comments={
            hasPanel
              ? {
                  count: annotations.length,
                  open: panelOpen,
                  controls: sheetId,
                  onToggle: togglePanel,
                  buttonRef: sheetButtonRef,
                }
              : null
          }
          handleCount={annotations.length}
          changed={changedSinceSent}
          position={
            multi
              ? {
                  index,
                  total: steps.length,
                  name: attachment.name,
                  noun: optionSet ? 'option' : 'file',
                  open: menuOpen,
                  peekId: fullViewPeekId,
                  onOpenChange: (open) => {
                    if (open) {
                      setSheet(false);
                      setMoreOpen(false);
                      peekOpener.current = 'pill';
                    }
                    setMenuOpen(open);
                  },
                  // A phone's pill opens the bottom sheet the pane draws (below), in one tap.
                  renderPeek: phone ? undefined : (closePeek) => (
                    <FilePeek
                      id={fullViewPeekId}
                      steps={allSteps}
                      index={allIndex}
                      phone={false}
                      annotationCounts={annotationCounts}
                      onClose={closePeek}
                      onGo={(target) => goTo(target, 'menu', allSteps)}
                    />
                  ),
                }
              : null
          }
          more={
            <FullScreenMore
              attachment={attachment}
              version={effectiveVersion}
              surface={props.openIn}
              phone={phone}
              open={moreOpen}
              onOpenChange={(open) => {
                if (open) setMenuOpen(false);
                setMoreOpen(open);
              }}
              versionAction={versionAction}
            />
          }
          moreOpen={moreOpen}
          leave={props.fullLocked ? { kind: 'back', onLeave: close } : { kind: 'exit', onLeave: () => toggleFull() }}
          // × does what Escape's last step does, never a pick (Side by side is the pick): back where full screen
          // was opened from, the thread alone (the file closes) or the file beside the thread.
          onExitFull={props.fullLocked ? undefined : exitCloses ? close : exitFull}
          exitCloses={exitCloses}
          chord={isHtml ? TOOLS_CHORD : null}
          shifted={drawerMode && drawer && hasPanel}
        />
      ) : (
        <div className="ib-vhead">
          {/* With more than one file the bar under the file names it. */}
          {!multi && (
            <span className="ib-fn" data-header-name="">
              <FileName name={attachment.name} />
            </span>
          )}
          <span className="ib-from" data-header-from="">
            {isVideo && inboxVideoMeta(attachment)
              ? inboxVideoMeta(attachment)
              : // An image the message's text shows: whose message, and when (approval "inbox-image-viewer").
                inline
                ? `${props.fromPerson ? 'You' : props.agent} · ${sentAt}`
                : `from ${props.agent} in ${props.projectName}`}
          </span>
          <span className="ib-sp" />
          {isHtml && !props.readOnly && !linkedTop && <HtmlSurfaceControls armed={armed} onToggleArmed={() => setArmed((v) => !v)} />}
          {props.openIn && <OpenInControl attachment={attachment} version={effectiveVersion} surface={props.openIn} label={!folded} big={phone} />}
          {/* A source that writes nothing (the tour) offers no Download: nothing leaves the window. */}
          {source.writes && (
            <Tip content={`Download ${attachment.name}${effectiveVersion === 'sent' ? ' (the version it sent)' : ''}`}>
              <a
                className="ib-btn ib-sm ib-ghost"
                href={source.downloadUrl(attachment, effectiveVersion)}
                download={attachment.name}
                data-attachment-download=""
              >
                <Icon name="download" size={14} />
                Download
              </a>
            </Tip>
          )}
          {folded && hasPanel && (
            <button
              type="button"
              ref={sheetButtonRef}
              className={`ib-btn ib-sm ib-vcomments${sheet ? ' ib-on' : ''}`}
              onClick={togglePanel}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && sheet && !event.defaultPrevented) {
                  event.preventDefault();
                  closeSheet();
                }
              }}
              aria-expanded={sheet}
              aria-controls={sheetId}
              aria-label={`Comments, ${annotations.length}`}
              data-annotations-sheet=""
            >
              <Icon name="comment" size={15} />
              {annotations.length}
            </button>
          )}
          {!props.fullLocked && (
            // The view's two parts (fileView.ts), the one shown pressed. This header shows only while the file is side by side.
            <div className="ib-seg ib-viewseg" role="group" aria-label="View" data-view-switch="">
              <Tip content="Side by side: files open beside the thread until you choose again">
                <button type="button" className="ib-seg-o" aria-pressed="true" data-on="" onClick={() => props.onKeepView?.()} aria-label={folded ? 'Side by side' : undefined} data-view-side="">
                  <Icon name="sideBySide" size={14} />
                  {!folded && 'Side by side'}
                </button>
              </Tip>
              {/* F names full screen here (approved hint placement); the key, unlike this button, saves nothing. */}
              <Tip content={withShortcut('Full screen: files open this way until you choose again', { scope: inboxThreadShortcuts, action: 'fullScreen' })}>
                <button type="button" className="ib-seg-o" aria-pressed="false" onClick={() => toggleFull()} aria-label={folded ? 'Full screen' : undefined} data-full-screen-toggle="">
                  <Icon name="frame" size={14} />
                  {!folded && 'Full screen'}
                </button>
              </Tip>
            </div>
          )}
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={close} aria-label={`Close ${attachment.name}`}>
              <Icon name="x" />
            </button>
          </Tip>
        </div>
      )}
      {full ? (
        versionChip && !linkedTop && (
          // A fact about the file: it stays when the toolbar tucks.
          <Tip content={versionChip.full}>
          <div className="ib-fvver" role="status" data-full-view-changed="">
            <Icon name="info" size={13} />
            <span className="ib-fvver-t">{versionChip.text}</span>
            {versionChip.action && (
              <button type="button" className="ib-vlink" onClick={() => chooseVersion(versionChip!.action!.to)}>
                {versionChip.action.label}
              </button>
            )}
          </div>
          </Tip>
        )
      ) : line ? (
        <div className="ib-changed" data-changed-line="">
          <Icon name="info" size={14} />
          {line}
        </div>
      ) : (
        <div />
      )}
      <div className="ib-vbody" ref={bodyRef}>
        <div
          ref={docAreaRef}
          className={`ib-docarea${isHtml ? ' ib-html' : ''}`}
          data-file-swipe={full && phone && multi ? swipeMode : undefined}
          data-image-peek={swipeOn && isImage && multi ? '' : undefined}
        >
          {error && (
            <div className="ib-error ib-view-error" role="alert">
              {error}
            </div>
          )}
          {view && isHtml && view.html !== null && (
            // Kept mounted under a linked page (inert, hidden), so Back finds it as it was left.
            <div className={`ib-htmlframe${linkedTop ? ' ib-covered' : ''}`} inert={linkedTop ? true : undefined}>
            <HtmlViewer
              key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
              rawHtml={view.html}
              title={attachment.name}
              annotations={annotations}
              onAddAnnotation={(annotation) => void save(annotation)}
              onSelectAnnotation={setSelectedId}
              selectedAnnotationId={selectedId}
              mentionSource={props.mentionSource}
              mode="selection"
              inputMethod="pinpoint"
              annotateModeActive={armed}
              // Annotate's Escape (from the page, or the viewer's own rung with focus out here): in full screen it is a
              // rung of the ladder (the drawer closes first); beside the thread it goes to Interact, as before.
              onAnnotateModeExit={() => {
                if (!escapeFromPage()) setArmed(false);
              }}
              // In Interact, an Escape the page did not use climbs the ladder (full screen only).
              onPageEscape={full ? () => void escapeFromPage() : undefined}
              onAnnotateModeToggle={() => setArmed((v) => !v)}
              // ⌘⇧X pressed inside the page: the bridge forwards it (Hide / Show the full-screen toolbar).
              onToolsToggle={full ? () => barRef.current?.toggle() : undefined}
              // A plain ] or [ pressed in the page while armed (the bridge forwards nothing in Interact).
              onStep={multi ? (dir) => !blockedRef.current && armed && stepRef.current(dir, 'key') : undefined}
              // A link the page's bridge handed over: another file of the thread, a page or image beside it, another site (htmlLinks.ts).
              onOpenLink={(href) => followLinkRef.current(href, pageFolder)}
              initialFragment={linkFragment?.id === attachment.id ? linkFragment.hash : undefined}
              onUnanchoredChange={(ids) => setUnanchored(new Set(ids))}
              fullViewport
              hideControls
              // Shift-click joins more elements to one comment, as in annotate (the viewer's own cap).
              readOnly={props.readOnly}
            />
            </div>
          )}
          {view && isHtml && linkedTop && (
            // A page the attached page links to, not attached: read-only (comments belong to attachments).
            <div className="ib-linked" data-linked-page={linkedTop.name}>
              <div className="ib-linkband" ref={linkBandRef} role="group" aria-label={`${linkedTop.name}, linked from ${attachment.name}`}>
                <button ref={linkedBackRef} type="button" className="ib-btn ib-sm" onClick={linkedBack} data-linked-back="">
                  <Icon name="chevL" size={13} />
                  <span className="ib-linkband-back">Back to {linkedStack.length > 1 ? linkedStack[linkedStack.length - 2]!.name : attachment.name}</span>
                </button>
                <span className="ib-linkband-t" data-linked-note="">
                  <b>{linkedTop.name}</b> is not attached, so comments are off.
                </span>
                {linkedTop.url && (
                  <a className="ib-vlink ib-linkband-tab" href={linkedTop.url} target="_blank" rel="noopener noreferrer" data-linked-open-tab="">
                    Open in new tab
                  </a>
                )}
              </div>
              <div className="ib-linkedframe">
                <HtmlViewer
                  key={`${linkedStack.length}:${linkedTop.path}`}
                  rawHtml={linkedTop.html}
                  title={linkedTop.name}
                  annotations={NO_ANNOTATIONS}
                  onAddAnnotation={noop}
                  onSelectAnnotation={noop}
                  selectedAnnotationId={null}
                  mode="selection"
                  inputMethod="pinpoint"
                  // Nothing to pin: a click on a link follows it.
                  annotateModeActive={false}
                  // An Escape the page did not use: one page back (full screen: the ladder, whose next rung is that).
                  onPageEscape={() => void escapeFromPage()}
                  onOpenLink={(href) => followLinkRef.current(href, folderOf(linkedTop.path))}
                  initialFragment={linkedTop.hash || undefined}
                  fullViewport
                  hideControls
                  maxAdditionalTargets={0}
                  readOnly
                />
              </div>
            </div>
          )}
          {isHtml && (
            <div className={`ib-linknote${linkNote ? ' ib-on' : ''}`} aria-hidden={linkNote ? undefined : true} data-link-note={linkNote ? 'shown' : 'hidden'}>
              <Icon name="info" size={13} />
              <span>{linkNote}</span>
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
              // A phone in full screen: the pane's follow swipe (above); elsewhere a touch screen's swipe at Fit.
              onSwipe={multi && !(full && phone) ? (dir) => step(dir, 'key') : undefined}
              edgesRef={imageEdges}
              onShown={swipe.settle}
              wheelHint={wheelHint}
              suggestion={suggestion?.comment}
              onSelect={setSelectedId}
              onRemove={remove}
              onNotice={props.onToast}
            />
          )}
          {swipeOn && isImage && multi && !prefersReducedMotion() && (
            <ImageSwipePeek
              swipe={swipe}
              steps={steps}
              index={index}
              area={docAreaRef}
              urlOf={(file) => source.imageUrl(file, file.unavailable !== null ? 'sent' : (memory.current.get(file.id)?.version ?? 'current'))}
            />
          )}
          {isVideo && (
            <VideoAttachmentView
              // Its own comment row per file: a typed comment never carries over to the next film.
              key={attachment.id}
              ref={videoRef}
              attachment={attachment}
              version={effectiveVersion}
              annotations={annotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
              readOnly={props.readOnly}
              onSave={save}
              onError={setError}
              phone={phone}
              poster={source.posterUrl?.(attachment) ?? undefined}
              suggestion={suggestion ?? undefined}
              onRemove={remove}
              onNotice={props.onToast}
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
                {source.writes && (
                  <a className="ib-btn ib-pri" href={source.downloadUrl(attachment, effectiveVersion)} download={attachment.name}>
                    <Icon name="download" size={14} />
                    Download
                  </a>
                )}
              </div>
            </div>
          )}
          {view && isCode && (
            <div className="ib-codeview" data-code-view="">
              {/* The code's top row: Copy file first (approval "inbox-copy-file"), then how to comment. */}
              <div className="ib-codehint" style={codeClear === null ? undefined : { paddingTop: codeClear }} data-code-row="">
                <CopyFileButton text={view.text} name={attachment.name} sent={view.version !== 'current'} announce={announce} />
                {!props.readOnly && (
                  <span className="ib-codehint-t">{phone ? 'Tap a line to comment.' : 'Click a line number, drag across lines, or select code to comment.'}</span>
                )}
              </div>
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
            <div className="ib-docscroll bg-card" data-look="clean" ref={setScrollViewport}>
              <ScrollViewportProvider viewport={scrollViewport}>
              <ImageResolverContext.Provider value={resolveImage}>
              <Viewer
                key={`${attachment.id}:${view.version}:${view.attachment.current?.sha256 ?? ''}`}
                ref={viewerRef}
                blocks={blocks}
                markdown={view.text}
                imageBaseDir={imageBaseDir}
                questionDecisionLines={false}
                annotations={annotations}
                mentionSource={props.mentionSource}
                onAddAnnotation={(annotation) => void save(annotation)}
                onSelectAnnotation={setSelectedId}
                selectedAnnotationId={selectedId}
                mode={isText ? mode : 'comment'}
                inputMethod={isText ? inputMethod : 'drag'}
                taterMode={false}
                gridEnabled={false}
                maxWidth={full ? 760 : 640}
                stickyActions={false}
                disableCodePathValidation
                copyLabel="Copy file"
                allowImages={false}
                refRepo={refRepo}
                readOnly={props.readOnly}
                onRestoreReport={(report) => setUnanchored(new Set(report.unanchored))}
                suggestComment={suggestion?.phrase ? (selected) => suggestionFor(view.text, suggestion, selected) : undefined}
              />
              </ImageResolverContext.Provider>
              </ScrollViewportProvider>
            </div>
          )}
        </div>
        <div
          className="ib-apanel"
          id={sheetId}
          role={folded || full ? 'region' : undefined}
          aria-label={folded || full ? 'Comments' : undefined}
          data-comments-drawer={drawerMode ? (drawer ? 'open' : 'closed') : undefined}
          onKeyDown={(event) => {
            // Escape closes the open sheet or drawer, unless something inside (an edit box) already used it.
            if (event.key === 'Escape' && panelOpen && (folded || full) && !event.defaultPrevented) {
              event.preventDefault();
              closeSheet();
            }
          }}
        >
          {/* The sheet's (and full screen's drawer's) own title and close (a phone's touch presentation has neither). */}
          {(folded || full) && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{annotations.length}</span>
              <span className="ib-sp" />
              {isVideo && <span className="ib-mut ib-sheet-note">By time</span>}
              <button type="button" className="ib-iconbtn" onClick={closeSheet} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          <AnnotationPanel
            // The sheet and the drawer draw the timeline under their own title and close (and a phone's window-wide overlay below 768 px would have no close here).
            presentation={folded || full ? 'embedded' : undefined}
            // A linked page takes no comments: the hint says where they can be written instead.
            emptyHint={linkedTop ? `Comment on ${attachment.name}, not on this page` : isImage ? 'Comment below the image' : isVideo ? 'Pause at a moment and comment below the film' : isCode ? 'Click a line to comment' : undefined}
            isOpen
            annotations={annotations}
            blocks={blocks}
            // A film's comments read by the moment they are at, each with its time (a click seeks there).
            compareAnnotations={isVideo ? compareVideoTimes : undefined}
            renderCardHeader={
              isVideo
                ? (annotation) => {
                    const time = readInboxVideoTime(annotation);
                    if (time === null) return null;
                    const frame = annotation.images?.[0];
                    return (
                      <span className="ib-vcardtop">
                        <Tip content={`Go to ${formatInboxVideoTime(time)}`}>
                          <button
                            type="button"
                            className="ib-vtime"
                            onClick={() => {
                              setSelectedId(annotation.id);
                              videoRef.current?.seekTo(annotation.id);
                            }}
                            aria-label={`Go to ${formatInboxVideoTime(time)}`}
                            data-video-card-time={annotation.id}
                          >
                            {formatInboxVideoTime(time)}
                          </button>
                        </Tip>
                        {frame && !isWordlessMarkup(annotation) && (
                          <Tip content={frame.name}>
                          <span className="ib-vframe ib-vframe-sm" data-video-card-frame={annotation.id}>
                            <img src={getImageSrc(frame.path)} alt="" />
                            {/marked up$/.test(frame.name) && (
                              <span className="ib-vpen" aria-hidden="true">
                                <Icon name="pen" size={8} />
                              </span>
                            )}
                          </span>
                          </Tip>
                        )}
                      </span>
                    );
                  }
                : undefined
            }
            // The moment and the frame are in the card's header; the quote ("cut.mp4 at 1:42") and the image row would repeat them.
            // A drawing with no words is drawn as its picture: no quote, no image row, not the stand-in words the agent gets.
            cardParts={(annotation) => {
              const wordless = isWordlessMarkup(annotation);
              if (isVideo && readInboxVideoTime(annotation) !== null) return wordless ? { quote: false, images: false, text: false } : { quote: false, images: false };
              return wordless ? { quote: false, images: false, text: false } : {};
            }}
            renderCardBody={(annotation) => (isWordlessMarkup(annotation) ? <MarkupPicture image={annotation.images![0]!} /> : null)}
            title={isVideo ? 'Comments' : undefined}
            // A linked page takes no comments: the panel lists the attached page's, and says so.
            titleNote={isVideo ? 'By time' : linkedTop ? `Off on ${linkedTop.name}` : undefined}
            onSelect={(id) => {
              // A card is a comment on the attached page: back to it first (a new entry, as a link followed).
              if (linkedTop) props.onLinked?.(null);
              setSelectedId(id);
              if (isVideo) videoRef.current?.seekTo(id);
              // A sheet over the file steps aside to show the comment; the drawer sits beside the page and stays.
              if (sheetMode) setSheet(false);
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
          {/* Full screen has no bottom bar: the drawer's foot says where the comments go, and the way to the reply (a phone's position lives here too). */}
          {full && (
            <div className="ib-fvfoot" data-full-view-foot="">
              {phone && multi && (
                <button
                  type="button"
                  ref={phonePosRef}
                  className="ib-btn ib-fvfoot-pos"
                  aria-haspopup="grid"
                  aria-expanded={menuOpen}
                  aria-controls={menuOpen ? fullViewPeekId : undefined}
                  aria-label={`${index + 1} of ${steps.length}, ${attachment.name}. Show every file in this thread`}
                  onClick={() => {
                    peekOpener.current = 'foot';
                    setMenuOpen((v) => !v);
                  }}
                  data-full-view-position=""
                  data-peek-opener=""
                >
                  <span className="ib-stepn">
                    {index + 1} of {steps.length}
                  </span>
                  <span className="ib-fvfoot-nm">
                    <FileName name={attachment.name} />
                  </span>
                  <Icon name="chevD" size={13} />
                </button>
              )}
              <p className="ib-fvsend" data-strip-chip="">
                <b>{chipText}</b> {props.strip.picks === 0 && props.strip.annotations === 1 ? 'rides' : 'ride'} your next Send to {props.agent}.
                {elsewhere > 0 && ` ${elsewhere} ${elsewhere === 1 ? 'is' : 'are'} on other files.`}
              </p>
              <div className="ib-fvacts">
                <button type="button" className="ib-btn ib-sm ib-pri" onClick={() => leave(null, props.strip.onWriteReply)}>
                  <Icon name="reply" size={14} />
                  Write the reply
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {hasComposer && isHtml && composerValue && <FullScreenComposer value={composerValue} noun={null} comment={null} />}
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
            {guard.escape ? 'Save it' : guard.to === null ? 'Save it and close' : 'Save it and go on'}
          </button>
          <button type="button" className="ib-btn ib-sm" onClick={discardAndGo} disabled={guardSaving} data-guard-discard="">
            {guard.escape ? 'Discard it' : guard.to === null ? 'Discard and close the file' : <span className="ib-gto">Discard and go to <FileName name={guard.to} /></span>}
          </button>
          <button type="button" className="ib-btn ib-sm ib-ghost" onClick={keepWriting} data-guard-keep="">
            Keep writing
          </button>
        </div>
      ) : full ? null : (
        <div />
      )}
      {!full && multi ? (
        // Beside the thread: the stepper in the bar under the file.
        <div className="ib-vfoot" data-view-foot="">
          <AttachmentStepper
            steps={steps}
            index={index}
            peek={optionSet ? { steps: allSteps, index: allIndex, onGo: (target) => goTo(target, 'menu', allSteps) } : undefined}
            menuOpen={menuOpen}
            onMenuOpenChange={setMenuOpen}
            onStep={step}
            onGo={(target) => goTo(target, 'menu')}
            endNote={endNote}
            annotationCounts={annotationCounts}
          />
        </div>
      ) : full ? null : (
        <div />
      )}
      {full && optionSet && (
        // A question's picture choices: the caption names the choice on screen for as long as the set is open (in place of the chip).
        <OptionCaption set={optionSet} index={index} otherFiles={Math.max(0, allSteps.length - steps.length)} note={endNote} />
      )}
      {full && !optionSet && (
        // The step chip (full screen only): names the new file for a moment, the end note at the ends (a one-file thread: its name once, as full screen starts). The live region says it.
        <div className={`ib-fvchip${chip ? ' ib-on' : ''}`} aria-hidden="true" data-full-view-chip={chip ? 'shown' : 'hidden'}>
          {multi && (
            <span className="ib-stepn">
              {index + 1} of {steps.length}
            </span>
          )}
          <b className="ib-fvchip-nm">
            <FileName name={attachment.name} />
          </b>
          {chip?.note && <span className="ib-fvchip-note">{chip.note}</span>}
          {multi && !phone && (
            <span className="ib-fvchip-keys">
              <ShortcutHint scope={inboxFileViewerShortcuts} action="previous" className="" />
              <ShortcutHint scope={inboxFileViewerShortcuts} action="next" className="" />
            </span>
          )}
        </div>
      )}
      {full && phone && multi && <FileSwipeCard swipe={swipe} steps={steps} index={index} skip={peeks} />}
      {full && phone && menuOpen && phonePeekHost
        ? createPortal(
            <div className="pn-inbox-peek">
              <FilePeek
                id={fullViewPeekId}
                steps={allSteps}
                index={allIndex}
                within={optionSet ? { steps, index, noun: 'option' } : undefined}
                phone
                annotationCounts={annotationCounts}
                onClose={() => {
                  setMenuOpen(false);
                  // The sheet's backdrop covered everything: focus back on what opened it (the toolbar's pill, or the position in the comments sheet).
                  requestAnimationFrame(focusPeekOpener);
                }}
                onGo={(target) => goTo(target, 'menu', allSteps)}
                // The step for every file, swipeable or not (the owner's answer for HTML pages and code that scrolls
                // sideways): one tap steps and closes the sheet, so the new file is what you see; at an end only the note.
                onStep={(dir) => {
                  const target = index + dir;
                  if (target < 0 || target >= steps.length) {
                    step(dir, 'button');
                    return;
                  }
                  steppedFromSheet.current = true;
                  goTo(target, 'button');
                }}
              />
            </div>,
            phonePeekHost,
          )
        : null}
      {linkImage &&
        createPortal(<ImageLightbox src={linkImage.src} alt={linkImage.alt} onClose={() => setLinkImage(null)} />, document.body)}
      <div className="ib-sr" aria-live="polite" data-step-live="">
        {announced}
      </div>
      </FullScreenComposerContext.Provider>
    </section>
  );
});
