/**
 * The code review app's keys on a review in the Inbox (approval 2026-11-23: "Yes, the same keys as code review",
 * "Yes, the review's keys win while a review is open"). Drawn beside the reader on a PR's page in Reviews and in a
 * guided review (PullReview.tsx, ReviewPane.tsx; a local changes pane mounts it the same way): while it is on screen
 * the review app's own scopes listen first (capture), and every key they take is `preventDefault`ed, so the Inbox's
 * keys stand down (guards.ts `bareKeyAllowed`, every Inbox scope's rule for a used key) and come back with it gone.
 *
 * The bindings and words are the review app's registry entries, never retyped (packages/ui/shortcuts/code-review/,
 * packages/review-editor/shortcuts.ts). What each does here is what the matching control on the page does
 * (reviewWalk.ts). Keys whose feature the Inbox's review does not have yet are taken and do nothing, so they never
 * mean their Inbox key instead: C (no file comments), P (no rendered Markdown view), A (no staging). The review
 * app's other keys are not taken: they have no Inbox meaning to hide, or the Inbox's meaning is the review's own.
 *
 * Mounted only through lazyParts.tsx (`ReviewKeysPart`, from the reader's chunk): it imports review-editor.
 */
import { useEffect, useRef } from 'react';
import {
  reviewAllFilesDiffShortcuts,
  reviewExplorerShortcuts,
  reviewFileTreeShortcuts,
  reviewMarkdownPreviewShortcuts,
  resolveShortcutBindings,
  useShortcutScope,
  type ShortcutHandlerConfig,
  type ShortcutScopeDefinition,
} from '@plannotator/ui/shortcuts';
import { codeReviewSurface, reviewEditorShortcuts } from '@plannotator/review-editor/shortcuts';
import { readingLineFor } from '@plannotator/review-editor/utils/changeNavigation';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen, singleKeysLive } from '../shortcuts/guards';
import { claimReviewKeys, openReviewKeys, type OpenReviewKeys, type ReviewKeyRef } from '../shortcuts/review';
import { selectionToolbarShowing } from '../selectionToolbar';
import {
  activeFile,
  changeStarts,
  collapseToggle,
  fileShells,
  fileStep,
  isCollapsed,
  pickChange,
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
  markdown: inboxMatched(reviewMarkdownPreviewShortcuts),
  editor: inboxMatched(reviewEditorShortcuts),
  explorer: inboxMatched(reviewExplorerShortcuts),
} as const;
const { fileTree, allFiles, markdown, editor, explorer } = REVIEW_KEY_SCOPES;

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
  { scope: markdown, action: 'cycleMarkdownView', inert: true },
  { scope: editor, action: 'stageFile', inert: true },
];

/** The map's rows: the keys that act, the same change keys on one row. */
const MAP_ROWS: readonly (readonly ReviewKeyRef[])[] = [
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
  [{ scope: editor, action: 'toggleViewed' }],
];

const CLAIM: OpenReviewKeys = {
  title: codeReviewSurface.title,
  rows: MAP_ROWS,
  claimed: new Set(REVIEW_KEY_ACTIONS.flatMap((ref) => resolveShortcutBindings(ref.scope.shortcuts[ref.action]!))),
};

/** The review the keys act on: the PR page, the guided review, else the element the keys are drawn in. */
const REVIEW_ROOT = '[data-pull-review], [data-review-message], [data-local-diff]';
/** Keys that move the page on their own: a widget that uses them keeps them (a tree, a menu, a slider, the rail). */
const PAGE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);
const ARROW_OWNERS =
  '[data-claims-arrows="true"], [data-diagram-canvas], [role="menu"], [role="menubar"], [role="listbox"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="separator"], [role="tree"], [role="treegrid"], [role="grid"], [data-review-files], [data-review-tree], [data-changes-tree], [data-repo-file-tree], select, video, audio';
/** How long a step toward an undrawn change looks before it stops (each try scrolls most of a view). */
const MAX_SEEK = 40;

/** Whether a review key may act now: never while typing, composing, in a dialog, menu or frame, or under a modal. */
export function reviewKeyAllowed(event: KeyboardEvent, root: HTMLElement): boolean {
  if (event.defaultPrevented || isComposingKey(event)) return false;
  const pageKey = PAGE_KEYS.has(event.key) || event.key === 'F5';
  // The letters and `[` `]` are single keys: off with Single-key shortcuts, as every Inbox single key (WCAG 2.1.4).
  if (!pageKey && !singleKeysLive()) return false;
  const target = keyTarget(event);
  if (target && (isEditableTarget(target) || inOverlay(target) || target.closest('[role="menu"], [role="listbox"], iframe'))) return false;
  if (PAGE_KEYS.has(event.key)) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const fromPage = !target || target === document.body || target === document.documentElement;
    if (!fromPage && !path.includes(root)) return false;
    if (path.some((node) => node instanceof Element && node.matches(ARROW_OWNERS))) return false;
  }
  if (modalOpen() || selectionToolbarShowing(document) || boardOver(target)) return false;
  return true;
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

function drawnChanges(shells: readonly HTMLElement[]): ChangeSpot[] {
  return shells.flatMap((shell) => (isCollapsed(shell) ? [] : changeStarts(shell).map((start) => ({ ...start, file: pathOf(shell) }))));
}

