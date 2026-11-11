import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AnnotationsList, type AnnotationsListProps, type CommentsListAt } from './AnnotationsChip';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { VoiceFoot } from './VoiceMic';
import { useVoiceSession } from '../voice';
import type { VoiceLate } from '../voiceSession';
import { AttachFilesButton, ComposeFileTiles, useFileDrop, type ComposeFile } from '../compose/ComposeFiles';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { useComposerState, type ComposerMode } from '../fullScreenComposer';
import { CORNERS, useComposerDrag } from '../composerDrag';
import { openItemsLabel } from '../openQuestions';
import { markFullScreenComposer } from '../pageMarks';
import { cardFootFitCandidates, drawOpenQuestionsForm, fitFootRow, footFitCandidates, openQuestionsFormText, type CardFootFit, type FootFit, type OpenQuestionsLabelForm } from '../footFit';

export interface FullScreenReply {
  to: string;
  value: string;
  onChange: (text: string) => void;
  errorActions?: ReactNode;
  onLateVoice: (outcome: VoiceLate) => void;
  onSend: () => void;
  sending: boolean;
  canSend: boolean;
  picks: number;
  annotations: number;
  comments: AnnotationsListProps & { list: CommentsListAt | null; onList: (next: CommentsListAt | null) => void };
  actions: number;
  files: readonly ComposeFile[];
  onFiles: (list: FileList) => void;
  onDropFiles: (list: FileList) => void;
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onRemoveFile: (key: string) => void;
  onPutBack: (key: string, field: HTMLTextAreaElement | null) => void;
  openQuestions: number;
  openActions: number;
  conflict: boolean;
  error: string | null;
  sentAt: number | null;
  onOpenThread: () => void;
  tags?: InboxComposerTags;
  skillFilter?: (entry: SkillCatalogEntry) => boolean;
}

export interface FullScreenComposerValue {
  threadId: string;
  phone: boolean;
  reply: FullScreenReply;
  tucked?: boolean;
  covered?: boolean;
  onGather?: () => void;
  fileKey?: string;
}

export const FullScreenComposerContext = createContext<FullScreenComposerValue | null>(null);

const CommentBinContext = createContext<ReactNode>(null);
export function FullScreenCommentBin() {
  return <>{useContext(CommentBinContext)}</>;
}

export const SENT_SHOWS_MS = 4000;

function useSentFlash(sentAt: number | null): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!sentAt) return;
    setOn(true);
    const timer = setTimeout(() => setOn(false), SENT_SHOWS_MS);
    return () => clearTimeout(timer);
  }, [sentAt]);
  return on;
}

const PILL_BAR_GAP = 4;

const Count = ({ n, word }: { n: number; word: string }) => (
  <span>
    {n}
    <span className="ib-fcomp-w">{` ${word}${n === 1 ? '' : 's'}`}</span>
  </span>
);

