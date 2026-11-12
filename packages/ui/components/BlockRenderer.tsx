import React from "react";
import type { Block } from "../types";
import { InlineMarkdown } from "./InlineMarkdown";
import { ListItemBody } from "./ListItemBody";
import { CodeBlock } from "./blocks/CodeBlock";
import { HtmlBlock } from "./blocks/HtmlBlock";
import { Callout } from "./blocks/Callout";
import { AlertBlock } from "./blocks/AlertBlock";
import { BlockquoteBlock } from "./blocks/BlockquoteBlock";
import { TableBlock } from "./blocks/TableBlock";
import { MathBlock } from "./blocks/MathBlock";
import { QuestionBlock, type QuestionBlockProps } from "./blocks/QuestionBlock";
import {
  indexQuestionBlocks,
  isQuestionDirectiveKind,
  type IndexedQuestion,
  type QuestionAnswer,
} from "@plannotator/core/question-block";

const standaloneQuestion = (block: Block, contractLines: boolean): IndexedQuestion | undefined => {
  const [indexed] = indexQuestionBlocks([block], { contractLines });
  return indexed ? { ...indexed, number: 0 } : undefined;
};

export const BlockRenderer: React.FC<{
  block: Block;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onToggleCheckbox?: (blockId: string, checked: boolean) => void;
  checkboxOverrides?: Map<string, boolean>;
  orderedIndex?: number | null;
  githubRepo?: string;
  repoHost?: string;
  headingAnchorId?: string;
  onNavigateAnchor?: (hash: string) => void;
  question?: IndexedQuestion;
  questionTotal?: number;
  questionAnswer?: QuestionAnswer;
  onAnswerQuestion?: (blockId: string, answer: QuestionAnswer | null, key: string) => void;
  onSaveQuestionAnswer?: QuestionBlockProps['onSaveAnswer'];
  saveQuestionAnswerLabel?: QuestionBlockProps['saveLabel'];
  renderQuestionFooter?: QuestionBlockProps['renderFooter'];
  questionDecisionRecording?: QuestionBlockProps['decisionRecording'];
  questionDecisionScope?: QuestionBlockProps['decisionScope'];
  onToggleQuestionDecisionRecording?: QuestionBlockProps['onToggleDecisionRecording'];
  onOpenQuestionDecision?: QuestionBlockProps['onOpenDecision'];
  questionStatusTag?: QuestionBlockProps['statusTag'];
  questionStatusLabel?: QuestionBlockProps['statusLabel'];
  renderQuestionBelowPrompt?: QuestionBlockProps['renderBelowPrompt'];
  renderQuestionAfterChoices?: QuestionBlockProps['renderAfterChoices'];
  questionContractLines?: boolean;
  questionPictureChoices?: QuestionBlockProps['pictureChoices'];
  questionPictureBadge?: QuestionBlockProps['pictureBadge'];
  onQuestionPictureZoom?: QuestionBlockProps['onZoomChoice'];
  questionPictureSize?: QuestionBlockProps['pictureSize'];
}> = ({ block, onOpenLinkedDoc, onOpenCodeFile, imageBaseDir, onImageClick, onToggleCheckbox, checkboxOverrides, orderedIndex, githubRepo, repoHost, headingAnchorId, onNavigateAnchor, question, questionTotal, questionAnswer, onAnswerQuestion, onSaveQuestionAnswer, saveQuestionAnswerLabel, renderQuestionFooter, questionDecisionRecording, questionDecisionScope, onToggleQuestionDecisionRecording, onOpenQuestionDecision, questionStatusTag, questionStatusLabel, renderQuestionBelowPrompt, renderQuestionAfterChoices, questionContractLines = false, questionPictureChoices, questionPictureBadge, onQuestionPictureZoom, questionPictureSize }) => {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level || 1}` as React.ElementType;
      const styles = {
        1: 'text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight',
        2: 'text-xl font-semibold mb-3 mt-8 text-foreground/90',
        3: 'text-base font-semibold mb-2 mt-6 text-foreground/80',
      }[block.level || 1] || 'text-base font-semibold mb-2 mt-4';
      return (
        <Tag
          id={headingAnchorId}
          className={styles}
          data-block-id={block.id}
          data-block-type="heading"
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} onOpenCodeFile={onOpenCodeFile} githubRepo={githubRepo} repoHost={repoHost} onNavigateAnchor={onNavigateAnchor} />
        </Tag>
      );
    }

    case 'blockquote': {
      if (block.alertKind) {
        return (
          <AlertBlock
            blockId={block.id}
            kind={block.alertKind}
            body={block.content}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onOpenCodeFile={onOpenCodeFile}
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            githubRepo={githubRepo}
            repoHost={repoHost}
            onNavigateAnchor={onNavigateAnchor}
          />
        );
      }
      return (
        <BlockquoteBlock
          block={block}
          onOpenLinkedDoc={onOpenLinkedDoc}
          onOpenCodeFile={onOpenCodeFile}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          githubRepo={githubRepo}
          repoHost={repoHost}
          onNavigateAnchor={onNavigateAnchor}
        />
      );
    }

    case 'list-item': {
      const indent = (block.level || 0) * 1.25;
      const isCheckbox = block.checked !== undefined;
      const isChecked = checkboxOverrides?.has(block.id)
        ? checkboxOverrides.get(block.id)!
        : block.checked;
      const isInteractive = isCheckbox && !!onToggleCheckbox;
      const textClass = `text-sm leading-relaxed ${isCheckbox && isChecked ? 'text-muted-foreground line-through' : 'text-foreground/90'}`;
      const inlineProps = { imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, repoHost, onNavigateAnchor };
      return (
        <div
          className="flex items-start gap-3 my-1.5"
          data-block-id={block.id}
          data-rich-list-level={block.level || 0}
          data-rich-list-kind={block.ordered ? 'ol' : 'ul'}
          data-rich-list-index={orderedIndex ?? undefined}
          data-rich-list-checked={isCheckbox ? String(isChecked) : undefined}
          style={{ marginLeft: `${indent}rem` }}
        >
          <ListItemBody
            level={block.level || 0}
            ordered={block.ordered}
            orderedIndex={orderedIndex}
            checked={isChecked}
            interactive={isInteractive}
            onToggle={isInteractive ? () => onToggleCheckbox!(block.id, !isChecked) : undefined}
            textClassName={textClass}
            content={block.content}
            renderInline={(text) => <InlineMarkdown {...inlineProps} text={text} />}
          />
        </div>
      );
    }

    case 'code':
      return <CodeBlock block={block} isHovered={false} />;

    case 'table':
      return (
        <TableBlock
          block={block}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          onOpenLinkedDoc={onOpenLinkedDoc}
          onOpenCodeFile={onOpenCodeFile}
          githubRepo={githubRepo}
          repoHost={repoHost}
          onNavigateAnchor={onNavigateAnchor}
        />
      );

    case 'math':
      return <MathBlock block={block} />;

    case 'hr':
      return <hr className="border-border/30 my-8" data-block-id={block.id} />;

    case 'html':
      return <HtmlBlock block={block} imageBaseDir={imageBaseDir} onOpenLinkedDoc={onOpenLinkedDoc} onOpenCodeFile={onOpenCodeFile} onNavigateAnchor={onNavigateAnchor} />;

    case 'directive': {
      const kind = block.directiveKind || 'note';
      if (isQuestionDirectiveKind(kind)) {
        const indexed = question ?? standaloneQuestion(block, questionContractLines);
        if (indexed) {
          return (
            <QuestionBlock
              blockId={block.id}
              indexed={indexed}
              total={questionTotal ?? 0}
              answer={questionAnswer}
              onAnswer={onAnswerQuestion}
              onSaveAnswer={onSaveQuestionAnswer}
              saveLabel={saveQuestionAnswerLabel}
              renderFooter={renderQuestionFooter}
              decisionRecording={questionDecisionRecording}
              decisionScope={questionDecisionScope}
              onToggleDecisionRecording={onToggleQuestionDecisionRecording}
              onOpenDecision={onOpenQuestionDecision}
              statusTag={questionStatusTag}
              statusLabel={questionStatusLabel}
              renderBelowPrompt={renderQuestionBelowPrompt}
              renderAfterChoices={renderQuestionAfterChoices}
              pictureChoices={questionPictureChoices}
              pictureBadge={questionPictureBadge}
              onZoomChoice={onQuestionPictureZoom}
              pictureSize={questionPictureSize}
              onOpenLinkedDoc={onOpenLinkedDoc}
              onOpenCodeFile={onOpenCodeFile}
              imageBaseDir={imageBaseDir}
              onImageClick={onImageClick}
              githubRepo={githubRepo}
              repoHost={repoHost}
              onNavigateAnchor={onNavigateAnchor}
            />
          );
        }
      }
      return (
        <Callout
          blockId={block.id}
          kind={kind}
          body={block.content}
          containerClassName={`directive directive-${kind} my-4 px-4 py-3 rounded-md border`}
          blockType="directive"
          kindAttribute={kind}
          onOpenLinkedDoc={onOpenLinkedDoc}
          onOpenCodeFile={onOpenCodeFile}
          imageBaseDir={imageBaseDir}
          onImageClick={onImageClick}
          githubRepo={githubRepo}
          repoHost={repoHost}
          onNavigateAnchor={onNavigateAnchor}
        />
      );
    }

    default:
      return (
        <p
          className="mb-4 leading-relaxed text-foreground/90 text-[15px]"
          data-block-id={block.id}
          style={block.blankLinesBefore ? { marginTop: `${block.blankLinesBefore}lh` } : undefined}
          data-blank-lines={block.blankLinesBefore}
        >
          <InlineMarkdown imageBaseDir={imageBaseDir} onImageClick={onImageClick} text={block.content} onOpenLinkedDoc={onOpenLinkedDoc} onOpenCodeFile={onOpenCodeFile} githubRepo={githubRepo} repoHost={repoHost} onNavigateAnchor={onNavigateAnchor} />
        </p>
      );
  }
};
