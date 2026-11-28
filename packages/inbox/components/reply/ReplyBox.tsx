/**
 * The thread's open reply box, drawn from props (Inbox-only for now). What it shows comes in, what the person does
 * goes out as callbacks: the words, the draft, the files, voice and the Send stay with the thread (Thread.tsx), which
 * renders this where the open box goes in its foot. The markup is the box's as it was inline in Thread.tsx, element
 * for element (replyBoxParity.test.tsx holds it), so a second host can take the same box later.
 *
 * From the top: after a conflict its line and choice, or a saved draft offered; a take back's note; a replaced
 * question's notice; on a phone the Draft line; then the box (× to close, the quoted message, the words and what goes
 * with them in one scrolling region, "Not saved" on a computer, a phone's summary line, the row with Send), the
 * skip's spoken line, and the live-session choice or the error line under it.
 */
import type { ClipboardEvent, ComponentProps, ReactNode, RefObject } from 'react';
import { AttachFilesButton, ComposeFileTiles, type ComposeFile, type useFileDrop } from '../../compose/ComposeFiles';
import { plural } from '../../format';
import { Icon } from '../../icons';
import { ReplyTextField } from '../../parts/ReplyTextField';
import { TakeBackNote } from '../../parts/TakeBackLines';
import { REPLY_FILES_SUMMARY_FROM, focusReplyFromBox } from '../../thread/replyBox';
import { caretToEndOnFirstFocus } from '../../thread/replyCaret';
import type { useReplyQuote } from '../../useReplyQuote';
import { DraftHead, DraftOffer, type DraftConflict } from '../DraftLabel';
import type { JumpTarget } from '../ReplacedQuestion';
import { ReplyActions, ReplyAnswers, type ActionRow, type DraftAnswer } from '../ReplyAnswers';
import { ReplyQuoteLine } from '../ReplyQuote';
import { ReplyRow } from '../ReplyRow';
import { ReplySummary, type FootComments } from '../ReplySummary';
import { Tip } from '../Tip';
import { ReplyBoxRecipientControl } from './ReplyBoxRecipients';
import type { ReplyBoxRecipients, ReplyBoxSkills, ReplyBoxVoice } from './replyBoxSeams';
import type { ThreadMentions } from '../../threadMentions';

type FieldProps = ComponentProps<typeof ReplyTextField>;
type ReplyQuote = ReturnType<typeof useReplyQuote>;

