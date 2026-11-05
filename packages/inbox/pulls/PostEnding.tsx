/**
 * The end of a pull request's review in the Inbox (the owner's answer C on #2590: the person chooses at the end).
 * Two places a review can go:
 *
 * - **Post to GitHub/GitLab**: the comments and Approve, Request changes or Comment go on the PR, as
 *   `plannotator review <PR url>` posts them: the review app's own decision arm (`buildDecisionSpec` with
 *   `platform`), its submit dialog and its providers, through `#platform-post`.
 * - **Send to the agent**: today's path, the verdict as a reply in the agent's thread (`agentControl`, the host's).
 *
 * The choice shows only when both can happen: with no agent (or a teammate's PR, whose agent path takes no
 * verdict), posting is the only ending; with no PR to post to, the agent's is.
 */
import { lazy, Suspense, useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import type { InboxPull } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { DecisionControl, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { PRPlatformIcon } from '@plannotator/ui/components/PRPlatformIcon';
import { buildDecisionSpec, type DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { inboxApi } from '../api';
import { RowAgentTiles } from '../components/RowAgents';
import { Icon } from '../icons';
import { usePhone } from '../phone';
import type { PlatformAction } from '../guide/platform-post-types';
import { platformRules, postablePull, postedWords, resolvePlatformDecisionAction } from './postRules';

// `#platform-post` is packages/inbox/guide/PlatformPost.tsx (package.json `imports`): the review app's dialog.
const PlatformPost = lazy(() => import('#platform-post'));

export type ReviewDestination = 'forge' | 'agent';

/**
 * A posted comment as it went: its id with what it says and where. A comment edited after it was posted keeps its
 * id but not this, so the correction counts as new and the follow-up offers it.
 */
export function postedSignature(c: CodeAnnotation): string {
  return JSON.stringify([c.id, c.text ?? '', c.suggestedCode ?? '', c.filePath, c.lineStart, c.lineEnd, c.side, c.scope ?? 'line']);
}

const DEST_KEY = 'plannotator-inbox-review-dest';

function readDestination(): ReviewDestination {
  try {
    return window.localStorage.getItem(DEST_KEY) === 'forge' ? 'forge' : 'agent';
  } catch {
    return 'agent';
  }
}

/** Where the person last chose a review goes (kept across reviews, as the review app keeps its own), and its setter. */
export function useReviewDestination(): [ReviewDestination, (next: ReviewDestination) => void] {
  const [picked, setPicked] = useState<ReviewDestination>(readDestination);
  const choose = useCallback((next: ReviewDestination) => {
    setPicked(next);
    try {
      window.localStorage.setItem(DEST_KEY, next);
    } catch {
      // Storage off: the choice holds for this page.
    }
  }, []);
  return [picked, choose];
}

/** Where this review goes: posting when there is no agent, the agent when there is no PR to post to, else the pick. */
export function reviewEnding(pull: InboxPull | null, hasAgent: boolean, picked: ReviewDestination): ReviewDestination | null {
  const postable = !!postablePull(pull);
  if (!postable) return hasAgent ? 'agent' : null;
  return hasAgent ? picked : 'forge';
}

export interface PostEndingProps {
  /** The PR this review can be posted to; null or unpostable (closed, its head unknown): the agent's ending alone. */
  pull: InboxPull | null;
  /** The agent the other ending sends to ("Claude Code"), with its control; null: posting is the only ending. */
  agent: { name: string; host?: string | null; control: ReactNode } | null;
  comments: readonly CodeAnnotation[];
  /** What the comments were written on (PlatformPost's `anchor`). */
  anchor: 'diff' | 'guide' | 'stack';
  /** The diff is not ready, or something else is on its way. */
  busy: boolean;
  /** The person's pick (`useReviewDestination`), with its setter. */
  picked: ReviewDestination;
  onPick: (next: ReviewDestination) => void;
  /** The review went on the PR: the host clears the comments that went (`posted`, their ids) and says so. */
  onPosted: (result: { action: PlatformAction; url: string; label: string; posted: readonly string[] }) => void;
  /**
   * The commit the comments were written on (the layer patch's own head, `InboxPullDiffAnswer.head_sha`), posted to
   * instead of the list's; null: not known, nothing can be posted. Absent: the list's head.
   */
  headSha?: string | null;
  /** The server said the PR moved past the commit posted to (`pull_moved`): the host reads it again. */
  onMoved?: () => void;
}

export function PostEnding({ pull, agent, comments: all, anchor, busy, picked, onPick, onPosted, headSha, onMoved }: PostEndingProps) {
  const phone = usePhone();
  const target = useMemo(() => {
    const listed = postablePull(pull);
    if (!listed || headSha === undefined) return listed;
    return headSha ? { ...listed, head_sha: headSha } : null;
  }, [pull, headSha]);
  const rules = target ? platformRules(target) : null;
  const destination: ReviewDestination = !target ? 'agent' : !agent ? 'forge' : picked;
  const choose = onPick;
  const [open, setOpen] = useState<{ action: PlatformAction; chooseEvent: boolean } | null>(null);
  // Kept once opened: a partial or refused attempt's plan (its narrowed retry) survives a Cancel and a reopen.
  const [mounted, setMounted] = useState(false);
  // The review that went: shown done (never posted twice) until the PR's head moves or a new comment is written. A
  // comment already posted on this PR is never posted again, at any head (Start review keeps its comments after a
  // post); a follow-up carries only what is new (or a main comment).
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
            platform: { label: rules.label, mrLabel: rules.mrLabel, selfAuthored: rules.selfAuthored, requestChangesSupported: rules.requestChangesSupported },
          })
        : null,
    [rules?.label, rules?.mrLabel, rules?.selfAuthored, rules?.requestChangesSupported, comments.length], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // As the review app's `runPlatformDecisionAction`: a muted decision (the person's own PR) does nothing; the rest
  // open the dialog on their event.
  const run = useCallback(
    (id: DecisionActionId) => {
      if (!spec || !rules || busy || open) return;
      if (id === 'primary' && spec.primary.muted) return;
      if (spec.items.some((item) => item.id === id && item.muted)) return;
      const mode = resolvePlatformDecisionAction(id, comments.length > 0, rules.requestChangesSupported);
      if (!mode) return;
      setMounted(true);
      setOpen(mode);
    },
    [spec, rules, busy, open, comments.length],
  );
  const handlers = useMemo<Record<DecisionActionId, DecisionHandler>>(
    () => ({
      primary: () => run('primary'),
      'note-with-approval': () => run('note-with-approval'),
      'request-changes': () => run('request-changes'),
      'note-with-feedback': () => run('note-with-feedback'),
      'approve-with-notes': () => run('approve-with-notes'),
      'discard-and-finish': () => {}, // the platform arm never offers it
    }),
    [run],
  );

  if (!target || !rules || !spec) return agent ? <>{agent.control}</> : null;

  const choice = agent && (
    <div className="ib-seg ib-seg-sm ib-rv-dest" role="radiogroup" aria-label="Where your review goes" data-review-destination={destination}>
      {(['forge', 'agent'] as const).map((value) => {
        const words = value === 'forge' ? `Post to the ${rules.mrLabel} on ${rules.label}` : `Send to ${agent.name}`;
        return (
          <label key={value} className="ib-seg-o" data-on={destination === value ? '' : undefined} data-review-destination-choice={value} title={words}>
            <input type="radio" name={name} checked={destination === value} onChange={() => choose(value)} aria-label={words} />
            {value === 'forge' ? <PRPlatformIcon platform={target.platform} className="ib-rv-dest-mark" /> : <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: agent.host ?? null }} tip={false} />}
            {!phone && <span aria-hidden="true">{value === 'forge' ? rules.label : agent.name}</span>}
          </label>
        );
      })}
    </div>
  );

  return (
    <>
      {choice}
      {destination === 'agent' && agent ? (
        agent.control
      ) : (
        <span className="ib-rv-decide" data-review-decision="" data-review-posts={target.platform}>
          {isDone ? (
            <>
              <button type="button" className="ib-btn ib-sm ib-rv-posted-done" disabled data-review-posted-done={done!.action}>
                <Icon name="checkCircle" size={14} />
                {postedWords({ label: rules.label, action: done!.action })}
              </button>
              {/* A follow-up: a main comment only (the dialog needs one when there is nothing new to post). */}
              <button
                type="button"
                className="ib-btn ib-sm"
                disabled={busy || !!open}
                onClick={() => {
                  setMounted(true);
                  setOpen({ action: 'comment', chooseEvent: false });
                }}
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
                if (answer?.code === 'pull_moved') {
                  setOpen(null);
                  onMoved();
                }
              }
              return response;
            }}
            onClose={() => setOpen(null)}
            onPosted={(result) => {
              setOpen(null);
              // A follow-up comment after an approval still reads as the approval.
              const action = sameHead && result.action === 'comment' ? done!.action : result.action;
              const went = new Set(result.posted);
              setDone({ key: target.key, head: target.head_sha, action, ids: new Set([...(sameKey ? done!.ids : []), ...comments.filter((c) => went.has(c.id)).map(postedSignature)]) });
              onPosted({ ...result, action, label: rules.label });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
