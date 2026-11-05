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
 * - Under `RAIL_FOLD_BELOW` of review the file rail folds: the header's Files
 *   button opens the same tree as a sheet over the diff, the comments' sheet's
 *   mirror. A phone keeps its picker.
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
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import { plural } from '@plannotator/core/inbox-format';
import type { InboxPullDiffAnswer, InboxPullsAnswer } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { AnnotationPanel } from '@plannotator/ui/components/AnnotationPanel';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { InboxApiError, inboxApi } from '../api';
import { guideCommentSections } from '../attachments';
import { RefMarkIcon } from '../board/RefMark';
import { Icon } from '../icons';
import { isTextCut, Tip } from '../components/Tip';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { VerdictKeys, verdictOf } from '../reviewVerdict';
import { REVIEW_FOLD_PANEL_BELOW } from '../components/ReviewPane';
import { PostEnding, reviewEnding, useReviewDestination } from './PostEnding';
import { postablePull, postedWords } from './postRules';
import { findStack, inboxPullLabel, linkAgentName, pullGroups, pullNounWord, pullVerdictReply } from './model';
import { forgeName } from './labels';
import { ReviewRailTree } from './ReviewRailTree';
import { PullDescription } from './PullDescription';
import { useSheetEscape } from '../shortcuts/useSheetEscape';
import { inOverlay } from '../shortcuts/guards';
import { reviewFiles } from './reviewFiles';
import { isOpen, layerPosition, layerVerdictLink, nextLayer, stackVerdictLink } from './topology';

// `#guide-reader` is packages/inbox/guide/GuideReader.tsx (package.json `imports`).
/** The review's width (px) under which its file rail folds into a sheet: the diff would have under 504 px beside it (the review app, in an 800 px window, leaves 544). */
const RAIL_FOLD_BELOW = 760;
/** The review's width (px) under which the controls' row has no room for the read-only note: it moves to the foot. */
const NOTE_ON_STRIP_FROM = 900;
const GuideReader = lazy(() => import('#guide-reader'));

/** The layer on screen brought to the middle of the strip, when the layers do not all fit. */
function centerCurrentLayer(strip: HTMLElement): void {
  const here = strip.querySelector<HTMLElement>('[aria-current="step"]');
  if (!here || strip.scrollWidth <= strip.clientWidth) return;
  const box = strip.getBoundingClientRect();
  const at = here.getBoundingClientRect();
  strip.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
}

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
/** The diffs read in this window, by layer, scope and the PR's last update (a new push reads again). */
const SEEN = new Map<string, InboxPullDiffAnswer>();
const SEEN_MAX = 12;

function readKept(id: string): { comments: CodeAnnotation[]; viewed: string[] } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORE + id) ?? 'null') as { comments?: unknown; viewed?: unknown } | null;
    return {
      comments: Array.isArray(raw?.comments) ? (raw!.comments as CodeAnnotation[]) : [],
      viewed: Array.isArray(raw?.viewed) ? (raw!.viewed as unknown[]).filter((v): v is string => typeof v === 'string') : [],
    };
  } catch {
    return { comments: [], viewed: [] };
  }
}

function keep(id: string, value: { comments: CodeAnnotation[]; viewed: string[] }): void {
  try {
    if (value.comments.length === 0 && value.viewed.length === 0) window.localStorage.removeItem(STORE + id);
    else window.localStorage.setItem(STORE + id, JSON.stringify(value));
  } catch {
    // Storage full or off: kept for this visit only.
  }
}

/**
 * One review per layer and scope: moving to another layer (Next layer, the strip) or switching This layer |
 * Whole stack starts afresh, so a note drafted on #412 never rides into #413's verdict.
 */
export function PullReview(props: PullReviewProps) {
  return <LayerReview key={`${props.layerKey}\u0000${props.scope}`} {...props} />;
}

/**
 * Stored comments of a layer from before its last push: their lines may have moved, so line comments go. Global
 * comments are on no line: they move to this push's comments.
 */
