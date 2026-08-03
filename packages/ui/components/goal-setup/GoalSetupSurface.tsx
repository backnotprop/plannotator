import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  Edit3,
  MessageSquare,
  Plus,
  TestTube2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  GoalSetupBundle,
  GoalSetupFactResult,
  GoalSetupFactsBundle,
  GoalSetupInterviewBundle,
  GoalSetupQuestion,
  GoalSetupQuestionAnswer,
} from '@plannotator/core/goal-setup';
import { ConfirmDialog } from '../ConfirmDialog';
import { CommentPopover } from '../CommentPopover';
import { Button } from '../core/button';
import { Textarea } from '../core/textarea';

interface GoalSetupSurfaceProps {
  bundle: GoalSetupBundle;
  maxWidth?: number | null;
  onSubmitted?: () => void;
  onActionStateChange?: (state: GoalSetupActionState) => void;
}

type SubmitState = 'idle' | 'submitting' | 'submitted' | 'error';

export interface GoalSetupSurfaceHandle {
  submit: () => void;
}

export interface GoalSetupActionState {
  canSubmit: boolean;
  isSubmitting: boolean;
  submitted: boolean;
  submitLabel: string;
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

async function submitGoalSetup(payload: unknown): Promise<void> {
  const response = await fetch('/api/goal-setup/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = 'Submission failed';
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
}

async function copyGoalSetupText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard is unavailable in this browser');
  }
  await navigator.clipboard.writeText(text);
}

function useGoalSetupCopy(onError: (message: string) => void) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const copy = useCallback(
    async (id: string, text: string) => {
      try {
        await copyGoalSetupText(text);
        onError('');
        setCopied(id);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Copy failed');
      }
    },
    [onError]
  );

  return { copied, copy };
}

export const GoalSetupSurface = React.forwardRef<GoalSetupSurfaceHandle, GoalSetupSurfaceProps>(({
  bundle,
  maxWidth = 880,
  onSubmitted,
  onActionStateChange,
}, ref) => (
  <div
    className="w-full"
    style={maxWidth == null ? undefined : { maxWidth }}
  >
    {bundle.stage === 'interview' ? (
      <InterviewSurface
        ref={ref}
        bundle={bundle}
        onSubmitted={onSubmitted}
        onActionStateChange={onActionStateChange}
      />
    ) : (
      <FactsSurface
        ref={ref}
        bundle={bundle}
        onSubmitted={onSubmitted}
        onActionStateChange={onActionStateChange}
      />
    )}
  </div>
));
GoalSetupSurface.displayName = 'GoalSetupSurface';

