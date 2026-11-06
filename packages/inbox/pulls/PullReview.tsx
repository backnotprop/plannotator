/**
 * "Review layer by layer" (approval "inbox-code-review-direction", item 4):
 * phase 1's full-window review mode (ReviewPane's frame: the rail of changed
 * files, Plannotator's own diff through `GuideReader` with line comments and
 * Viewed ticks, the comments panel, ui's DecisionControl in the header) on one
 * layer of a stack, or on the whole stack up to a layer.
 *
 * - One title, the bar's (approval "inbox-pr-page"): the reader draws none of its
 *   own (`GuideReader` `bare`). The rail holds the stack and the files; the
 *   sidebar's toggle is first in the bar, and the page sits beside the sidebar
 *   as the other pages do.
 * - The rail stays at every width but a phone's, where the row under the bar
 *   opens it as a sheet over the diff, the comments' sheet's mirror; an open
 *   sidebar never takes it away: its toggle gives the room back.
 * - A layer is the PR's own diff; "All N layers" is the compare from the
 *   stack's base branch to this layer's head (inbox-pulls.ts `diff`).
 * - The end of a layer's diff offers the next layer.
 * - Approve / Send feedback go into the review thread as the person's reply
 *   (`pullVerdictReply`): This layer's to the layer's own agent thread
 *   (`layerVerdictLink`), Whole stack's to the stack's one review thread
 *   (`stackVerdictLink`); a teammate's PR has no agent here, so its diff
 *   reads without a verdict. No merge button, and nothing is posted to the
 *   forge unless the person chooses to post.
 *
 * No new keyboard shortcuts. The comments and Viewed ticks are kept in this
 * window's storage per layer and scope until the verdict goes.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GuideReaderPart, PanePart, PullAllFilesPart, PullRepoFilePart, ReaderPart } from '../lazyParts';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import { anchorStillMatches, captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';
import type { KeptComment } from '../guide/platform-post-types';
import type { DiffFile } from '@plannotator/core/diff-files';
import { inboxPullRepoKey, type InboxPullDiffAnswer, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { InboxApiError, inboxApi } from '../api';
import { guideCommentSections } from '../attachments';
import { RefMarkIcon } from '../board/RefMark';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { DiffStyleSwitch } from '../components/DiffStyleSwitch';
import { SidebarTrigger } from '../shell/sidebar';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { VerdictKeys, verdictOf } from '../reviewVerdict';
import { OpenInCodeSpans, OpenInFile } from '../components/OpenIn';
import { REVIEW_FOLD_PANEL_BELOW } from '../components/ReviewPane';
import { PostEnding, useReviewDestination } from './PostEnding';
import { postablePull, postedSignature, postedWords } from './postRules';
import { findStack, inboxPullLabel, linkAgentName, pullGroups, pullNounWord, pullVerdictReply } from './model';
import { forgeName } from './labels';
import { FileTreeMark } from './fileTreeMark';
import { TooltipEscapePassesThrough } from '@plannotator/ui/components/Tooltip';
import { RailStack } from './RailStack';
import { RailTree } from './RailTree';
import { DetailsButton, DetailsTitle, PullDetails, usePullDetails } from './PullDetails';
import { RailScopeSwitch } from './RailScope';
import { useTreeScope } from '@plannotator/review-editor/hooks/useTreeScope';
import { useSheetEscape } from '../shortcuts/useSheetEscape';
import { inOverlay } from '../shortcuts/guards';
import { reviewFiles } from './reviewFiles';
import { layerVerdictLink, nextLayer, stackVerdictLink } from './topology';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
/** The file rail's width: dragged and kept. */
const RAIL_WIDTH = { key: 'plannotator-inbox-pull-rail-width', initial: 280, min: 180, max: 480 };
const GuideReader = GuideReaderPart.Part;

export interface PullReviewProps {
  model: InboxPullsAnswer | null;
  /** The list could not be read (the review has nothing to show). */
  modelError: string | null;
  stackId: string;
  layerKey: string;
  scope: 'layer' | 'stack';
  onLayer: (key: string, scope: 'layer' | 'stack') => void;
  /** Back to the stack view. */
  onBack: () => void;
  /** The verdict went. */
  onSent: () => void;
}

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];
const STORE = 'plannotator-inbox-pull-review:';
/** The diffs read in this window, by what makes a diff: layer, scope, head commit and base (a new commit reads again). */
const SEEN = new Map<string, InboxPullDiffAnswer>();
const SEEN_MAX = 12;
/** The head each layer's last patch named here, either scope. */
const NEWEST = new Map<string, string>();
/** A diff read in this window, only if it is of the newest head read (as the server's cache): a list gone back reads the forge. */
const seenDiff = (seenId: string, layerKey: string): InboxPullDiffAnswer | undefined => {
  const seen = SEEN.get(seenId);
  return seen && seen.head_sha === NEWEST.get(layerKey) ? seen : undefined;
};
/** A stored review's last part when it names a head commit (as `shaOf` in the server's inbox-pulls.ts takes one). */
const HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** What a line comment's lines are on, kept on it as `anchorSnapshot`: the same head can show other lines (a retarget). */
function stampOf(patch: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < patch.length; i++) hash = Math.imul(hash ^ patch.charCodeAt(i), 0x01000193);
  return `${patch.length}:${(hash >>> 0).toString(36)}`;
}

function readKept(id: string): { comments: KeptComment[]; viewed: string[] } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE + id) ?? 'null') as { comments?: unknown; viewed?: unknown } | null;
    return {
      comments: Array.isArray(raw?.comments) ? (raw!.comments as KeptComment[]) : [],
      viewed: Array.isArray(raw?.viewed) ? (raw!.viewed as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return { comments: [], viewed: [] };
  }
}

function keep(id: string, value: { comments: KeptComment[]; viewed: string[] }): boolean {
  try {
    if (value.comments.length === 0 && value.viewed.length === 0) window.localStorage.removeItem(STORE + id);
    else window.localStorage.setItem(STORE + id, JSON.stringify(value));
    return true;
  } catch {
    // Storage full or off: kept for this visit only.
    return false;
  }
}