function dropStale(layerKey: string, scope: string, keptId: string): void {
  try {
    const prefix = `${STORE}${layerKey}:${scope}:`;
    const carried: CodeAnnotation[] = [];
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const name = window.localStorage.key(i);
      if (!name || !name.startsWith(prefix) || name === STORE + keptId) continue;
      carried.push(...readKept(name.slice(STORE.length)).comments.filter((c) => c.scope === 'general'));
      window.localStorage.removeItem(name);
    }
    if (carried.length === 0) return;
    const now = readKept(keptId);
    const ids = new Set(now.comments.map((c) => c.id));
    const comments = [...now.comments];
    for (const c of carried) {
      if (ids.has(c.id)) continue;
      ids.add(c.id);
      comments.push(c);
    }
    keep(keptId, { comments, viewed: now.viewed });
  } catch {
    // Storage off.
  }
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

  const seenId = layer ? `${layer.key}\u0000${scope}\u0000${layer.updated_at}` : '';
  const [diff, setDiff] = useState<InboxPullDiffAnswer | null>(() => SEEN.get(seenId) ?? null);
  const [diffError, setDiffError] = useState<string | null>(null);
  useEffect(() => {
    if (!layer) return;
    // Back to a diff read a moment ago (This layer → Whole stack → This layer): drawn at once, not read again.
    const seen = SEEN.get(seenId);
    setDiffError(null);
    if (seen) {
      setDiff(seen);
      return;
    }
    const controller = new AbortController();
    setDiff(null);
    inboxApi
      .pullDiff(layer.key, scope, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        SEEN.set(seenId, answer);
        while (SEEN.size > SEEN_MAX) SEEN.delete(SEEN.keys().next().value!);
        setDiff(answer);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDiffError(cause instanceof Error ? cause.message : 'The diff could not be read.');
      });
    return () => controller.abort();
    // A new layer or scope reads again; the same one keeps its diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer?.key, scope, layer?.updated_at]);

  // Comments and Viewed are kept per push: a new push (`updated_at`) starts clean, but for the global comments.
  const keptId = `${layerKey}:${scope}:${layer?.updated_at ?? ''}`;
  useEffect(() => {
    if (layer) dropStale(layerKey, scope, keptId);
  }, [layer, layerKey, scope, keptId]);
  const [comments, setComments] = useState<CodeAnnotation[]>(() => readKept(keptId).comments);
  const [viewed, setViewed] = useState<string[]>(() => readKept(keptId).viewed);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ id: string; token: number } | null>(null);
  useEffect(() => {
    const kept = readKept(keptId);
    setComments(kept.comments);
    setViewed(kept.viewed);
    setSelectedId(null);
  }, [keptId]);
  const write = (next: { comments?: CodeAnnotation[]; viewed?: string[] }) => {
    const value = { comments: next.comments ?? comments, viewed: next.viewed ?? viewed };
    if (next.comments) setComments(next.comments);
    if (next.viewed) setViewed(next.viewed);
    keep(keptId, value);
  };
  // A diff that could not be read (too large, a refused compare) takes no verdict: there is nothing on screen to judge.
  const canDecide = !!link?.last && !diffError;
  // Post to GitHub/GitLab (the owner's answer C): any open PR whose head the list read, the person's or a
  // teammate's, with or without an agent. The person chooses at the end where the review goes.
  // A layer's comments are on its patch: posted at that patch's own head (the list's can be a minute behind the forge);
  // a patch whose head the forge did not pin down posts nothing (Open on GitHub instead), and neither does a diff
  // that could not be read (the header then offers Open on GitHub).
  const postHead = scope === 'layer' ? (diff?.head_sha ?? null) : (layer?.head_sha ?? null);
  const canPost = !!postablePull(layer) && !diffError && (!diff || !!postHead);
  const [picked, pick] = useReviewDestination();
  const ending = canPost ? reviewEnding(layer, canDecide, picked) : canDecide ? 'agent' : null;
  const [posted, setPosted] = useState<{ label: string; url: string; action: string } | null>(null);
  useEffect(() => setPosted(null), [keptId]);
  const save = (annotation: CodeAnnotation) => write({ comments: [...comments.filter((c) => c.id !== annotation.id), annotation] });
  const remove = (id: string) => write({ comments: comments.filter((c) => c.id !== id) });
  const showComment = (id: string) => {
    setSelectedId(id);
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  // Both measured once the review is drawn: while the list is read, a loading pane stands in its place.
  const drawn = !!(model && stack && layer);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true, drawn);
  // Under RAIL_FOLD_BELOW of review width the file rail folds into a sheet, so the diff keeps the room.
  const [splitRef, railFolded] = useNarrowerThan<HTMLDivElement>(RAIL_FOLD_BELOW, false, drawn);
  const [headRef, noteOffStrip] = useNarrowerThan<HTMLDivElement>(NOTE_ON_STRIP_FROM, false, drawn);
  // Global comment and Split | Unified sit on the strip, as on the review app's tab row. A phone keeps them above the files.
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState(false);
  const sheetId = useId();
  useEffect(() => {
    if (!folded) setSheet(false);
  }, [folded]);
  // The folded rail's sheet, the comments' mirror on the other side: one of the two is open at a time.
  const [filesSheet, setFilesSheet] = useState(false);
  const filesSheetId = useId();
  const filesButton = useRef<HTMLButtonElement>(null);
  const sheetButton = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!railFolded || phone) setFilesSheet(false);
  }, [railFolded, phone]);
  useEffect(() => {
    if (sheet) setFilesSheet(false);
  }, [sheet]);
  // Opening the Files sheet, focus goes to its first row.
  useEffect(() => {
    if (filesSheet) railRef.current?.querySelector<HTMLElement>('[data-review-files] button')?.focus({ preventScroll: true });
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
    const moved = railRef.current?.contains(held) ? filesButton.current : panelRef.current?.contains(held) ? sheetButton.current : held.matches('.ib-vfiles') ? first(railRef.current) : held.matches('.ib-vcomments') ? first(panelRef.current) : null;
    moved?.focus({ preventScroll: true });
  }, [railFolded, folded]);
  // A global comment chosen in the guide: selected in the panel, and the folded panel opens on it (as ReviewPane).
  const showGlobalComment = (id: string) => {
    setSelectedId(id);
    if (folded) setSheet(true);
  };
  // The unsaved global comment's words are named per layer and scope, not per push: they outlive a push, as the
  // global comments do.
  const readerComments = canDecide || canPost ? { annotations: comments, selectedId, onSelect: setSelectedId, onSave: async (annotation: CodeAnnotation) => (save(annotation), true), onDelete: remove, scrollTarget, draftScope: `${layerKey}:${scope}`, onShowGlobalComment: showGlobalComment } : undefined;

  // The files in the rail's order, as the review app has them: the diffs below follow it.
  const { files, tree, loose, patch } = useMemo(() => reviewFiles(diff?.patch ?? ''), [diff]);
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
  // A file picked in the rail. From the sheet it closes, showing the file, and focus goes back to its button.
  const pickFile = (path: string) => {
    move(path);
    if (filesSheet) closeFiles();
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
      const carried = plan.withComments && !plan.discard ? comments : [];
      const parts = pullVerdictReply(plan.verdict, { pull: layer, scope, base: stack.base }, carried.length, carried.length > 0 ? guideCommentSections(carried) : '', note);
      const input = { words: parts.words, questions: [], ...(parts.feedback ? { feedback: parts.feedback } : {}) };
      setSending(true);
      setSendError(null);
      try {
        await inboxApi.reply(link.last.message_id, { idempotency_key: keys.current.keyFor(input), ...input });
        keys.current.done();
        keep(keptId, { comments: [], viewed: [] });
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
    [sending, layer, link, stack, comments, scope, keptId, onSent],
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
    if (stripRef.current) centerCurrentLayer(stripRef.current);
  }, [layerKey, phone, stack?.layers.length]);
  // More layers than fit: the strip's edges fade as on a phone (`data-over` in inbox.css).
  const [layersOver, setLayersOver] = useState(false);
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || phone || typeof ResizeObserver === 'undefined') return;
    // Again on every change of width: the controls arrive on the row after the first draw and take room from the layers.
    const read = () => {
      setLayersOver(strip.scrollWidth > strip.clientWidth);
      centerCurrentLayer(strip);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [drawn, phone, stack?.layers.length]);
  const scopeName = useId();

  if (!model || !stack || !layer) {
    return (
      <section className={`ib-viewer ib-review ib-prreview${phone ? '' : ' ib-prr-wide'}`} aria-label="Review" data-pull-review="">
        <div className="ib-vhead">
          <button type="button" className="ib-back" onClick={onBack}>
            <Icon name="back" size={15} />
            Pull requests
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

  // Whose PR this is, or that it has no thread yet: beside the title or on the strip, on the foot where those run short.
  const readOnlyWords = layer.mine ? 'No review thread yet' : layer.author ? `by ${layer.author}` : '';
  const readOnlyNote = !canDecide && !posted && !diffError && !!readOnlyWords && (
    <Tip cut content={readOnlyWords}>
      <p className="ib-prr-note" data-pull-review-readonly={layer.mine ? 'unlinked' : 'teammate'}>
        {readOnlyWords}
      </p>
    </Tip>
  );
  const whereWords =
    scope === 'stack'
      ? `Whole stack · ${diff ? `${diff.base}…${diff.head}` : `${stack.base} up to ${label}`}`
      : position && position.of > 1
        ? `Layer ${position.at} of ${position.of} · only what this layer changes`
        : `Only what this ${noun} changes`;
  const whereEnd = phone ? '' : ending === 'forge' ? `your review goes on the ${forgeName(stack)} ${layer.platform === 'gitlab' ? 'MR' : 'PR'}` : agent && canDecide ? `your verdict goes to ${agent}` : '';

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-review ib-prreview${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}${phone ? '' : ' ib-prr-wide'}${railFolded ? ' ib-railfold' : ''}${filesSheet ? ' ib-files-open' : ''}`}
      aria-label={`Review ${label}`}
      data-pull-review={layer.key}
      data-pull-scope={scope}
      onFocusCapture={(event) => {
        lastFocus.current = event.target;
      }}
    >
      <div className="ib-vhead" ref={headRef}>
        <button type="button" className="ib-back" onClick={onBack}>
          <Icon name="back" size={15} />
          {phone ? <span className="ib-sr">Pull requests</span> : 'Pull requests'}
        </button>
        <span className="ib-vsep" />
        {!phone && railFolded && files.length > 0 && (
          <button
            ref={filesButton}
            type="button"
            className={`ib-btn ib-sm ib-vfiles${filesSheet ? ' ib-on' : ''}`}
            onClick={() => {
              setFilesSheet((open) => !open);
              setSheet(false);
            }}
            aria-expanded={filesSheet}
            aria-controls={filesSheetId}
            aria-label={`Files, ${files.length}`}
            data-pull-review-files-button=""
          >
            <Icon name="folder" size={15} />
            Files {files.length}
          </button>
        )}
        {/* The review's one title (the reader draws none of its own): cut with "…", whole on hover; the verdict stays on screen. */}
        {/* The title as the forge has it, with who wants to merge what, as the review app's overview says it. */}
        <Tip content={`${label} ${layer.title} · ${layer.author ?? 'A teammate'} wants to merge ${layer.head} into ${layer.base}`}>
          <span className="ib-fn ib-prr-fn" data-pull-review-title="">
            <RefMarkIcon kind="pr" state={layer.state} size={15} />
            <span className="ib-prr-num">{label}</span>
            <bdi>{layer.title}</bdi>
          </span>
        </Tip>
        {!phone && !noteOffStrip && !layer.mine && readOnlyNote}
        <span className="ib-sp" />
        {folded && readerComments && (
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
            comments={comments}
            anchor={scope === 'stack' ? 'stack' : 'diff'}
            headSha={postHead}
            busy={sending || !snapshot}
            picked={picked}
            onPick={pick}
            onPosted={(result) => {
              // Only what went is cleared: a whole stack's line comments map to no PR's lines and stay.
              const went = new Set(result.posted);
              const left = comments.filter((c) => !went.has(c.id));
              keep(keptId, { comments: left, viewed });
              setComments(left);
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
      <div className="ib-rsplit" ref={splitRef}>
        <div className="ib-prr-strip">
          {/* No other scroller is under the strip: a mouse wheel moves the layers sideways. */}
          <nav
            ref={stripRef}
            className="ib-prr-layers"
            aria-label="Layers, bottom first"
            data-over={layersOver ? '' : undefined}
            onWheel={(event) => {
              if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
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
          {!phone && !noteOffStrip && layer.mine && readOnlyNote}
          {scopeSwitch}
          {!phone && <div ref={setControlsHost} className="ib-prr-controls" data-pull-controls="" />}
        </div>
        <nav className="ib-rrail" id={filesSheetId} ref={railRef} aria-label="Changed files" {...sheetKeys}>
          <ReviewRailTree
            tree={tree}
            loose={loose}
            files={files}
            viewed={viewedSet}
            commentCount={(path) => comments.filter((comment) => comment.filePath === path).length}
            onSelect={pickFile}
            onToggleViewed={toggleViewed}
          />
          <div className="ib-rv-progress" aria-live="polite">
            {diff ? `${files.filter((file) => viewedSet.has(file.path)).length} of ${plural(files.length, 'file')} viewed` : ''}
          </div>
        </nav>
        <div className="ib-gbody">
          <PullDescription markdown={diff?.description} layer={layer} headSha={diff?.head_sha} />
          {phone && files.length > 0 && (
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
            <Suspense fallback={null}>
              <GuideReader bare controlsHost={controlsHost} snapshot={snapshot} reviewed={[]} onReviewedChange={() => {}} comments={readerComments} mode="files" reveal={reveal} viewed={{ files: viewedSet, onToggle: toggleViewed }} />
            </Suspense>
          ) : (
            <p className="ib-pr-empty" aria-busy="true">
              Reading the diff…
            </p>
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
          <AnnotationPanel
            emptyHint={readerComments ? 'Click a line number, drag across lines, or select code to comment' : undefined}
            isOpen
            presentation={folded ? 'embedded' : undefined}
            annotations={NO_ANNOTATIONS}
            blocks={NO_BLOCKS}
            codeAnnotations={comments}
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
        <div className="ib-prr-foot" data-pull-review-foot="">
          {(phone || noteOffStrip) && readOnlyNote}
          {/* A long branch name gives way before where the review goes; the whole line on hover when either is cut. */}
          <Tip content={whereEnd ? `${whereWords} · ${whereEnd}` : whereWords} when={(line) => Array.from(line.children).some((part) => isTextCut(part) || part.getClientRects().length === 0)}>
            <span className="ib-prr-where">
              <span className="ib-prr-where-at">{whereWords}</span>
              {whereEnd && (
                <>
                  <span className="ib-prr-where-sep"> · </span>
                  <span className="ib-prr-where-to">{whereEnd}</span>
                </>
              )}
            </span>
          </Tip>
          <span className="ib-sp" />
          {next && (
            <button type="button" className="ib-btn" onClick={() => onLayer(next.key, 'layer')} data-pull-next-layer={next.key}>
              Next layer: {inboxPullLabel(next)}
              <Icon name="chevR" size={14} />
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
