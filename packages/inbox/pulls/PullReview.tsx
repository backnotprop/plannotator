import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { GuideReaderPart, PanePart, PullAllFilesPart, PullRepoFilePart, ReaderPart } from '../lazyParts';
import { buildGuideSnapshot } from '@plannotator/core/guide-format';
import { patchBlobIds, type DiffFile } from '@plannotator/core/diff-files';
import { anchorStillMatches, captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';
import type { KeptComment } from '../guide/platform-post-types';
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
import { DiffControls, nextCollapseAll, type CollapseAllState } from '../components/DiffControls';
import { SidebarTrigger } from '../shell/sidebar';
import { useNarrowerThan } from '../narrower';
import { usePhone } from '../phone';
import { holdBarAfterClose, usePhoneCommentsSheet } from '../components/phoneCommentsSheet';
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
import { FILE_BAND_HEIGHT, FILE_BAND_HEIGHT_PHONE, FileThread, fileThreadOpen, LineThread, ThreadMemory } from './LineThreads';
import { fileThreadKey, placeThreads, threadKey } from './threadPlaces';
import type { GuideFileNote, GuideLineNote } from '../guide/types';
import { RailScopeSwitch } from './RailScope';
import { useTreeScope } from '@plannotator/ui/hooks/useTreeScope';
import { useSheetEscape } from '../shortcuts/useSheetEscape';
import { inOverlay } from '../shortcuts/guards';
import { reviewFiles } from './reviewFiles';
import { layerVerdictLink, nextLayer, stackVerdictLink } from './topology';
import { RiskMark } from './RiskMark';
import { ContextNotesProvider, useContextNotes } from '../contextNotes/ContextNotes';
import { placesWord, riskNotes, takeRiskPlaces } from '../contextNotes/model';
import { usePullRisk } from './usePullRisk';
import { Named } from './Face';
import { person, wordsText, type Words } from './words';

const RAIL_WIDTH = { key: 'plannotator-inbox-pull-rail-width', initial: 280, min: 180, max: 480 };
const GuideReader = GuideReaderPart.Part;

export interface PullReviewProps {
  model: InboxPullsAnswer | null;
  modelError: string | null;
  stackId: string;
  layerKey: string;
  scope: 'layer' | 'stack';
  onLayer: (key: string, scope: 'layer' | 'stack') => void;
  onBack: () => void;
  onSent: () => void;
  onPosted?: () => void;
}

const NO_BLOCKS: never[] = [];
const NO_ANNOTATIONS: never[] = [];
const STORE = 'plannotator-inbox-pull-review:';
const SEEN = new Map<string, InboxPullDiffAnswer>();
const SEEN_MAX = 12;
const NEWEST = new Map<string, string>();
const seenDiff = (seenId: string, layerKey: string): InboxPullDiffAnswer | undefined => {
  const seen = SEEN.get(seenId);
  return seen && seen.head_sha === NEWEST.get(layerKey) ? seen : undefined;
};
const HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

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
    return false;
  }
}

export function PullReview(props: PullReviewProps) {
  // A tooltip in the rail, a file's head or the decision (ui's, not the Inbox's Tip) would eat the Escape that closes a sheet.
  return (
    <TooltipEscapePassesThrough.Provider value={true}>
      <LayerReview key={`${props.layerKey}\u0000${props.scope}`} {...props} />
    </TooltipEscapePassesThrough.Provider>
  );
}

interface OnScreen {
  updatedAt: string | null;
  listHead: string | null;
  stamp: string | null;
  base: string | null;
  files: readonly DiffFile[];
}

const onLine = (c: CodeAnnotation) => (c.scope ?? 'line') === 'line';

function isHere(c: KeptComment, screen: Pick<OnScreen, 'stamp' | 'files'>): boolean {
  if (!onLine(c)) return c.scope !== 'file' || !screen.stamp || screen.files.some((f) => f.path === c.filePath);
  if (c.outdated) return false;
  return !screen.stamp || c.anchorSnapshot === undefined || c.anchorSnapshot === screen.stamp || anchorStillMatches(c, screen.files);
}

