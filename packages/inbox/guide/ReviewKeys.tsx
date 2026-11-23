/**
 * The code review app's keys on a review in the Inbox (approval 2026-11-23: "Yes, the same keys as code review",
 * "Yes, the review's keys win while a review is open"). Drawn beside the reader on a PR's page in Reviews and in a
 * guided review (PullReview.tsx, ReviewPane.tsx): while its diff is on screen the review app's own scopes listen first
 * (capture), and every key they take is `preventDefault`ed, so the Inbox's keys stand down (guards.ts
 * `bareKeyAllowed`, every Inbox scope's rule for a used key) and come back with it gone.
 *
 * The bindings and words are the review app's registry entries, never retyped (packages/ui/shortcuts/code-review/,
 * packages/review-editor/shortcuts.ts). What each does here is what the matching control on the page does, or what
 * production's own code does (reviewWalk.ts). Keys whose feature the Inbox's review does not have yet are taken and do
 * nothing, so they never mean their Inbox key instead: C (no file comments), A (no staging). The review app's other
 * keys are not taken: they have no Inbox meaning to hide, or the Inbox's meaning is the review's own (P: G P stays
 * Go to Reviews).
 *
 * Mounted only through lazyParts.tsx (`ReviewKeysPart`, from the reader's chunk): it imports review-editor.
 */
import { useEffect, useMemo, useRef } from 'react';
import { getSingularPatch } from '@pierre/diffs';
import {
  matchesShortcutBindingGroup,
  reviewAllFilesDiffShortcuts,
  reviewExplorerShortcuts,
  reviewFileTreeShortcuts,
  resolveShortcutBindings,
  SHORTCUT_SEQUENCE_WINDOW_MS,
  useShortcutScope,
  type ShortcutHandlerConfig,
  type ShortcutScopeDefinition,
} from '@plannotator/ui/shortcuts';
import { parseDiffToFiles } from '@plannotator/guide-viewer/diffParser';
import { codeReviewSurface, reviewEditorShortcuts } from '@plannotator/review-editor/shortcuts';
import { findChangeElement, listDiffChanges, readingLineFor, renderedUnifiedRange, type DiffChange } from '@plannotator/review-editor/utils/changeNavigation';
import { focusFileHeaderWhenLost } from '@plannotator/review-editor/utils/focusFileHeader';
import { inboxAppShortcuts } from '../shortcuts/app.shortcuts';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen, singleKeysLive } from '../shortcuts/guards';
import { claimReviewKeys, openReviewKeys, type OpenReviewKeys, type ReviewKeyRef } from '../shortcuts/review';
import { selectionToolbarShowing, STRANGERS_MARKUP } from '../selectionToolbar';
import {
  activeFile,
  changeTarget,
  collapseToggle,
  fileShells,
  fileStep,
  isCollapsed,
  reopenTarget,
  scrollerOf,
  stepOrigin,
  viewedToggle,
  viewOf,
  type ChangeSpot,
  type FileStep,
} from './reviewWalk';

/** The review app's scopes as the Inbox matches letters: by the physical key on a non-Latin layout too, as every Inbox scope does. */
const inboxMatched = <T extends ShortcutScopeDefinition<any>>(scope: T): T => ({ ...scope, lettersByCode: true });
export const REVIEW_KEY_SCOPES = {
  fileTree: inboxMatched(reviewFileTreeShortcuts),
  allFiles: inboxMatched(reviewAllFilesDiffShortcuts),
  editor: inboxMatched(reviewEditorShortcuts),
  explorer: inboxMatched(reviewExplorerShortcuts),
} as const;
const { fileTree, allFiles, editor, explorer } = REVIEW_KEY_SCOPES;

/** The actions taken here: each acts, or (`inert`) has nothing to act on in the Inbox's review yet. */
export const REVIEW_KEY_ACTIONS: readonly (ReviewKeyRef & { inert?: true })[] = [
  { scope: fileTree, action: 'nextFile' },
  { scope: fileTree, action: 'prevFile' },
  { scope: fileTree, action: 'firstFile' },
  { scope: fileTree, action: 'lastFile' },
  { scope: allFiles, action: 'nextFile' },
  { scope: allFiles, action: 'prevFile' },
  { scope: editor, action: 'nextChange' },
  { scope: editor, action: 'prevChange' },
  { scope: explorer, action: 'nextChange' },
  { scope: explorer, action: 'previousChange' },
  { scope: allFiles, action: 'toggleCollapse' },
  { scope: allFiles, action: 'undoCollapse' },
  { scope: editor, action: 'toggleViewed' },
  { scope: allFiles, action: 'addFileComment', inert: true },
  { scope: editor, action: 'stageFile', inert: true },
];