/**
 * One review per layer and scope: moving to another layer (Next layer, the rail) or to all the layers starts afresh, so a note drafted on #412 never rides into #413's verdict.
 */
export function PullReview(props: PullReviewProps) {
  // A tooltip in the rail, a file's head or the decision (ui's, not the Inbox's Tip) would eat the Escape that closes a sheet.
  return (
    <TooltipEscapePassesThrough.Provider value={true}>
      <LayerReview key={`${props.layerKey}\u0000${props.scope}`} {...props} />
    </TooltipEscapePassesThrough.Provider>
  );
}

/** What the diff on screen is, for the kept comments: what is read of it, and what the list says. */
interface OnScreen {
  updatedAt: string | null;
  listHead: string | null;
  /** The patch's stamp, its base and its files; null, none yet. */
  stamp: string | null;
  base: string | null;
  files: readonly DiffFile[];
}

const onLine = (c: CodeAnnotation) => (c.scope ?? 'line') === 'line';

/** A line comment is drawn on this diff only if these are truly its lines: this patch, or the same code at the same place. */
function isHere(c: KeptComment, screen: Pick<OnScreen, 'stamp' | 'files'>): boolean {
  // A file-level comment is here while its file is.
  if (!onLine(c)) return c.scope !== 'file' || !screen.stamp || screen.files.some((f) => f.path === c.filePath);
  if (c.outdated) return false;
  return !screen.stamp || c.anchorSnapshot === undefined || c.anchorSnapshot === screen.stamp || anchorStillMatches(c, screen.files);
}

/** The stored entries of one layer and scope, by the name `readKept` takes. */
function allEntries(layerKey: string, scope: string): string[] {
  const names: string[] = [];
  try {
    const prefix = `${STORE}${layerKey}:${scope}:`;
    for (let i = 0; i < window.localStorage.length; i++) {
      const name = window.localStorage.key(i);
      if (name?.startsWith(prefix)) names.push(name.slice(STORE.length));
    }
  } catch {
    // Storage off.
  }
  return names;
}

/**
 * One comment in other words in another entry (a window still on the old head edited it): both are the person's, so it
 * stays as a comment of its own, for them to see both and delete one. Its id follows from its words, so every read
 * gives the same one.
 */
const asSeparate = (c: KeptComment): KeptComment => ({ ...c, id: `${c.id}:${stampOf(postedSignature(c))}` });

/**
 * A review's words: this head's entry, with what the layer's other entries hold, all of it in view: a push loses no
 * comment. Viewed ticks stay with their head, but for an entry that names no commit (written before the head was known,
 * or by an older Inbox, which named the PR's last update).
 *
 * A line comment says what it was read on. One read on another commit, the PR on the same base, keeps its lines there
 * and posts there. One whose lines no diff can vouch for is marked outdated, so it never posts on whatever sits at those
 * lines now: read under this very head on another patch (a retarget), read with no head named, or on another base. The
 * same code at the same place is left alone. One with nothing to say is an older Inbox's: outdated once the PR has updated
 * since, or a head is named that the list (`listHead`) does not name; otherwise it was read on the patch named.
 *
 * `read` touches nothing, as an entry can be newer than what this window knows. `absorb` takes what is now in view out of
 * the other entries (the person wrote, so this entry speaks for them). `move`, once a patch read here names this head,
 * also removes the other heads' Viewed.
 */
function gather(layerKey: string, scope: string, keptId: string, screen: OnScreen, mode: 'read' | 'absorb' | 'move'): { comments: KeptComment[]; viewed: string[] } {
  const now = readKept(keptId);
  try {
    const prefix = `${STORE}${layerKey}:${scope}:`;
    const head = keptId.slice(keptId.lastIndexOf(':') + 1);
    const named = HEAD_SHA.test(head);
    const { stamp, base, files, listHead, updatedAt } = screen;
    const readHere = named && base ? { readHead: head, readBase: base } : {};
    const placed = (c: KeptComment, stale: boolean): KeptComment => {
      if (!onLine(c) || c.outdated) return c;
      if (c.anchorSnapshot === undefined) {
        if (stale) return { ...c, outdated: true };
        return named && stamp ? { ...c, anchorSnapshot: stamp, ...readHere, ...captureAnchor(c, files) } : c;
      }
      if (!stamp) return c;
      if (c.anchorSnapshot === stamp) return c.readHead || !named ? c : { ...c, ...readHere };
      if (!named || anchorStillMatches(c, files)) return c;
      return c.readHead === head || c.readBase !== base ? { ...c, outdated: true } : c;
    };
    const mine = now.comments.map((c) => placed(c, false));
    let changed = mine.some((c, i) => c !== now.comments[i]);
    const carried: KeptComment[] = [];
    const ticks: string[] = [];
    const taken: (() => void)[] = [];
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const name = window.localStorage.key(i);
      if (!name || !name.startsWith(prefix) || name === STORE + keptId) continue;
      const suffix = name.slice(prefix.length);
      const ofAHead = HEAD_SHA.test(suffix);
      const was = readKept(name.slice(STORE.length));
      const stale = !ofAHead && (suffix !== updatedAt || (named && listHead !== head));
      carried.push(...was.comments.map((c) => placed(c, stale)));
      if (!ofAHead) ticks.push(...was.viewed);
      if (mode === 'read') continue;
      taken.push(() => {
        if (!ofAHead || mode === 'move') window.localStorage.removeItem(name);
        else keep(name.slice(STORE.length), { comments: [], viewed: was.viewed });
      });
    }
    changed ||= carried.length > 0 || ticks.length > 0;
    const comments = [...mine];
    for (const c of carried) {
      const apart = asSeparate(c);
      if (comments.some((o) => o.id === apart.id)) continue;
      const same = comments.find((o) => o.id === c.id);
      if (!same) comments.push(c);
      else if (postedSignature(same) !== postedSignature(c)) comments.push(apart);
    }
    const value = { comments, viewed: [...new Set([...now.viewed, ...ticks])] };
    // The other entries give up their words only once this one holds them.
    if (mode !== 'read' && (!changed || keep(keptId, value))) for (const take of taken) take();
    return value;
  } catch {
    // Storage off.
    return now;
  }
}

