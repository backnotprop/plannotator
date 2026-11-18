/**
 * What a thread opened from Reviews says under its messages: "Curating the review…" while an agent writes the first
 * review, or, for a branch an agent reported ready (Branch reviews), what is needed to review it and the person's own
 * "Ask for a guided review". The ask is a reply in this thread, so the review comes back to the same thread. Nothing
 * runs until the person asks.
 */
import { useState } from 'react';
import { inboxApi } from '../api';
import { localReviewMessage } from '../compose/reviewBox';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { rankBranch } from './branchReviews';
import type { ReviewView } from './reviewsModel';

const newKey = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

export function ReviewViewNote({ view }: { view: ReviewView }) {
  if (view.curating) {
    return (
      <p className="ib-rvcurating" data-review-curating="">
        {view.curating}
      </p>
    );
  }
  return view.branch ? <BranchAsk note={view.branch} /> : null;
}

function BranchAsk({ note }: { note: NonNullable<ReviewView['branch']> }) {
  const [state, setState] = useState<{ asked: string | null; sending: boolean; error: string | null }>({ asked: null, sending: false, error: null });
  const [ranking, setRanking] = useState<'idle' | 'asking' | 'started' | 'not'>('idle');
  const { report, replyTo } = note;
  const asked = state.asked !== null && state.asked === replyTo;
  const rank = async () => {
    if (ranking === 'asking') return;
    setRanking('asking');
    try {
      setRanking((await rankBranch(report.thread_id)).started ? 'started' : 'not');
    } catch {
      setRanking('not');
    }
  };
  const ask = async () => {
    if (!replyTo || state.sending) return;
    setState({ asked: null, sending: true, error: null });
    try {
      const words = localReviewMessage({ changes: 'branch', project: note.projectName, branch: report.branch, base: report.base, words: '' });
      const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE);
      await inboxApi.reply(replyTo, { idempotency_key: newKey(), words: withSkillsBlock(words, skills), questions: [] });
      setState({ asked: replyTo, sending: false, error: null });
    } catch (cause) {
      setState({ asked: null, sending: false, error: cause instanceof Error ? cause.message : 'The request could not be sent.' });
    }
  };
  return (
    <div className="ib-rvbranch" data-review-branch={report.place} data-review-branch-machine={report.machine?.id}>
      {note.reach && (
        <p className="ib-rvbranch-reach" data-review-branch-reach="">
          {note.reach}
        </p>
      )}
      {note.canAsk && !asked && (
        <button type="button" className="ib-btn ib-pri" onClick={() => void ask()} disabled={state.sending || !replyTo} data-review-branch-ask="">
          {state.sending ? 'Asking…' : 'Ask for a guided review'}
        </button>
      )}
      {note.canRank && ranking !== 'started' && (
        <p className="ib-rvbranch-reach" data-review-branch-rank="">
          Not ranked at this commit.{' '}
          <button type="button" className="ib-btn" onClick={() => void rank()} disabled={ranking === 'asking'} data-review-branch-rank-button="">
            {ranking === 'asking' ? 'Ranking…' : 'Rank'}
          </button>
          {ranking === 'not' && ' It could not start. Check the risk agent in Set risk rules.'}
        </p>
      )}
      {ranking === 'started' && (
        <p className="ib-rvbranch-reach" role="status" data-review-branch-ranking="">
          Ranking. Its level shows on the row when it is in.
        </p>
      )}
      {asked && (
        <p className="ib-rvbranch-asked" role="status" data-review-branch-asked="">
          Asked for a guided review. It comes back in this thread.
        </p>
      )}
      {state.error && (
        <p className="ib-error" role="alert" data-review-branch-error="">
          {state.error}
        </p>
      )}
    </div>
  );
}