function Rides({ reply, phone, linkRef, onComments }: { reply: FullScreenReply; phone: boolean; linkRef: RefObject<HTMLButtonElement | null>; onComments: () => void }) {
  const chips = useRef<HTMLSpanElement>(null);
  const [form, setForm] = useState<OpenQuestionsLabelForm>('full');
  const n = reply.openQuestions;
  const a = reply.openActions;
  const label = openItemsLabel(n, a);
  const fit = useCallback(() => {
    const row = chips.current;
    const button = row?.querySelector<HTMLElement>('[data-fcomp-questions]');
    const foot = row?.closest<HTMLElement>('[data-fcomp-foot]');
    if (phone && row && foot) {
      const apply = (next: CardFootFit) => {
        foot.setAttribute('data-fit', next.fit);
        if (button) drawOpenQuestionsForm(button, next);
      };
      const fits = () => row.scrollWidth <= row.clientWidth + 1 && foot.scrollWidth <= foot.clientWidth + 1;
      const next = fitFootRow(row, cardFootFitCandidates(), apply, fits);
      if (next) setForm(next.form);
      return;
    }
    if (!row || !button) return;
    const apply = (next: FootFit) => drawOpenQuestionsForm(button, next);
    const fits = () => row.scrollWidth <= row.clientWidth + 1;
    const next = fitFootRow(row, footFitCandidates('full').filter((c) => !c.tight), apply, fits) ?? { form: 'full' as const, tight: false };
    apply(next);
    setForm(next.form);
  }, [phone]);
  useLayoutEffect(() => fit(), [fit, n, a, reply.picks, reply.actions, reply.annotations]);
  useLayoutEffect(() => {
    const foot = chips.current?.closest('[data-fcomp-foot]');
    return () => foot?.removeAttribute('data-fit');
  }, []);
  useEffect(() => {
    const row = chips.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(row);
    for (const chip of row.children) observer.observe(chip);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fit());
    return () => observer.disconnect();
  }, [fit, n, a, reply.picks, reply.actions, reply.annotations]);
  return (
    <span className="ib-fcomp-chips" ref={chips}>
      {reply.picks > 0 && (
        <span className="ib-fcomp-chip">
          <Icon name="check" size={12} />
          <Count n={reply.picks} word="pick" />
        </span>
      )}
      {reply.actions > 0 && (
        <span className="ib-fcomp-chip">
          <Icon name="check" size={12} />
          <Count n={reply.actions} word="action item" />
        </span>
      )}
      {reply.annotations > 0 && (
        <button
          ref={linkRef}
          type="button"
          className="ib-fcomp-chip"
          data-fcomp-comments=""
          data-comments-link=""
          aria-expanded={reply.comments.list !== null}
          aria-haspopup="dialog"
          onClick={onComments}
        >
          <Icon name="comment" size={12} />
          <Count n={reply.annotations} word="comment" />
        </button>
      )}
      {reply.openQuestions + reply.openActions > 0 && (
        <button
          type="button"
          className="ib-fcomp-q"
          onClick={reply.onOpenThread}
          data-fcomp-questions=""
          data-oq-n={n}
          data-oq-actions={a}
          data-oq-label={label}
          data-label-form={form}
          aria-label={form === 'full' ? undefined : label}
        >
          <Icon name="question" size={12} />
          <span data-oq-words="">{openQuestionsFormText(n, form, a)}</span>
        </button>
      )}
    </span>
  );
}