/**
 * The comments as a post takes them. On GitHub one read on an older commit goes at that commit, in that commit's lines,
 * and GitHub marks it outdated if the code moved. GitLab's docs do not say a thread can be placed on an older version, so
 * there, and on another base, it goes in the body with its label unless its lines still read the same here.
 */
function forPost(comments: readonly KeptComment[], screen: Pick<OnScreen, 'stamp' | 'files' | 'base'>, head: string | null, platform: string | undefined, scope: string): KeptComment[] {
  return comments.map((c) => {
    if (!onLine(c) || c.outdated) return c;
    const here = isHere(c, screen);
    if (scope === 'layer' && platform === 'github' && !c.outsideDiff && c.readHead && head && c.readHead !== head && c.readBase === screen.base) return { ...c, postAt: c.readHead, postHere: here };
    return here ? c : { ...c, outdated: true };
  });
}

function LayerReview({ model, modelError, stackId, layerKey, scope, onLayer, onBack, onSent }: PullReviewProps) {
  const phone = usePhone();
  const item = useMemo(() => (model ? findStack(pullGroups(model, null), stackId) : null), [model, stackId]);
  const stack = item?.stack ?? null;
  const layer = stack?.layers.find((l) => l.key === layerKey) ?? null;
  // The verdict goes to this layer's own review thread (its stack's only as a fallback), and only on the person's
  // own PR: a teammate's layer, even in a stack with theirs, reads without a verdict. A Whole stack verdict goes to the
  // stack's one review thread (its lowest linked layer's), as the stack view names it.
  const link = useMemo(() => {
    if (!stack || !model || !layer) return null;
    return scope === 'stack' ? stackVerdictLink(layer, stack, model.links) : layerVerdictLink(layer, stack, model.links);
  }, [stack, model, layer, scope]);
  const agent = linkAgentName(link);
  // Where this layer sits on its own line of the stack (a fork's sibling branch is not counted).
  const next = stack && layer ? nextLayer(stack, layer.key) : null;

  // What makes this diff: its head commit and its base. `updated_at` also moves with a label, a comment or a review,
  // which change nothing here (no read, no scroll lost); it only stands in while the list names no head.
  const diffBase = scope === 'stack' ? stack?.open_base : layer?.base;
  const seenId = layer ? `${layer.key}\u0000${scope}\u0000${layer.head_sha ?? layer.updated_at}\u0000${diffBase}` : '';
  const [diff, setDiff] = useState<InboxPullDiffAnswer | null>(() => seenDiff(seenId, layerKey) ?? null);
  const [diffError, setDiffError] = useState<string | null>(null);
  // A patch this review read itself named its head. One remembered in `SEEN` can be older than what another window kept.
  const read = useRef(false);
  // A read to try again when the list is next read (its tick, a focus): one that failed or named no head.
  const [attempt, setAttempt] = useState(0);
  const again = useRef(false);
  useEffect(() => {
    if (again.current) setAttempt((n) => n + 1);
    again.current = false;
  }, [model]);
  useEffect(() => {
    if (!layer) return;
    // Back to a diff read a moment ago (This layer → Whole stack → This layer): drawn at once, not read again.
    const seen = seenDiff(seenId, layerKey);
    if (seen) {
      setDiffError(null);
      setDiff(seen);
      return;
    }
    // The list caught up with the patch on screen: nothing new to read.
    if (diff?.head_sha && diff.head_sha === layer.head_sha && diff.base === diffBase) {
      SEEN.set(seenId, diff);
      return;
    }
    const controller = new AbortController();
    // Whatever is on screen stays, and keeps its comments, until a read names a newer patch.
    inboxApi
      .pullDiff(layer.key, scope, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        setDiffError(null);
        again.current = !answer.head_sha;
        if (answer.head_sha) {
          NEWEST.set(layerKey, answer.head_sha);
          SEEN.set(seenId, answer);
          while (SEEN.size > SEEN_MAX) SEEN.delete(SEEN.keys().next().value!);
          read.current = true;
        } else if (diff?.head_sha) return;
        setDiff(answer);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        again.current = !(cause instanceof InboxApiError && (cause.code === 'pull_diff_too_large' || cause.code === 'pull_diff_fork'));
        if (!diff) setDiffError(cause instanceof Error ? cause.message : 'The diff could not be read.');
      });
    return () => controller.abort();
    // A new layer or scope reads again; the same one keeps its diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenId, attempt]);

  // Comments and Viewed are kept per head commit: a new commit starts clean, but for the global comments. The head is
  // the patch's when it says, in either scope (the list can be minutes behind it, and the comments are on the patch;
  // another layer's commit changes nothing here), else the list's. A patch naming no head keeps the name it came up
  // under, as the list moving says nothing about the code on screen; other code naming no head takes the list's again.
  // Neither says: the name in use stays.
  const lastName = useRef<string | null>(null);
  const lastPatch = useRef<string | null>(null);
  const keptName = diff?.head_sha ?? (diff && diff.patch === lastPatch.current ? lastName.current : null) ?? layer?.head_sha ?? lastName.current ?? layer?.updated_at ?? null;
  lastName.current = keptName;
  lastPatch.current = diff?.patch ?? null;
  const keptId = `${layerKey}:${scope}:${keptName ?? ''}`;
  const sure = read.current;
  const rawPatch = diff?.patch;
  const stamp = useMemo(() => (rawPatch === undefined ? null : stampOf(rawPatch)), [rawPatch]);
  // The files in the rail's order, as the review app has them: the diffs below follow it.
  const { files, tree, loose, patch } = useMemo(() => reviewFiles(rawPatch ?? ''), [rawPatch]);
  const screen: OnScreen = { updatedAt: layer?.updated_at ?? null, listHead: layer?.head_sha ?? null, stamp, base: diff?.base ?? null, files };
  const words = (mode: 'read' | 'absorb' | 'move') => gather(layerKey, scope, keptId, screen, mode);
  const [comments, setComments] = useState<KeptComment[]>(() => words('read').comments);
  const [viewed, setViewed] = useState<string[]>(() => words('read').viewed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; token: number } | null>(null);
  useEffect(() => {
    const kept = words(sure ? 'move' : 'read');
    setComments(kept.comments);
    setViewed(kept.viewed);
    setSelectedId(null);
    // The layer and scope are in `keptId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptId, sure, stamp]);
  // Another window's words reach this one, so its next save does not write over them. If this window could not store,
  // what it holds is the only copy.
  const unstored = useRef(false);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (unstored.current || (event.key !== null && !event.key.startsWith(`${STORE}${layerKey}:${scope}:`))) return;
      const kept = words('read');
      setComments(kept.comments);
      setViewed(kept.viewed);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptId, sure, stamp]);
  const store = (value: { comments: KeptComment[]; viewed: string[] }) => {
    if (!sure) words('absorb');
    unstored.current = !keep(keptId, value);
  };
  // What went, in the words that went, leaves every entry of this review, so it cannot come back on a reload and go twice:
  // a post started before a push answers after the page has moved its comments to the new head's entry. A comment edited
  // since has not gone, and stays.
  const forgetWent = (went: readonly CodeAnnotation[]) => {
    const sent = new Set(went.map(postedSignature));
    const isGone = (c: KeptComment) => sent.has(postedSignature(c)) || sent.has(postedSignature(asSeparate(c)));
    for (const id of allEntries(layerKey, scope)) {
      const was = readKept(id);
      const left = was.comments.filter((c) => !isGone(c));
      if (left.length < was.comments.length) keep(id, { ...was, comments: left });
    }
    setComments((now) => now.filter((c) => !sent.has(postedSignature(c))));
  };
  const write = (next: { comments?: KeptComment[]; viewed?: string[] }) => {
    const value = { comments: next.comments ?? comments, viewed: next.viewed ?? viewed };
    if (next.comments) setComments(next.comments);
    if (next.viewed) setViewed(next.viewed);
    store(value);
  };
  // A diff that could not be read (too large, a refused compare) takes no verdict: there is nothing on screen to judge.
  const canDecide = !!link?.last && !diffError;
  // Post to GitHub/GitLab (the owner's answer C): any open PR whose head the list read, the person's or a
  // teammate's, with or without an agent. The person chooses at the end where the review goes.
  // A layer's comments are on its patch: posted at that patch's own head (the list's can be a minute behind the forge);
  // a patch whose head the forge did not pin down posts nothing (Open on GitHub instead), and neither does a diff
  // that could not be read (the header then offers Open on GitHub).
  const postHead = diff?.head_sha ?? (scope === 'layer' ? null : (layer?.head_sha ?? null));
  const canPost = !!postablePull(layer) && !diffError && (!diff || !!postHead);
  const [picked, pick] = useReviewDestination();
  const [posted, setPosted] = useState<{ label: string; url: string; action: string } | null>(null);
  useEffect(() => setPosted(null), [keptId]);
  // A new line comment is on the diff on screen: it says so, with the code at its lines. An edited one stays what it was.
  const save = (annotation: CodeAnnotation) => {
    const was = comments.find((c) => c.id === annotation.id);
    const read: Partial<KeptComment> = was
      ? { anchorSnapshot: was.anchorSnapshot, anchorText: was.anchorText, anchorContext: was.anchorContext, readHead: was.readHead, readBase: was.readBase, outdated: was.outdated }
      : onLine(annotation) && stamp
        ? { anchorSnapshot: stamp, ...captureAnchor(annotation, files), ...(diff?.head_sha ? { readHead: diff.head_sha, readBase: diff.base } : {}) }
        : {};
    write({ comments: [...comments.filter((c) => c.id !== annotation.id), { ...annotation, ...read }] });
  };
  const remove = (id: string) => {
    write({ comments: comments.filter((c) => c.id !== id) });
    // Also where another window's entry still holds it, so it does not come back.
    forgetWent(comments.filter((c) => c.id === id));
  };
  const here = useMemo(() => comments.filter((c) => isHere(c, { stamp, files })), [comments, stamp, files]);
  const showComment = (id: string) => {
    setSelectedId(id);
    const comment = comments.find((c) => c.id === id);
    // Not drawn on this diff: its file, if it is still in it.
    if (comment && !here.includes(comment)) {
      if (files.some((file) => file.path === comment.filePath)) move(comment.filePath);
      return;
    }
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  // Both measured once the review is drawn: while the list is read, a loading pane stands in its place.
  const drawn = !!(model && stack && layer);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true, drawn);
  // Global comment sits in the bar. A phone keeps it in the comments' sheet.
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [railWidth, setRailWidth] = useState(() => {
    try {
      const kept = Number(window.localStorage.getItem(RAIL_WIDTH.key));
      return kept >= RAIL_WIDTH.min && kept <= RAIL_WIDTH.max ? kept : RAIL_WIDTH.initial;
    } catch {
      return RAIL_WIDTH.initial;
    }
  });
  const dragRail = (next: number) => {
    const width = Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, Math.round(next)));
    setRailWidth(width);
    try {
      window.localStorage.setItem(RAIL_WIDTH.key, String(width));
    } catch {
      // Storage full or off: this visit only.
    }
  };
  // Once the tab on the first file has scrolled away, the same switch sits in the bar. Nothing floats over the code.
  const [diffBody, setDiffBody] = useState<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    if (!diffBody || phone) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = diffBody.getBoundingClientRect();
        const tab = diffBody.querySelector('[data-guide-section-tab] [data-diff-style-switch]')?.getBoundingClientRect();
        setDocked(!!tab && tab.bottom <= box.top);
      });
    };
    read();
    diffBody.addEventListener('scroll', read, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      diffBody.removeEventListener('scroll', read);
    };
  }, [phone, diffBody]);
  const [sheet, setSheet] = useState(false);
  const sheetId = useId();
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  // The folded rail's sheet, the comments' mirror on the other side: one of the two is open at a time.
  const [filesSheet, setFilesSheet] = useState(false);
  // The PR's details over the code; what opened them takes focus back. One thing over the code at a time.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Only once the list names it: on a fresh load the Inbox has no list yet, and would refuse a PR it has not listed.
  // Read again when the PR moves, and whenever the panel opens (the server keeps a read for a minute).
  const details = usePullDetails(layer ? layerKey : null, layer ? `${layer.head_sha ?? ''}\u0000${layer.updated_at}` : '');
  const detailsPanel = useRef<HTMLElement>(null);
  const detailsOpener = useRef<HTMLElement | null>(null);
  const toggleDetails = (event: React.MouseEvent<HTMLElement>) => {
    detailsOpener.current = event.currentTarget;
    if (!detailsOpen) details.retry();
    setDetailsOpen((open) => !open);
    setSheet(false);
    setFilesSheet(false);
  };
  const closeDetails = () => {
    setDetailsOpen(false);
    detailsOpener.current?.focus({ preventScroll: true });
  };
  useSheetEscape(detailsOpen, closeDetails);
  useEffect(() => {
    if (detailsOpen) detailsPanel.current?.focus({ preventScroll: true });
  }, [detailsOpen]);
  useEffect(() => {
    if (sheet || filesSheet) setDetailsOpen(false);
  }, [sheet, filesSheet]);
  // Another layer is another PR: its details do not carry over.
  useEffect(() => setDetailsOpen(false), [layerKey]);
  const filesSheetId = useId();
  const filesButton = useRef<HTMLButtonElement>(null);
  const sheetButton = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!phone) setFilesSheet(false);
  }, [phone]);
  useEffect(() => {
    if (sheet) setFilesSheet(false);
  }, [sheet]);
  // Opening the Files sheet, focus goes to its first row.
  useEffect(() => {
    if (filesSheet) railRef.current?.querySelector<HTMLElement>('[data-review-files] button, [data-repo-file-tree] button, [data-pull-layer-row] button')?.focus({ preventScroll: true });
  }, [filesSheet]);
  const closeComments = () => {
    setSheet(false);
    sheetButton.current?.focus({ preventScroll: true });
  };
  const closeFiles = () => {
    setFilesSheet(false);
    filesButton.current?.focus({ preventScroll: true });
  };
  // Escape closes either sheet, wherever focus is, and focus goes back to its button.
  useSheetEscape(folded && sheet, closeComments);
  useSheetEscape(filesSheet, closeFiles);
  // Tabbing out of a sheet closes it, so focus never lands unseen on what it covers (a click beside it does not).
  const tabbing = useRef(false);
  const sheetKeys = {
    onKeyDown: (event: React.KeyboardEvent) => {
      tabbing.current = event.key === 'Tab';
    },
    onKeyUp: () => {
      tabbing.current = false;
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      const left = tabbing.current && event.relatedTarget instanceof Element && !event.currentTarget.contains(event.relatedTarget) && !inOverlay(event.relatedTarget);
      tabbing.current = false;
      if (!left) return;
      setSheet(false);
      setFilesSheet(false);
      setDetailsOpen(false);
    },
  };
  // Crossing a fold takes away what held focus (a button, or a rail or panel that hides): focus moves to the same
  // thing's other shape, so it never drops to the page.
  const lastFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const held = lastFocus.current;
    const now = document.activeElement;
    if (!held || (now && now !== held && now !== document.body) || (held.isConnected && held.getClientRects().length > 0)) return;
    const first = (root: HTMLElement | null) => root?.querySelector<HTMLElement>('button, [tabindex="0"]');
    const moved = railRef.current?.contains(held) ? filesButton.current : panelRef.current?.contains(held) ? sheetButton.current : held.matches('[data-pull-review-files-button]') ? first(railRef.current) : held.matches('.ib-vcomments') ? first(panelRef.current) : null;
    moved?.focus({ preventScroll: true });
  }, [phone, folded]);
  // A global comment chosen in the guide: selected in the panel, and the folded panel opens on it (as ReviewPane).
  const showGlobalComment = (id: string) => {
    setSelectedId(id);
    if (folded) setSheet(true);
  };
  // The unsaved global comment's words are named per layer and scope, not per push: they outlive a push, as the
  // global comments do.
  const readerComments = canDecide || canPost ? { annotations: here, selectedId, onSelect: setSelectedId, onSave: async (annotation: CodeAnnotation) => (save(annotation), true), onDelete: remove, scrollTarget, draftScope: `${layerKey}:${scope}`, onShowGlobalComment: showGlobalComment } : undefined;

  // Open in: what is on disk in a clone of this repository, which may not be the PR's version; nothing when no clone holds the file.
  const repoKey = stack ? inboxPullRepoKey(stack.host, stack.repo) : null;
  const fileOpenIn = useCallback((path: string) => (repoKey ? <OpenInFile scope={{ repo: repoKey }} path={path} /> : null), [repoKey]);
  const snapshot = useMemo(
    () =>
      diff && layer
        ? buildGuideSnapshot({
            guide: { title: layer.title, intent: '', sections: [] },
            reviewed: [],
            review: { rawPatch: patch, gitRef: `${diff.base}...${diff.head}`, source: { kind: 'pr', repo: stack?.repo, branch: layer.head, pr: { url: layer.url, number: layer.number, title: layer.title, platform: layer.platform } } },
            exportedAt: new Date(0).toISOString(),
          })
        : null,
    [diff, patch, layer, stack?.repo],
  );
  const viewedSet = useMemo(() => new Set(viewed), [viewed]);
  const toggleViewed = useCallback((path: string) => write({ viewed: viewed.includes(path) ? viewed.filter((p) => p !== path) : [...viewed, path] }), [viewed, comments]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reveal, setReveal] = useState<{ path: string; token: number } | null>(null);
  const move = (path: string) => setReveal((was) => ({ path, token: (was?.token ?? 0) + 1 }));
  // The rail's Changes | All files (the review app's switch, remembered as it remembers it). All files is the
  // repository at the head the patch on screen was read at (else the list's); with no head known it is not offered.
  const [treeScope, setTreeScope] = useTreeScope();
  const repoSha = diff?.head_sha ?? layer?.head_sha ?? null;
  const allFiles = treeScope === 'all' && !!repoSha;
  // A file of the repository the PR does not change, shown whole in place of the diff.
  const [repoOpen, setRepoOpen] = useState<string | null>(null);
  useEffect(() => setRepoOpen(null), [layerKey, scope, repoSha]);
  // A file picked in the rail. From the sheet it closes, showing the file, and focus goes back to its button.
  const pickFile = (path: string) => {
    setRepoOpen(null);
    move(path);
    if (filesSheet) closeFiles();
  };
  const openRepoFile = (path: string) => {
    setRepoOpen(path);
    if (filesSheet) closeFiles();
  };
  const pickScope = (next: 'changes' | 'all') => {
    setTreeScope(next);
    if (next === 'changes') setRepoOpen(null);
  };

  // The verdict: one reply to the agent's last message in its thread.
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const keys = useRef(new VerdictKeys());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sendVerdict = useCallback(
    async (id: DecisionActionId, note?: string) => {
      if (sending || !layer || !link?.last || !stack) return;
      const plan = verdictOf(id, comments.length > 0);
      // What the agent reads names lines of the diff on screen: one not on it says so.
      const carried = plan.withComments && !plan.discard ? comments.map((c) => (onLine(c) && !c.outdated && !isHere(c, { stamp, files }) ? { ...c, outdated: true } : c)) : [];
      const parts = pullVerdictReply(plan.verdict, { pull: layer, scope, base: stack.base }, carried.length, carried.length > 0 ? guideCommentSections(carried) : '', note);
      const input = { words: parts.words, questions: [], ...(parts.feedback ? { feedback: parts.feedback } : {}) };
      setSending(true);
      setSendError(null);
      try {
        await inboxApi.reply(link.last.message_id, { idempotency_key: keys.current.keyFor(input), ...input });
        keys.current.done();
        store({ comments: [], viewed: [] });
        if (!mounted.current) return;
        setComments([]);
        setNotes({});
        onSent();
      } catch (cause) {
        if (!mounted.current) return;
        setSendError(cause instanceof InboxApiError || cause instanceof Error ? cause.message : 'Your verdict was not sent.');
      } finally {
        if (mounted.current) setSending(false);
      }
    },
    [sending, layer, link, stack, comments, scope, keptId, sure, stamp, files, onSent],
  );
  const spec = useMemo(
    () => buildDecisionSpec({ app: 'review', gate: true, count: comments.length, hasFeedback: comments.length > 0, approvalNotesSupported: true }),
    [comments.length],
  );
  const handlers = useMemo<Record<DecisionActionId, DecisionHandler>>(
    () => ({
      primary: () => void sendVerdict('primary'),
      'note-with-approval': (note) => void sendVerdict('note-with-approval', note),
      'request-changes': (note) => void sendVerdict('request-changes', note),
      'note-with-feedback': (note) => void sendVerdict('note-with-feedback', note),
      'approve-with-notes': () => void sendVerdict('approve-with-notes'),
      'discard-and-finish': () => void sendVerdict('discard-and-finish'),
    }),
    [sendVerdict],
  );

  if (!model || !stack || !layer) {
    return (
      <section className={`ib-viewer ib-review ib-prreview${phone ? '' : ' ib-prr-wide'}`} aria-label="Review" data-pull-review="">
        <div className="ib-vhead">
          {!phone && <SidebarTrigger />}
          <Tip content="Reviews">
            <button type="button" className="ib-back" onClick={onBack} aria-label="Reviews">
              <Icon name="back" size={15} />
            </button>
          </Tip>
        </div>
        <div className="ib-pr-empty" role={modelError || model ? 'alert' : undefined}>
          {modelError ?? (model ? 'This pull request is no longer in the list.' : 'Reading your pull requests…')}
        </div>
      </section>
    );
  }

  const label = inboxPullLabel(layer);
  const noun = pullNounWord(layer.platform);
  const wholeTip = `Whole stack: ${diff && scope === 'stack' ? `${diff.base}…${diff.head}` : `${stack.base} up to ${label}`}`;

  const readOnlyWords = layer.mine ? 'No review thread yet' : layer.author ? `by ${layer.author}` : 'by a deleted account';
  const readOnlyNote = !canDecide && !posted && !diffError && (
    <Tip cut content={readOnlyWords}>
      <p className="ib-prr-note" data-pull-review-readonly={layer.mine ? 'unlinked' : 'teammate'}>
        {readOnlyWords}
      </p>
    </Tip>
  );
  // The title opens the PR's details (the owner's "title only"; with `DETAILS_BUTTON`, the Details button beside it too).
  const title = (
    <DetailsTitle
      name={scope === 'stack' ? `Whole stack up to ${label}` : `${label} ${layer.title}`}
      tip={`${label} ${layer.title} · ${layer.author ?? 'A teammate'} wants to merge ${layer.head} into ${layer.base}`}
      open={detailsOpen}
      data={details.data}
      onToggle={toggleDetails}
      className="ib-fn ib-prr-fn"
      data-pull-review-title=""
    >
      <RefMarkIcon kind="pr" state={layer.state} size={15} />
      {scope === 'stack' ? (
        <bdi>Whole stack up to {label}</bdi>
      ) : (
        <>
          <span className="ib-prr-num">{label}</span>
          <bdi>{layer.title}</bdi>
        </>
      )}
    </DetailsTitle>
  );
  const toggleFiles = () => {
    setFilesSheet((open) => !open);
    setSheet(false);
  };
  const seenCount = files.filter((f) => viewedSet.has(f.path)).length;
  const scopeSwitch = repoSha ? <RailScopeSwitch scope={allFiles ? 'all' : 'changes'} changed={files.length} onSelect={pickScope} /> : undefined;
  const rail = (
    <>
      {stack.layers.length > 1 && <RailStack layers={stack.layers} here={layer} scope={scope} wholeTip={wholeTip} wholeCounts={scope === 'stack' && diff ? { add: files.reduce((sum, f) => sum + f.additions, 0), del: files.reduce((sum, f) => sum + f.deletions, 0) } : undefined} onLayer={onLayer} />}
      {allFiles && repoSha ? (
        <PanePart>
          <PullAllFilesPart.Part
            pullKey={layer.key}
            sha={repoSha}
            files={files}
            viewed={viewedSet}
            comments={comments}
            activePath={reveal?.path ?? null}
            openPath={repoOpen}
            head={
              <div className="ib-prp-fileshead">
                {scopeSwitch}
                <span className="ib-sp" />
                {seenCount > 0 && <span>{seenCount} viewed</span>}
              </div>
            }
            onSelect={pickFile}
            onOpen={openRepoFile}
            onToggleViewed={toggleViewed}
          />
        </PanePart>
      ) : (
        <RailTree tree={tree} loose={loose} files={files} viewed={viewedSet} commentCount={(path) => comments.filter((comment) => comment.filePath === path).length} onSelect={pickFile} onToggleViewed={toggleViewed} head={scopeSwitch} />
      )}
    </>
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-review ib-prreview${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}${phone ? '' : ' ib-prr-wide'}${phone ? ' ib-railfold' : ''}${filesSheet ? ' ib-files-open' : ''}`}
      style={{ '--ib-rail-w': `${railWidth}px` } as React.CSSProperties}
      aria-label={`Review ${label}`}
      data-pull-review={layer.key}
      data-pull-scope={scope}
      onFocusCapture={(event) => {
        lastFocus.current = event.target;
      }}
    >
      <div className="ib-vhead">
        {!phone && <SidebarTrigger />}
        <Tip content="Reviews">
          <button type="button" className="ib-back" onClick={onBack} aria-label="Reviews">
            <Icon name="back" size={15} />
          </button>
        </Tip>
        {!phone && title}
        {!phone && readOnlyNote}
        {!phone && <DetailsButton open={detailsOpen} data={details.data} onToggle={toggleDetails} />}
        <span className="ib-sp" />
        {!phone && docked && <DiffStyleSwitch icons name="ib-diff-style-held" />}
        {!phone && <div ref={setControlsHost} className="ib-prr-controls" data-pull-controls="" />}
        {folded && (readerComments || comments.length > 0) && (
          <button
            type="button"
            ref={sheetButton}
            className={`ib-btn ib-sm ib-vcomments${sheet ? ' ib-on' : ''}`}
            onClick={() => setSheet((v) => !v)}
            aria-expanded={sheet}
            aria-controls={sheetId}
            aria-label={`Comments, ${comments.length}`}
          >
            <Icon name="comment" size={15} />
            {comments.length}
          </button>
        )}
        {canPost ? (
          <PostEnding
            pull={layer}
            agent={
              canDecide && agent
                ? {
                    name: agent,
                    host: link?.agent?.host ?? null,
                    control: (
                      <span className="ib-rv-decide" data-review-decision="">
                        <DecisionControl spec={spec} handlers={handlers} busy={sending || !snapshot} isLoading={sending} labelBreakpoint="md" drafts={notes} onDraftsChange={setNotes} />
                      </span>
                    ),
                  }
                : null
            }
            comments={forPost(comments, screen, postHead, layer.platform, scope)}
            readComments={() => {
              if (unstored.current) return forPost(comments, screen, postHead, layer.platform, scope);
              // What another window wrote that has not reached this one: the panel says the same as the post.
              const stands = words('read').comments;
              setComments(stands);
              return forPost(stands, screen, postHead, layer.platform, scope);
            }}
            anchor={scope === 'stack' ? 'stack' : 'diff'}
            note={layer.mine && !canDecide ? readOnlyWords : undefined}
            headSha={postHead}
            busy={sending || !snapshot}
            picked={picked}
            onPick={pick}
            onWent={forgetWent}
            onPosted={(result) => {
              // Only what went is cleared: a whole stack's line comments map to no PR's lines and stay.
              forgetWent(result.posted);
              setPosted({ label: result.label, url: result.url, action: result.action });
            }}
          />
        ) : canDecide ? (
          <span className="ib-rv-decide" data-review-decision="">
            <DecisionControl spec={spec} handlers={handlers} busy={sending || !snapshot} isLoading={sending} labelBreakpoint="md" drafts={notes} onDraftsChange={setNotes} />
          </span>
        ) : (
          <a className="ib-btn ib-sm" href={layer.url} target="_blank" rel="noreferrer noopener" data-pull-review-forge="">
            <Icon name="external" size={14} />
            {phone ? <span className="ib-sr">Open on {forgeName(stack)}</span> : `Open on ${forgeName(stack)}`}
          </a>
        )}
      </div>
      <div className="ib-rsplit">
        {phone && (
          <div className="ib-prp-row2">
            <button type="button" className={`ib-prp-this${detailsOpen ? ' ib-on' : ''}`} aria-expanded={detailsOpen} aria-label={`${stack.layers.length > 1 ? `${stack.layers.findIndex((l) => l.key === layer.key) + 1} of ${stack.layers.length} ` : ''}${scope === 'stack' ? `Whole stack up to ${label}` : layer.title}, opens details`} onClick={toggleDetails} data-pull-review-title="" data-pull-details-button="">
              {stack.layers.length > 1 && <span className="ib-prp-of">{stack.layers.findIndex((l) => l.key === layer.key) + 1} of {stack.layers.length}</span>}
              <bdi className="ib-prp-title">{scope === 'stack' ? `Whole stack up to ${label}` : layer.title}</bdi>
              <Icon name="chevD" size={13} />
            </button>
            {files.length > 0 && (
              <button ref={filesButton} type="button" className={`ib-prp-jump${filesSheet ? ' ib-on' : ''}`} aria-expanded={filesSheet} aria-controls={filesSheetId} aria-label={`Files, ${files.length}`} onClick={toggleFiles} data-pull-review-files-button="">
                <FileTreeMark />
                <span>{files.length}</span>
              </button>
            )}
          </div>
        )}
        {detailsOpen && (
          <PullDetails
            layer={layer}
            description={diff?.description}
            headSha={diff?.head_sha}
            data={details.data}
            failed={details.failed}
            heldUntil={details.heldUntil}
            onRetry={details.retry}
            forge={forgeName(stack)}
            panel={detailsPanel}
            phone={phone}
            inDiff={(path) => files.some((file) => file.path === path)}
            onClose={closeDetails}
            onFile={move}
            keys={sheetKeys}
            top={phone && stack.layers.length > 1 ? <RailStack layers={stack.layers} here={layer} scope={scope} wholeTip={wholeTip} onLayer={(key, next) => { setDetailsOpen(false); onLayer(key, next); }} /> : undefined}
          />
        )}
        <nav className="ib-rrail" id={filesSheetId} ref={railRef} aria-label="Changed files" {...sheetKeys}>
          {rail}
        </nav>
        {!phone && (
          <div
            className="ib-prp-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Width of the file rail"
            aria-valuemin={RAIL_WIDTH.min}
            aria-valuemax={RAIL_WIDTH.max}
            aria-valuenow={railWidth}
            tabIndex={0}
            onDoubleClick={() => dragRail(RAIL_WIDTH.initial)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') dragRail(railWidth - 16);
              if (event.key === 'ArrowRight') dragRail(railWidth + 16);
            }}
            onPointerDown={(event) => {
              const from = event.clientX - railWidth;
              const handle = event.currentTarget;
              handle.setPointerCapture(event.pointerId);
              const moved = (e: PointerEvent) => dragRail(e.clientX - from);
              const up = () => {
                handle.removeEventListener('pointermove', moved);
                handle.removeEventListener('pointerup', up);
              };
              handle.addEventListener('pointermove', moved);
              handle.addEventListener('pointerup', up);
            }}
            data-pull-rail-handle=""
          />
        )}
        <div className="ib-gbody" ref={setDiffBody} data-repo-open={repoOpen && repoSha ? '' : undefined}>
          {repoOpen && repoSha && (
            <PanePart>
              <PullRepoFilePart.Part key={repoOpen} pullKey={layer.key} sha={repoSha} path={repoOpen} />
            </PanePart>
          )}
          {posted && (
            <div className="ib-prr-posted" role="status" data-pull-review-posted={posted.action}>
              <Icon name="checkCircle" size={15} />
              <span>
                {postedWords(posted)}
              </span>
              <a href={posted.url} target="_blank" rel="noreferrer noopener">
                View on {posted.label}
                <Icon name="external" size={13} />
              </a>
            </div>
          )}
          {sendError && (
            <div className="ib-error ib-gerror" role="alert">
              {sendError}
            </div>
          )}
          {diffError ? (
            <div className="ib-error ib-gerror" role="alert" data-pull-diff-error="">
              {diffError}{' '}
              <a href={layer.url} target="_blank" rel="noreferrer noopener" data-pull-diff-error-forge="">
                Open {label} on {forgeName(stack)}
              </a>
            </div>
          ) : diff && files.length === 0 ? (
            <p className="ib-prr-note" data-pull-diff-empty="">
              {scope === 'stack' ? `The stack up to ${label} changes no files.` : `This ${noun} changes no files.`}
            </p>
          ) : snapshot ? (
            // Keyed on the code: new code brings a new reader, so a composer left open cannot save onto a moved line; the
            // same code keeps it, whatever the head reads said. The reader is a chunk loaded on first use: one that cannot
            // arrive says so here (GuidePane).
            <ReaderPart key={diff?.patch} diff={snapshot.review.rawPatch}>
              <OpenInCodeSpans scope={{ repo: repoKey ?? '' }} on={!!repoKey}>
                <GuideReader bare controlsHost={controlsHost} snapshot={snapshot} reviewed={[]} onReviewedChange={() => {}} comments={readerComments} mode="files" reveal={reveal} viewed={{ files: viewedSet, onToggle: toggleViewed }} fileOpenIn={fileOpenIn} />
              </OpenInCodeSpans>
            </ReaderPart>
          ) : (
            <p className="ib-pr-empty" aria-busy="true">
              Reading the diff…
            </p>
          )}
          {next && scope === 'layer' && (diff || diffError) && (
            <button type="button" className="ib-prp-next" onClick={() => onLayer(next.key, 'layer')} data-pull-next-layer={next.key}>
              <span className="ib-prp-nextw">Next layer</span>
              <span className="ib-prp-num">{inboxPullLabel(next)}</span>
              <bdi className="ib-prp-title">{next.title}</bdi>
              <Icon name="chevR" size={15} />
            </button>
          )}
        </div>
        <div className="ib-apanel ib-gpanel" id={sheetId} ref={panelRef} role={folded ? 'region' : undefined} aria-label={folded ? 'Comments' : undefined} {...sheetKeys}>
          {folded && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{comments.length}</span>
              <span className="ib-sp" />
              <button type="button" className="ib-iconbtn" onClick={closeComments} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          {phone && <div ref={setControlsHost} className="ib-prr-controls ib-prp-sheetctl" data-pull-controls="" />}
          <AnnotationPanel
            emptyHint={readerComments ? 'Click a line number, drag across lines, or select code to comment' : undefined}
            isOpen
            presentation={folded ? 'embedded' : undefined}
            annotations={NO_ANNOTATIONS}
            blocks={NO_BLOCKS}
            codeAnnotations={comments}
            codeAnnotationNote={(c) => (here.includes(c) ? null : 'Written on older code')}
            onSelect={showComment}
            onDelete={remove}
            selectedId={selectedId}
            onSelectCodeAnnotation={showComment}
            onDeleteCodeAnnotation={remove}
            onEditCodeAnnotation={readerComments ? (id, updates) => {
              const before = comments.find((c) => c.id === id);
              if (before) save({ ...before, ...updates });
            } : undefined}
            width="100%"
            readOnly={!readerComments}
          />
        </div>
      </div>
    </section>
  );
}