export interface ReplyBoxProps {
  phone: boolean;
  /** The thread the reply answers: its mentions (a dragged row, a pasted link) are taken by its field. */
  threadId: string;
  /** Where the field keeps those mentions (threadMentions.ts `createThreadMentions`, one per box). Absent: the Inbox's own. */
  mentions?: ThreadMentions;
  // Above the box.
  /** A saved draft is offered (Restore draft). */
  offerShown: boolean;
  onRestoreDraft: () => void;
  /** After a conflict: its line, Keep mine and Discard mine (the bin is Discard mine then too). */
  conflict: DraftConflict | null;
  takeBack: ComponentProps<typeof TakeBackNote>['state'];
  /** Over the box: a replaced question's notice (the Inbox's ChangedNotice). Absent: none. */
  changedNotice?: ReactNode;
  onJump: (target: JumpTarget) => void;
  /** "Draft  Saved 4:51 PM  Discard" (a phone, above the box) or "Not saved …" (a computer, over the row). */
  draftStamp: ReactNode;
  draftAboveRef: RefObject<HTMLDivElement | null>;
  /** The draft's last save did not land, or its words are longer than a draft holds. */
  draftNotSaved: boolean;
  // The box.
  dropOver: boolean;
  dropHandlers: ReturnType<typeof useFileDrop>['handlers'];
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onClose: () => void;
  quote: ReplyQuote['quote'];
  quotedMessage: ReplyQuote['quotedMessage'];
  onRemoveQuote: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  // The words.
  replyText: FieldProps['replyText'];
  /** A Send carries the words now: the field shows none. */
  sendingWords: boolean;
  textRef: RefObject<HTMLTextAreaElement | null>;
  /** The reply's voice and what draws it (reply/replyVoice.ts). Absent: no microphone, no voice line, no voice code. */
  voice?: ReplyBoxVoice;
  replyToNames: string;
  /** The field's placeholder (the Inbox's "Write a reply. Type / for a skill"). */
  placeholder: string;
  /** The asker note's id while it shows: the field is described by it. */
  askerNoteId: string | null;
  /** Who gets the reply, when several agents could: a computer's chip leads the words, a phone's sits in the row. Absent: no control. */
  recipients?: ReplyBoxRecipients;
  /** The Skills button and the list a `/` opens. Absent: neither, and no skill list is read. */
  skills?: ReplyBoxSkills;
  tags: FieldProps['tags'];
  onChange: (text: string) => void;
  onFieldKeyDown: NonNullable<FieldProps['onKeyDown']>;
  // Files.
  files: readonly ComposeFile[];
  onRemoveFile: (key: string) => void;
  onPutBackFile: (key: string, field: HTMLTextAreaElement | null) => void;
  /** The paperclip's files. Absent: no paperclip. */
  onAttachFiles?: (list: FileList) => void;
  onShowFiles: () => void;
  // What goes with the reply.
  draftAnswers: readonly DraftAnswer[];
  draftActions: readonly ActionRow[];
  /** The open questions this Send skips or keeps open. */
  replySkip: ComponentProps<typeof ReplySummary>['skip'];
  dropped: number;
  /** The comments the reply takes, when the thread can have any. */
  comments: FootComments | null;
  replySummaryShown: boolean;
  chips: ReactNode;
  fold: boolean;
  onFold: (fold: boolean) => void;
  fitKey: string;
  // Send.
  /** The live-session choice stands in for Send and the bin, and shows under the box. */
  routeChoiceOpen: boolean;
  routeChoice: ReactNode;
  sending: boolean;
  sendRef: RefObject<HTMLButtonElement | null>;
  sendAria: string | undefined;
  /** Send pressed with nothing still uploading. */
  onSend: () => void;
  /** Send pressed while a file still uploads: the box does not send, and the host says why (required: never silent). */
  onSendWhileUploading: () => void;
  onDiscardDraft: () => void;
  errorLine: ReactNode;
}

