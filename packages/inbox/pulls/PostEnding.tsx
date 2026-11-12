import { Suspense, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { PlatformPostPart } from '../lazyParts';
import type { InboxPull } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { PRPlatformIcon } from '@plannotator/ui/components/PRPlatformIcon';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { inboxApi } from '../api';
import { RowAgentTiles } from '../components/RowAgents';
import { Tip } from '../components/Tip';
import { Icon } from '../icons';
import type { PlatformAction } from '../guide/platform-post-types';
import { platformRules, postablePull, postedSignature, postedWords, resolvePlatformDecisionAction } from './postRules';

const PlatformPost = PlatformPostPart.Part;

function LoadFailed({ notice, onFailed }: { notice: ReactNode; onFailed: (notice: ReactNode) => void }) {
  useEffect(() => onFailed(notice), [notice, onFailed]);
  return null;
}

export type ReviewDestination = 'forge' | 'agent';

const DEST_KEY = 'plannotator-inbox-review-dest';

function readDestination(): ReviewDestination {
  try {
    return window.localStorage.getItem(DEST_KEY) === 'forge' ? 'forge' : 'agent';
  } catch {
    return 'agent';
  }
}

export function useReviewDestination(): [ReviewDestination, (next: ReviewDestination) => void] {
  const [picked, setPicked] = useState<ReviewDestination>(readDestination);
  const choose = useCallback((next: ReviewDestination) => {
    setPicked(next);
    try {
      window.localStorage.setItem(DEST_KEY, next);
    } catch {} // Storage off: the choice holds for this page.
  }, []);
  return [picked, choose];
}

export function reviewEnding(pull: InboxPull | null, hasAgent: boolean, picked: ReviewDestination): ReviewDestination | null {
  const postable = !!postablePull(pull);
  if (!postable) return hasAgent ? 'agent' : null;
  return hasAgent ? picked : 'forge';
}

export interface PostEndingProps {
  pull: InboxPull | null;
  agent: { name: string; host?: string | null; control: ReactNode } | null;
  comments: readonly CodeAnnotation[];
  anchor: 'diff' | 'guide' | 'stack';
  busy: boolean;
  picked: ReviewDestination;
  onPick: (next: ReviewDestination) => void;
  onPosted: (result: { action: PlatformAction; url: string; label: string; posted: readonly CodeAnnotation[] }) => void;
  onWent?: (went: readonly CodeAnnotation[]) => void;
  readComments?: () => readonly CodeAnnotation[];
  headSha?: string | null;
  onMoved?: () => void;
  note?: string;
}

export function PostEnding({ pull, agent, comments: all, readComments, anchor, busy, picked, onPick, onPosted, onWent, headSha, onMoved, note }: PostEndingProps) {
  const target = useMemo(() => {
    const listed = postablePull(pull);
    if (!listed || headSha === undefined) return listed;
    return headSha ? { ...listed, head_sha: headSha } : null;
  }, [pull, headSha]);
  const rules = target ? platformRules(target) : null;
  const destination: ReviewDestination = !target ? 'agent' : !agent ? 'forge' : picked;
  const choose = onPick;
  const [open, setOpen] = useState<{ action: PlatformAction; chooseEvent: boolean } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [loadFailure, setLoadFailure] = useState<ReactNode>(null);
  const loadFailed = useCallback((notice: ReactNode) => {
    PlatformPostPart.retry();
    setOpen(null);
    setMounted(false);
    setLoadFailure(notice);
  }, []);
  const openDialog = useCallback((mode: { action: PlatformAction; chooseEvent: boolean }) => {
    setLoadFailure(null);
    setMounted(true);
    setOpen(mode);
  }, []);
  // A comment already posted on this PR is never posted again, at any head; a follow-up carries only what is new.
  const [done, setDone] = useState<{ key: string; head: string; action: PlatformAction; ids: ReadonlySet<string> } | null>(null);
  const sameKey = !!done && !!target && done.key === target.key;
  const sameHead = sameKey && done!.head === target!.head_sha;
  const comments = useMemo(() => (sameKey ? all.filter((c) => !done!.ids.has(postedSignature(c))) : all), [sameKey, all, done]);
  const isDone = sameHead && comments.length === 0;
  const name = useId();

  const spec = useMemo(
    () =>
      rules
        ? buildDecisionSpec({
            app: 'review',
            gate: true,
            count: comments.length,
            hasFeedback: comments.length > 0,
            approvalNotesSupported: false,
            platform: {
              label: rules.label,
              mrLabel: rules.mrLabel,
              selfAuthored: rules.selfAuthored,
              requestChangesSupported: rules.requestChangesSupported,
              selfRequestChangesBlocked: rules.selfRequestChangesBlocked,
            },
          })
        : null,
    [rules?.label, rules?.mrLabel, rules?.selfAuthored, rules?.requestChangesSupported, rules?.selfRequestChangesBlocked, comments.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const run = useCallback(
    (id: DecisionActionId) => {
      if (!spec || !rules || busy || open) return;
      if (id === 'primary' && spec.primary.muted) return;
      if (spec.items.some((item) => item.id === id && item.muted)) return;
      const mode = resolvePlatformDecisionAction(id, comments.length > 0, rules.requestChangesSupported);
      if (!mode) return;
      openDialog(mode);
    },
    [spec, rules, busy, open, comments.length, openDialog],
  );
  const handlers = useMemo<Record<DecisionActionId, DecisionHandler>>(
    () => ({
      primary: () => run('primary'),
      'note-with-approval': () => run('note-with-approval'),
      'request-changes': () => run('request-changes'),
      'note-with-feedback': () => run('note-with-feedback'),
      'approve-with-notes': () => run('approve-with-notes'),
      'discard-and-finish': () => {},
    }),
    [run],
  );

  if (!target || !rules || !spec)
    return agent ? (
      <>
        <Tip content={`Send to ${agent.name}`}>
          <span className="ib-rv-dest-lone" role="img" aria-label={`Your verdict goes to ${agent.name}`} data-review-going="agent">
            <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: agent.host ?? null }} tip={false} />
          </span>
        </Tip>
        {agent.control}
      </>
    ) : null;

  const forgeMark = target.platform === 'github' ? <Icon name="github" size={15} className="ib-rv-dest-mark" /> : <PRPlatformIcon platform={target.platform} className="ib-rv-dest-mark" />;
  const choice = agent && (
    <div className="ib-seg ib-seg-sm ib-rv-dest" role="radiogroup" aria-label="Where your review goes" data-review-destination={destination}>
      {(['forge', 'agent'] as const).map((value) => {
        const words = value === 'forge' ? `Post to the ${rules.mrLabel} on ${rules.label}` : `Send to ${agent.name}`;
        return (
          <Tip key={value} content={words}>
            <label className="ib-seg-o" data-on={destination === value ? '' : undefined} data-review-destination-choice={value}>
              <input type="radio" name={name} checked={destination === value} onChange={() => choose(value)} aria-label={words} />
              {value === 'forge' ? forgeMark : <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: agent.host ?? null }} tip={false} />}
            </label>
          </Tip>
        );
      })}
    </div>
  );

  return (
    <>
      {choice}
      {!agent && (
        <Tip content={`${isDone ? 'Posted' : 'Posts'} to the ${rules.mrLabel} on ${rules.label}${note ? `. ${note}` : ''}`}>
          <span className="ib-rv-dest-lone" role="img" aria-label={`Your review goes to the ${rules.mrLabel} on ${rules.label}`} data-review-going="forge">
            {forgeMark}
          </span>
        </Tip>
      )}
      {destination === 'agent' && agent ? (
        agent.control
      ) : (
        <span className="ib-rv-decide" data-review-decision="" data-review-posts={target.platform}>
          {loadFailure}
          {isDone ? (
            <>
              <button type="button" className="ib-btn ib-sm ib-rv-posted-done" disabled data-review-posted-done={done!.action}>
                <Icon name="checkCircle" size={14} />
                {postedWords({ label: rules.label, action: done!.action })}
              </button>
              <button
                type="button"
                className="ib-btn ib-sm"
                disabled={busy || !!open}
                onClick={() => openDialog({ action: 'comment', chooseEvent: false })}
                data-review-post-followup=""
              >
                Comment…
              </button>
            </>
          ) : (
            <DecisionControl spec={spec} handlers={handlers} busy={busy || !!open} isLoading={false} labelBreakpoint="md" />
          )}
        </span>
      )}
      {mounted && (
        <LazyBlockBoundary fallback={(notice) => <LoadFailed notice={notice} onFailed={loadFailed} />}>
          <Suspense fallback={null}>
            <PlatformPost
              pull={target}
              open={open}
              comments={comments}
              anchor={anchor}
              post={async (request) => {
                const response = await inboxApi.pullReviewPost(request);
                if (response.status === 409 && onMoved) {
                  const answer = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
                  if (answer?.code === 'pull_moved' || answer?.code === 'pull_commit_gone') {
                    setOpen(null);
                    onMoved();
                  }
                }
                return response;
              }}
              onClose={() => setOpen(null)}
              onWent={onWent}
              readComments={readComments && (() => readComments().filter((c) => !sameKey || !done!.ids.has(postedSignature(c))))}
              hostReadsAgain={Boolean(onMoved)}
              onPosted={(result) => {
                setOpen(null);
                const action = sameHead && result.action === 'comment' ? done!.action : result.action;
                // At the commit it went to: a newer one on screen by now is still to be reviewed.
                setDone({ key: target.key, head: result.head, action, ids: new Set([...(sameKey ? done!.ids : []), ...result.posted.map(postedSignature)]) });
                onPosted({ ...result, action, label: rules.label });
              }}
            />
          </Suspense>
        </LazyBlockBoundary>
      )}
    </>
  );
}
