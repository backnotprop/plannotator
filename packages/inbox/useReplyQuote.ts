import { useEffect, useRef, useState, type RefObject } from 'react';
import type { InboxMessageWire, InboxReplyQuote } from '@plannotator/core/inbox-types';
import { flashQuoteWords, REPLY_QUOTE_WORDS } from './replyQuote';
import type { useReplyDraft } from './replyDraft';

interface ReplyQuoteHost {
  threadId: string;
  messages: readonly InboxMessageWire[];
  replyDraft: Pick<ReturnType<typeof useReplyDraft>, 'draft' | 'quote'>;
  boxOpen: boolean;
  boxOpenNow: () => boolean;
  saveDraft: () => void;
  announce: (text: string) => void;
  textRef: RefObject<HTMLTextAreaElement | null>;
  bodyRef: RefObject<HTMLElement | null>;
  jumpToMessage: (messageId: string) => void;
}

export function useReplyQuote({ threadId, messages, replyDraft, boxOpen, boxOpenNow, saveDraft, announce, textRef, bodyRef, jumpToMessage }: ReplyQuoteHost) {
  const [quote, setQuoteState] = useState<InboxReplyQuote | null>(null);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const quoteChosen = useRef(false);
  const quotedMessage = quote ? messages.find((m) => m.id === quote.of) : undefined;
  const setQuote = (next: InboxReplyQuote | null) => {
    quoteChosen.current = true;
    setQuoteState(next);
    replyDraft.quote(next);
    saveDraft();
  };
  const draftQuote = replyDraft.draft?.quote ? JSON.stringify(replyDraft.draft.quote) : '';
  useEffect(() => {
    if (!draftQuote) return;
    if (boxOpenNow() && quoteChosen.current) return;
    const saved = JSON.parse(draftQuote) as InboxReplyQuote;
    setQuoteState(saved);
    replyDraft.quote(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftQuote]);
  useEffect(() => {
    setQuoteState(null);
    quoteChosen.current = false;
  }, [threadId]);
  useEffect(() => {
    if (boxOpen || replyDraft.draft) return;
    quoteChosen.current = false;
    if (quoteRef.current) {
      setQuoteState(null);
      replyDraft.quote(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxOpen]);
  const forgetQuote = () => {
    quoteChosen.current = false;
    setQuoteState(null);
    replyDraft.quote(null);
  };
  const removeQuote = () => {
    setQuote(null);
    announce(REPLY_QUOTE_WORDS.removed);
    textRef.current?.focus();
  };
  const jumpToQuote = (target: InboxReplyQuote) => {
    jumpToMessage(target.of);
    if (target.words === undefined) return;
    const words = target.words;
    setTimeout(() => {
      const article = bodyRef.current?.querySelector(`[data-message-article="${CSS.escape(target.of)}"] .ib-msg`);
      if (article) flashQuoteWords(article, words);
    }, 250);
  };
  const quoteWordsAtPress = useRef<{ id: string; words: string | null } | null>(null);
  return { quote, quoteRef, quotedMessage, setQuote, forgetQuote, removeQuote, jumpToQuote, quoteWordsAtPress };
}