export function ReplyBox({
  phone,
  threadId,
  mentions,
  offerShown,
  onRestoreDraft,
  conflict,
  takeBack,
  changedNotice,
  onJump,
  draftStamp,
  draftAboveRef,
  draftNotSaved,
  dropOver,
  dropHandlers,
  onPaste,
  onClose,
  quote,
  quotedMessage,
  onRemoveQuote,
  scrollRef,
  replyText,
  sendingWords,
  textRef,
  voice,
  replyToNames,
  placeholder,
  askerNoteId,
  recipients,
  skills,
  tags,
  onChange,
  onFieldKeyDown,
  files,
  onRemoveFile,
  onPutBackFile,
  onAttachFiles,
  onShowFiles,
  draftAnswers,
  draftActions,
  replySkip,
  dropped,
  comments,
  replySummaryShown,
  chips,
  fold,
  onFold,
  fitKey,
  routeChoiceOpen,
  routeChoice,
  sending,
  sendRef,
  sendAria,
  onSend,
  onSendWhileUploading,
  onDiscardDraft,
  errorLine,
}: ReplyBoxProps) {
  const recipientPill = recipients ? <ReplyBoxRecipientControl phone={phone} recipients={recipients} /> : null;
  // A file still uploading holds the Send back, whatever the host's own Send does.
  const pressSend = () => (files.some((file) => file.state === 'uploading') ? onSendWhileUploading() : onSend());
  return (
    <>
      {/* Above the box (approval "inbox-reply-recipient"): after a conflict its line and choice, and on a phone the
          Draft line (below). On a computer nothing else. */}
      {offerShown && <DraftOffer onRestore={onRestoreDraft} />}
      {conflict !== null && <DraftHead conflict={conflict} />}
      <TakeBackNote state={takeBack} />
      {changedNotice}
      {/* On a phone "Draft  Saved 4:51 PM  Discard" sits above the box, at the right, once something is saved.
          While the live-session choice stands in for the box's Send it goes, as a computer's bin does, so
          Discard cannot close the box under the choice. */}
      {phone && !routeChoiceOpen && (
        <div className="ib-draft-above" data-draft-above="" ref={draftAboveRef}>
          {draftStamp}
        </div>
      )}
      <div
        className="ib-rbox"
        data-drop-over={dropOver ? '' : undefined}
        {...dropHandlers}
        // A press beside the text (the row of chips under it) puts the caret in the reply.
        onMouseDown={(event) => focusReplyFromBox(event, textRef.current)}
        // A box put back holding words has its caret at their start: its first focus by a key lands after them.
        onFocus={(event) => caretToEndOnFirstFocus(event.target, textRef.current)}
        // A paste that carries files (a screenshot, a copied image) attaches them; text pastes as text.
        onPaste={onPaste}
      >
        {/* The one visible way to close for a pointer or a phone (Esc does the same): it keeps the words and files as
            the draft, as Cancel did; an empty box leaves none. */}
        <Tip content="Close (Esc). Your words stay as a draft.">
          <button type="button" className="ib-rclose" aria-label="Close the reply box (your draft is kept)" data-reply-close="" onClick={() => onClose()}>
            <Icon name="chevD" size={phone ? 20 : 16} />
          </button>
        </Tip>
        {/* The message the words answer (approval "inbox-reply-quote"): one quiet line over them, × drops it. */}
        {quote && quotedMessage && <ReplyQuoteLine message={quotedMessage} words={quote.words} phone={phone} onRemove={onRemoveQuote} />}
        {/* The words, files, answers and actions scroll in one region capped near half the window (decision D1), so
            the row with Send under it is always in view however much the reply holds. */}
        <div className="ib-rscroll" data-reply-scroll="" ref={scrollRef}>
          <ReplyTextField
            replyText={replyText}
            mentionThread={threadId}
            mentionScope={mentions}
            sendingWords={sendingWords}
            textareaRef={textRef}
            voice={voice?.handle}
            voiceParts={voice?.parts}
            voiceNoteGlide
            ariaLabel={`Reply to ${replyToNames}`}
            ariaDescribedBy={[askerNoteId, conflict !== null ? conflict.id : null].filter(Boolean).join(' ') || undefined}
            placeholder={placeholder}
            lead={phone ? undefined : recipientPill}
            destination="your reply"
            skills={!!skills}
            skillFilter={skills?.filter}
            commands={skills?.commands}
            tags={tags}
            onChange={(text) => onChange(text)}
            onKeyDown={onFieldKeyDown}
          />
          {files.length > 0 && (
            <div className="ib-rfiles" data-reply-files="">
              <ComposeFileTiles
                files={files}
                onRemove={(key) => {
                  onRemoveFile(key);
                  // The × goes with its tile: focus stays in the reply.
                  textRef.current?.focus();
                }}
                onPutBack={(key) => onPutBackFile(key, textRef.current)}
              />
            </div>
          )}
          {draftAnswers.length > 0 && <ReplyAnswers answers={draftAnswers} onJump={onJump} />}
          {draftActions.length > 0 && <ReplyActions actions={draftActions} onJump={onJump} />}
        </div>
        {/* A computer: a draft that did not save says so on its own line over the row, in full (a phone says it in
            the Draft line above the box). */}
        {!phone && draftNotSaved && (
          <div className="ib-rnote" data-reply-note="">
            {draftStamp}
          </div>
        )}
        {/* A phone: what goes with the reply, on one quiet line over the row (who gets it is in the row). */}
        {phone && (
          <div className="ib-rline" data-reply-line="" data-empty={replySummaryShown ? undefined : ''}>
            <ReplySummary skip={replySkip} dropped={dropped} comments={comments} />
          </div>
        )}
        <ReplyRow
          phone={phone}
          keepOpen={replySkip.keepOpen}
          fold={fold}
          onFold={onFold}
          fitKey={fitKey}
          send={
            routeChoiceOpen ? null : (
              // No tooltip: a button that says Send needs none, and ⌘↵ is named only to assistive technology
              // (approval "inbox-send-no-shortcut-hint").
              <button type="button" className="ib-btn ib-pri ib-rsend" ref={sendRef} data-reply-send="" onClick={pressSend} disabled={sending || !!voice?.handle.busy || !!voice?.handle.others.busy} aria-keyshortcuts={sendAria}>
                {/* While it sends the spinner takes the word's place and Send keeps its width, so nothing beside it moves. */}
                {sending && <span className="ib-spin" aria-hidden="true" />}
                {/* A phone: the round arrow; the word stays as the button's name. */}
                {phone && <Icon name="arrowUp" size={20} className="ib-rsend-i" />}
                <span className="ib-rsend-w">Send</span>
              </button>
            )
          }
          clip={onAttachFiles ? <AttachFilesButton className="ib-rclip" iconSize={phone ? 20 : 16} phone={phone} inputData="data-reply-attach" onFiles={onAttachFiles} /> : null}
          skills={
            skills ? (
              <Tip content="Skills (or type / in the reply)">
                <button type="button" className="ib-ricon" aria-label="Skills" data-reply-skills="" onClick={skills.onOpen}>
                  <Icon name="cube" size={phone ? 20 : 16} />
                </button>
              </Tip>
            ) : null
          }
          mic={voice ? <voice.parts.MicButton voice={voice.handle} phone={phone} /> : null}
          status={voice ? <voice.parts.StatusLine voice={voice.handle} phone={phone} /> : null}
          files={
            files.length >= REPLY_FILES_SUMMARY_FROM ? (
              <button type="button" className="ib-rchip ib-rfilesn" data-reply-files-count="" aria-label={`${files.length} files attached. Show them`} onClick={onShowFiles}>
                <Icon name="clip" size={13} />
                {files.length} files
              </button>
            ) : null
          }
          chips={chips}
          summary={<ReplySummary skip={replySkip} dropped={dropped} comments={comments ? { props: comments.props, list: comments.list?.card ? null : comments.list, onList: comments.onList } : null} />}
          pill={phone ? recipientPill : null}
          hint={skills?.noneHint ? 'No skills are installed' : null}
          discard={
            // While the live-session choice is open it stands in for Send and the bin, as it did for Send's
            // row, so nothing can close the box under it. After a conflict the bin is "Discard mine": the
            // other window's draft is never deleted from here.
            phone || routeChoiceOpen ? null : conflict !== null ? (
              <Tip content="Discard your words; the other window’s draft stays">
                <button type="button" className="ib-ricon ib-rdiscard" aria-label="Discard my words" data-reply-discard="" onClick={conflict.onDiscard}>
                  <Icon name="trash" size={16} />
                </button>
              </Tip>
            ) : (
              <Tip content="Discard this draft">
                <button type="button" className="ib-ricon ib-rdiscard" aria-label="Discard draft" data-reply-discard="" onClick={onDiscardDraft}>
                  <Icon name="trash" size={16} />
                </button>
              </Tip>
            )
          }
        />
        {dropOver && (
          <div className="ib-rdrop" aria-hidden="true" data-box-drop="">
            <Icon name="clip" size={18} />
            Drop to attach
          </div>
        )}
      </div>
      <div className="ib-sr" role="status">
        {replySkip.keepOpen ? '' : `${plural(replySkip.count, 'question')} will be skipped when you send.`}
      </div>
      {routeChoiceOpen ? routeChoice : errorLine}
    </>
  );
}