const InterviewSurface = React.forwardRef<GoalSetupSurfaceHandle, {
  bundle: GoalSetupInterviewBundle;
  onSubmitted?: () => void;
  onActionStateChange?: (state: GoalSetupActionState) => void;
}>(({ bundle, onSubmitted, onActionStateChange }, ref) => {
  const [answers, setAnswers] = useState<Record<string, GoalSetupQuestionAnswer>>(() =>
    Object.fromEntries(
      bundle.questions.map((question) => [
        question.id,
        {
          questionId: question.id,
          selectedOptionIds: [],
          customAnswer: '',
          note: '',
          answer: '',
          completed: false,
        },
      ])
    )
  );
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(
    () => bundle.questions[0]?.id ?? null
  );
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [noteOpenForId, setNoteOpenForId] = useState<string | null>(null);
  const [recommendationActionForId, setRecommendationActionForId] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const questionRefs = useRef(new Map<string, HTMLDivElement>());
  const didAutoFocus = useRef(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [error, setError] = useState('');
  const { copied, copy } = useGoalSetupCopy(setError);

  const focusQuestionControl = useCallback(
    (questionId: string, options?: { scroll?: boolean }) => {
      requestAnimationFrame(() => {
        const row = questionRefs.current.get(questionId);
        if (!row) return;
        if (options?.scroll) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        const focusTarget = row.querySelector<HTMLElement>('.goal-answer-focus');
        if (focusTarget) requestAnimationFrame(() => focusTarget.focus());
      });
    },
    []
  );

  useEffect(() => {
    if (didAutoFocus.current || !activeQuestionId) return;
    didAutoFocus.current = true;
    focusQuestionControl(activeQuestionId);
  }, [activeQuestionId, focusQuestionControl]);

  const answerList = useMemo(
    () =>
      bundle.questions.map((question) => {
        const answer = answers[question.id];
        const completed = hasAnswer(question, answer);
        return {
          ...answer,
          answer: buildAnswerText(question, answer),
          completed,
          skipped: skippedIds.has(question.id) && !completed,
        };
      }),
    [answers, bundle.questions, skippedIds]
  );

  const completedCount = answerList.filter((answer) => answer.completed).length;
  const [showIncompleteWarning, setShowIncompleteWarning] = useState(false);

  const copyInterviewJson = useCallback(() => {
    copy('interview-json', JSON.stringify(buildInterviewCopyPayload(bundle, answerList), null, 2));
  }, [answerList, bundle, copy]);

  const copyInterviewMarkdown = useCallback(() => {
    copy('interview-markdown', formatInterviewMarkdown(bundle, answerList));
  }, [answerList, bundle, copy]);

  const incompleteQuestions = useMemo(
    () =>
      bundle.questions.filter(
        (q) => q.required !== false && !hasAnswer(q, answers[q.id]) && !skippedIds.has(q.id)
      ),
    [bundle.questions, answers, skippedIds]
  );
  const skippedQuestions = useMemo(
    () => bundle.questions.filter((q) => skippedIds.has(q.id) && !hasAnswer(q, answers[q.id])),
    [bundle.questions, answers, skippedIds]
  );

  const updateAnswer = useCallback(
    (questionId: string, patch: Partial<GoalSetupQuestionAnswer>) => {
      const answerFieldsChanged =
        Object.prototype.hasOwnProperty.call(patch, 'answer') ||
        Object.prototype.hasOwnProperty.call(patch, 'customAnswer') ||
        Object.prototype.hasOwnProperty.call(patch, 'selectedOptionIds');
      setAnswers((current) => ({
        ...current,
        [questionId]: {
          ...current[questionId],
          ...patch,
        },
      }));
      setSkippedIds((current) => {
        if (!answerFieldsChanged || !current.has(questionId)) return current;
        const next = new Set(current);
        next.delete(questionId);
        return next;
      });
    },
    []
  );

  const doSubmit = async () => {
    if (submitState === 'submitting') return;
    setShowIncompleteWarning(false);
    setSubmitState('submitting');
    setError('');
    try {
      await submitGoalSetup({
        stage: 'interview',
        title: bundle.title,
        goalSlug: bundle.goalSlug,
        answers: answerList,
      });
      setSubmitState('submitted');
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitState('error');
    }
  };

  const handleSubmit = () => {
    if (submitState === 'submitting') return;
    if (incompleteQuestions.length > 0 || skippedQuestions.length > 0) {
      setShowIncompleteWarning(true);
      return;
    }
    doSubmit();
  };

  React.useImperativeHandle(ref, () => ({ submit: handleSubmit }), [handleSubmit]);

  useEffect(() => {
    onActionStateChange?.({
      canSubmit: true,
      isSubmitting: submitState === 'submitting',
      submitted: submitState === 'submitted',
      submitLabel: 'Submit Answers',
    });
  }, [onActionStateChange, submitState]);

  const advance = useCallback(
    (delta: 1 | -1) => {
      const ids = bundle.questions.map((q) => q.id);
      if (ids.length === 0) return;
      const currentIndex = activeQuestionId ? ids.indexOf(activeQuestionId) : -1;
      const nextIndex =
        currentIndex === -1
          ? delta === 1 ? 0 : ids.length - 1
          : Math.max(0, Math.min(ids.length - 1, currentIndex + delta));
      const nextId = ids[nextIndex];
      setActiveQuestionId(nextId);
      focusQuestionControl(nextId, { scroll: true });
    },
    [bundle.questions, activeQuestionId, focusQuestionControl]
  );

  const skipQuestion = useCallback(
    (questionId: string) => {
      setSkippedIds((current) => {
        const next = new Set(current);
        next.add(questionId);
        return next;
      });
      advance(1);
    },
    [advance]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {

      // Ctrl+letter shortcuts — work from anywhere, including inside text fields
      if (event.ctrlKey && !event.metaKey && !event.altKey && activeQuestionId) {
        const key = event.key.toLowerCase();
        if (key === 'u') {
          event.preventDefault();
          setRecommendationActionForId({ id: activeQuestionId, nonce: Date.now() });
          return;
        }
        if (key === 'k') {
          event.preventDefault();
          skipQuestion(activeQuestionId);
          return;
        }
        if (key === 'j') {
          event.preventDefault();
          setNoteOpenForId(activeQuestionId);
          requestAnimationFrame(() => {
            const row = questionRefs.current.get(activeQuestionId);
            const noteInput = row?.querySelector<HTMLElement>('.goal-note-textarea');
            if (noteInput) requestAnimationFrame(() => noteInput.focus());
          });
          return;
        }
      }

      // Escape — blur current input so shortcuts work again
      if (event.key === 'Escape') {
        const el = event.target;
        if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          event.preventDefault();
          el.blur();
        }
        return;
      }

      // Tab / Shift+Tab — advance between questions
      if (event.key === 'Tab') {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (!target.closest('.goal-row')) return;
        event.preventDefault();
        advance(event.shiftKey ? -1 : 1);
        return;
      }

      // Number keys — toggle options on the active question
      if (!activeQuestionId) return;
      const el = event.target;
      if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      const activeQuestion = bundle.questions.find((q) => q.id === activeQuestionId);
      if (!activeQuestion?.options?.length) return;
      const mode = activeQuestion.answerMode || 'text';
      const isMulti = mode === 'multi' || mode === 'multi-custom';

      // "/" — focus the custom input for the active question
      if (event.key === '/' && (mode === 'custom' || mode === 'single-custom' || mode === 'multi-custom')) {
        event.preventDefault();
        const row = questionRefs.current.get(activeQuestionId);
        const customInput = row?.querySelector<HTMLElement>('.goal-custom-input');
        customInput?.focus();
        return;
      }

      const digit = parseInt(event.key, 10);
      if (isNaN(digit) || digit < 1 || digit > activeQuestion.options.length) return;
      event.preventDefault();

      const option = activeQuestion.options[digit - 1];
      const current = answers[activeQuestionId];
      if (isMulti) {
        updateAnswer(activeQuestionId, {
          selectedOptionIds: current.selectedOptionIds.includes(option.id)
            ? current.selectedOptionIds.filter((id) => id !== option.id)
            : [...current.selectedOptionIds, option.id],
        });
      } else {
        updateAnswer(activeQuestionId, {
          selectedOptionIds: current.selectedOptionIds.includes(option.id) ? [] : [option.id],
          customAnswer: '',
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [advance, activeQuestionId, bundle.questions, answers, updateAnswer, skipQuestion]);

  return (
    <section className="w-full">
      <ConfirmDialog
        isOpen={showIncompleteWarning}
        onClose={() => setShowIncompleteWarning(false)}
        onConfirm={doSubmit}
        variant="warning"
        title="Submit with incomplete answers?"
        message={
          <>
            {skippedQuestions.length > 0 && (
              <span>{skippedQuestions.length} skipped question{skippedQuestions.length !== 1 ? 's' : ''} will be sent as skipped, including any notes. </span>
            )}
            {incompleteQuestions.length > 0 && (
              <span>{incompleteQuestions.length} required question{incompleteQuestions.length !== 1 ? 's' : ''} {incompleteQuestions.length !== 1 ? 'are' : 'is'} still unanswered. </span>
            )}
            <span>The agent will work with whatever you've provided.</span>
          </>
        }
        confirmText="Submit anyway"
        cancelText="Go back"
        showCancel
      />

      <div className="goal-shell" data-has-active={activeQuestionId !== null ? 'true' : 'false'}>
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Goal interview
            </div>
            <h1 className="mt-0.5 truncate text-lg font-medium leading-tight text-foreground">
              {bundle.title || 'Answer the setup questions'}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1">
              <GoalCopyButton
                onClick={copyInterviewJson}
                copied={copied === 'interview-json'}
                format="JSON"
                title="Copy all questions and answers as raw JSON"
              />
              <GoalCopyButton
                onClick={copyInterviewMarkdown}
                copied={copied === 'interview-markdown'}
                format="Markdown"
                title="Copy all questions and answers as markdown"
              />
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {completedCount}/{bundle.questions.length} answered
            </div>
          </div>
        </header>

        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {bundle.questions.map((question) => {
          const answer = answers[question.id];
          const isActive = activeQuestionId === question.id;
          const complete = hasAnswer(question, answer);
          const skipped = skippedIds.has(question.id) && !complete;
          const noteSummary = answer.note?.trim();
          const summary = skipped
            ? noteSummary ? `Skipped · ${noteSummary}` : 'Skipped'
            : complete
              ? buildAnswerText(question, answer).replace(/\s*\n+\s*/g, ' · ').trim()
              : '';

          return (
            <div
              key={question.id}
              ref={(node) => {
                if (node) questionRefs.current.set(question.id, node);
                else questionRefs.current.delete(question.id);
              }}
              className={cx(
                'goal-row',
                isActive && 'active',
                complete && 'answered',
                skipped && 'skipped'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setActiveQuestionId((current) =>
                    current === question.id ? null : question.id
                  );
                }}
                tabIndex={-1}
                aria-expanded={isActive}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left focus-visible:outline-none"
              >
                <StatusDot complete={complete} skipped={skipped} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium leading-snug text-foreground">
                    {question.prompt}
                  </span>
                  {!isActive && summary && (
                    <span className={cx(
                      'mt-0.5 block truncate text-[12px] leading-snug',
                      skipped ? 'text-warning' : 'text-muted-foreground'
                    )}>
                      {summary}
                    </span>
                  )}
                </span>
                {question.required === false && !complete && !skipped && (
                  <span className="shrink-0 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
                    opt
                  </span>
                )}
                {skipped && <Check className="h-3.5 w-3.5 shrink-0 text-warning" />}
                {complete && !skipped && <Check className="h-3.5 w-3.5 shrink-0 text-success/85" />}
                <ChevronDown
                  className={cx(
                    'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
                    isActive && 'rotate-180'
                  )}
                />
              </button>

              <div className={cx('goal-question-body', isActive && 'expanded')}>
                <div className="goal-question-body-inner">
                  <div className="goal-row-divider" />
                  <QuestionAnswerControls
                    question={question}
                    answer={answer}
                    onChange={(patch) => updateAnswer(question.id, patch)}
                    noteOpen={noteOpenForId === question.id}
                    onNoteOpenChange={(open) =>
                      setNoteOpenForId(open ? question.id : null)
                    }
                    onSkip={() => skipQuestion(question.id)}
                    recommendationCommand={
                      recommendationActionForId?.id === question.id
                        ? recommendationActionForId
                        : null
                    }
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <GoalShortcutPill />
    </section>
  );
});
InterviewSurface.displayName = 'InterviewSurface';

const QuestionAnswerControls: React.FC<{
  question: GoalSetupQuestion;
  answer: GoalSetupQuestionAnswer;
  onChange: (patch: Partial<GoalSetupQuestionAnswer>) => void;
  noteOpen: boolean;
  onNoteOpenChange: (open: boolean) => void;
  onSkip: () => void;
  recommendationCommand: { nonce: number } | null;
}> = ({ question, answer, onChange, noteOpen, onNoteOpenChange, onSkip, recommendationCommand }) => {
  const mode = question.answerMode || 'text';
  const options = question.options || [];
  const supportsOptions = mode === 'single' || mode === 'multi' || mode === 'single-custom' || mode === 'multi-custom';
  const supportsCustom = mode === 'custom' || mode === 'single-custom' || mode === 'multi-custom';
  const supportsText = mode === 'text';
  const isMulti = mode === 'multi' || mode === 'multi-custom';
  const textValue = supportsText ? answer.answer : answer.customAnswer;
  const showTextArea = supportsText || mode === 'custom';
  const showCustomOption = supportsOptions && supportsCustom;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hasAnyAnswer = hasAnswer(question, answer);
  const canUseRecommendation = showTextArea || supportsCustom || Boolean(question.recommendedOptionIds?.length);

  useEffect(() => {
    if (answer.note && !noteOpen) {
      onNoteOpenChange(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer.note]);

  const toggleOption = (optionId: string) => {
    if (isMulti) {
      onChange({
        selectedOptionIds: answer.selectedOptionIds.includes(optionId)
          ? answer.selectedOptionIds.filter((id) => id !== optionId)
          : [...answer.selectedOptionIds, optionId],
      });
      return;
    }
    onChange({
      selectedOptionIds: answer.selectedOptionIds.includes(optionId) ? [] : [optionId],
      customAnswer: '',
    });
  };

  const updateTextValue = (value: string) => {
    supportsText
      ? onChange({ answer: value })
      : onChange({ customAnswer: value });
  };

  const updateCustomOption = (value: string) => {
    onChange({
      customAnswer: value,
      ...(mode === 'single-custom' && value.trim() ? { selectedOptionIds: [] } : {}),
    });
  };

  const applyRecommendation = () => {
    const patch: Partial<GoalSetupQuestionAnswer> = {};
    const hasRecommendedOptions = Boolean(question.recommendedOptionIds?.length && supportsOptions);
    if (question.recommendedOptionIds?.length && supportsOptions) {
      patch.selectedOptionIds = isMulti
        ? question.recommendedOptionIds
        : [question.recommendedOptionIds[0]];
      if (!isMulti) patch.customAnswer = '';
    }
    if (question.recommendedAnswer) {
      if (supportsText) {
        patch.answer = question.recommendedAnswer;
      } else if (mode === 'custom') {
        patch.customAnswer = question.recommendedAnswer;
      } else if (supportsCustom && !hasRecommendedOptions) {
        patch.customAnswer = question.recommendedAnswer;
        if (mode === 'single-custom') patch.selectedOptionIds = [];
      }
    }
    if (Object.keys(patch).length === 0) return;
    onChange(patch);
    if (showTextArea) requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    if (!recommendationCommand) return;
    applyRecommendation();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendationCommand?.nonce]);

  return (
    <div className="px-3 pb-3 pt-2.5">
      {question.description && (
        <p className="mb-2.5 text-[12.5px] leading-snug text-muted-foreground">
          {question.description}
        </p>
      )}
      {(question.recommendedAnswer || question.recommendedOptionIds?.length) && !hasAnyAnswer && (
        <div className="mb-2.5 flex items-start gap-2.5 rounded-md bg-muted/30 px-3 py-2">
          <div className="min-w-0 flex-1">
            <RecommendedBadge label="Recommended" />
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {question.recommendedAnswer || question.recommendedOptionIds!.map((id) =>
                question.options?.find((o) => o.id === id)?.label ?? id
              ).join(', ')}
            </p>
          </div>
          {canUseRecommendation && (
            <button
              type="button"
              onClick={applyRecommendation}
              className="mt-0.5 shrink-0 rounded-md bg-primary/15 px-2.5 py-1 text-[12px] font-medium text-primary hover:bg-primary/25"
            >
              Use
            </button>
          )}
        </div>
      )}

      {supportsOptions && options.length > 0 && (
        <div className="mb-2.5 space-y-0.5">
          {options.map((option, optionIndex) => {
            const selected = answer.selectedOptionIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => toggleOption(option.id)}
                className={cx(
                  'goal-answer-focus flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
                  selected
                    ? 'bg-primary/10 text-foreground'
                    : 'text-foreground/85 hover:bg-muted/30'
                )}
              >
                <span
                  className={cx(
                    'flex h-3.5 w-3.5 flex-none items-center justify-center transition-colors',
                    isMulti ? 'rounded-sm' : 'rounded-full',
                    selected
                      ? 'bg-primary text-primary-foreground'
                      : 'border-[1.5px] border-muted-foreground/35'
                  )}
                >
                  {selected && <Check className="h-2 w-2" strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 text-[13px] leading-snug">
                  <span className="font-medium">{option.label}</span>
                  {option.description && (
                    <span className="text-muted-foreground"> — {option.description}</span>
                  )}
                </span>
                <kbd className="goal-shortcut-pill ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/40 bg-muted/40 font-mono text-[10px] text-muted-foreground">{optionIndex + 1}</kbd>
              </button>
            );
          })}
          {showCustomOption && (
            <label
              className={cx(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors',
                answer.customAnswer.trim()
                  ? 'bg-primary/10'
                  : 'hover:bg-muted/30'
              )}
            >
              <span
                className={cx(
                  'flex h-3.5 w-3.5 flex-none items-center justify-center transition-colors',
                  isMulti ? 'rounded-sm' : 'rounded-full',
                  answer.customAnswer.trim()
                    ? 'bg-primary text-primary-foreground'
                    : 'border-[1.5px] border-muted-foreground/35'
                )}
              >
                {answer.customAnswer.trim() ? <Check className="h-2 w-2" strokeWidth={3} /> : <Plus className="h-2 w-2" strokeWidth={3} />}
              </span>
              <input
                value={answer.customAnswer}
                onChange={(event) => updateCustomOption(event.target.value)}
                placeholder="Other…"
                className="goal-answer-focus goal-custom-input min-w-0 flex-1 bg-transparent text-[13px] leading-snug text-foreground outline-none placeholder:text-muted-foreground/50"
              />
              <kbd className="goal-shortcut-pill ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/40 bg-muted/40 font-mono text-[10px] text-muted-foreground">/</kbd>
            </label>
          )}
        </div>
      )}

      {showTextArea && (
        <Textarea
          ref={textareaRef}
          value={textValue}
          onChange={(event) => updateTextValue(event.target.value)}
          placeholder={question.recommendedAnswer || 'Type your answer'}
          className="goal-answer-focus"
        />
      )}

      <div className="mt-3">
        {noteOpen ? (
          <div className="rounded-md bg-muted/25 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Note</span>
              <button
                type="button"
                onClick={() => {
                  onChange({ note: '' });
                  onNoteOpenChange(false);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Remove note"
                aria-label="Remove note"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <Textarea
              value={answer.note || ''}
              onChange={(event) => onChange({ note: event.target.value })}
              placeholder="Add context, constraints, or questions for the agent"
              className="goal-note-textarea min-h-16 border-0 bg-transparent focus:ring-0"
            />
            <div className="mt-2 flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
                {answer.note?.trim() ? 'Skip with note' : 'Skip'}
                <ChevronDown className="h-3 w-3 -rotate-90" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => onNoteOpenChange(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add note
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
              Skip
              <ChevronDown className="h-3 w-3 -rotate-90" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

const FACTS_HELP_ITEMS = [
  { icon: Check, label: 'Accept', color: 'text-success', description: 'Mark a fact as accepted. Accepted facts become part of the final fact sheet.' },
  { icon: Edit3, label: 'Edit', color: 'text-primary', description: 'Edit the fact text before accepting. Click again to finish editing.' },
  { icon: MessageSquare, label: 'Comment', color: 'text-primary', description: 'Add a note or context to a fact. The agent sees your comments alongside the fact.' },
  { icon: TestTube2, label: 'Auto-verify', color: 'text-primary', description: 'Flag this fact for automated verification. The agent will write concrete test checks for flagged facts in the plan.' },
  { icon: Trash2, label: 'Remove', color: 'text-destructive', description: 'Remove a fact entirely. It won\'t appear in the final fact sheet or plan.' },
];

const FactsSurface = React.forwardRef<GoalSetupSurfaceHandle, {
  bundle: GoalSetupFactsBundle;
  onSubmitted?: () => void;
  onActionStateChange?: (state: GoalSetupActionState) => void;
}>(({ bundle, onSubmitted, onActionStateChange }, ref) => {
  // Product choice: facts stay visible after acceptance so later review passes keep context.
  // `showAccepted` is legacy model state and does not hide rows in this surface.
  const [facts, setFacts] = useState<GoalSetupFactResult[]>(() =>
    bundle.facts.map((fact) => ({
      id: fact.id,
      text: fact.text,
      accepted: fact.accepted,
      removed: fact.removed,
      comment: fact.comment,
      automatedVerification: fact.automatedVerification,
      recommendedAutomatedVerification: fact.recommendedAutomatedVerification,
    }))
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [error, setError] = useState('');
  const { copied, copy } = useGoalSetupCopy(setError);
  const commentButtons = useRef(new Map<string, HTMLButtonElement>());
  const commentDrafts = useRef(new Map<string, string>());

  const liveFacts = facts.filter((fact) => !fact.removed);
  const acceptedCount = liveFacts.filter((fact) => fact.accepted).length;
  const commentingFact = commentingId
    ? facts.find((fact) => fact.id === commentingId)
    : undefined;
  const commentingAnchor = commentingId
    ? commentButtons.current.get(commentingId)
    : undefined;

  const updateFact = useCallback((id: string, patch: Partial<GoalSetupFactResult>) => {
    setFacts((current) =>
      current.map((fact) => (fact.id === id ? { ...fact, ...patch } : fact))
    );
  }, []);

  const withOpenCommentDraft = useCallback((sourceFacts: GoalSetupFactResult[]) => {
    if (!commentingId) return sourceFacts;
    const draft = commentDrafts.current.get(commentingId);
    if (draft === undefined) return sourceFacts;
    return sourceFacts.map((fact) =>
      fact.id === commentingId ? { ...fact, comment: draft.trim() ? draft : '' } : fact
    );
  }, [commentingId]);

  const submitFacts = useCallback(async (nextFacts = facts) => {
    if (submitState === 'submitting') return;
    const factsToSubmit = withOpenCommentDraft(nextFacts);
    const blankFact = factsToSubmit.find((fact) => !fact.removed && !fact.text.trim());
    if (blankFact) {
      setError('Fact text cannot be empty. Edit the blank fact or remove it before submitting.');
      setEditingId(blankFact.id);
      return;
    }
    setError('');
    setSubmitState('submitting');
    try {
      await submitGoalSetup({
        stage: 'facts',
        title: bundle.title,
        goalSlug: bundle.goalSlug,
        facts: factsToSubmit,
      });
      setSubmitState('submitted');
      onSubmitted?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitState('error');
    }
  }, [bundle.goalSlug, bundle.title, facts, onSubmitted, submitState, withOpenCommentDraft]);

  const handleSubmit = useCallback(() => {
    submitFacts();
  }, [submitFacts]);

  const acceptAllFacts = useCallback(() => {
    setFacts((current) =>
      current.map((fact) => (fact.removed ? fact : { ...fact, accepted: true }))
    );
  }, []);

  const copyFactsJson = useCallback(() => {
    copy('facts-json', JSON.stringify(buildFactsCopyPayload(bundle, withOpenCommentDraft(facts)), null, 2));
  }, [bundle, copy, facts, withOpenCommentDraft]);

  const copyFactsMarkdown = useCallback(() => {
    copy('facts-markdown', formatFactsMarkdown(bundle, withOpenCommentDraft(facts)));
  }, [bundle, copy, facts, withOpenCommentDraft]);

  React.useImperativeHandle(ref, () => ({ submit: handleSubmit }), [handleSubmit]);

  useEffect(() => {
    onActionStateChange?.({
      canSubmit: true,
      isSubmitting: submitState === 'submitting',
      submitted: submitState === 'submitted',
      submitLabel: 'Submit Facts',
    });
  }, [onActionStateChange, submitState]);

  return (
    <section className="w-full">
      <div className="goal-shell">
        <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Fact review
            </div>
            <div className="mt-0.5 flex items-baseline gap-2">
              <h1 className="truncate text-lg font-medium leading-tight text-foreground">
                {bundle.title || 'Review the facts'}
              </h1>
              <button
                type="button"
                onClick={() => setShowHelp(true)}
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
              >
                help
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-1">
              <GoalCopyButton
                onClick={copyFactsJson}
                copied={copied === 'facts-json'}
                format="JSON"
                title="Copy all facts as raw JSON"
              />
              <GoalCopyButton
                onClick={copyFactsMarkdown}
                copied={copied === 'facts-markdown'}
                format="Markdown"
                title="Copy all facts as markdown"
              />
              <GoalHeaderButton
                onClick={acceptAllFacts}
                disabled={liveFacts.length === 0 || submitState === 'submitting'}
                title="Accept every visible fact"
                className="gap-1.5 text-success hover:bg-success/10 hover:text-success"
              >
                <Check className="h-3.5 w-3.5" />
                Accept all
              </GoalHeaderButton>
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {acceptedCount}/{liveFacts.length} accepted
            </div>
          </div>
        </header>

        <ConfirmDialog
          isOpen={showHelp}
          onClose={() => setShowHelp(false)}
          title="Fact actions"
          variant="info"
          wide
          confirmText="Got it"
          message={
            <div className="space-y-3">
              {FACTS_HELP_ITEMS.map((item) => (
                <div key={item.label} className="flex items-start gap-2.5">
                  <item.icon className={cx('mt-0.5 h-4 w-4 shrink-0', item.color)} />
                  <div>
                    <div className="text-sm font-medium text-foreground">{item.label}</div>
                    <div className="text-xs text-muted-foreground">{item.description}</div>
                  </div>
                </div>
              ))}
            </div>
          }
        />

        {error && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {liveFacts.map((fact) => {
          const editing = editingId === fact.id;
          return (
            <div
              key={fact.id}
              className={cx(
                'goal-row flex items-center gap-2.5 px-3 py-2.5',
                fact.accepted && 'answered'
              )}
            >
              <button
                type="button"
                onClick={() => updateFact(fact.id, { accepted: !fact.accepted })}
                title={fact.accepted ? 'Unaccept' : 'Accept'}
                className="shrink-0"
              >
                <StatusDot complete={fact.accepted} />
              </button>

              <div className="min-w-0 flex-1">
                {editing ? (
                  <Textarea
                    value={fact.text}
                    onChange={(event) => updateFact(fact.id, { text: event.target.value })}
                    className="min-h-12"
                  />
                ) : (
                  <p className="text-[13.5px] leading-snug text-foreground">{fact.text}</p>
                )}
                {fact.comment && (
                  <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
                    {fact.comment}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => updateFact(fact.id, { accepted: !fact.accepted })}
                  title={fact.accepted ? 'Unaccept' : 'Accept'}
                  className={cx(
                    'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                    fact.accepted ? 'bg-success/15 text-success' : 'text-muted-foreground hover:bg-success/10 hover:text-success'
                  )}
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(editing ? null : fact.id)}
                  title={editing ? 'Done editing' : 'Edit'}
                  className={cx(
                    'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                    editing ? 'bg-primary/10 text-primary' : 'hover:bg-muted hover:text-foreground'
                  )}
                >
                  <Edit3 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  ref={(node) => {
                    if (node) commentButtons.current.set(fact.id, node);
                    else commentButtons.current.delete(fact.id);
                  }}
                  onClick={() => setCommentingId(fact.id)}
                  title="Comment"
                  className={cx(
                    'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                    fact.comment ? 'bg-primary/10 text-primary' : 'hover:bg-muted hover:text-foreground'
                  )}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => updateFact(fact.id, { automatedVerification: !fact.automatedVerification })}
                  title={fact.automatedVerification ? 'Disable auto-verify' : 'Enable auto-verify'}
                  className={cx(
                    'inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors',
                    fact.automatedVerification ? 'bg-primary/10 text-primary' : 'hover:bg-muted hover:text-foreground'
                  )}
                >
                  <TestTube2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => updateFact(fact.id, { removed: true, accepted: false })}
                  title="Remove"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}

        {liveFacts.length === 0 && (
          <div className="goal-row px-4 py-8 text-center text-sm text-muted-foreground">
            All facts have been removed.
          </div>
        )}
      </div>

      {commentingFact && (
        <CommentPopover
          key={commentingFact.id}
          anchorEl={commentingAnchor}
          contextText={commentingFact.text}
          isGlobal={false}
          initialText={commentingFact.comment || ''}
          draftKey={goalFactCommentDraftKey(bundle, commentingFact.id)}
          allowImages={false}
          allowEmptySubmit
          onDraftChange={(text) => {
            commentDrafts.current.set(commentingFact.id, text);
          }}
          onSubmit={(text) => {
            commentDrafts.current.delete(commentingFact.id);
            updateFact(commentingFact.id, { comment: text.trim() ? text : '' });
            setCommentingId(null);
          }}
          onClose={() => {
            commentDrafts.current.delete(commentingFact.id);
            setCommentingId(null);
          }}
        />
      )}
    </section>
  );
});
FactsSurface.displayName = 'FactsSurface';

const GoalHeaderButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  className,
  type = 'button',
  ...props
}) => (
  <button
    type={type}
    className={cx(
      'inline-flex h-6 items-center rounded-md px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40',
      className
    )}
    {...props}
  />
);

const GoalCopyButton: React.FC<{
  copied: boolean;
  format: 'JSON' | 'Markdown';
} & React.ButtonHTMLAttributes<HTMLButtonElement>> = ({
  copied,
  format,
  className,
  title,
  ...props
}) => (
  <GoalHeaderButton
    className={cx(
      'gap-1.5 bg-muted/50 px-2.5',
      copied && 'bg-success/10 text-success hover:bg-success/10 hover:text-success',
      className
    )}
    title={copied ? `Copied ${format}` : title}
    aria-label={`Copy ${format}`}
    {...props}
  >
    {copied ? (
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
    ) : (
      <Copy className="h-3.5 w-3.5" aria-hidden="true" />
    )}
    <span>Copy {format}</span>
  </GoalHeaderButton>
);

const GoalShortcutPill: React.FC = () => (
  <div
    role="status"
    aria-label="Keyboard shortcuts"
    className="goal-shortcut-pill pointer-events-none fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border/50 bg-popover/85 px-3 py-1.5 text-[10px] text-muted-foreground shadow-xl backdrop-blur-md"
  >
    <kbd>tab</kbd>
    <span>next</span>
    <span className="text-muted-foreground/40">·</span>
    <span className="flex"><kbd>ctrl</kbd><kbd>u</kbd></span>
    <span>use rec</span>
    <span className="text-muted-foreground/40">·</span>
    <span className="flex"><kbd>ctrl</kbd><kbd>k</kbd></span>
    <span>skip</span>
    <span className="text-muted-foreground/40">·</span>
    <span className="flex"><kbd>ctrl</kbd><kbd>j</kbd></span>
    <span>note</span>
    <span className="text-muted-foreground/40">·</span>
    <span className="flex"><kbd>cmd</kbd><kbd>enter</kbd></span>
    <span>submit</span>
  </div>
);


const RecommendedBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="inline-flex self-start items-center rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
    {label}
  </span>
);

const StatusDot: React.FC<{ complete: boolean; skipped?: boolean }> = ({ complete, skipped }) => (
  <span
    aria-hidden="true"
    className={cx(
      'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full transition-colors',
      complete
        ? 'bg-success text-success-foreground'
        : skipped
          ? 'bg-warning text-warning-foreground'
          : 'border-[1.5px] border-muted-foreground/30 bg-transparent'
    )}
  >
    {(complete || skipped) && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
  </span>
);


function hasAnswer(question: GoalSetupQuestion, answer: GoalSetupQuestionAnswer): boolean {
  const text = buildAnswerText(question, answer);
  return text.trim().length > 0;
}

function buildAnswerText(question: GoalSetupQuestion, answer: GoalSetupQuestionAnswer): string {
  const selectedLabels =
    question.options
      ?.filter((option) => answer.selectedOptionIds.includes(option.id))
      .map((option) => option.label) || [];
  const freeText =
    (question.answerMode || 'text') === 'text'
      ? answer.answer.trim()
      : answer.customAnswer.trim();
  return [...selectedLabels, freeText].filter(Boolean).join('\n');
}

function buildInterviewCopyPayload(
  bundle: GoalSetupInterviewBundle,
  answers: GoalSetupQuestionAnswer[]
) {
  return {
    stage: 'interview',
    title: bundle.title,
    goalSlug: bundle.goalSlug,
    questions: bundle.questions,
    answers,
  };
}

function buildFactsCopyPayload(
  bundle: GoalSetupFactsBundle,
  facts: GoalSetupFactResult[]
) {
  return {
    stage: 'facts',
    title: bundle.title,
    goalSlug: bundle.goalSlug,
    facts,
  };
}

function formatInterviewMarkdown(
  bundle: GoalSetupInterviewBundle,
  answers: GoalSetupQuestionAnswer[]
): string {
  const answerById = new Map(answers.map((answer) => [answer.questionId, answer]));
  const lines = [`# ${bundle.title || 'Goal interview'}`, '', '## Questions'];

  bundle.questions.forEach((question, index) => {
    const answer = answerById.get(question.id);
    const answerText = answer?.answer?.trim() || '';
    const note = answer?.note?.trim() || '';
    const status = answer?.skipped ? 'skipped' : answer?.completed ? 'answered' : 'unanswered';

    lines.push('', `${index + 1}. ${question.prompt}`);
    lines.push(`   - Status: ${status}`);

    if (question.description) {
      lines.push(`   - Context: ${question.description}`);
    }

    if (question.recommendedAnswer) {
      lines.push('   - Recommended answer:');
      lines.push(...indentMarkdownBlock(question.recommendedAnswer, '     '));
    }

    if (question.options?.length) {
      lines.push('   - Options:');
      for (const option of question.options) {
        const selected = answer?.selectedOptionIds.includes(option.id) ?? false;
        const recommended = question.recommendedOptionIds?.includes(option.id) ?? false;
        const description = option.description ? ` - ${option.description}` : '';
        lines.push(
          `     - [${selected ? 'x' : ' '}] ${option.label}${recommended ? ' (recommended)' : ''}${description}`
        );
      }
    }

    lines.push('   - Answer:');
    lines.push(...indentMarkdownBlock(answerText || '_No answer yet_', '     '));

    if (note) {
      lines.push('   - Note:');
      lines.push(...indentMarkdownBlock(note, '     '));
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatFactsMarkdown(
  bundle: GoalSetupFactsBundle,
  facts: GoalSetupFactResult[]
): string {
  const lines = [`# ${bundle.title || 'Facts'}`, '', '## Facts'];

  if (facts.length === 0) {
    lines.push('', 'No facts.');
    return `${lines.join('\n').trimEnd()}\n`;
  }

  for (const fact of facts) {
    const status = fact.removed ? 'removed' : fact.accepted ? 'accepted' : 'pending';
    const checkbox = fact.accepted && !fact.removed ? 'x' : ' ';
    const factText = fact.removed ? `~~${fact.text}~~` : fact.text;
    const verification = `${fact.automatedVerification ? 'yes' : 'no'}${
      fact.recommendedAutomatedVerification ? ' (recommended)' : ''
    }`;

    lines.push('', `- [${checkbox}] ${factText}`);
    lines.push(`  - Status: ${status}`);
    lines.push(`  - Automated verification: ${verification}`);

    if (fact.comment?.trim()) {
      lines.push('  - Comment:');
      lines.push(...indentMarkdownBlock(fact.comment, '    '));
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function indentMarkdownBlock(text: string, prefix: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [`${prefix}_None_`];
  return trimmed.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

function goalFactCommentDraftKey(bundle: GoalSetupFactsBundle, factId: string): string {
  const scope = bundle.goalSlug || bundle.title || 'untitled-goal';
  return `goal-fact-${scope}-${factId}`;
}