/** The map's rows: the keys that do something on this review, the same change keys on one row. */
function mapRows(viewed: boolean): (readonly ReviewKeyRef[])[] {
  return [
    [{ scope: fileTree, action: 'nextFile' }],
    [{ scope: fileTree, action: 'prevFile' }],
    [{ scope: fileTree, action: 'firstFile' }],
    [{ scope: fileTree, action: 'lastFile' }],
    [{ scope: allFiles, action: 'nextFile' }],
    [{ scope: allFiles, action: 'prevFile' }],
    [{ scope: editor, action: 'nextChange' }, { scope: explorer, action: 'nextChange' }],
    [{ scope: editor, action: 'prevChange' }, { scope: explorer, action: 'previousChange' }],
    [{ scope: allFiles, action: 'toggleCollapse' }],
    [{ scope: allFiles, action: 'undoCollapse' }],
    ...(viewed ? [[{ scope: editor, action: 'toggleViewed' }]] : []),
  ];
}

const CLAIMED = new Set(REVIEW_KEY_ACTIONS.flatMap((ref) => resolveShortcutBindings(ref.scope.shortcuts[ref.action]!)));

/** The review the keys act on: the PR page or the guided review, else the element the keys are drawn in. */
const REVIEW_ROOT = '[data-pull-review], [data-review-message]';
/** Keys that move the page on their own: a widget that uses them keeps them (a tree, a menu, a slider, the rail). */
const PAGE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);
const ARROW_OWNERS =
  '[data-claims-arrows="true"], [data-diagram-canvas], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="separator"], [role="tree"], [role="treegrid"], [role="grid"], [data-review-files], [data-review-tree], [data-changes-tree], [data-repo-file-tree], select, video, audio';
/** What the diff can be under, or what has the keys while it is open: the PR's Details, a menu, a dialog or a sheet. */
const OPEN_COVERS = '[role="menu"], [role="dialog"], [role="alertdialog"]';
/** How many steps a change not drawn yet is looked for in its file (each scrolls most of a view toward it). */
const MAX_SEEK = 60;
/** The Inbox's sequences (`G P` Go to Reviews…): a key that ends one is never the review's. */
const SEQUENCES = Object.values(inboxAppShortcuts.shortcuts).flatMap((shortcut) =>
  resolveShortcutBindings(shortcut)
    .map((binding) => binding.trim().split(/\s+/))
    .filter((groups) => groups.length === 2)
    .map(([first, second]) => ({ first: first!, second: second! })),
);

/** The key before this one, and when: a sequence's first key, still waiting for its second. */
export interface LastKey {
  event: KeyboardEvent;
  at: number;
}

/** Whether `event` is the second key of an Inbox sequence whose first key was `before`, in time. */
export function endsSequence(event: KeyboardEvent, before: LastKey | null, now = Date.now()): boolean {
  if (!before || now - before.at > SHORTCUT_SEQUENCE_WINDOW_MS) return false;
  return SEQUENCES.some(
    ({ first, second }) =>
      matchesShortcutBindingGroup(before.event, first, inboxAppShortcuts) && matchesShortcutBindingGroup(event, second, inboxAppShortcuts),
  );
}

/**
 * Whether the review's diff is what the person is looking at: not under a repository file opened over it (the PR
 * page keeps the diff in place, `visibility: hidden`), and not covered where it is drawn. Asked of the page itself: the
 * element at the left, the middle and the right of the view's middle line must be the review's (any one will do, so a
 * side panel over part of it still leaves the keys to the part in view). With no layout to ask (no element anywhere),
 * nothing covers it.
 */
