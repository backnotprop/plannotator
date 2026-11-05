/**
 * Post to GitHub/GitLab from the Inbox (the owner's answer C on #2590: the person chooses at the end where a review
 * goes). This is the review app's PR-mode posting, reused whole: `buildReviewSubmission` (inline comments, file-level
 * comments on GitHub, the review body's file-scoped and "Comments outside the diff" sections), `buildPlatformReviewBody`,
 * `submitPlatformReviewTargets` (retry-safe target states, the partial result and its narrowed retry) and
 * `ReviewSubmissionDialog` (the same dialog, its Comment / Request changes choice, GitLab's missing request-changes,
 * the partial and blocked notices). Only the request goes elsewhere: to the Inbox's `POST /api/inbox/pulls/review`.
 *
 * Reached as `#platform-post` (package.json `imports`). It imports review-editor, which does not compile under the
 * window's strict settings, so it is checked with the guide reader (tsconfig.guide.json) and the window reads its
 * shape from platform-post-module.d.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';
import {
  buildPlatformReviewBody,
  buildReviewSubmission,
  ReviewSubmissionDialog,
  type ReviewSubmission,
  type SubmissionTarget,
} from '@plannotator/review-editor/components/ReviewSubmissionDialog';
import { submitPlatformReviewTargets } from '@plannotator/review-editor/utils/platformReviewSubmission';
import { closePendingTab, openPendingTab, settlePendingTab, type TabOpener } from '@plannotator/review-editor/utils/pendingExternalTab';
import { platformRules } from '../pulls/postRules';
import type { KeptComment, PlatformAction, PlatformPostProps, PlatformPostPull } from './platform-post-types';

/** A link to lines at the PR's head commit, for a comment the platform cannot take inline (review app `prBlobPermalink`). */
function permalinkOf(pull: PlatformPostPull) {
  return (path: string, start: number, end: number) => {
    const file = path.split('/').map(encodeURIComponent).join('/');
    return pull.platform === 'gitlab'
      ? `https://${pull.host}/${pull.repo}/-/blob/${pull.head_sha}/${file}#L${start}${end !== start ? `-${end}` : ''}`
      : `https://${pull.host}/${pull.repo}/blob/${pull.head_sha}/${file}#L${start}${end !== start ? `-L${end}` : ''}`;
  };
}

/**
 * The comments as the review app's builder takes them. `diff`: written on this PR's own diff at the commit posted to,
 * so each goes inline where the platform takes it. `guide`: written on an agent's guided review, whose diff the Inbox
 * cannot vouch is this PR's, so each line comment rides the review body with the code it was written on. `stack`: the
 * whole stack's diff, whose lines map to no single PR (the dialog offers them to copy, as the review app does). A
 * global comment is on no line, so on any diff it rides the review body (the review app's general comment).
 *
 * A comment read on another commit (`postAt`) is its own target, posted there, since a review names one commit. A commit
 * that has gone (`gone`): inline here if its lines still read the same, else in the body with its label.
 */
function asSubmitted(comments: readonly KeptComment[], pull: PlatformPostPull, anchor: PlatformPostProps['anchor'], gone: ReadonlySet<string>, head: string): CodeAnnotation[] {
  return comments.map((c) => {
    // Read on the commit this plan posts at: an ordinary comment of this review.
    const older = c.postAt && c.postAt !== head && !gone.has(c.postAt) ? c.postAt : null;
    return {
      ...c,
      prUrl: older ? `${pull.url}${AT}${older}` : pull.url,
      prNumber: pull.number,
      prTitle: older ? `read at ${older.slice(0, 7)}` : pull.title,
      // The row cuts at its end, so nothing long stands before the commit it names.
      prRepo: older ? '' : pull.repo,
      ...(c.postAt && gone.has(c.postAt) && !c.postHere ? { outdated: true } : {}),
      ...(anchor === 'stack' && (c.scope ?? 'line') !== 'general' ? { diffScope: 'full-stack' as const } : { diffScope: 'layer' as const }),
      ...(anchor === 'guide' && (c.scope ?? 'line') === 'line' ? { anchorSnapshot: 'guide' } : {}),
    };
  });
}

