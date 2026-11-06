/**
 * "Review layer by layer" (approval "inbox-code-review-direction", item 4):
 * phase 1's full-window review mode (ReviewPane's frame: the rail of changed
 * files, Plannotator's own diff through `GuideReader` with line comments and
 * Viewed ticks, the comments panel, ui's DecisionControl in the header) on one
 * layer of a stack, or on the whole stack up to a layer.
 *
 * - One title, the header's (approval "pr-page-review-with-agent"): the
 *   reader draws none of its own (`GuideReader` `bare`), and the strip under
 *   the header names every layer by its number, bottom to top, the one on
 *   screen marked, with "This layer | Whole stack" (native radios).
 * - Under 900 px of review the file rail folds into the "Files · N files"
 *   picker over the diff (`RAIL_FOLD_BELOW`), so the diff keeps the width.
 * - "This layer" is the PR's own diff; "Whole stack" is the compare from the
 *   stack's base branch to this layer's head (inbox-pulls.ts `diff`).
 * - The foot says which layer this is, and "Next layer" moves up the stack.
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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { GuideReaderPart, ReaderPart } from '../lazyParts';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import { parseDiffToFiles, patchBlobIds, type DiffFile } from '@plannotator/core/diff-files';
import { anchorStillMatches, captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';
import type { KeptComment } from '../guide/platform-post-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { inboxPullRepoKey, type InboxPullDiffAnswer, type InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { InboxApiError, inboxApi } from '../api';
import { guideCommentSections } from '../attachments';
import { RefMarkIcon } from '../board/RefMark';
import { Icon } from '../icons';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { holdBarAfterClose, usePhoneCommentsSheet } from '../components/phoneCommentsSheet';
import { VerdictKeys, verdictOf } from '../reviewVerdict';
import { OpenInCodeSpans, OpenInFile } from '../components/OpenIn';
import { Tip } from '../components/Tip';
import { REVIEW_FOLD_PANEL_BELOW } from '../components/ReviewPane';
import { PostEnding, reviewEnding, useReviewDestination } from './PostEnding';
import { postablePull, postedSignature, postedWords } from './postRules';
import { findStack, inboxPullLabel, linkAgentName, pullGroups, pullNounWord, pullVerdictReply } from './model';
import { forgeName } from './labels';
import { railRows } from './rail';
import { isOpen, layerPosition, layerVerdictLink, nextLayer, stackVerdictLink } from './topology';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
/** The review's width (px) under which its file rail folds into the Files picker over the diff. */
const RAIL_FOLD_BELOW = 900;
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
 * One review per layer and scope: moving to another layer (Next layer, the strip) or switching This layer |
 * Whole stack starts afresh, so a note drafted on #412 never rides into #413's verdict.
 */
