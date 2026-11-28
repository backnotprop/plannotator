/**
 * What a thread opened from Reviews says under its messages: "Curating the review…" while an agent writes the first
 * review, or, for a branch an agent reported ready (Branch reviews), what is needed to review it and the person's own
 * "Ask for a guided review". The ask is a reply in this thread, so the review comes back to the same thread. Nothing
 * runs until the person asks.
 */
import { useRef, useState } from 'react';
import { inboxApi } from '../api';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { branchAskWords, rankBranch } from './branchReviews';
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
  // Asked for this report (its thread and time), not for the message it replied to: the ask itself becomes the
  // thread's last message. A new report (a new head) can be asked for again. The thread says so after a reopen.
  const reportKey = `${report.thread_id}@${report.at}`;
  const asked = note.asked === true || state.asked === reportKey;
  // A second press before the first one's render (a double click) sends nothing.
  const sendingRef = useRef(false);
  // One idempotency key per report until a send succeeds: a retry after a send that reached the Inbox but failed on
  // the way back is the same request, never a second ask.
  const keyRef = useRef<{ report: string; key: string } | null>(null);
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
    if (!replyTo || asked || sendingRef.current) return;
    sendingRef.current = true;
    setState({ asked: null, sending: true, error: null });
    try {
      const words = branchAskWords(report, note.projectName);
      const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE);
      if (keyRef.current?.report !== reportKey) keyRef.current = { report: reportKey, key: newKey() };
      await inboxApi.reply(replyTo, { idempotency_key: keyRef.current.key, words: withSkillsBlock(words, skills), questions: [] });
      keyRef.current = null;
      setState({ asked: reportKey, sending: false, error: null });
    } catch (cause) {
      setState({ asked: null, sending: false, error: cause instanceof Error ? cause.message : 'The request could not be sent.' });
    } finally {
      sendingRef.current = false;
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