const OPEN_PR_KEY = 'plannotator-inbox-platform-open-pr';
/** Between a PR's URL and a commit, in a target of that commit. */
const AT = '#plannotator-at-';

export default function PlatformPost({ pull, open, comments, anchor, post, onClose, onPosted, onWent, hostReadsAgain }: PlatformPostProps) {
  const rules = platformRules(pull);
  const [action, setAction] = useState<PlatformAction>('comment');
  const [chooseEvent, setChooseEvent] = useState(false);
  const [plan, setPlan] = useState<ReviewSubmission>({ targets: [], orphans: [] });
  const [general, setGeneral] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [openPR, setOpenPR] = useState(() => {
    try {
      return window.localStorage.getItem(OPEN_PR_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const gone = useRef(new Set<string>());
  const opened = useRef(false);
  // The head this plan's lines are on: it posts there, whatever the PR has moved to. A commit that cannot take it
  // (`pull_moved`, `pull_commit_gone`) is refused, with what the person wrote still in the dialog.
  const planHead = useRef(pull.head_sha);
  const refused = useRef(false);
  // The comments this plan was built from, as they stood then: another window's, or a new head's view of these, wait for
  // the next plan.
  const planned = useRef<readonly KeptComment[]>([]);
  const carried = useRef<CodeAnnotation[]>([]);
  const planOf = (kept: readonly KeptComment[]) => {
    const submitted = asSubmitted(kept, pull, anchor, gone.current, planHead.current);
    planned.current = kept;
    carried.current = submitted;
    return buildReviewSubmission(
      submitted,
      [],
      pull.url,
      new Set(submitted.map((c) => c.filePath)),
      { number: pull.number, title: pull.title, repo: pull.repo },
      anchor === 'guide' ? new Map([[pull.url, 'diff']]) : undefined,
      pull.platform,
      permalinkOf(pull),
    );
  };
  useEffect(() => {
    if (!open) {
      opened.current = false;
      return;
    }
    // A plan kept from a partial or blocked attempt stays (its narrowed retry); otherwise built fresh.
    if (opened.current) return;
    opened.current = true;
    // Words typed for a refused review are no approval because its comments have gone (a new commit): they stay that
    // review. A host that closes the dialog and reads the PR again has put the decision back, and that is what was pressed.
    setAction(open.action === 'approve' && general.trim() && refused.current && !hostReadsAgain ? action : open.action);
    setChooseEvent(open.chooseEvent);
    const sameHead = planHead.current === pull.head_sha;
    planHead.current = pull.head_sha;
    refused.current = false;
    setPlan((was) => (sameHead && was.targets.some((t) => t.status === 'partial' || t.status === 'blocked') ? was : planOf(comments)));
  }, [open, comments, pull, anchor]);

  /** A comment went only if a target the forge took carried it; what the dialog could only offer to copy did not. */
  const wentIn = (targets: readonly SubmissionTarget[], orphans: ReviewSubmission['orphans']) => {
    const kept = new Set(orphans.flatMap((group) => group.annotations.map((a) => a.id)));
    return carried.current.filter((c) => !kept.has(c.id) && targets.some((t) => t.status === 'success' && t.prUrl === c.prUrl)).map((c) => c.id);
  };

  const send = async (pending: ReturnType<typeof openPendingTab> | null) => {
    // Refused, and the new commit is in: retrying that plan can never go, so this shows the new one to read and post.
    if (refused.current && planHead.current !== pull.head_sha) {
      closePendingTab(pending);
      refused.current = false;
      planHead.current = pull.head_sha;
      setPlan(planOf(comments));
      return;
    }
    setSubmitting(true);
    try {
      const review = (target: SubmissionTarget) => !target.prUrl.includes(AT);
      const fetchReview = async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        const at = typeof request.targetPrUrl === 'string' && request.targetPrUrl.includes(AT) ? request.targetPrUrl.slice(request.targetPrUrl.indexOf(AT) + AT.length) : null;
        const response = await post({ ...request, key: pull.key, head_sha: at ?? planHead.current });
        if (response.status === 409) {
          const answer = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
          // It went on an earlier try whose answer never came: nothing there holds up the rest.
          if (answer?.code === 'already_posted' && at) return Response.json({ ok: true, prUrl: pull.url, submission: { status: 'complete' } });
          if (answer?.code === 'pull_commit_gone' && at) gone.current.add(at);
          else if (answer?.code === 'pull_moved' || answer?.code === 'pull_commit_gone') refused.current = true;
        }
        return response;
      };
      // First what goes at an older commit: it is a comment there, whatever the verdict here says.
      const older = plan.targets.filter((target) => !review(target));
      let settled: SubmissionTarget[] = [];
      if (older.length > 0) {
        const earlier = await submitPlatformReviewTargets({ targets: older, action: 'comment', generalComment: '', bodyForTarget: (target) => buildPlatformReviewBody('comment', pull.platform, '', target), fetchReview });
        settled = earlier.targets;
        const ids = wentIn(settled, plan.orphans);
        if (ids.length > 0) onWent?.(ids);
        const stuck = settled.filter((t) => t.status !== 'success' && !gone.current.has(t.prUrl.slice(t.prUrl.indexOf(AT) + AT.length)));
        if (stuck.length > 0) {
          closePendingTab(pending);
          setPlan((was) => ({ ...was, targets: [...settled, ...was.targets.filter(review)] }));
          return;
        }
      }
      // A commit that has gone puts its comments in this review, so the review is built again with them.
      const fresh = settled.some((t) => t.status !== 'success');
      const rebuilt = fresh ? planOf(planned.current) : plan;
      let targets = rebuilt.targets.filter(review);
      // A verdict goes to this PR alone, whatever is left for it after an older commit; a comment with no line comments
      // still posts its main comment (as the review app).
      if (action !== 'comment' || (targets.length === 0 && general.trim())) {
        const current = targets.find((t) => t.prUrl === pull.url);
        const empty: SubmissionTarget = {
          prUrl: pull.url,
          prNumber: pull.number,
          prTitle: pull.title,
          prRepo: pull.repo,
          fileComments: [],
          fileLevelComments: [],
          fileScopedBody: '',
          fileCount: 0,
          annotationCount: 0,
          status: 'pending',
        };
        targets = [current ?? empty];
      }
      const attempt = await submitPlatformReviewTargets({
        targets,
        action,
        generalComment: general,
        // A verdict whose line comments all went at an older commit has no thread of its own and still needs a body.
        bodyForTarget: (target) => buildPlatformReviewBody(action, pull.platform, general, target.fileComments.length > 0 ? target : { ...target, fileComments: older.flatMap((t) => t.fileComments) }),
        fetchReview,
      });
      if (!attempt.allComplete) {
        closePendingTab(pending);
        setPlan({ ...rebuilt, targets: [...settled.filter((t) => t.status === 'success'), ...attempt.targets] });
        return;
      }
      if (openPR) settlePendingTab(pending, attempt.openUrls.length > 0 ? attempt.openUrls : [pull.url], window as unknown as TabOpener);
      else closePendingTab(pending);
      const posted = wentIn([...settled, ...attempt.targets], rebuilt.orphans);
      setPlan({ targets: [], orphans: [] });
      setGeneral('');
      onPosted({ action, url: pull.url, posted, head: planHead.current });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pn-inbox-platform-post" data-pull-platform-post={open ? action : undefined}>
      <ReviewSubmissionDialog
        isOpen={!!open}
        action={action}
        onActionChange={chooseEvent ? (next) => setAction(next) : undefined}
        requestChangesUnavailableReason={rules.requestChangesUnavailableReason}
        submission={plan}
        generalComment={general}
        onGeneralCommentChange={setGeneral}
        platformOpenPR={openPR}
        onPlatformOpenPRChange={(checked) => {
          setOpenPR(checked);
          try {
            window.localStorage.setItem(OPEN_PR_KEY, String(checked));
          } catch {
            // Storage off: the choice holds for this page.
          }
        }}
        onConfirm={() => {
          // The tab opens in the click itself (browsers allow it only then), as the review app does (#1583).
          const pending = openPR ? openPendingTab(window as unknown as TabOpener, rules.label) : null;
          void send(pending);
        }}
        onCancel={onClose}
        isSubmitting={submitting}
        recoveryPersistsRefresh={false}
        mrLabel={rules.mrLabel}
        platformLabel={rules.label}
      />
    </div>
  );
}