export function diffOnScreen(scroller: HTMLElement): boolean {
  if (scroller.closest('[data-repo-open]') || scroller.hasAttribute('data-repo-open')) return false;
  if (typeof document.elementFromPoint !== 'function') return true;
  const page = scroller === document.scrollingElement || scroller === document.documentElement;
  const rect = page ? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
  const y = (Math.max(rect.top, 0) + Math.min(rect.bottom, window.innerHeight)) / 2;
  const hits = [0.25, 0.5, 0.75].map((share) => document.elementFromPoint(rect.left + (rect.right - rect.left) * share, y));
  if (hits.every((hit) => hit === null)) return true;
  return hits.some((hit) => !!hit && (page || scroller.contains(hit)) && !hit.closest('.ib-prp-repofile'));
}

/** A menu, a dialog or a sheet open anywhere on the window (a PR description's raw HTML is none). */
function coverOpen(): boolean {
  for (const el of document.querySelectorAll(OPEN_COVERS)) {
    if (!el.closest(STRANGERS_MARKUP) && el.getClientRects().length > 0) return true;
  }
  return false;
}

/**
 * Whether the review has the keys now, from where focus is (`target`): not while focus is in a dialog, menu, frame or
 * the PR's Details, or under a modal, a cover, a Shape board or a repository file. Otherwise the keys are the Inbox's
 * again, and the map and the Undo toast say so (OpenReviewKeys `live`).
 */
export function reviewKeysLive(root: HTMLElement, scroller: HTMLElement, target: Element | null): boolean {
  if (target && (inOverlay(target) || target.closest('[role="menu"], [role="listbox"], iframe, [data-pull-details]'))) return false;
  if (modalOpen() || selectionToolbarShowing(document) || boardOver(target) || coverOpen()) return false;
  return diffOnScreen(scroller);
}

/** Whether a review key may act now: never while typing or composing, and only while the review has the keys. */
export function reviewKeyAllowed(event: KeyboardEvent, root: HTMLElement, scroller: HTMLElement): boolean {
  if (event.defaultPrevented || isComposingKey(event)) return false;
  const pageKey = PAGE_KEYS.has(event.key) || event.key === 'F5';
  // The letters and `[` `]` are single keys: off with Single-key shortcuts, as every Inbox single key (WCAG 2.1.4).
  if (!pageKey && !singleKeysLive()) return false;
  const target = keyTarget(event);
  if (target && isEditableTarget(target)) return false;
  if (PAGE_KEYS.has(event.key)) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const fromPage = !target || target === document.body || target === document.documentElement;
    if (!fromPage && !path.includes(root)) return false;
    if (path.some((node) => node instanceof Element && node.matches(ARROW_OWNERS))) return false;
  }
  return reviewKeysLive(root, scroller, target);
}

