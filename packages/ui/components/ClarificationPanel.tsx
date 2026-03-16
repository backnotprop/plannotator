/**
 * ClarificationPanel — Floating panel for AI clarification questions
 *
 * When the AI embeds questions in a plan, this panel renders them as
 * interactive question cards. Supports pick_one, pick_many, confirm,
 * ask_text, and show_options question types. Inspired by Octto's
 * branch-based Q&A model.
 */

import React, { useState, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Types (matching packages/shared/questions.ts)                      */
/* ------------------------------------------------------------------ */

export type QuestionType =
  | "pick_one"
  | "pick_many"
  | "confirm"
  | "ask_text"
  | "show_options";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ShowOption {
  id: string;
  name: string;
  description?: string;
  pros?: string[];
  cons?: string[];
}

export interface ClarificationQuestion {
  id: string;
  type: QuestionType;
  question: string;
  context?: string;
  options?: QuestionOption[];
  showOptions?: ShowOption[];
  placeholder?: string;
  required?: boolean;
  branchId?: string;
}

export interface QuestionAnswer {
  questionId: string;
  type: QuestionType;
  answer: string | string[];
  answeredAt: string;
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface ClarificationPanelProps {
  isOpen: boolean;
  questions: ClarificationQuestion[];
  answers: QuestionAnswer[];
  onSubmitAnswer: (answer: QuestionAnswer) => void;
  onClose: () => void;
  isSubmitting?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export const ClarificationPanel: React.FC<ClarificationPanelProps> = ({
  isOpen,
  questions,
  answers,
  onSubmitAnswer,
  onClose,
  isSubmitting,
}) => {
  if (!isOpen || questions.length === 0) return null;

  const answeredIds = new Set(answers.map((a) => a.questionId));
  const unanswered = questions.filter((q) => !answeredIds.has(q.id));
  const answered = questions.filter((q) => answeredIds.has(q.id));
  const allAnswered = unanswered.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 max-h-[80vh] flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/50 flex-shrink-0">
          <svg
            className="w-4 h-4 text-primary"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span className="text-sm font-semibold flex-1">
            Clarification Questions
          </span>
          <span className="text-[10px] text-muted-foreground">
            {answers.length}/{questions.length} answered
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Questions */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* Unanswered questions */}
          {unanswered.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              onSubmit={onSubmitAnswer}
              disabled={isSubmitting}
            />
          ))}

          {/* Answered questions (collapsed) */}
          {answered.length > 0 && (
            <>
              {unanswered.length > 0 && (
                <div className="flex items-center gap-2 pt-2">
                  <div className="flex-1 h-px bg-border/50" />
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wider">
                    Answered
                  </span>
                  <div className="flex-1 h-px bg-border/50" />
                </div>
              )}
              {answered.map((q) => {
                const answer = answers.find((a) => a.questionId === q.id);
                return (
                  <AnsweredCard key={q.id} question={q} answer={answer!} />
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        {allAnswered && (
          <div className="px-4 py-3 border-t border-border/50 bg-success/5 flex-shrink-0">
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 text-success"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-xs text-success font-medium">
                All questions answered — continue reviewing the plan
              </span>
              <button
                onClick={onClose}
                className="ml-auto px-3 py-1 rounded-md text-xs font-medium bg-success text-success-foreground hover:opacity-90 transition-opacity"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  QuestionCard — Single unanswered question                          */
/* ------------------------------------------------------------------ */

const QuestionCard: React.FC<{
  question: ClarificationQuestion;
  onSubmit: (answer: QuestionAnswer) => void;
  disabled?: boolean;
}> = ({ question, onSubmit, disabled }) => {
  const [selection, setSelection] = useState<string | string[]>(
    question.type === "pick_many" ? [] : ""
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    // Validate
    if (question.required !== false) {
      if (question.type === "pick_many" && (selection as string[]).length === 0) {
        setError("Please select at least one option");
        return;
      }
      if (question.type !== "pick_many" && !selection) {
        setError("Please provide an answer");
        return;
      }
    }
    setError(null);
    onSubmit({
      questionId: question.id,
      type: question.type,
      answer: selection,
      answeredAt: new Date().toISOString(),
    });
  }, [question, selection, onSubmit]);

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-2">
      {/* Branch context */}
      {question.branchId && (
        <div className="text-[9px] text-primary/70 uppercase tracking-wider font-medium">
          {question.branchId}
        </div>
      )}

      {/* Question text */}
      <div className="text-sm font-medium text-foreground">
        {question.question}
      </div>

      {/* Context/reasoning */}
      {question.context && (
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          {question.context}
        </div>
      )}

      {/* Answer input based on type */}
      <div className="pt-1">
        {question.type === "pick_one" && question.options && (
          <PickOneInput
            options={question.options}
            value={selection as string}
            onChange={(v) => { setSelection(v); setError(null); }}
          />
        )}
        {question.type === "pick_many" && question.options && (
          <PickManyInput
            options={question.options}
            value={selection as string[]}
            onChange={(v) => { setSelection(v); setError(null); }}
          />
        )}
        {question.type === "confirm" && (
          <ConfirmInput
            value={selection as string}
            onChange={(v) => { setSelection(v); setError(null); }}
          />
        )}
        {question.type === "ask_text" && (
          <TextInput
            placeholder={question.placeholder}
            value={selection as string}
            onChange={(v) => { setSelection(v); setError(null); }}
          />
        )}
        {question.type === "show_options" && question.showOptions && (
          <ShowOptionsInput
            options={question.showOptions}
            value={selection as string}
            onChange={(v) => { setSelection(v); setError(null); }}
          />
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="text-[10px] text-destructive">{error}</div>
      )}

      {/* Submit button */}
      <div className="flex justify-end pt-1">
        <button
          onClick={handleSubmit}
          disabled={disabled}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
            disabled
              ? "opacity-50 cursor-not-allowed bg-muted text-muted-foreground"
              : "bg-primary text-primary-foreground hover:opacity-90"
          }`}
        >
          Answer
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  AnsweredCard — Collapsed answered question                         */
/* ------------------------------------------------------------------ */

const AnsweredCard: React.FC<{
  question: ClarificationQuestion;
  answer: QuestionAnswer;
}> = ({ question, answer }) => {
  const displayAnswer = formatAnswer(question, answer);

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 flex items-start gap-2">
      <svg
        className="w-3.5 h-3.5 text-success flex-shrink-0 mt-0.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M5 13l4 4L19 7"
        />
      </svg>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-medium text-foreground/70 truncate">
          {question.question}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {displayAnswer}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Input Components                                                   */
/* ------------------------------------------------------------------ */

const PickOneInput: React.FC<{
  options: QuestionOption[];
  value: string;
  onChange: (value: string) => void;
}> = ({ options, value, onChange }) => (
  <div className="space-y-1">
    {options.map((opt) => (
      <label
        key={opt.id}
        className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors ${
          value === opt.id
            ? "bg-primary/10 border border-primary/30"
            : "hover:bg-muted/50 border border-transparent"
        }`}
      >
        <input
          type="radio"
          name="pick-one"
          value={opt.id}
          checked={value === opt.id}
          onChange={() => onChange(opt.id)}
          className="mt-0.5 accent-primary"
        />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium">
            {opt.label}
            {opt.recommended && (
              <span className="ml-1 text-[9px] text-primary/70">(recommended)</span>
            )}
          </div>
          {opt.description && (
            <div className="text-[10px] text-muted-foreground">
              {opt.description}
            </div>
          )}
        </div>
      </label>
    ))}
  </div>
);

const PickManyInput: React.FC<{
  options: QuestionOption[];
  value: string[];
  onChange: (value: string[]) => void;
}> = ({ options, value, onChange }) => (
  <div className="space-y-1">
    {options.map((opt) => {
      const checked = value.includes(opt.id);
      return (
        <label
          key={opt.id}
          className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition-colors ${
            checked
              ? "bg-primary/10 border border-primary/30"
              : "hover:bg-muted/50 border border-transparent"
          }`}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={() =>
              onChange(
                checked
                  ? value.filter((v) => v !== opt.id)
                  : [...value, opt.id]
              )
            }
            className="mt-0.5 accent-primary"
          />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium">
              {opt.label}
              {opt.recommended && (
                <span className="ml-1 text-[9px] text-primary/70">(recommended)</span>
              )}
            </div>
            {opt.description && (
              <div className="text-[10px] text-muted-foreground">
                {opt.description}
              </div>
            )}
          </div>
        </label>
      );
    })}
  </div>
);

const ConfirmInput: React.FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => (
  <div className="flex gap-2">
    <button
      onClick={() => onChange("yes")}
      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-all ${
        value === "yes"
          ? "bg-success/15 text-success border border-success/30"
          : "bg-muted hover:bg-muted/80 text-muted-foreground border border-transparent"
      }`}
    >
      Yes
    </button>
    <button
      onClick={() => onChange("no")}
      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-all ${
        value === "no"
          ? "bg-accent/15 text-accent border border-accent/30"
          : "bg-muted hover:bg-muted/80 text-muted-foreground border border-transparent"
      }`}
    >
      No
    </button>
  </div>
);

const TextInput: React.FC<{
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ placeholder, value, onChange }) => (
  <textarea
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder || "Type your answer..."}
    rows={3}
    className="w-full px-3 py-2 rounded-md border border-border bg-background text-xs resize-none focus:outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
  />
);

const ShowOptionsInput: React.FC<{
  options: ShowOption[];
  value: string;
  onChange: (value: string) => void;
}> = ({ options, value, onChange }) => (
  <div className="space-y-2">
    {options.map((opt) => (
      <button
        key={opt.id}
        onClick={() => onChange(opt.id)}
        className={`w-full text-left p-2.5 rounded-md transition-all ${
          value === opt.id
            ? "bg-primary/10 border border-primary/30"
            : "bg-muted/30 hover:bg-muted/50 border border-transparent"
        }`}
      >
        <div className="text-xs font-semibold">{opt.name}</div>
        {opt.description && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {opt.description}
          </div>
        )}
        {(opt.pros || opt.cons) && (
          <div className="flex gap-3 mt-1.5">
            {opt.pros && opt.pros.length > 0 && (
              <div className="flex-1">
                {opt.pros.map((p, i) => (
                  <div key={i} className="text-[9px] text-success">
                    + {p}
                  </div>
                ))}
              </div>
            )}
            {opt.cons && opt.cons.length > 0 && (
              <div className="flex-1">
                {opt.cons.map((c, i) => (
                  <div key={i} className="text-[9px] text-accent">
                    − {c}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </button>
    ))}
  </div>
);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatAnswer(
  question: ClarificationQuestion,
  answer: QuestionAnswer
): string {
  const val = answer.answer;
  switch (question.type) {
    case "pick_one": {
      const opt = question.options?.find((o) => o.id === val);
      return opt ? opt.label : String(val);
    }
    case "pick_many": {
      const ids = val as string[];
      return ids
        .map((id) => question.options?.find((o) => o.id === id)?.label || id)
        .join(", ");
    }
    case "confirm":
      return val === "yes" ? "Yes" : "No";
    case "ask_text":
      return String(val);
    case "show_options": {
      const opt = question.showOptions?.find((o) => o.id === val);
      return opt ? opt.name : String(val);
    }
    default:
      return String(val);
  }
}

/* ------------------------------------------------------------------ */
/*  ClarificationBadge — Header badge for question count               */
/* ------------------------------------------------------------------ */

export const ClarificationBadge: React.FC<{
  totalQuestions: number;
  answeredCount: number;
  onClick: () => void;
}> = ({ totalQuestions, answeredCount, onClick }) => {
  if (totalQuestions === 0) return null;

  const allDone = answeredCount === totalQuestions;

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all ${
        allDone
          ? "bg-success/10 text-success hover:bg-success/20"
          : "bg-primary/10 text-primary hover:bg-primary/20 animate-pulse"
      }`}
      title={
        allDone
          ? "All questions answered"
          : `${totalQuestions - answeredCount} question${totalQuestions - answeredCount !== 1 ? "s" : ""} from the AI`
      }
    >
      <svg
        className="w-3 h-3"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span>
        {answeredCount}/{totalQuestions}
      </span>
    </button>
  );
};
