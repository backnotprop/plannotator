/**
 * Reply with a quote (approval "inbox-reply-quote"; replyQuote.ts): the quiet line naming the message a reply
 * answers. In the reply box (`ReplyQuoteLine`), above the words: ↩, the author's mark, "Claude Code · 10:04 AM", up
 * to two muted lines of the message (or the selected words, in quotes), and ×. A phone shows one line, the mark and
 * the words. On the sent reply (`SentQuoteLine`): the same line on one row, a button that goes to the original.
 * No bar, no well, no outline: muted text on the surface it sits on.
 */

import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { agentName, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { quoteLineText, REPLY_QUOTE_WORDS } from '../replyQuote';
import { Tip } from './Tip';

function whoOf(message: InboxMessageWire): string {
  return message.author.kind === 'agent' ? agentName(message.author) : 'You';
}

/** An agent's mark at text size. The person's own mark is the reply arrow, which the line already starts with: none. */
function QuoteMark({ message }: { message: InboxMessageWire }) {
  return message.author.kind === 'agent' ? <AuthorMark author={message.author} /> : null;
}

/** The reply box's quote line, with its ×. */
export function ReplyQuoteLine({ message, words, phone, onRemove }: { message: InboxMessageWire; words?: string; phone: boolean; onRemove: () => void }) {
  const who = whoOf(message);
  const time = whenTime(message.created_at);
  const text = quoteLineText(message, words);
  return (
    <div className="ib-rquote" role="group" aria-label={REPLY_QUOTE_WORDS.label(who, time, words !== undefined)} data-reply-quote={message.id} data-quote-words={words !== undefined ? '' : undefined}>
      <Icon name="reply" size={14} className="ib-rquote-ic" />
      <div className="ib-rquote-t" dir="auto">
        {phone ? (
          <span className="ib-rquote-one">
            <QuoteMark message={message} />
            <span className="ib-rquote-w">{text}</span>
          </span>
        ) : (
          <span className="ib-rquote-clip">
            <span className="ib-rquote-src">
              <QuoteMark message={message} />
              <span className="ib-rquote-nm">{who}</span>
              <span className="ib-rquote-tm">· {time}</span>
            </span>{' '}
            {text}
          </span>
        )}
      </div>
      <Tip content={REPLY_QUOTE_WORDS.remove}>
        <button type="button" className="ib-rquote-x" aria-label={REPLY_QUOTE_WORDS.remove} onClick={onRemove} data-reply-quote-remove="">
          <Icon name="x" size={phone ? 16 : 14} />
        </button>
      </Tip>
    </div>
  );
}

/** A sent reply's quote line: the original's mark, name, time and words; a press goes to it. Null when the original is not in the thread. */
export function SentQuoteLine({ message, words, phone, onJump }: { message: InboxMessageWire | undefined; words?: string; phone: boolean; onJump: () => void }) {
  if (!message) return null;
  const who = whoOf(message);
  const time = whenTime(message.created_at);
  const text = quoteLineText(message, words);
  return (
    <Tip content={REPLY_QUOTE_WORDS.goTo}>
      <button type="button" className="ib-squote" onClick={onJump} aria-label={`${REPLY_QUOTE_WORDS.label(who, time, words !== undefined)}. ${REPLY_QUOTE_WORDS.goTo}`} data-sent-quote={message.id}>
        <Icon name="reply" size={14} className="ib-rquote-ic" />
        <QuoteMark message={message} />
        {!phone && (
          <span className="ib-squote-src">
            <span className="ib-squote-nm">{who}</span>
            <span className="ib-rquote-tm">· {time}</span>
          </span>
        )}
        <span className="ib-squote-w" dir="auto">
          {text}
        </span>
      </button>
    </Tip>
  );
}
