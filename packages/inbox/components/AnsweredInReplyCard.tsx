import { useId, useState } from 'react';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import type { InboxAuthor, InboxQuestion } from '@plannotator/core/inbox-types';
import { agentName, whenTime } from '../format';
import type { JumpTarget } from './ReplacedQuestion';

const FOOT_BUTTON = 'whitespace-nowrap rounded-[5px] px-[7px] py-[3px] text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-60 pointer-coarse:min-h-11';

export function AnsweredInReplyCard({
  question,
  number,
  total,
  by,
  readOnly,
  onJump,
  onReopen,
  refRepo,
}: {
  question: InboxQuestion;
  number: number;
  total: number;
  by: InboxAuthor | null;
  readOnly: boolean;
  onJump: (target: JumpTarget) => void;
  onReopen: () => Promise<unknown>;
  refRepo?: { display: string; host?: string } | null;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const taken = question.answered_in_reply!;
  const reopen = () => {
    setBusy(true);
    setFailed(false);
    onReopen().catch(() => {
      setBusy(false);
      setFailed(true);
    });
  };
  return (
    <fieldset
      className="question-block relative my-5 min-w-0 rounded-[10px] border border-primary/45 bg-[color-mix(in_oklab,var(--background)_35%,var(--card))] px-3.5 pb-2.5 pt-3"
      tabIndex={-1}
      aria-labelledby={`${id}-p`}
      data-question-state="answered_in_reply"
      data-question-key={question.key}
      data-message-id={question.message_id}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Question {number} of {total}
        </span>
        <span className="ml-auto inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded border border-transparent bg-success/15 px-1.5 text-[10.5px] font-semibold leading-4 tracking-[0.03em] text-success" data-question-tag="ok">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Answered
        </span>
      </div>
      <p id={`${id}-p`} className="m-0 text-[15px] font-semibold leading-[1.45] text-foreground">
        <InlineMarkdown text={question.prompt} githubRepo={refRepo?.display} repoHost={refRepo?.host} />
      </p>
      <blockquote className="mx-0 mb-0 mt-2.5 rounded-[7px] bg-primary/12 px-[9px] py-1.5 text-[13.5px] leading-[1.45] text-foreground" data-answered-quote="">
        <span className="font-[550] [overflow-wrap:anywhere]">“{taken.quote}”</span>
        <button type="button" className="mt-0.5 block text-left text-[12.5px] text-muted-foreground hover:text-foreground hover:underline" onClick={() => onJump({ kind: 'message', messageId: taken.reply_id })}>
          Your words, from your reply ↓
        </button>
      </blockquote>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 border-t border-border/55 pt-1.5">
        <span className="ib-qfoot-st" data-answered-by="">
          {by ? agentName(by) : 'The agent'} took this from your reply · {whenTime(taken.at)}
        </span>
        {failed && (
          <span className="ib-qfoot-st text-destructive" role="alert" data-answered-reopen-failed="">
            Couldn't reopen it. Try again.
          </span>
        )}
        {!readOnly && (
          <button type="button" className={FOOT_BUTTON} disabled={busy} onClick={reopen} data-answered-reopen="">
            Reopen
          </button>
        )}
      </div>
    </fieldset>
  );
}