export function ReviewKeys() {
  const marker = useRef<HTMLSpanElement>(null);
  /** The change the last N or Shift+N landed on: the next step goes on from it while it is on screen. */
  const cursor = useRef<{ file: string; index: number } | null>(null);
  /** The step in flight toward a change not drawn yet; a new key ends it. */
  const seek = useRef(0);
  // Two reviews drawn at once (a guided review over a PR's page): the keys are the one drawn last.
  const claim = useRef<OpenReviewKeys>({ ...CLAIM });
  useEffect(() => claimReviewKeys(claim.current), []);

  const rootOf = (): HTMLElement | null => marker.current?.closest<HTMLElement>(REVIEW_ROOT) ?? marker.current?.parentElement ?? null;
  const take = (act: (root: HTMLElement, event: KeyboardEvent) => void): ShortcutHandlerConfig => ({
    when: (event) => {
      const root = rootOf();
      return !!root && openReviewKeys() === claim.current && reviewKeyAllowed(event, root);
    },
    handle: (event) => {
      // Taken whether or not there is anywhere to go: at the last file J stays, it never becomes the Inbox's J.
      event.preventDefault();
      const root = rootOf();
      if (root) act(root, event);
    },
  });
  const inert = take(() => {});

  const toFile = (step: FileStep) =>
    take((root) => {
      seek.current++;
      const { shells, view } = layoutOf(root);
      const target = fileStep(step, stepOrigin(spans(shells), view.top), shells.length);
      if (target !== null) reach(shells[target]!);
    });

  /** The file X and V act on: the top-most on screen, as the review app's active file. */
  const onActive = (act: (shell: HTMLElement) => void) =>
    take((root) => {
      const { shells, view } = layoutOf(root);
      const at = activeFile(spans(shells), view);
      if (at !== -1) act(shells[at]!);
    });

  const reopen = take((root) => {
    const { shells, view } = layoutOf(root);
    const target = reopenTarget(shells.map(isCollapsed), activeFile(spans(shells), view));
    if (target === null) return;
    collapseToggle(shells[target]!)?.click();
    reach(shells[target]!);
  });

  /**
   * N / Shift+N: the next or previous change, measured as the review app measures (from the change it last landed
   * on while that is on screen, else from the middle of the view). One not drawn yet (further down a long file, or in
   * a file not mounted) is looked for by scrolling on from where the key was pressed until it is drawn.
   */
  const toChange = (direction: 'next' | 'prev') =>
    take((root) => {
      const token = ++seek.current;
      const land = (spot: ChangeSpot) => {
        cursor.current = { file: spot.file, index: spot.index };
        spot.el.scrollIntoView({ block: 'center' });
      };
      const first = layoutOf(root);
      const { scroller } = first;
      const atTop = scroller.scrollTop <= 1;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const drawn = drawnChanges(first.shells);
      const spot = pickChange(drawn, direction, first.view, { atTop, atBottom }, cursor.current);
      if (spot) return land(spot);
      // Where the step starts, in the scroller's own coordinates: the change last landed on while it is on screen, else
      // the reading line. The drawn rows past it had no change.
      const contentOf = (y: number, view: { top: number }) => scroller.scrollTop + y - view.top;
      const landed = cursor.current && drawn.find((candidate) => candidate.file === cursor.current!.file && candidate.index === cursor.current!.index);
      const landedRect = landed?.el.getBoundingClientRect();
      const onScreen = landedRect && landedRect.bottom > first.view.top && landedRect.top < first.view.bottom;
      const from = onScreen
        ? contentOf(landedRect.top + landedRect.height / 2, first.view)
        : contentOf(readingLineFor(first.view, direction, { atTop, atBottom }), first.view);
      void (async () => {
        for (let tries = 0; tries < MAX_SEEK; tries++) {
          const before = scroller.scrollTop;
          const height = scroller.clientHeight || window.innerHeight;
          scroller.scrollTop += (direction === 'next' ? 1 : -1) * Math.round(height * 0.8);
          const moved = scroller.scrollTop !== before;
          // The files that came on screen mount and draw their rows.
          for (let wait = 0; wait < 3; wait++) await frame();
          if (token !== seek.current) return;
          const now = layoutOf(root);
          for (let wait = 0; wait < 12 && now.shells.some((shell) => shell.querySelector('[data-guide-code-view-mounted="false"]') && overlaps(shell, now.view)); wait++) await frame();
          if (token !== seek.current) return;
          const spots = drawnChanges(now.shells).filter((candidate) => {
            const rect = candidate.el.getBoundingClientRect();
            const middle = contentOf(rect.top + rect.height / 2, now.view);
            return direction === 'next' ? middle > from + 4 : middle < from - 4;
          });
          const found = direction === 'next' ? spots[0] : spots[spots.length - 1];
          if (found) return land(found);
          if (!moved) return;
        }
      })();
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
  // No rendered Markdown view in the Inbox's review yet.
  useShortcutScope({ scope: markdown, capture: true, handlers: { cycleMarkdownView: inert } });
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

function overlaps(el: HTMLElement, view: { top: number; bottom: number }): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > view.top && rect.top < view.bottom;
}