/** A Shape board open over the review (ShapeBoardLayer), or the key from inside one: the board has the keys then. */
function boardOver(target: Element | null): boolean {
  if (target?.closest('[data-shape-layer]')) return true;
  const layers = document.querySelectorAll<HTMLElement>('[data-shape-layer]:not([data-shape-in-thread])');
  return [...layers].some((layer) => !layer.closest('[hidden]'));
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

interface Layout {
  shells: HTMLElement[];
  view: { top: number; bottom: number };
  scroller: HTMLElement;
}

function layoutOf(root: HTMLElement): Layout {
  const shells = fileShells(root);
  const scroller = scrollerOf(shells[0] ?? root);
  return { shells, view: viewOf(scroller), scroller };
}

const spans = (shells: readonly HTMLElement[]) => shells.map((shell) => shell.getBoundingClientRect());
const pathOf = (shell: HTMLElement) => shell.dataset.guideFileShell ?? '';
/** A file brought to the top of the view, at the place a jump from the review's rail puts it (its `scroll-mt-4`). */
const reach = (shell: HTMLElement) => shell.scrollIntoView({ block: 'start' });
const drawn = (shell: HTMLElement) => renderedUnifiedRange(shell) !== null;

/**
 * Every change of a file in `diff`, by path: the patch the reader draws each file from (GuideReader's files). Read
 * only when a key asks (N, Shift+N), once per file: a review never stepped through is never parsed here, and a patch
 * Pierre finds fault with says so only when it is read for a step, as the review app's own reading does.
 */
export function changesByPath(diff: string): (path: string) => DiffChange[] {
  let patches: Map<string, string> | null = null;
  const read = new Map<string, DiffChange[]>();
  return (path) => {
    const known = read.get(path);
    if (known) return known;
    patches ??= new Map(parseDiffToFiles(diff).map((file) => [file.path, file.patch]));
    const patch = patches.get(path);
    let changes: DiffChange[] = [];
    try {
      changes = patch === undefined ? [] : listDiffChanges(getSingularPatch(patch).hunks);
    } catch {
      changes = [];
    }
    read.set(path, changes);
    return changes;
  };
}

export interface ReviewKeysProps {
  /** The review's patch, as its reader draws it. */
  diff: string;
  /** Whether the review has Viewed ticks (V's control). */
  viewed: boolean;
}

export function ReviewKeys({ diff, viewed }: ReviewKeysProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const changes = useMemo(() => changesByPath(diff), [diff]);
  /** The change the last N or Shift+N landed on: the next step goes on from it while it is on screen. */
  const cursor = useRef<{ shell: HTMLElement; index: number } | null>(null);
  /** The step in flight toward a change not drawn yet; a new key ends it. */
  const seek = useRef(0);
  const seeking = useRef(false);
  /** The key before the one being handled (a sequence's first key). */
  const keys = useRef<{ before: LastKey | null; now: LastKey | null }>({ before: null, now: null });
  // Before the scopes below, so it has seen each key by the time they are asked.
  useEffect(() => {
    const note = (event: KeyboardEvent) => {
      if (keys.current.now?.event === event) return;
      keys.current = { before: keys.current.now, now: { event, at: Date.now() } };
    };
    window.addEventListener('keydown', note, true);
    return () => window.removeEventListener('keydown', note, true);
  }, []);
  // Two reviews drawn at once (a guided review over a PR's page): the keys are the one drawn last.
  const claim = useMemo<OpenReviewKeys>(
    () => ({
      title: codeReviewSurface.title,
      rows: mapRows(viewed),
      claimed: CLAIMED,
      live: () => {
        const root = rootOf();
        return !!root && reviewKeysLive(root, layoutOf(root).scroller, document.activeElement);
      },
    }),
    [viewed],
  );
  const claimRef = useRef(claim);
  claimRef.current = claim;
  useEffect(() => claimReviewKeys(claim), [claim]);

  const rootOf = (): HTMLElement | null => marker.current?.closest<HTMLElement>(REVIEW_ROOT) ?? marker.current?.parentElement ?? null;
  const take = (act: (root: HTMLElement, event: KeyboardEvent) => void, { once = false } = {}): ShortcutHandlerConfig => ({
    when: (event) => {
      const root = rootOf();
      if (!root || openReviewKeys() !== claimRef.current || endsSequence(event, keys.current.before)) return false;
      return reviewKeyAllowed(event, root, layoutOf(root).scroller);
    },
    handle: (event) => {
      // Taken whether or not there is anywhere to go: at the last file J stays, it never becomes the Inbox's J.
      event.preventDefault();
      // A held toggle (X, V) acts once, as the Inbox's own keys do.
      if (once && event.repeat) return;
      const root = rootOf();
      if (root) act(root, event);
    },
  });
  const inert = take(() => {});

  const toFile = (step: FileStep) =>
    take((root) => {
      seek.current++;
      seeking.current = false;
      const { shells, view, scroller } = layoutOf(root);
      const origin = stepOrigin(spans(shells), view, scroller.scrollTop <= 1);
      const target = fileStep(step, origin, shells.length);
      // J in the last file, K in the first: there is no other file that way, so the page stays where it is.
      if (target === null || ((step === 'next' || step === 'prev') && target === origin)) return;
      reach(shells[target]!);
      // As the review app's file keys do (FileTree): the keyboard lands on the file's header.
      focusFileHeaderWhenLost(pathOf(shells[target]!));
    });

  /** The file X and V act on: the top-most on screen, as the review app's active file. */
  const onActive = (act: (shell: HTMLElement) => void) =>
    take(
      (root) => {
        const { shells, view } = layoutOf(root);
        const at = activeFile(spans(shells), view);
        if (at !== -1) act(shells[at]!);
      },
      { once: true },
    );

  const reopen = take((root) => {
    const { shells, view } = layoutOf(root);
    const target = reopenTarget(shells.map(isCollapsed), activeFile(spans(shells), view));
    if (target === null) return;
    collapseToggle(shells[target]!)?.click();
    reach(shells[target]!);
  });

  /**
   * N / Shift+N: the next or previous change, as the review app's `jumpChange` picks it (AllFilesCodeView): every
   * change of the open files, from the one it last landed on while that is on screen, else from the reading line. With
   * none that way the page stays. One whose row is not drawn yet (a file not mounted, or a long file's rows further on)
   * is brought on screen: its file first, then on toward its row until it is drawn. A held key steps only once the
   * step before it has landed, as the review app's queue does.
   */
  const toChange = (direction: 'next' | 'prev') =>
    take((root, event) => {
      if (event.repeat && seeking.current) return;
      const token = ++seek.current;
      seeking.current = false;
      const { shells, view, scroller } = layoutOf(root);
      const scroll = {
        atTop: scroller.scrollTop <= 1,
        atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1,
      };
      // From the change it last landed on while that is on screen (its row drawn, in view).
      const last = cursor.current;
      const lastChange = last && shells.includes(last.shell) ? changes(pathOf(last.shell)).find((change) => change.unifiedIndex === last.index) : undefined;
      const lastRect = lastChange ? findChangeElement(last!.shell, lastChange)?.getBoundingClientRect() : undefined;
      const from = lastRect && lastRect.bottom > view.top && lastRect.top < view.bottom ? last : null;
      const spot = changeTarget(shells, (shell) => changes(pathOf(shell)), readingLineFor(view, direction, scroll), direction, from);
      if (!spot) return;
      cursor.current = { shell: spot.shell, index: spot.change.unifiedIndex };
      if (spot.el) {
        spot.el.scrollIntoView({ block: 'center' });
        return;
      }
      seeking.current = true;
      void bringOn(spot, scroller, () => token === seek.current).finally(() => {
        if (token === seek.current) seeking.current = false;
      });
    });

  const fileHandlers = { nextFile: toFile('next'), prevFile: toFile('prev') };
  useShortcutScope({ scope: fileTree, capture: true, handlers: { ...fileHandlers, firstFile: toFile('first'), lastFile: toFile('last') } });
  useShortcutScope({
    scope: allFiles,
    capture: true,
    handlers: {
      ...fileHandlers,
      toggleCollapse: onActive((shell) => collapseToggle(shell)?.click()),
      undoCollapse: reopen,
      // No file comments in the Inbox's review yet.
      addFileComment: inert,
    },
  });
  useShortcutScope({
    scope: editor,
    capture: true,
    handlers: {
      // Where the review has Viewed ticks: what the header's Viewed does (and its folding), else nothing.
      toggleViewed: onActive((shell) => viewedToggle(shell)?.click()),
      nextChange: toChange('next'),
      prevChange: toChange('prev'),
      // No staging in the Inbox.
      stageFile: inert,
    },
  });
  useShortcutScope({ scope: explorer, capture: true, handlers: { nextChange: toChange('next'), previousChange: toChange('prev') } });

  return <span ref={marker} hidden data-review-keys="" />;
}

/**
 * A change whose row is not drawn yet, brought on screen: its file first (a file not mounted draws once it is near the
 * view), then a step at a time toward its row, which is in that file, until the row is drawn; then it is centred as a
 * drawn one is. Never past its file, and it stops once a step no longer moves the page or a newer key took over.
 */
async function bringOn(spot: ChangeSpot, scroller: HTMLElement, live: () => boolean): Promise<void> {
  const { shell, change } = spot;
  if (!drawn(shell)) shell.scrollIntoView({ block: 'start' });
  for (let tries = 0; tries < MAX_SEEK; tries++) {
    for (let wait = 0; wait < 3; wait++) await frame();
    if (!live()) return;
    const el = findChangeElement(shell, change);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    const rows = renderedUnifiedRange(shell);
    // Not mounted yet: give it a few more frames.
    if (!rows) continue;
    const before = scroller.scrollTop;
    const height = scroller.clientHeight || window.innerHeight;
    scroller.scrollTop += (change.unifiedIndex < rows.min ? -1 : 1) * Math.round(height * 0.8);
    if (scroller.scrollTop === before) return;
  }
}
