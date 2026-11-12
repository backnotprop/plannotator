/**
 * One message's body: its text with its question cards, action items and context notes, the person's comments on
 * it, and its pictures. Drawn inside parts/MessageView.tsx, which draws it again only when what it draws from changed.
 * Its pieces are hooks beside it, called in the order its effects always ran.
 */
import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { useInitiativePeek } from '../../components/InitiativePeek';
import type { Block } from '@plannotator/ui/types';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import { ImageResolverContext } from '@plannotator/ui/components/ImageResolverContext';
import { SoftLineBreaksContext } from '@plannotator/ui/components/InlineMarkdown';
import { useRefRepo } from '../../links';
import { OpenInCodeSpans } from '../../components/OpenIn';
import { InlineReuseLayer } from '../../reuse';
import { SentAnswers, ReplyActions } from '../../components/ReplyAnswers';
import { SkillsLine } from '../../components/SkillsLine';
import { HostMark } from '../../icons';
import type { MessageBodyProps } from './types';
import { NO_ANNOTATIONS, noop } from '../../thread/helpers';
import { useBodyText } from './useBodyText';
import { useBodyImages } from './useBodyImages';
import { useBodyLinks } from './useBodyLinks';
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
  onOpenInlineImage,
  onOpenOptionSet,
  readOnly,
  answers,
  onPick,
  footerFor,
  renderReplacedCard,
  renderReplacesLine,
  renderActions,
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
}: MessageBodyProps) {
  const { skills, actionsSent, replyParts, ownReply, replyFileList, shown, noteBlocks, noteAtLine, notesRef, restShown, feedbackShown, blocks, restBlocks, feedbackBlocks } = useBodyText({ message, sentActions, sentAnswers, replyFiles, projectRoot, contextNotes });
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
      if (link.getAttribute('href')!.startsWith('#board&') && tapOpens(link)) return;
      window.location.hash = link.getAttribute('href')!;
    },
    [tapOpens],
  );
  // Hover cards for issue, PR and MR links in the body (ui RefHoverCard).
  const refCard = useRefHoverCards(bodyRef);
  const { imageBaseDir, htmlEmbeds, resolveImage, fallback, setFallback, onImageClick, onZoomChoice, pictureSizeOf } = useBodyImages({ message, imageBase, bodyRef, onOpenInlineImage, inlineRefOf, onImage, onOpenOptionSet });
  const { tagLabels, tagHosts, tagLayerRef, tagMarks, resolveLocalLink } = useBodyLinks({ message, bodyRef, skills, replyFiles, replyFileList, projectRoot, openInFiles, onOpenAttachment, setFallback });
  const { renderFooter, questionCard, belowPrompt, directiveBlock, afterChoices, answerLocked, statusLabel } = useQuestionCards({ message, projectRoot, readOnly, footerFor, renderReplacedCard, renderReplacesLine, renderActions, onTryPrototype, blocks, noteAtLine, notesRef, refRepo });
  const pictures = useCommentPictures();
  const { viewerRef, commentList, selectedBadge, selectBadge, commentsRef, addComment, restoreReport, sideButton, side, answerQuestion } = useBodyComments({ comments, message, blocks, onPick });

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
    <SoftLineBreaksContext.Provider value={ownReply}>
    <OpenInCodeSpans scope={{ thread: message.thread_id, message: message.id }} on={openInFiles}>
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
        htmlEmbeds={htmlEmbeds}
        // `readOnly` is about the question cards (answerLocked locks them); with comments on, the text still takes them.
        readOnly={readOnly && !comments}
        questionAnswers={answers}
        onAnswerQuestion={answerQuestion}
        renderQuestionFooter={renderFooter}
        // The Inbox records no decisions: a `Decision:` line an older agent wrote is context.
        questionDecisionLines={false}
        // The Inbox draws the contract lines (Stakes, Shows, Why, Can't be undone), approval "inbox-decision-mode".
        questionContractLines
        // Option lines (`Pros:`, `Cons:`, `Prototype:`) are read, not shown in the meaning line: the card draws the
        // Trade-offs table and the Try prototype tab (approval "inbox-question-tradeoffs").
        questionOptionLines
        renderQuestionAfterChoices={onTryPrototype ? afterChoices : undefined}
        questionReadOnly={answerLocked}
        questionStatusLabel={statusLabel}
        questionPictureBadge={pictureBadge}
        questionPictureSize={pictureSizeOf}
        renderQuestionCard={renderReplacedCard ? questionCard : undefined}
        renderQuestionBelowPrompt={renderReplacesLine ? belowPrompt : undefined}
        renderDirectiveBlock={renderActions || noteBlocks.length > 0 ? directiveBlock : undefined}
      />
      )}
      {replyParts && sentAnswers && sentAnswers.length > 0 && <SentAnswers groups={sentAnswers} onJump={onJumpQuestion} />}
      {actionsSent && <ReplyActions actions={sentActions!} sent onJump={onJumpQuestion} />}
      {replyParts && restShown && <div data-sent-rest="">{readOnlyViewer(restBlocks, restShown)}</div>}
      {feedbackShown && <div data-reply-feedback="">{readOnlyViewer(feedbackBlocks, feedbackShown)}</div>}
      {skills && <SkillsLine split={skills} />}
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
    </OpenInCodeSpans>
    </SoftLineBreaksContext.Provider>
    </ImageResolverContext.Provider>
  );
}
