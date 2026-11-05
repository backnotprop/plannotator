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
import type { PlatformAction, PlatformPostProps, PlatformPostPull } from './platform-post-types';

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
 */
function asSubmitted(comments: readonly CodeAnnotation[], pull: PlatformPostPull, anchor: PlatformPostProps['anchor']): CodeAnnotation[] {
  return comments.map((c) => ({
    ...c,
    prUrl: pull.url,
    prNumber: pull.number,
    prTitle: pull.title,
    prRepo: pull.repo,
    ...(anchor === 'stack' && (c.scope ?? 'line') !== 'general' ? { diffScope: 'full-stack' as const } : { diffScope: 'layer' as const }),
    ...(anchor === 'guide' && (c.scope ?? 'line') === 'line' ? { anchorSnapshot: 'guide' } : {}),
  }));
}

const OPEN_PR_KEY = 'plannotator-inbox-platform-open-pr';

export default function PlatformPost({ pull, open, comments, anchor, post, onClose, onPosted }: PlatformPostProps) {
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
  const submitted = useMemo(() => asSubmitted(comments, pull, anchor), [comments, pull, anchor]);
  const opened = useRef(false);
  // The head this plan's lines are on: it posts there, whatever the PR has moved to. A commit the Inbox no longer takes
  // is refused (`pull_moved`), with what the person wrote still in the dialog.
  const planHead = useRef(pull.head_sha);
  const refused = useRef(false);
  const planNow = () =>
    buildReviewSubmission(
      submitted,
      [],
      pull.url,
      new Set(submitted.map((c) => c.filePath)),
      { number: pull.number, title: pull.title, repo: pull.repo },
      anchor === 'guide' ? new Map([[pull.url, 'diff']]) : undefined,
      pull.platform,
      permalinkOf(pull),
    );
  useEffect(() => {
    if (!open) {
      opened.current = false;
      return;
    }
    // A plan kept from a partial or blocked attempt stays (its narrowed retry); otherwise built fresh.
    if (opened.current) return;
    opened.current = true;
    // Words typed for a review are no approval because its comments have gone (a new commit): they stay that review.
    setAction(open.action === 'approve' && general.trim() ? action : open.action);
    setChooseEvent(open.chooseEvent);
    const sameHead = planHead.current === pull.head_sha;
    planHead.current = pull.head_sha;
    refused.current = false;
    setPlan((was) => (sameHead && was.targets.some((t) => t.status === 'partial' || t.status === 'blocked') ? was : planNow()));
  }, [open, submitted, pull, anchor]);

  const send = async (pending: ReturnType<typeof openPendingTab> | null) => {
    // Refused, and the new commit is in: retrying that plan can never go, so this shows the new one to read and post.
    if (refused.current && planHead.current !== pull.head_sha) {
      closePendingTab(pending);
      refused.current = false;
      planHead.current = pull.head_sha;
      setPlan(planNow());
      return;
    }
    setSubmitting(true);
    try {
      let targets = plan.targets;
      // Approve goes to this PR alone; a comment with no line comments still posts its main comment (as the review app).
      if (action === 'approve' || (targets.length === 0 && general.trim())) {
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
        bodyForTarget: (target) => buildPlatformReviewBody(action, pull.platform, general, target),
        fetchReview: async (_url, init) => {
          const response = await post({ ...(JSON.parse(String(init.body)) as Record<string, unknown>), key: pull.key, head_sha: planHead.current });
          if (response.status === 409) {
            const answer = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
            if (answer?.code === 'pull_moved') refused.current = true;
          }
          return response;
        },
      });
      if (!attempt.allComplete) {
        closePendingTab(pending);
        setPlan((was) => ({ ...was, targets: attempt.targets }));
        return;
      }
      if (openPR) settlePendingTab(pending, attempt.openUrls.length > 0 ? attempt.openUrls : [pull.url], window as unknown as TabOpener);
      else closePendingTab(pending);
      // What went: every comment but the ones the dialog could only offer to copy (the whole stack's line comments).
      const kept = new Set(plan.orphans.flatMap((group) => group.annotations.map((a) => a.id)));
      const posted = comments.filter((c) => !kept.has(c.id)).map((c) => c.id);
      setPlan({ targets: [], orphans: [] });
      setGeneral('');
      onPosted({ action, url: pull.url, posted });
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
