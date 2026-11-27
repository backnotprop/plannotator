import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { clearLateVoiceMiss, noteLateVoiceMiss } from '../lateVoice';
import { landWordsInReplyDraft, takeHeldVoiceWords } from '../replyDraft';
import { keepsReplyDraft } from '../machineDrafts';
/** Dictated words land in the thread's draft where it is kept (a linked machine's older Plannotator keeps none: they wait). */
const land = (threadId: string, words: string) => landWordsInReplyDraft(threadId, words, undefined, keepsReplyDraft);
import { spaced } from '../voiceField';
import type { VoiceLate } from '../voiceSession';

interface LateVoiceOptions {
  thread: InboxThread;
  threadRef: RefObject<InboxThread>;
  boxRef: RefObject<{ open: boolean; text: string }>;
  textRef: RefObject<HTMLTextAreaElement | null>;
  boxOpen: boolean;
  sending: boolean;
  changeReply: (text: string, behind?: boolean) => void;
}

/** A take that outlived its field (full screen's card, or the closed box): its words go to the reply of the thread it was taken in, else to that draft. */
export function useLateVoice({ thread, threadRef, boxRef, textRef, boxOpen, sending, changeReply }: LateVoiceOptions): (outcome: VoiceLate, takenIn?: string) => void {
  /** Words a take left in full screen's card brought back, waiting for the box (`changeReply` waits for a Send). */
  const lateVoice = useRef<string[]>([]);
  const [lateVoiceTick, setLateVoiceTick] = useState(0);
  const paneMounted = useRef(true);
  const onLateVoice = useCallback((outcome: VoiceLate, takenIn?: string) => {
    const threadId = takenIn ?? threadRef.current.thread_id;
    if ('failed' in outcome) {
      noteLateVoiceMiss(threadId, outcome.retry && (() => {
        clearLateVoiceMiss(threadId);
        outcome.retry?.();
      }));
    } else if (paneMounted.current && threadId === threadRef.current.thread_id) {
      lateVoice.current.push(outcome.text);
      setLateVoiceTick((tick) => tick + 1);
    } else void land(threadId, outcome.text);
  }, []);
  useEffect(() => {
    // While a Send is on its way the box takes no words: these wait for it to end.
    const waiting = boxRef.current.open && !sending ? [...lateVoice.current, ...takeHeldVoiceWords(thread.thread_id)] : lateVoice.current;
    if (waiting.length === 0 || sending) return;
    lateVoice.current = [];
    if (!boxRef.current.open) {
      // What this pane knows of the draft can be behind a save still on its way (Cancel's): the Inbox's copy decides.
      for (const words of waiting) void land(thread.thread_id, words);
      return;
    }
    let text = boxRef.current.text;
    for (const words of waiting) text += spaced(text.at(-1), undefined, words);
    // They go after the words, so someone typing keeps their place: the field holds them first, and React finds nothing to set.
    const field = textRef.current;
    if (field && document.activeElement === field) {
      const { selectionStart, selectionEnd } = field;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, text);
      field.setSelectionRange(selectionStart, selectionEnd);
    }
    changeReply(text, true);
    // changeReply reads this render's Send state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lateVoiceTick, sending, boxOpen]);
  useEffect(() => {
    paneMounted.current = true;
    return () => {
      paneMounted.current = false;
      for (const words of lateVoice.current) void land(threadRef.current.thread_id, words);
      lateVoice.current = [];
    };
  }, []);
  return onLateVoice;
}