function allEntries(layerKey: string, scope: string): string[] {
  const names: string[] = [];
  try {
    const prefix = `${STORE}${layerKey}:${scope}:`;
    for (let i = 0; i < window.localStorage.length; i++) {
      const name = window.localStorage.key(i);
      if (name?.startsWith(prefix)) names.push(name.slice(STORE.length));
    }
  } catch {}
  return names;
}

const asSeparate = (c: KeptComment): KeptComment => ({ ...c, id: `${c.id}:${stampOf(postedSignature(c))}` });

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
    if (mode !== 'read' && (!changed || keep(keptId, value))) for (const take of taken) take();
    return value;
  } catch {
    return now;
  }
}

function forPost(comments: readonly KeptComment[], screen: Pick<OnScreen, 'stamp' | 'files' | 'base'>, head: string | null, platform: string | undefined, scope: string): KeptComment[] {
  return comments.map((c) => {
    if (!onLine(c) || c.outdated) return c;
    const here = isHere(c, screen);
    if (scope === 'layer' && platform === 'github' && !c.outsideDiff && c.readHead && head && c.readHead !== head && c.readBase === screen.base) return { ...c, postAt: c.readHead, postHere: here };
    return here ? c : { ...c, outdated: true };
  });
}

function LayerReview({ model, modelError, stackId, layerKey, scope, onLayer, onBack, onSent, onPosted }: PullReviewProps) {
  const phone = usePhone();
  const item = useMemo(() => (model ? findStack(pullGroups(model, null), stackId) : null), [model, stackId]);
  const stack = item?.stack ?? null;
  const layer = stack?.layers.find((l) => l.key === layerKey) ?? null;
  const link = useMemo(() => {
    if (!stack || !model || !layer) return null;
    return scope === 'stack' ? stackVerdictLink(layer, stack, model.links) : layerVerdictLink(layer, stack, model.links);
  }, [stack, model, layer, scope]);
  const agent = linkAgentName(link);
  const next = stack && layer ? nextLayer(stack, layer.key) : null;

  const diffBase = scope === 'stack' ? stack?.open_base : layer?.base;
  const seenId = layer ? `${layer.key}\u0000${scope}\u0000${layer.head_sha ?? layer.updated_at}\u0000${diffBase}` : '';
  const [diff, setDiff] = useState<InboxPullDiffAnswer | null>(() => seenDiff(seenId, layerKey) ?? null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const read = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const again = useRef(false);
  useEffect(() => {
    if (again.current) setAttempt((n) => n + 1);
    again.current = false;
  }, [model]);
  useEffect(() => {
    if (!layer) return;
    const seen = seenDiff(seenId, layerKey);
    if (seen) {
      setDiffError(null);
      setDiff(seen);
      return;
    }
    if (diff?.head_sha && diff.head_sha === layer.head_sha && diff.base === diffBase) {
      SEEN.set(seenId, diff);
      return;
    }
    const controller = new AbortController();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seenId, attempt]);

  const lastName = useRef<string | null>(null);
  const lastPatch = useRef<string | null>(null);
  const keptName = diff?.head_sha ?? (diff && diff.patch === lastPatch.current ? lastName.current : null) ?? layer?.head_sha ?? lastName.current ?? layer?.updated_at ?? null;
  lastName.current = keptName;
  lastPatch.current = diff?.patch ?? null;
  const keptId = `${layerKey}:${scope}:${keptName ?? ''}`;
  const sure = read.current;
  const rawPatch = diff?.patch;
  const stamp = useMemo(() => (rawPatch === undefined ? null : stampOf(rawPatch)), [rawPatch]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keptId, sure, stamp]);
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
  const canDecide = !!link?.last && !diffError;
  const riskAnswer = usePullRisk(model).answer;
  const judged = riskAnswer?.judgments[layer?.key ?? ''];
  const riskFailure = riskAnswer?.failed[layer?.key ?? ''];
  const postHead = diff?.head_sha ?? (scope === 'layer' ? null : (layer?.head_sha ?? null));
  const canPost = !!postablePull(layer) && !diffError && (!diff || !!postHead);
  const headMoved = !!diff && !diff.head_sha;
  const fileContents = useCallback(
    async (path: string, signal: AbortSignal, patch: string) => {
      const ids = headMoved ? null : patchBlobIds(patch);
      return ids ? inboxApi.pullFile(layerKey, scope, path, ids, signal) : { oldContent: null, newContent: null };
    },
    [layerKey, scope, headMoved],
  );
  const [picked, pick] = useReviewDestination();
  const [posted, setPosted] = useState<{ label: string; url: string; action: string } | null>(null);
  useEffect(() => setPosted(null), [keptId]);
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
    forgetWent(comments.filter((c) => c.id === id));
  };
  const here = useMemo(() => comments.filter((c) => isHere(c, { stamp, files })), [comments, stamp, files]);
  const showComment = (id: string) => {
    setSelectedId(id);
    const comment = comments.find((c) => c.id === id);
    if (comment && !here.includes(comment)) {
      if (files.some((file) => file.path === comment.filePath)) move(comment.filePath);
      return;
    }
    setScrollTarget((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  const drawn = !!(model && stack && layer);
  const [paneRef, folded] = useNarrowerThan<HTMLElement>(REVIEW_FOLD_PANEL_BELOW, true, drawn);
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
    } catch {}
  };
  const [collapseAll, setCollapseAll] = useState<CollapseAllState | null>(null);
  const [sheet, setSheet] = useState(false);
  const sheetId = useId();
  const sheetCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setSheet(false);
  }, [folded]);
  const [filesSheet, setFilesSheet] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const details = usePullDetails(layer ? layerKey : null, layer ? `${layer.head_sha ?? ''}\u0000${layer.updated_at}` : '');
  const threadMemory = useRef(new ThreadMemory()).current;
  const threadsHere = details.data && details.data.key === layerKey ? details.data.threads : undefined;
  const threads = useMemo(() => (threadsHere && diff ? placeThreads(threadsHere, files, scope) : null), [threadsHere, diff, files, scope]);
  const threadHead = diff?.head_sha;
  const fileThreadIds = useMemo(() => (threads ? threads.onFiles.map(({ thread }) => thread.id) : []), [threads]);
  const openFileThreads = useSyncExternalStore(
    threadMemory.subscribe,
    () => fileThreadIds.filter((id) => fileThreadOpen(threadMemory, id)).join('\n'),
  );
  const lineNotes = useMemo<GuideLineNote[] | undefined>(() => {
    if (!threads || !layer) return undefined;
    const notes: GuideLineNote[] = threads.placed.map((placed) => ({
      id: `forge:${placed.thread.id}`,
      filePath: placed.thread.file,
      line: placed.line,
      side: placed.side,
      key: `${layer.key}|${threadHead ?? ''}|${threadKey(placed)}`,
      render: () => <LineThread placed={placed} layer={layer} memory={threadMemory} headSha={threadHead} />,
    }));
    const open = new Set(openFileThreads ? openFileThreads.split('\n') : []);
    for (const { thread, side, lines } of threads.onFiles) {
      if (!lines || !open.has(thread.id)) continue;
      notes.push({
        id: `forge:${thread.id}`,
        filePath: thread.file,
        line: 0,
        side,
        key: `${layer.key}|${threadHead ?? ''}|open|${fileThreadKey(thread)}`,
        render: () => <FileThread thread={thread} layer={layer} memory={threadMemory} headSha={threadHead} open />,
      });
    }
    return notes;
  }, [threads, layer, threadHead, threadMemory, openFileThreads]);
  const wholeFileNotes = useMemo<GuideFileNote[] | undefined>(() => {
    if (!threads || !layer) return undefined;
    const open = new Set(openFileThreads ? openFileThreads.split('\n') : []);
    const notes: GuideFileNote[] = [];
    for (const { thread, lines } of threads.onFiles) {
      const opened = open.has(thread.id);
      if (opened && lines) continue;
      notes.push({
        id: `forge:${thread.id}`,
        filePath: thread.file,
        key: `${layer.key}|${threadHead ?? ''}|${opened ? 'open' : phone ? 'phone' : ''}|${fileThreadKey(thread)}`,
        ...(opened ? {} : { height: phone ? FILE_BAND_HEIGHT_PHONE : FILE_BAND_HEIGHT }),
        render: () => <FileThread thread={thread} layer={layer} memory={threadMemory} headSha={threadHead} open={opened} phone={phone} />,
      });
    }
    return notes;
  }, [threads, layer, threadHead, threadMemory, openFileThreads, phone]);
  const openThreads = threads?.open;
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
  useEffect(() => {
    if (filesSheet) railRef.current?.querySelector<HTMLElement>('[data-review-files] button, [data-repo-file-tree] button, [data-pull-layer-row] button')?.focus({ preventScroll: true });
  }, [filesSheet]);
  const closeComments = () => {
    // At once: on a phone the button can take focus only once the page shows again.
    flushSync(() => setSheet(false));
    sheetButton.current?.focus({ preventScroll: true });
    if (phone) holdBarAfterClose(sheetButton.current);
  };
  usePhoneCommentsSheet(phone && sheet, sheetCloseRef, closeComments);
  const closeFiles = () => {
    setFilesSheet(false);
    filesButton.current?.focus({ preventScroll: true });
  };
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
      if (folded) setSheet(false);
      setFilesSheet(false);
      setDetailsOpen(false);
    },
  };
  const lastFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const held = lastFocus.current;
    const now = document.activeElement;
    if (!held || (now && now !== held && now !== document.body) || (held.isConnected && held.getClientRects().length > 0)) return;
    const first = (root: HTMLElement | null) => root?.querySelector<HTMLElement>('button, [tabindex="0"]');
    const moved = railRef.current?.contains(held) ? filesButton.current : panelRef.current?.contains(held) ? sheetButton.current : held.matches('[data-pull-review-files-button]') ? first(railRef.current) : held.matches('.ib-vcomments') ? first(panelRef.current) : null;
    moved?.focus({ preventScroll: true });
  }, [phone, folded]);
  const showFromPanel = (id: string) => {
    showComment(id);
    if (phone) setSheet(false);
  };
  const showGlobalComment = (id: string) => {
    setSelectedId(id);
    setSheet(true);
  };
  const saveFromReader = async (annotation: CodeAnnotation) => {
    const added = !comments.some((c) => c.id === annotation.id);
    save(annotation);
    if (added && !folded) setSheet(true);
    return true;
  };
  const readerComments = canDecide || canPost ? { annotations: here, selectedId, onSelect: setSelectedId, onSave: saveFromReader, onDelete: remove, scrollTarget, draftScope: `${layerKey}:${scope}`, onShowGlobalComment: showGlobalComment } : undefined;

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
  const [treeScope, setTreeScope] = useTreeScope();
  const repoSha = diff?.head_sha ?? layer?.head_sha ?? null;
  const allFiles = treeScope === 'all' && !!repoSha;
  const [repoOpen, setRepoOpen] = useState<string | null>(null);
  useEffect(() => setRepoOpen(null), [layerKey, scope, repoSha]);
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
  const placeNotes = useMemo(
    () => (scope === 'layer' && judged && layer && diff?.head_sha && diff.head_sha === layer.head_sha ? riskNotes(judged, files) : []),
    [scope, judged, layer?.head_sha, diff?.head_sha, files], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const places = useContextNotes(placeNotes, {});
  const placeAt = useRef(-1);
  const goToPlace = (index: number) => {
    const note = placeNotes[index];
    if (!note) return;
    placeAt.current = index;
    move(note.file);
    places.show(note.id);
  };
  const nextPlace = () => goToPlace((placeAt.current + 1) % placeNotes.length);
  const placesTaken = useRef<string | null>(null);
  const placesWanted = useRef(false);
  useEffect(() => {
    // StrictMode runs this twice on the same layer: the second run keeps what the first took.
    if (placesTaken.current === layerKey) return;
    placesTaken.current = layerKey;
    placesWanted.current = takeRiskPlaces(layerKey);
  }, [layerKey]);
  useEffect(() => {
    if (!placesWanted.current) return;
    if (placeNotes.length > 0) {
      placesWanted.current = false;
      goToPlace(0);
      return;
    }
    if (scope !== 'layer' || diffError || (judged && layer && diff?.head_sha && diff.head_sha === layer.head_sha)) placesWanted.current = false;
  }, [placeNotes.length, layerKey, scope, diffError, judged, diff?.head_sha, layer?.head_sha]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <section className={`ib-viewer ib-wlayer ib-review ib-prreview${phone ? '' : ' ib-prr-wide'}`} aria-label="Review" data-pull-review="">
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

  const readOnlyParts: Words = layer.mine ? ['No review thread yet'] : layer.author ? ['by ', person(layer.author)] : ['by a deleted account'];
  const readOnlyWords = wordsText(readOnlyParts);
  const readOnlyNote = !canDecide && !posted && !diffError && (
    <Tip cut content={readOnlyWords}>
      <p className="ib-prr-note" data-pull-review-readonly={layer.mine ? 'unlinked' : 'teammate'}>
        <Named words={readOnlyParts} host={layer.host} />
      </p>
    </Tip>
  );
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
        <RailTree tree={tree} loose={loose} files={files} viewed={viewedSet} commentCount={(path) => comments.filter((comment) => comment.filePath === path).length} threadCount={openThreads ? (path) => openThreads.get(path) ?? 0 : undefined} onSelect={pickFile} onToggleViewed={toggleViewed} head={scopeSwitch} />
      )}
    </>
  );

  return (
    <section
      ref={paneRef}
      className={`ib-viewer ib-wlayer ib-review ib-prreview${folded ? ' ib-fold' : ''}${folded && sheet ? ' ib-panel-open' : ''}${!folded && !sheet ? ' ib-prr-panel-shut' : ''}${phone ? '' : ' ib-prr-wide'}${phone ? ' ib-railfold' : ''}${filesSheet ? ' ib-files-open' : ''}`}
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
        {judged && <RiskMark judgment={judged} />}
        {placeNotes.length > 0 && (
          <button type="button" className="ib-ctxn-places" onClick={nextPlace} data-pull-risk-places={placeNotes.length}>
            {placesWord(placeNotes.length)}
          </button>
        )}
        {!judged && riskFailure && <RiskMark failed={riskFailure} />}
        {!phone && readOnlyNote}
        {!phone && <DetailsButton open={detailsOpen} data={details.data} onToggle={toggleDetails} />}
        <span className="ib-sp" />
        {!phone && snapshot && <DiffControls files={files.length} collapseAll={collapseAll} onCollapseAll={() => setCollapseAll(nextCollapseAll)} />}
        {!phone && <div ref={setControlsHost} className="ib-prr-controls" data-pull-controls="" />}
        {(readerComments || comments.length > 0) && (
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
              forgetWent(result.posted);
              setPosted({ label: result.label, url: result.url, action: result.action });
              onPosted?.();
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
        <div className="ib-gbody" data-repo-open={repoOpen && repoSha ? '' : undefined}>
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
            <ReaderPart key={diff?.patch} diff={snapshot.review.rawPatch}>
              <OpenInCodeSpans scope={{ repo: repoKey ?? '', pull: layerKey }} on={!!repoKey}>
                <ContextNotesProvider api={places.api}>
                  <GuideReader
                    bare
                    controlsHost={controlsHost}
                    hostDiffControls
                    {...(collapseAll ? { collapseAll } : {})}
                    snapshot={snapshot}
                    reviewed={[]}
                    onReviewedChange={() => {}}
                    comments={readerComments}
                    mode="files"
                    reveal={reveal}
                    viewed={{ files: viewedSet, onToggle: toggleViewed }}
                    fileOpenIn={fileOpenIn}
                    fileContents={fileContents}
                    lineNotes={lineNotes}
                    wholeFileNotes={wholeFileNotes}
                    {...(places.anchors.length > 0 ? { contextNotes: places.anchors, renderContextNote: places.renderContextNote } : {})}
                  />
                </ContextNotesProvider>
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
              <button ref={sheetCloseRef} type="button" className="ib-iconbtn" onClick={closeComments} aria-label="Close the comments">
                <Icon name="x" />
              </button>
            </div>
          )}
          {phone && <div ref={setControlsHost} className="ib-prr-controls ib-prp-sheetctl" data-pull-controls="" />}
          <AnnotationPanel
            title="Comments"
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
    </section>
  );
}
