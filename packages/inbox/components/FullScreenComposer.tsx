/**
 * The full-screen composer (approval "inbox-fullscreen-composer", 2A, round 4;
 * record in `.product/approved/inbox-fullscreen-composer/`, not in this repo).
 * One card floats at the bottom centre of a file in full screen (an image, a
 * film, an HTML page), so the person can comment on the file or answer the
 * agent without leaving it.
 *
 * - Two tabs on the card's top edge (a radio group): "Comment on this image"
 *   (the file's own comment row, drawn as is) and "Reply to <agent>" (the
 *   thread's reply). HTML is Reply only: its comments go on the page, with the
 *   pen. On a phone a pin or a selection gives it the Comment tab until the
 *   comment is saved or dropped (HtmlPageComment.tsx).
 * - The reply is the thread's reply draft, not a copy: the field shows the
 *   thread's words, every keystroke goes through the reply box's own change
 *   (Thread.tsx `changeReply`), and Send is the thread's Send, with its rules
 *   and refusals, kept in full screen.
 * - Minimize (the double chevron at the card's top right) is the toolbar's »:
 *   the card, the toolbar and everything else that floats gather into one
 *   corner control (`onGather`; `tucked`: inert, flown into the corner in
 *   inbox.css). The corner control says "Draft" while a draft waits; one press
 *   brings everything back with focus in the card's field.
 * - On a phone the pill sits left of the toolbar when both fit on the row, else above it (`pillAbove`).
 * - The pill (30 px, "Reply draft" while a draft waits, else the tab's label)
 *   is left for a card folded by default (an HTML page on a phone opens clear)
 *   and for a host that gives no `onGather`. The pill gives the card back and
 *   focus goes to its field. Kept per thread (fullScreenComposer.ts).
 * - No dots, no "Draft saved" line: the words say what waits.
 * - Files: the Reply tab's toolbar starts with the reply box's paperclip, and a
 *   paste or a drop on the card attaches as in the box. They are the box's
 *   files (one reply), shown here with the box's tiles.
 *
 * - On a phone the toolbar is one row: what yields when it runs short is `cardFootFitCandidates` (footFit.ts).
 * - "N comments" opens the thread's list of comments (AnnotationsChip.tsx). The list is the card's sibling, never
 *   its child: the card's backdrop filter would hold a phone's sheet, a fixed box, inside the card.
 *
 * The card is the file's foot (`data-file-foot`, AttachmentPane measures it):
 * the toolbar on a phone, the chip and the notes sit above it. A phone's pill
 * shares the toolbar's row instead (left of it), so it is no foot.
 */
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { createContext, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { AnnotationsList, type AnnotationsListProps, type CommentsListAt } from './AnnotationsChip';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { VoiceFoot } from './VoiceMic';
import { useVoiceSession } from '../voice';
import type { VoiceLate } from '../voiceSession';
import { AttachFilesButton, ComposeFileTiles, useFileDrop, type ComposeFile } from '../compose/ComposeFiles';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { useComposerState, type ComposerMode } from '../fullScreenComposer';
import { openItemsLabel } from '../openQuestions';
import { cardFootFitCandidates, drawOpenQuestionsForm, fitFootRow, footFitCandidates, openQuestionsFormText, type CardFootFit, type FootFit, type OpenQuestionsLabelForm } from '../footFit';

/** The thread's reply, as the composer's Reply tab shows and sends it (Thread.tsx builds it). */
export interface FullScreenReply {
  /** Who the reply goes to ("Claude Code", or the agent the thread was handed to). */
  to: string;
  /** The thread's reply words: the open reply box's, else the kept draft's. */
  value: string;
  /** The reply box's own change: the box takes the words and the draft saves them. */
  onChange: (text: string) => void;
  /** A take this card's field left behind while it was being transcribed: the thread's reply takes the words. Can run after the card has gone. */
  onLateVoice: (threadId: string, outcome: VoiceLate) => void;
  /** The thread's Send, kept in full screen. */
  onSend: () => void;
  sending: boolean;
  /** Something would go with a Send (words, picks, comments, files, action items): Send is not dimmed. */
  canSend: boolean;
  /** What rides the Send besides the words. */
  picks: number;
  annotations: number;
  /** The thread's list of comments, and whether it is open. */
  comments: AnnotationsListProps & { list: CommentsListAt | null; onList: (next: CommentsListAt | null) => void };
  actions: number;
  /** The reply box's files (pasted, dropped, picked), shown in the card as the box shows them. */
  files: readonly ComposeFile[];
  /** The paperclip's files: the reply box's own attach (a phone names them as a paste). */
  onFiles: (list: FileList) => void;
  /** Files dropped on the card: as a drop on the reply box. */
  onDropFiles: (list: FileList) => void;
  /** A paste in the reply field: files in it attach, as in the reply box (text pastes as text). */
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  /** A file tile's ×. */
  onRemoveFile: (key: string) => void;
  /** A pasted text tile's Undo or Put back: its words back in the reply, the caret after them in `field` (the card's). */
  onPutBack: (key: string, field: HTMLTextAreaElement | null) => void;
  /** Questions in the thread still open (no pick). */
  openQuestions: number;
  /**
   * Action items in the thread still open (not marked). Named with the questions in the thread foot's words
   * (`openItemsLabel`); the counts differ from the foot's in one way: the questions here are those with no pick,
   * where the foot also counts picked questions not sent yet.
   */
  openActions: number;
  /** Another window changed the draft while this one held words (the thread's box offers Keep mine / Discard). */
  conflict: boolean;
  /** The thread's error after a refused Send (the thread's own line announces it). */
  error: string | null;
  /** When a Send from here last went (the card says so for a moment). */
  sentAt: number | null;
  /** The thread's reply box, on the device's own route back to the thread. */
  onOpenThread: () => void;
  tags?: InboxComposerTags;
  /** The thread's skill rule (skills.ts `inboxSkillFilter`), as the reply box's. */
  skillFilter?: (entry: SkillCatalogEntry) => boolean;
}

export interface FullScreenComposerValue {
  threadId: string;
  phone: boolean;
  reply: FullScreenReply;
  /** The tools are gathered into the corner control: the card and the pill went with them (inert). Set by the pane. */
  tucked?: boolean;
  /** A phone's comments sheet is over the file: the card and the pill are hidden under it. Set by the pane. */
  covered?: boolean;
  /** The card's ⌄: gather every floating tool into the corner control, as » does. Set by the pane. */
  onGather?: () => void;
}

/** Given by the pane in full screen (image, film and HTML only): the views draw the composer from it. */
export const FullScreenComposerContext = createContext<FullScreenComposerValue | null>(null);

/** How long "Sent to …" shows after a Send from the card. */
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

/** The least room between a phone's pill and the toolbar on one row. */
const PILL_BAR_GAP = 4;

/** "2 comments", one flex item. Short of room, a phone keeps the number (`.ib-fcomp-w` goes visually hidden, so the name stays whole). */
const Count = ({ n, word }: { n: number; word: string }) => (
  <span>
    {n}
    <span className="ib-fcomp-w">{` ${word}${n === 1 ? '' : 's'}`}</span>
  </span>
);

/** The chips of what rides the Send, and the open questions (a way to them, in the thread). */
function Rides({ reply, phone, linkRef, onComments }: { reply: FullScreenReply; phone: boolean; linkRef: RefObject<HTMLButtonElement | null>; onComments: () => void }) {
  const chips = useRef<HTMLSpanElement>(null);
  const [form, setForm] = useState<OpenQuestionsLabelForm>('full');
  const n = reply.openQuestions;
  const a = reply.openActions;
  const label = openItemsLabel(n, a);
  // The thread foot's own fit (footFit.ts), on this row: the longest words ("2 open questions"), then "2 open", then
  // "2", that keep the chips on one line and inside the row. Tried on the page before paint.
  // A phone's whole foot has one row to share, so its fit goes further (`cardFootFitCandidates`, footFit.ts).
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
      // Null: the row is not laid out (dictating, it steps aside). The fit stays until it is back.
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
  // The foot outlives this row ("Sent to …" takes its place for a moment): the fit goes with the chips.
  useLayoutEffect(() => {
    const foot = chips.current?.closest('[data-fcomp-foot]');
    return () => foot?.removeAttribute('data-fit');
  }, []);
  useEffect(() => {
    const row = chips.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(row);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fit());
    return () => observer.disconnect();
  }, [fit]);
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
      {/* The thread foot's words (openItemsLabel): "2 open questions", "1 open action item", "2 questions, 1 action item".
          Its question count leaves out picked questions, which the foot counts until they are sent. */}
      {reply.openQuestions + reply.openActions > 0 && (
        <button
          type="button"
          className="ib-fcomp-q"
          onClick={reply.onOpenThread}
          data-fcomp-questions=""
          // What footFit.ts draws each form from; a shorter form keeps the whole count as its name.
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
  /** What a comment is on ("this image", "this video", "this page"). */
  noun: 'image' | 'video' | 'page' | null;
  /** The file's own comment row (its field, Mark up, Comment), drawn as is in the Comment tab. Null: Reply only. */
  comment: ReactNode | null;
  /** The card starts as its pill until the person opens it (an HTML page on a phone). */
  foldedByDefault?: boolean;
  /** The person minimized the card (a comment with no words yet drops its draft). */
  onMinimized?: () => void;
}) {
  const { reply, phone, threadId } = value;
  const takesComments = comment !== null;
  const hasDraft = reply.value.trim() !== '';
  const state = useComposerState(threadId, hasDraft, takesComments, foldedByDefault);
  const mode = state.mode;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const commentsRef = useRef<HTMLButtonElement | null>(null);
  /** The card's height when the list opened: the list sits just above the card. */
  const [cardHeight, setCardHeight] = useState(0);
  const voice = useVoiceSession(!value.covered && mode === 'reply' && !state.minimized, (outcome) => reply.onLateVoice(threadId, outcome));
  // The sheet hides the status and Stop, so no microphone stays open behind it. What was said still lands in the reply.
  const covered = value.covered === true;
  useEffect(() => {
    if (!covered) return;
    voice.session.stop();
    if (voice.session.view().phase !== 'sending') voice.session.covered();
  }, [covered, voice.session]);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  /** Where focus goes once the next state is drawn: the card's field (restored, a tab picked) or the pill (minimized). */
  const focusNext = useRef<'field' | 'pill' | null>(null);
  const sent = useSentFlash(reply.sentAt);
  /** A phone's pill shares the toolbar's row until they would touch (a narrow phone, "Draft", 75/78): then it sits above. */
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
  // Files dropped on the card attach to the reply, as on the reply box (a comment takes no files: Reply only).
  const drop = useFileDrop((list) => reply.onDropFiles(list), !state.minimized && mode === 'reply' && !value.tucked);
  const errorId = `ib-fcomp-err-${threadId}`;

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === 'pill') pillRef.current?.focus({ preventScroll: true });
    else {
      const field = cardRef.current?.querySelector<HTMLTextAreaElement>('.ib-fcomp-row > :not([hidden]) textarea');
      if (!field) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  });

  // Read-only while a Send is on its way, as the thread's box is: the words it carries are the words shown.
  useEffect(() => {
    if (replyRef.current) replyRef.current.readOnly = reply.sending;
  });

  // The list goes with the card's Reply tab: it opens from there, and the card can leave without a press outside.
  const listAt = reply.comments.list;
  const listShown = listAt !== null && !state.minimized && mode === 'reply' && !value.tucked;
  useEffect(() => {
    if (listAt && !listShown) reply.comments.onList(null);
  });

  const nounText = noun === 'video' ? 'this video' : noun === 'page' ? 'this page' : 'this image';
  const commentLabel = `Comment on ${nounText}`;
  const replyLabel = `Reply to ${reply.to}`;
  const label = mode === 'comment' ? commentLabel : replyLabel;

  /**
   * The file's comment row stays drawn (hidden) on the Reply tab and while minimized: words typed in it are
   * never dropped, and the pane's unsaved-comment question (`unsavedComposer`) still finds them before a
   * step or a close (its Keep writing brings the Comment tab back: `revealComposerComment`).
   */
  const keptComment = (shown: boolean) =>
    takesComments ? (
      <div className="ib-fcomp-slot" hidden={!shown || undefined} data-fcomp-comment-slot="">
        {comment}
      </div>
    ) : null;

  if (state.minimized) {
    // Words or files wait in the reply: the pill says so (a phone's, "Draft").
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
          {/* A phone names only a waiting draft: the toolbar takes the rest of the row. */}
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
  // The tabs are one radio group: arrows move the pick (and focus with it), Tab leaves the group.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next: ComposerMode = mode === 'comment' ? 'reply' : 'comment';
    state.setMode(next);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>(`[data-fcomp-mode="${next}"]`)?.focus({ preventScroll: true }));
  };
  const tab = (which: ComposerMode, icon: 'comment' | 'reply', text: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === which}
      tabIndex={mode === which ? 0 : -1}
      className={mode === which ? 'ib-on' : undefined}
      onClick={() => pick(which)}
      onKeyDown={onTabKey}
      data-fcomp-mode={which}
    >
      <Icon name={icon} size={12} />
      {text}
    </button>
  );

  const showSent = sent && mode === 'reply' && !hasDraft;
  // The reply's toolbar, as the reply box's: the paperclip first, then what rides the Send, Open in thread at the end.
  const foot =
    mode === 'reply' ? (
      <div className="ib-fcomp-foot" data-fcomp-foot="">
        <AttachFilesButton
          className="ib-fvb ib-fcomp-clip"
          iconSize={phone ? 18 : 15}
          phone={phone}
          inputData="data-fcomp-attach"
          onFiles={reply.onFiles}
        />
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
        <VoiceFoot voice={voice} phone={phone} />
        <button type="button" className="ib-fcomp-link" onClick={reply.onOpenThread} data-fcomp-open-thread="">
          <span className="ib-fcomp-lo">Open in </span>
          <span className="ib-fcomp-lt">thread</span>
        </button>
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
              // With no comment left there is no count. The card, on a phone: the reply field would raise the keyboard.
              if (back) (commentsRef.current ?? (phone ? cardRef.current : replyRef.current))?.focus({ preventScroll: true });
            }}
          />
        </div>
      </div>
    )}
    <div
      ref={cardRef}
      className={`ib-fcomp ib-mode-${mode}${phone ? ' ib-phone' : ''}`}
      role="group"
      aria-label={label}
      tabIndex={-1}
      inert={value.tucked || undefined}
      data-fcomp=""
      data-fcomp-mode-on={mode}
      data-file-foot=""
      data-drop-over={drop.over ? '' : undefined}
      {...drop.handlers}
      onKeyDown={(event) => {
        // Mod+Enter sends the reply from anywhere in the card (the tabs, the buttons, the tags), as it does from the
        // reply field, whose own handler has stopped it by now. Never from the comment tab (its Enter is the file's).
        if (mode !== 'reply' || event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.defaultPrevented || event.repeat || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
        if (!reply.canSend || reply.sending || voice.busy) return;
        event.preventDefault();
        event.stopPropagation();
        reply.onSend();
      }}
    >
      <div className="ib-fcomp-top">
        {takesComments ? (
          <div className="ib-fcomp-tabs" role="radiogroup" aria-label="Write" ref={tabsRef}>
            {tab('comment', 'comment', phone ? 'Comment' : commentLabel)}
            {tab('reply', 'reply', phone ? 'Reply' : replyLabel)}
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
              // The same gather as the toolbar's »: everything goes into the corner control, and comes back with it.
              if (value.onGather) return value.onGather();
              focusNext.current = 'pill';
              state.setMinimized(true);
            }}
            aria-label={value.onGather ? 'Hide tools' : 'Hide the composer'}
            aria-expanded={value.onGather ? undefined : true}
            data-fcomp-minimize=""
          >
            <Icon name="chevsD" size={phone ? 18 : 15} />
          </button>
        </Tip>
      </div>
      <div className="ib-fcomp-row">
        {keptComment(mode === 'comment')}
        {mode === 'comment' ? null : (
          <>
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
                  // Writing here keeps the card on Reply for the thread (a draft emptied never flips it back).
                  state.setMode('reply');
                  reply.onChange(text);
                }}
                onKeyDown={(event) => {
                  // The reply box's own Send key. Escape is left to full screen's ladder: focus leaves the field, the words stay.
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!voice.busy) reply.onSend();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="ib-btn ib-pri ib-fcomp-send"
              onClick={reply.onSend}
              disabled={reply.sending || !reply.canSend || voice.busy}
              aria-busy={reply.sending || undefined}
              aria-label={phone ? `Send to ${reply.to}` : undefined}
              data-fcomp-send=""
            >
              <Icon name="send" size={phone ? 17 : 13} />
              {!phone && <span>{reply.sending ? 'Sending…' : 'Send'}</span>}
            </button>
          </>
        )}
      </div>
      {mode === 'reply' && reply.error && (
        // The thread's own error line (role="alert") says it; here it is shown where the person is looking.
        <p className="ib-fcomp-err" id={errorId} data-fcomp-error="">
          {reply.error}
        </p>
      )}
      {mode === 'reply' && reply.files.length > 0 && (
        <div className="ib-rfiles ib-fcomp-files" data-fcomp-files="">
          <ComposeFileTiles
            files={reply.files}
            onRemove={(key) => {
              reply.onRemoveFile(key);
              // The × goes with its tile: focus stays in the reply, as in the reply box.
              replyRef.current?.focus({ preventScroll: true });
            }}
            onPutBack={(key) => reply.onPutBack(key, replyRef.current)}
          />
        </div>
      )}
      {foot}
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
