/**
 * The full-screen composer (approval "inbox-fullscreen-composer", 2A, round 4;
 * record in `.product/approved/inbox-fullscreen-composer/`, not in this repo).
 * One card floats at the bottom centre of a file in full screen (an image, a
 * film, an HTML page), so the person can comment on the file or answer the
 * agent without leaving it.
 *
 * - Two tabs on the card's top edge (a radio group): "Comment on this image"
 *   (the file's own comment row, drawn as is) and "Reply to <agent>" (the
 *   thread's reply). HTML is Reply only: its comments go on the page, with the pen.
 * - The reply is the thread's reply draft, not a copy: the field shows the
 *   thread's words, every keystroke goes through the reply box's own change
 *   (Thread.tsx `changeReply`), and Send is the thread's Send, with its rules
 *   and refusals, kept in full screen.
 * - Minimize (the double chevron at the card's top right) leaves a 30 px pill
 *   at the foot that reads "Reply draft" while a draft waits, else the tab's
 *   label. The pill gives the card back and focus goes to its field; minimizing
 *   puts focus on the pill. Kept per thread (fullScreenComposer.ts).
 * - Hide (») in the toolbar hides the card and the pill with everything else
 *   that floats (`tucked`: inert, faded out in inbox.css).
 * - No dots, no "Draft saved" line: the words say what waits.
 * - Files: the Reply tab's toolbar starts with the reply box's paperclip, and a
 *   paste or a drop on the card attaches as in the box. They are the box's
 *   files (one reply), shown here with the box's tiles.
 *
 * The card is the file's foot (`data-file-foot`, AttachmentPane measures it):
 * the toolbar on a phone, the chip and the notes sit above it. A phone's pill
 * shares the toolbar's row instead (left of it), so it is no foot.
 */
import { createContext, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { InboxComposerField, type InboxComposerTags } from './ComposerField';
import { AttachFilesButton, ComposeFileTiles, useFileDrop, type ComposeFile } from '../compose/ComposeFiles';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { useComposerState, type ComposerMode } from '../fullScreenComposer';

/** The thread's reply, as the composer's Reply tab shows and sends it (Thread.tsx builds it). */
export interface FullScreenReply {
  /** Who the reply goes to ("Claude Code", or the agent the thread was handed to). */
  to: string;
  /** The thread's reply words: the open reply box's, else the kept draft's. */
  value: string;
  /** The reply box's own change: the box takes the words and the draft saves them. */
  onChange: (text: string) => void;
  /** The thread's Send, kept in full screen. */
  onSend: () => void;
  sending: boolean;
  /** Something would go with a Send (words, picks, comments, files, action items): Send is not dimmed. */
  canSend: boolean;
  /** What rides the Send besides the words. */
  picks: number;
  annotations: number;
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
  /** Questions in the thread still open (no pick). */
  openQuestions: number;
  /** Another window changed the draft while this one held words (the thread's box offers Keep mine / Discard). */
  conflict: boolean;
  /** The thread's error after a refused Send (the thread's own line announces it). */
  error: string | null;
  /** When a Send from here last went (the card says so for a moment). */
  sentAt: number | null;
  /** The thread's reply box, on the device's own route back to the thread. */
  onOpenThread: () => void;
  tags?: InboxComposerTags;
}

export interface FullScreenComposerValue {
  threadId: string;
  phone: boolean;
  reply: FullScreenReply;
  /** Hide (») tucked the toolbar: the card and the pill hide with it. Set by the pane. */
  tucked?: boolean;
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The chips of what rides the Send, and the open questions (a way to them, in the thread). */
function Rides({ reply }: { reply: FullScreenReply }) {
  return (
    <span className="ib-fcomp-chips">
      {reply.picks > 0 && (
        <span className="ib-fcomp-chip">
          <Icon name="check" size={12} />
          {plural(reply.picks, 'pick')}
        </span>
      )}
      {reply.actions > 0 && (
        <span className="ib-fcomp-chip">
          <Icon name="check" size={12} />
          {plural(reply.actions, 'action item')}
        </span>
      )}
      {reply.annotations > 0 && (
        <span className="ib-fcomp-chip">
          <Icon name="comment" size={12} />
          {plural(reply.annotations, 'comment')}
        </span>
      )}
      {reply.openQuestions > 0 && (
        <button type="button" className="ib-fcomp-q" onClick={reply.onOpenThread} data-fcomp-questions="">
          <Icon name="question" size={12} />
          {reply.openQuestions === 1 ? '1 question open' : `${reply.openQuestions} questions open`}
        </button>
      )}
    </span>
  );
}

export function FullScreenComposer({
  value,
  noun,
  comment,
}: {
  value: FullScreenComposerValue;
  /** What a comment is on ("this image", "this video"). */
  noun: 'image' | 'video' | null;
  /** The file's own comment row (its field, Mark up, Comment), drawn as is in the Comment tab. Null: Reply only. */
  comment: ReactNode | null;
}) {
  const { reply, phone, threadId } = value;
  const takesComments = comment !== null;
  const hasDraft = reply.value.trim() !== '';
  const state = useComposerState(threadId, hasDraft, takesComments);
  const mode = state.mode;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  /** Where focus goes once the next state is drawn: the card's field (restored, a tab picked) or the pill (minimized). */
  const focusNext = useRef<'field' | 'pill' | null>(null);
  const sent = useSentFlash(reply.sentAt);
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

  const nounText = noun === 'video' ? 'this video' : 'this image';
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
      <div className={`ib-fcomp-pillwrap${phone ? ' ib-phone' : ''}`} data-fcomp-pillwrap="" inert={value.tucked || undefined} {...(phone ? {} : { 'data-file-foot': '' })}>
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
            Sent to {reply.to}
          </span>
        ) : reply.conflict ? (
          <span className="ib-fcomp-note">This reply changed in another window.</span>
        ) : (
          <Rides reply={reply} />
        )}
        <button type="button" className="ib-fcomp-link" onClick={reply.onOpenThread} data-fcomp-open-thread="">
          Open in thread
        </button>
      </div>
    ) : null;

  return (
    <div
      ref={cardRef}
      className={`ib-fcomp ib-mode-${mode}${phone ? ' ib-phone' : ''}`}
      role="group"
      aria-label={label}
      inert={value.tucked || undefined}
      data-fcomp=""
      data-fcomp-mode-on={mode}
      data-file-foot=""
      data-drop-over={drop.over ? '' : undefined}
      {...drop.handlers}
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
        <Tip content="Hide the composer" side="top">
          <button
            type="button"
            className="ib-fvb ib-fcomp-min"
            onClick={() => {
              focusNext.current = 'pill';
              state.setMinimized(true);
            }}
            aria-label="Hide the composer"
            aria-expanded={true}
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
                ariaLabel={replyLabel}
                ariaDescribedBy={reply.error ? errorId : undefined}
                placeholder={`${replyLabel}…`}
                destination="your reply"
                tags={reply.tags}
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
                    reply.onSend();
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="ib-btn ib-pri ib-fcomp-send"
              onClick={reply.onSend}
              disabled={reply.sending || !reply.canSend}
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
  );
}
