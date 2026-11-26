/**
 * One message's body: its text with its question cards, action items and context notes, the person's comments on
 * it, and its pictures. Drawn inside parts/MessageView.tsx, which draws it again only when what it draws from changed.
 * Its pieces are hooks beside it, called in the order its effects always ran.
 */
import { useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { useInitiativePeek } from '../../components/InitiativePeek';
import type { Block } from '@plannotator/ui/types';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import { ImageResolverContext } from '@plannotator/ui/components/ImageResolverContext';
import { SoftLineBreaksContext } from '@plannotator/ui/components/InlineMarkdown';
import { ImageRowsContext } from '@plannotator/ui/components/imageRow';
import { useRefRepo } from '../../links';
import { OpenInCodeSpans } from '../../components/OpenIn';
import { readsServedFor, useLinkedReadsRev } from '../../linkedReads';
import { FileRefCodeSpans } from '../../components/FileRefSpan';
import { InlineReuseLayer } from '../../reuse';
import { SentAnswers, ReplyActions } from '../../components/ReplyAnswers';
import { SkillsLine } from '../../components/SkillsLine';
import { noteSkillOpener } from '../../skillOpener';
import { SkillChips } from './SkillChips';
import { PullDetailsLine } from '../../pulls/PullDetailsLine';
import { HostMark } from '../../icons';
import type { MessageBodyProps } from './types';
import { NO_ANNOTATIONS, noop } from '../../thread/helpers';
import { useBodyText } from './useBodyText';
import { useBodyImages } from './useBodyImages';
import { PictureRetry } from './PictureRetry';
import { useBodyLinks } from './useBodyLinks';
import { useFileRefs } from './useFileRefs';
import { useQuestionCards } from './useQuestionCards';
import { useBodyComments } from './useBodyComments';
import { useCommentPictures } from '../../commentPictures';

/** One message's text, with its question cards (exported for its DOM test). */
export function MessageBody({
  message,
  projectRoot,
  openInFiles = false,
  repo,
  onOpenAttachment,
  onOpenFileRef,
  onOpenSkill,
  onOpenInlineImage,
  onOpenOptionSet,
  onOpenUncapturedImage,
  readOnly,
  movedThread,
  answers,
  onPick,
  footerFor,
  renderReplacedCard,
  renderReplacesLine,
  renderActions,
  renderRunBlock,
  comments,
  sentAnswers,
  sentActions,
  onJumpQuestion,
  imageBase,
  onImage,
  pictureBadge,
  inlineRefOf,
  replyFiles,
  contextNotes,
  onTryPrototype,
  onlyQuestion,
}: MessageBodyProps) {
  const { skills, pullDetails, actionsSent, replyParts, ownReply, replyFileList, shown, noteBlocks, noteAtLine, notesRef, restShown, feedbackShown, blocks, restBlocks, feedbackBlocks } = useBodyText({ message, sentActions, sentAnswers, replyFiles, projectRoot, contextNotes });
  const refRepo = useRefRepo(repo);
  // The body's pictures are drawn whole in a box; a very long one shows its top with "Show all"
  // (images.ts fitMessageImage, inbox.css). A click on a picture still opens it in the viewer.
  const bodyRef = useRef<HTMLDivElement>(null);
  const pressSelected = useRef(false);
  // A sent tag's preview: hover or focus, or a first tap on a touch screen (InitiativePeek).
  const tagPeek = useInitiativePeek(bodyRef);
  const { tapOpens } = tagPeek;
  const openHashtag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target as Element | null;
      // The preview is portaled: its own links are plain in-app links.
      if (target?.closest?.('[data-tag-peek]')) return;
      const link = target?.closest?.('a[href^="#board&initiative="], a[href^="#tag="]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (tapOpens(link)) return;
      window.location.hash = link.getAttribute('href')!;
    },
    [tapOpens],
  );
  // Hover cards for issue, PR and MR links in the body (ui RefHoverCard).
  const refCard = useRefHoverCards(bodyRef);
  const { refsOn, openFileRefRef } = useFileRefs({ message, projectRoot, onOpenFileRef, onOpenAttachment });
  const { imageBaseDir, htmlEmbeds, resolveImage, fallback, setFallback, onImageClick, onZoomChoice, pictureSizeOf, refOf } = useBodyImages({ message, imageBase, bodyRef, onOpenInlineImage, inlineRefOf, onImage, onOpenOptionSet, onOpenUncapturedImage, openFileRefRef });
  // A code span's hover reads on the message's own machine, under its Code review switch (one set with this
  // computer's, `capability-set`; off there, it answers nothing): none for a machine too old to serve it.
  useLinkedReadsRev();
  const codeHovers = openInFiles && readsServedFor(message.id);
  const { tagLabels, tagHosts, tagLayerRef, tagMarks, resolveLocalLink } = useBodyLinks({ message, bodyRef, skills, replyFiles, replyFileList, projectRoot, openInFiles, onOpenAttachment, setFallback, refsOn, openFileRefRef });
  const { renderFooter, acceptBehavior, questionCard, belowPrompt, directiveBlock, afterChoices, answerLocked, statusLabel } = useQuestionCards({ message, projectRoot, readOnly, movedThread, footerFor, answers, renderReplacedCard, renderReplacesLine, renderActions, renderRunBlock, onTryPrototype, blocks, noteAtLine, notesRef, refRepo });
  const pictures = useCommentPictures();
  const { viewerRef, commentList, selectedBadge, selectBadge, commentsRef, addComment, restoreReport, sideButton, side, answerQuestion, embedAnnotate } = useBodyComments({ comments, message, blocks, onPick, pictures });
  // The message's live html blocks take comments on their elements where its text takes them (the pen under a block).
  const annotatableEmbeds = useMemo(() => (embedAnnotate ? { ...htmlEmbeds, annotate: embedAnnotate } : htmlEmbeds), [htmlEmbeds, embedAnnotate]);

  /** The sent reply's parts after the words (the rest, the feedback): read-only text. */
  const readOnlyViewer = (parts: Block[], markdown: string) => (
    <Viewer
      blocks={parts}
      markdown={markdown}
      annotations={NO_ANNOTATIONS}
      onAddAnnotation={noop}
      onSelectAnnotation={noop}
      selectedAnnotationId={null}
      allowImages={false}
      mode="selection"
      clickAWord={false}
      taterMode={false}
      maxWidth={null}
      stickyActions={false}
      disableCodePathValidation
      imageBaseDir={imageBaseDir}
      onImageClick={onImageClick}
      resolveLocalLink={resolveLocalLink}
      refRepo={refRepo}
      answerOnly
      htmlEmbeds={htmlEmbeds}
      readOnly
      questionDecisionLines={false}
    />
  );

  // A sent message's skill opens its file beside the thread; focus comes back to what opened it (skillOpener.ts).
  const openSkill = onOpenSkill
    ? (name: string, from: HTMLElement) => {
        noteSkillOpener(from, message.thread_id);
        onOpenSkill(name);
      }
    : undefined;

  const openHighlight = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const mark = target.closest?.<HTMLElement>('[data-bind-id], [data-highlight-id]');
    const id = mark?.getAttribute('data-bind-id') ?? mark?.getAttribute('data-highlight-id');
    // A link in the highlight stays a link. A comment not sent yet (its draft mark) is the Viewer's: it opens the box.
    if (!id || target.closest('a, button') || mark?.classList.contains('comment-draft')) return;
    const option = target.closest('[data-question-option]');
    if (option && !event.defaultPrevented && !option.querySelector('input:disabled')) return;
    // A press that ended in a selection (a drag, a double or triple click) is the comment toolbar's.
    commentsRef.current?.onOpen?.(pressSelected.current || event.detail > 1 ? null : id);
  };
  // Read on the way down: the highlighter takes the selection away at this mouseup, so the click finds none.
  const readPress = () => {
    pressSelected.current = window.getSelection()?.isCollapsed === false;
  };

  return (
    <ImageResolverContext.Provider value={resolveImage}>
    {/* A picture named before it was written shows once it is there (PictureRetry). */}
    <PictureRetry bodyRef={bodyRef} message={message} retries={(src) => refOf(src) !== null}>
    {/* The body fits its pictures itself (images.ts, `.ib-body img[data-ib-fit]`): no image rows from ui. */}
    <ImageRowsContext.Provider value={false}>
    <SoftLineBreaksContext.Provider value={ownReply}>
    <OpenInCodeSpans scope={{ thread: message.thread_id, message: message.id }} on={codeHovers}>
    <FileRefCodeSpans on={refsOn} hover={codeHovers} scope={{ thread: message.thread_id, message: message.id }} openRef={openFileRefRef}>
    <div className="ib-body" data-message-id={message.id} data-text-comments={comments ? '' : undefined} data-sent-reply={replyParts ? '' : undefined} ref={bodyRef} onMouseUpCapture={comments?.onOpen ? readPress : undefined} onClickCapture={openHashtag} onClick={comments?.onOpen ? openHighlight : undefined}>
      {refCard}
      {tagPeek.node}
      {(!(replyParts || actionsSent || feedbackShown) || shown !== '') && (
      <Viewer
        ref={viewerRef}
        blocks={blocks}
        markdown={shown}
        annotations={commentList}
        onAddAnnotation={comments ? addComment : noop}
        onSelectAnnotation={comments ? selectBadge : noop}
        selectedAnnotationId={comments ? (comments.revealed ?? comments.openId ?? selectedBadge) : null}
        textComments={comments !== undefined}
        textDeletions={comments !== undefined && message.author.kind === 'agent'}
        questionTextComments={comments !== undefined}
        suggestComment={comments?.suggest}
        onSide={comments?.onSide ? side : undefined}
        sideButton={sideButton}
        allowImages={pictures}
        onRestoreReport={comments ? restoreReport : undefined}
        mode="selection"
        // A click on a word of a message makes nothing (the owner, 2026-11-10): a thread is read and clicked
        // through. Dragging over words still offers the comment; files and documents keep the click.
        clickAWord={false}
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={imageBaseDir}
        onImageClick={onImageClick}
        onQuestionPictureZoom={onOpenOptionSet ? onZoomChoice : undefined}
        resolveLocalLink={resolveLocalLink}
        refRepo={refRepo}
        answerOnly
        htmlEmbeds={annotatableEmbeds}
        // `readOnly` is about the question cards (answerLocked locks them); with comments on, the text still takes them.
        readOnly={readOnly && !comments}
        questionAnswers={answers}
        onlyQuestionKey={onlyQuestion}
        onAnswerQuestion={answerQuestion}
        renderQuestionFooter={renderFooter}
        // The Inbox records no decisions: a `Decision:` line an older agent wrote is context.
        questionDecisionLines={false}
        // The Inbox draws the contract lines (Stakes, Shows, Why, Can't be undone), approval "inbox-decision-mode".
        questionContractLines
        // Option lines (`Pros:`, `Cons:`, `Prototype:`) are read, not shown in the meaning line: the card draws the
        // Trade-offs table and the Try prototype tab (approval "inbox-question-tradeoffs").
        questionOptionLines
        // Change lines (`Where:`, `Before:`, `After:`): the card draws the place and each version (approval "before-after").
        questionChangeLines
        renderQuestionAfterChoices={onTryPrototype ? afterChoices : undefined}
        questionReadOnly={answerLocked}
        questionStatusLabel={statusLabel}
        questionPictureBadge={pictureBadge}
        questionPictureSize={pictureSizeOf}
        questionAcceptBehavior={acceptBehavior}
        renderQuestionCard={renderReplacedCard ? questionCard : undefined}
        renderQuestionBelowPrompt={renderReplacesLine ? belowPrompt : undefined}
        renderDirectiveBlock={renderActions || renderRunBlock || noteBlocks.length > 0 ? directiveBlock : undefined}
      />
      )}
      {/* Right after the words: the chips' buttons come in the words' order, before the names on the skills line. */}
      {skills && openSkill && <SkillChips bodyRef={bodyRef} messageId={message.id} skills={skills.skills} onOpen={openSkill} />}
      {replyParts && sentAnswers && sentAnswers.length > 0 && <SentAnswers groups={sentAnswers} onJump={onJumpQuestion} />}
      {actionsSent && <ReplyActions actions={sentActions!} sent onJump={onJumpQuestion} />}
      {replyParts && restShown && <div data-sent-rest="">{readOnlyViewer(restBlocks, restShown)}</div>}
      {feedbackShown && <div data-reply-feedback="">{readOnlyViewer(feedbackBlocks, feedbackShown)}</div>}
      {pullDetails && <PullDetailsLine details={pullDetails} />}
      {skills && <SkillsLine split={skills} onOpen={openSkill} />}
      {tagLabels && (
        <div className="ib-tg-marks" ref={tagLayerRef} aria-hidden="true" data-tag-marks="">
          {tagMarks.map((mark, index) => (
            <span key={index} className="ib-tg-mark" style={{ left: mark.left, top: mark.top, width: mark.size, height: mark.size }}>
              <HostMark host={tagHosts.get(mark.label) ?? null} />
            </span>
          ))}
        </div>
      )}
      <InlineReuseLayer bodyRef={bodyRef} />
      {fallback && createPortal(<ImageLightbox src={fallback.src} alt={fallback.alt} onClose={() => setFallback(null)} />, document.body)}
    </div>
    </FileRefCodeSpans>
    </OpenInCodeSpans>
    </SoftLineBreaksContext.Provider>
    </ImageRowsContext.Provider>
    </PictureRetry>
    </ImageResolverContext.Provider>
  );
}