export function PullReview(props: PullReviewProps) {
  return <LayerReview key={`${props.layerKey}\u0000${props.scope}`} {...props} />;
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
  const open = stack ? stack.layers.filter(isOpen) : [];
  // Where this layer sits on its own line of the stack (a fork's sibling branch is not counted).
  const position = stack && layer ? layerPosition(stack, layer.key) : null;
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
  const patch = diff?.patch;
  const stamp = useMemo(() => (patch === undefined ? null : stampOf(patch)), [patch]);
  const files = useMemo(() => (patch === undefined ? [] : parseDiffToFiles(patch)), [patch]);
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
  // The expand arrows' whole files, at the commits this diff runs between.
  // Asked only with the blobs the patch names, so the server can refuse a text that is not this patch's file; a patch
  // without them (GitLab's whole stack), or a diff whose head moved during its read, opens nothing.
  const headMoved = !!diff && !diff.head_sha;
  const fileContents = useCallback(
    async (path: string, signal: AbortSignal, patch: string) => {
      const ids = headMoved ? null : patchBlobIds(patch);
      return ids ? inboxApi.pullFile(layerKey, scope, path, ids, signal) : { oldContent: null, newContent: null };
    },
    [layerKey, scope, headMoved],
  );
  const [picked, pick] = useReviewDestination();
  const ending = canPost ? reviewEnding(layer, canDecide, picked) : canDecide ? 'agent' : null;
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
      if (byPath.has(comment.filePath)) move(comment.filePath);
      return;
    }
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  // Both measured once the review is drawn: while the list is read, a loading pane stands in its place.
  const drawn = !!(model && stack && layer);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true, drawn);
  // Under RAIL_FOLD_BELOW of review width the file rail folds into the Files picker over the diff (as on a phone), so
  // the diff keeps the room.
  const [splitRef, railFolded] = useNarrowerThan<HTMLDivElement>(RAIL_FOLD_BELOW, false, drawn);
  const filesPicker = phone || railFolded;
  const [sheet, setSheet] = useState(false);
  const sheetId = useId();
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  const closeSheet = () => {
    // At once: on a phone the button can take focus only once the page shows again.
    flushSync(() => setSheet(false));
    if (!phone) return;
    sheetButtonRef.current?.focus({ preventScroll: true });
    holdBarAfterClose(sheetButtonRef.current);
  };
  usePhoneCommentsSheet(phone && sheet, sheetCloseRef, closeSheet);
  const onSheetKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && phone && sheet && !event.defaultPrevented) {
      event.preventDefault();
      closeSheet();
    }
  };
  // The sheet covers a phone's diff: a comment chosen in it closes it, to show the comment's lines (as ReviewPane).
  const showFromPanel = (id: string) => {
    showComment(id);
    if (phone) setSheet(false);
  };
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
  const rail = useMemo(() => railRows(files.map((file) => file.path)), [files]);
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const snapshot = useMemo(
    () =>
      diff && layer
        ? buildGuideSnapshot({
            guide: { title: layer.title, intent: '', sections: [] },
            reviewed: [],
            review: { rawPatch: diff.patch, gitRef: `${diff.base}...${diff.head}`, source: { kind: 'pr', repo: stack?.repo, branch: layer.head, pr: { url: layer.url, number: layer.number, title: layer.title, platform: layer.platform } } },
            exportedAt: new Date(0).toISOString(),
          })
        : null,
    [diff, layer, stack?.repo],
  );
  const viewedSet = useMemo(() => new Set(viewed), [viewed]);
  const toggleViewed = useCallback((path: string) => write({ viewed: viewed.includes(path) ? viewed.filter((p) => p !== path) : [...viewed, path] }), [viewed, comments]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reveal, setReveal] = useState<{ path: string; token: number } | null>(null);
  const move = (path: string) => setReveal((was) => ({ path, token: (was?.token ?? 0) + 1 }));

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

  // The strip scrolls sideways (a phone, a deep stack): the layer on screen is brought into it, never left off its edge.
  const stripRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const here = strip?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!strip || !here || strip.scrollWidth <= strip.clientWidth) return;
    const box = strip.getBoundingClientRect();
    const at = here.getBoundingClientRect();
    strip.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
  }, [layerKey, phone, stack?.layers.length]);
  const scopeName = useId();

  if (!model || !stack || !layer) {
    return (
      <section className="ib-viewer ib-review ib-prreview" aria-label="Review" data-pull-review="">
        <div className="ib-vhead">
          <button type="button" className="ib-back" onClick={onBack}>
            <Icon name="back" size={15} />
            Reviews
          </button>
        </div>
        <div className="ib-pr-empty" role={modelError || model ? 'alert' : undefined}>
          {modelError ?? (model ? 'This pull request is no longer in the list.' : 'Reading your pull requests…')}
        </div>
      </section>
    );
  }

  const label = inboxPullLabel(layer);
  const noun = pullNounWord(layer.platform);
  const scopeSwitch = open.length > 1 && (
    <div className="ib-seg ib-prr-scope" role="radiogroup" aria-label="Diff">
      {(['layer', 'stack'] as const).map((value) => (
        <label key={value} className="ib-seg-o" data-on={scope === value ? '' : undefined} data-pull-scope-choice={value}>
          <input type="radio" name={scopeName} checked={scope === value} onChange={() => onLayer(layer.key, value)} />
          {value === 'layer' ? 'This layer' : 'Whole stack'}
        </label>
      ))}
    </div>
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-review ib-prreview${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}${railFolded ? ' ib-railfold' : ''}`}
      aria-label={`Review ${label}`}
      data-pull-review={layer.key}
      data-pull-scope={scope}
    >
      <div className="ib-vhead">
        <button type="button" className="ib-back" onClick={onBack}>
          <Icon name="back" size={15} />
          {phone ? <span className="ib-sr">Reviews</span> : 'Reviews'}
        </button>
        <span className="ib-vsep" />
        {/* The review's one title (the reader draws none of its own): cut with "…", whole on hover; the verdict stays on screen. */}
        <span className="ib-fn ib-prr-fn" title={`${label} ${layer.title}`} data-pull-review-title="">
          <RefMarkIcon kind="pr" state={layer.state} size={15} />
          <span className="ib-prr-num">{label}</span>
          <bdi>{layer.title}</bdi>
        </span>
        <span className="ib-sp" />
        {folded && (readerComments || comments.length > 0) && (
          <button
            ref={sheetButtonRef}
            type="button"
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
      <div className="ib-prr-strip">
        <nav ref={stripRef} className="ib-prr-layers" aria-label="Layers, bottom first">
          {stack.layers.map((l, i) => {
            const here = l.key === layer.key;
            const reviewable = isOpen(l);
            return (
              <span key={l.key} className="ib-prr-lstep">
                {i > 0 && <Icon name="chevR" size={12} />}
                <button
                  type="button"
                  className="ib-prr-layer"
                  aria-current={here ? 'step' : undefined}
                  disabled={!reviewable}
                  onClick={() => onLayer(l.key, scope)}
                  data-pull-layer-step={l.key}
                >
                  <RefMarkIcon kind="pr" state={l.state} size={13} />
                  <span>{inboxPullLabel(l)}</span>
                </button>
              </span>
            );
          })}
        </nav>
        {scopeSwitch}
      </div>
      <div className="ib-rsplit" ref={splitRef}>
        <nav className="ib-rrail" aria-label="Changed files">
          {/* The files, then a folder heading over each group when names repeat in deep folders (`railRows`). */}
          <ul className="ib-rv-list" data-review-files="">
            {rail.map((row) => {
              if (row.kind === 'folder') {
                return (
                  <li key={`dir:${row.key}`} className="ib-rv-folder" aria-hidden="true" title={row.full} data-review-folder={row.full}>
                    <bdi dir="ltr">{row.text}</bdi>
                  </li>
                );
              }
              const stats = byPath.get(row.path);
              const seen = viewedSet.has(row.path);
              return (
                <li key={row.path}>
                  <button type="button" className="ib-rv-row ib-rv-file" onClick={() => move(row.path)} aria-label={`${row.path}${seen ? ', viewed' : ''}`}>
                    <span className="ib-rv-mark" data-done={seen ? '' : undefined} aria-hidden="true">
                      {seen ? <Icon name="check" size={12} /> : null}
                    </span>
                    <span className="ib-rv-t">
                      <Tip content={row.path} cut>
                        <span className="ib-rv-path">
                          <bdi dir="ltr">
                            {row.dir && <span className="ib-rv-dir">{row.dir}</span>}
                            {row.name}
                          </bdi>
                        </span>
                      </Tip>
                    </span>
                    <span className="ib-rv-n">
                      <span className="ib-add">+{formatCount(stats?.additions ?? 0)}</span> <span className="ib-del">-{formatCount(stats?.deletions ?? 0)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="ib-rv-progress" aria-live="polite">
            {diff ? `${viewed.filter((path) => files.some((file) => file.path === path)).length} of ${plural(files.length, 'file')} viewed` : ''}
          </div>
        </nav>
        <div className="ib-gbody">
          {filesPicker && files.length > 0 && (
            <div className="ib-rv-phonebar" data-review-phonebar="">
              <select className="ib-rv-jump" aria-label="Go to a file" value="" onChange={(event) => event.target.value && move(event.target.value)}>
                <option value="" disabled>
                  {`Files · ${plural(files.length, 'file')}`}
                </option>
                {files.map((file) => (
                  <option key={file.path} value={file.path}>
                    {`${file.path}${viewedSet.has(file.path) ? ' ✓' : ''}`}
                  </option>
                ))}
              </select>
            </div>
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
          {!canDecide && !posted && !diffError && (
            <p className="ib-prr-note" data-pull-review-readonly={layer.mine ? 'unlinked' : 'teammate'}>
              {layer.mine ? 'No review thread yet' : `${layer.author ?? 'A teammate'}'s ${noun}`}
            </p>
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
                <GuideReader bare snapshot={snapshot} reviewed={[]} onReviewedChange={() => {}} comments={readerComments} mode="files" reveal={reveal} viewed={{ files: viewedSet, onToggle: toggleViewed }} fileOpenIn={fileOpenIn} fileContents={fileContents} />
              </OpenInCodeSpans>
            </ReaderPart>
          ) : (
            <p className="ib-pr-empty" aria-busy="true">
              Reading the diff…
            </p>
          )}
        </div>
        <div className="ib-apanel ib-gpanel" id={sheetId} onKeyDown={onSheetKey} role={folded ? 'region' : undefined} aria-label={folded ? 'Comments' : undefined}>
          {folded && (
            <div className="ib-sheet-h">
              <b>Comments</b>
              <span className="ib-mut">{comments.length}</span>
              <span className="ib-sp" />
              <button ref={sheetCloseRef} type="button" className="ib-iconbtn" onClick={closeSheet} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          <AnnotationPanel
            emptyHint={readerComments ? 'Click a line number, drag across lines, or select code to comment' : undefined}
            isOpen
            presentation={folded ? 'embedded' : undefined}
            annotations={NO_ANNOTATIONS}
            blocks={NO_BLOCKS}
            codeAnnotations={comments}
            codeAnnotationNote={(c) => (here.includes(c) ? null : 'Written on older code')}
            onSelect={showFromPanel}
            onDelete={remove}
            selectedId={selectedId}
            onSelectCodeAnnotation={showFromPanel}
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
      <div className="ib-prr-foot" data-pull-review-foot="">
        <span className="ib-prr-where">
          {scope === 'stack'
            ? `Whole stack · ${diff ? `${diff.base}…${diff.head}` : `${stack.base} up to ${label}`}`
            : position && position.of > 1
              ? `Layer ${position.at} of ${position.of} · only what this layer changes`
              : `Only what this ${noun} changes`}
          {phone ? '' : ending === 'forge' ? ` · your review goes on the ${forgeName(stack)} ${layer.platform === 'gitlab' ? 'MR' : 'PR'}` : agent && canDecide ? ` · your verdict goes to ${agent}` : ''}
        </span>
        <span className="ib-sp" />
        {next && (
          <button type="button" className="ib-btn" onClick={() => onLayer(next.key, 'layer')} data-pull-next-layer={next.key}>
            Next layer: {inboxPullLabel(next)}
            <Icon name="chevR" size={14} />
          </button>
        )}
      </div>
    </section>
  );
}