export function FullScreenComposer({
  value,
  noun,
  comment,
  foldedByDefault = false,
  onMinimized,
}: {
  value: FullScreenComposerValue;
  noun: 'image' | 'video' | 'recording' | 'page' | null;
  comment: ReactNode | null;
  foldedByDefault?: boolean;
  onMinimized?: () => void;
}) {
  const { reply, phone, threadId } = value;
  const takesComments = comment !== null;
  const hasDraft = reply.value.trim() !== '';
  const state = useComposerState(threadId, hasDraft, takesComments, foldedByDefault);
  const mode = state.mode;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const { attach: attachDrag, handle: dragHandle, resizable, narrow, corner } = useComposerDrag(!phone, value.fileKey);
  const cardRefMarked = useCallback((el: HTMLDivElement | null) => {
    cardRef.current = el;
    attachDrag(el);
    const release = markFullScreenComposer(el);
    return () => {
      cardRef.current = null;
      attachDrag(null);
      release?.();
    };
  }, [attachDrag]);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const commentsRef = useRef<HTMLButtonElement | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const voice = useVoiceSession(!value.covered && mode === 'reply' && !state.minimized, reply.onLateVoice);
  // The sheet hides the status and Stop, so no microphone stays open behind it. What was said still lands in the reply.
  const covered = value.covered === true;
  useEffect(() => {
    if (!covered) return;
    voice.session.stop();
    if (voice.session.view().phase !== 'sending') voice.session.covered();
  }, [covered, voice.session]);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const focusNext = useRef<'field' | 'pill' | null>(null);
  const sent = useSentFlash(reply.sentAt);
  const [pillAbove, setPillAbove] = useState(false);
  useLayoutEffect(() => {
    const pill = phone && state.minimized ? pillRef.current : null;
    const view = pill?.closest('.ib-fullview');
    const bar = view?.querySelector('[data-full-view-bar]');
    if (!pill || !view || !bar) {
      setPillAbove(false);
      return;
    }
    const tucked = value.tucked;
    const flying = (el: Element | null) => el?.getAnimations?.().some((animation) => animation.playState === 'running');
    const check = () => {
      // Gathered or in flight (Hide tools and back), both fly to the corner and are not where they land: the pill keeps
      // its place and is measured at `transitionend`, so it never jumps.
      if (tucked || flying(bar) || flying(pill.parentElement)) return;
      setPillAbove(pill.getBoundingClientRect().right + PILL_BAR_GAP > bar.getBoundingClientRect().left);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    for (const el of [pill, bar, view]) observer.observe(el);
    // The flight is a transform, which no ResizeObserver sees.
    view.addEventListener('transitionend', check);
    return () => {
      observer.disconnect();
      view.removeEventListener('transitionend', check);
    };
  });
  const drop = useFileDrop((list) => reply.onDropFiles(list), !state.minimized && mode === 'reply' && !value.tucked);
  const errorId = `ib-fcomp-err-${threadId}`;
  const [commentWords, setCommentWords] = useState(false);
  const readCommentWords = useCallback(() => {
    const field = cardRef.current?.querySelector<HTMLTextAreaElement>('[data-fcomp-comment-slot] textarea');
    setCommentWords(!!field && field.value.trim() !== '');
  }, []);
  useLayoutEffect(() => readCommentWords());

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === 'pill') pillRef.current?.focus({ preventScroll: true });
    else {
      const field = cardRef.current?.querySelector<HTMLTextAreaElement>('[data-fcomp-body] > :not([hidden]) textarea');
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  });

  useEffect(() => {
    if (replyRef.current) replyRef.current.readOnly = reply.sending;
  });

  const listAt = reply.comments.list;
  const listShown = listAt !== null && !state.minimized && mode === 'reply' && !value.tucked;
  useEffect(() => {
    if (listAt && !listShown) reply.comments.onList(null);
  });

  const nounText = noun === 'video' ? 'this video' : noun === 'recording' ? 'this recording' : noun === 'page' ? 'this page' : 'this image';
  const commentLabel = `Comment on ${nounText}`;
  const replyLabel = `Reply to ${reply.to}`;
  const label = mode === 'comment' ? commentLabel : replyLabel;

  /** The file's comment row stays drawn (hidden) on the Reply tab and while minimized, so typed words are never dropped and the pane can still read them as the file closes. */
  const keptComment = (shown: boolean, bin: ReactNode = null) =>
    takesComments ? (
      <div className="ib-fcomp-slot" hidden={!shown || undefined} data-fcomp-comment-slot="">
        <CommentBinContext.Provider value={bin}>{comment}</CommentBinContext.Provider>
      </div>
    ) : null;

  if (state.minimized) {
    const waiting = hasDraft || reply.files.length > 0;
    const pillText = waiting ? 'Reply draft' : label;
    return (
      <>
      {keptComment(false)}
      <div className={`ib-fcomp-pillwrap${phone ? ' ib-phone' : ''}`} data-fcomp-pill-above={pillAbove ? '' : undefined} data-fcomp-pillwrap="" inert={value.tucked || undefined} {...(phone ? {} : { 'data-file-foot': '' })}>
        <button
          type="button"
          ref={pillRef}
          className={`ib-fcomp-pill ib-mode-${waiting ? 'reply' : mode}`}
          onClick={() => {
            focusNext.current = 'field';
            state.setMinimized(false);
          }}
          aria-expanded={false}
          aria-label={`Show the composer: ${pillText}`}
          data-fcomp-pill=""
        >
          <Icon name={waiting || mode === 'reply' ? 'reply' : 'comment'} size={phone ? 18 : 13} />
          {(!phone || waiting) && <span className="ib-fcomp-pilll">{phone ? 'Draft' : pillText}</span>}
          {!phone && <Icon name="chevsU" size={12} />}
        </button>
      </div>
      </>
    );
  }

  const pick = (next: ComposerMode) => {
    if (next !== mode) state.setMode(next);
    focusNext.current = 'field';
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next: ComposerMode = mode === 'comment' ? 'reply' : 'comment';
    state.setMode(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`[data-fcomp-mode="${next}"]`)?.focus({ preventScroll: true }));
  };
  const flare = (side: 'l' | 'r') => (
    <svg className={`ib-fcomp-flare ib-fcomp-flare-${side}`} width="11" height="10" viewBox="0 0 11 10" aria-hidden="true">
      <path d="M11 0V10H0V9.5A10.5 9.5 0 0 0 10.5 0Z" />
    </svg>
  );
  const tab = (which: ComposerMode, icon: 'comment' | 'reply', text: string, words: boolean, short?: string) => {
    const on = mode === which;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={on}
        tabIndex={on ? 0 : -1}
        className={on ? 'ib-fcomp-tab ib-on' : 'ib-fcomp-tab'}
        onClick={() => pick(which)}
        onKeyDown={onTabKey}
        data-fcomp-mode={which}
        title={!on && words ? `${text} (has words)` : narrow && short ? text : undefined}
      >
        {on && flare('l')}
        {on && flare('r')}
        <Icon name={icon} size={phone ? 16 : 13} />
        <span className="ib-fcomp-tabl" data-short={short}>{text}</span>
        {!on && words && <span className="ib-fcomp-tabdot" aria-hidden="true" data-fcomp-tab-dot="" />}
        {!on && words && <span className="ib-sr">, has words</span>}
      </button>
    );
  };

  const showSent = sent && mode === 'reply' && !hasDraft;
  const clearComment = () => {
    const field = cardRef.current?.querySelector<HTMLTextAreaElement>('[data-fcomp-comment-slot] textarea');
    if (!field) return;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, '');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus({ preventScroll: true });
  };
  const binIcon = <Icon name="trash" size={phone ? 18 : 15} />;
  const send = (
    <button
      type="button"
      className="ib-btn ib-pri ib-fcomp-send"
      onClick={reply.onSend}
      disabled={reply.sending || !reply.canSend || voice.busy}
      aria-busy={reply.sending || undefined}
      aria-label={phone ? `Send to ${reply.to}` : undefined}
      data-fcomp-send=""
    >
      {reply.sending ? 'Sending…' : 'Send'}
    </button>
  );
  const foot =
    mode === 'reply' ? (
      <div className="ib-fcomp-foot" data-fcomp-foot="">
        {!phone && send}
        <AttachFilesButton
          className="ib-fvb ib-fcomp-clip"
          iconSize={phone ? 18 : 15}
          phone={phone}
          inputData="data-fcomp-attach"
          onFiles={reply.onFiles}
        />
        <VoiceFoot voice={voice} phone={phone} />
        {showSent ? (
          <span className="ib-fcomp-sent" data-fcomp-sent="">
            <Icon name="checkCircle" size={13} />
            <span className="ib-fcomp-sentl">Sent to {reply.to}</span>
          </span>
        ) : reply.conflict ? (
          <span className="ib-fcomp-note">This reply changed in another window.</span>
        ) : (
          <Rides
            reply={reply}
            phone={phone}
            linkRef={commentsRef}
            onComments={() => {
              setCardHeight(cardRef.current?.offsetHeight ?? 0);
              reply.comments.onList(listAt ? null : { at: null });
            }}
          />
        )}
        <button type="button" className="ib-fcomp-link" onClick={reply.onOpenThread} data-fcomp-open-thread="">
          <span className="ib-fcomp-lo">Open in </span>
          <span className="ib-fcomp-lt">thread</span>
        </button>
        <button
          type="button"
          className="ib-fvb ib-fcomp-bin"
          disabled={!hasDraft}
          onClick={() => {
            reply.onChange('');
            replyRef.current?.focus({ preventScroll: true });
          }}
          aria-label="Clear the reply’s words"
          title="Clear the reply’s words"
          data-fcomp-bin=""
        >
          {binIcon}
        </button>
        {phone && send}
      </div>
    ) : null;

  return (
    <>
    {listShown && (
      <div className="ib-annat ib-anncard" style={{ '--ib-fcomp-h': `${cardHeight}px` } as CSSProperties}>
        <div className="ib-annat-in">
          <AnnotationsList
            {...reply.comments}
            at={listAt.at}
            press={listAt.press}
            onClose={(back) => {
              reply.comments.onList(null);
              if (back) (commentsRef.current ?? (phone ? cardRef.current : replyRef.current))?.focus({ preventScroll: true });
            }}
          />
        </div>
      </div>
    )}
    <div
      ref={cardRefMarked}
      className={`ib-fcomp ib-mode-${mode}${phone ? ' ib-phone' : ''}`}
      role="group"
      aria-label={label}
      tabIndex={-1}
      inert={value.tucked || undefined}
      data-fcomp=""
      data-fcomp-mode-on={mode}
      data-file-foot=""
      data-drop-over={drop.over ? '' : undefined}
      onInput={readCommentWords}
      {...drop.handlers}
      onKeyDown={(event) => {
        if (mode !== 'reply' || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented || event.repeat || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
        if (!reply.canSend || reply.sending || voice.busy) return;
        event.preventDefault();
        event.stopPropagation();
        reply.onSend();
      }}
    >
      <div className="ib-fcomp-top" {...dragHandle}>
        {takesComments ? (
          <div className="ib-fcomp-tabs" role="radiogroup" aria-label="Write" ref={tabsRef}>
            {tab('comment', 'comment', phone ? 'Comment' : commentLabel, commentWords, phone ? undefined : 'Comment')}
            {tab('reply', 'reply', phone ? 'Reply' : replyLabel, hasDraft, phone ? undefined : 'Reply')}
          </div>
        ) : (
          <span className="ib-fcomp-solo">
            <Icon name="reply" size={12} />
            Reply to <b>{reply.to}</b>
          </span>
        )}
        <Tip content={value.onGather ? 'Hide tools' : 'Hide the composer'} side="top">
          <button
            type="button"
            className="ib-fvb ib-fcomp-min"
            onClick={() => {
              onMinimized?.();
              if (value.onGather) return value.onGather();
              focusNext.current = 'pill';
              state.setMinimized(true);
            }}
            aria-label={value.onGather ? 'Hide tools' : 'Hide the composer'}
            aria-expanded={value.onGather ? undefined : true}
            data-fcomp-minimize=""
          >
            <Icon name="chevD" size={phone ? 18 : 16} />
          </button>
        </Tip>
      </div>
      {mode === 'reply' && reply.files.length > 0 && (
        <div className="ib-rfiles ib-fcomp-files" data-fcomp-files="">
          <ComposeFileTiles
            files={reply.files}
            onRemove={(key) => {
              reply.onRemoveFile(key);
              replyRef.current?.focus({ preventScroll: true });
            }}
            onPutBack={(key) => reply.onPutBack(key, replyRef.current)}
          />
        </div>
      )}
      <div className="ib-fcomp-body" data-fcomp-body="">
        {keptComment(mode === 'comment', mode === 'comment' && (
          <span className="ib-fcomp-cend">
            <button
              type="button"
              className="ib-fvb ib-fcomp-bin"
              disabled={!commentWords}
              onClick={clearComment}
              aria-label="Discard this comment"
              title="Discard this comment"
              data-fcomp-bin=""
            >
              {binIcon}
            </button>
          </span>
        ))}
        {mode === 'reply' && (
          <div className="ib-fcomp-field" data-fcomp-field="" onPaste={reply.onPaste}>
            <InboxComposerField
              textareaRef={replyRef}
              voice={voice}
              ariaLabel={replyLabel}
              ariaDescribedBy={reply.error ? errorId : undefined}
              placeholder={`${replyLabel}…`}
              destination="your reply"
              tags={reply.tags}
              skillFilter={reply.skillFilter}
              value={reply.value}
              onChange={(text) => {
                state.setMode('reply');
                reply.onChange(text);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!voice.busy) reply.onSend();
                }
              }}
            />
          </div>
        )}
        {foot}
      </div>
      {mode === 'reply' && reply.error && (
        <p className="ib-fcomp-err" id={errorId} data-fcomp-error="">
          {reply.error}
          {reply.errorActions}
        </p>
      )}
      {resizable && CORNERS.map((which) => <span key={which} className="ib-fcomp-corner" aria-hidden="true" {...corner(which)} />)}
      {drop.over && (
        <div className="ib-rdrop ib-fcomp-drop" aria-hidden="true" data-fcomp-drop="">
          <Icon name="clip" size={18} />
          Drop to attach
        </div>
      )}
    </div>
    </>
  );
}
