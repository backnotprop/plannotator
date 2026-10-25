/**
 * A question as a card hanging off the agent's bubble. Picks save at once
 * (the real picks route) and ride the composer until the person sends.
 */
import { useState } from 'react';
import { Badge } from '@halftone/design-system/primitives/badge';
import { Button } from '@halftone/design-system/primitives/button/button';
import { RadioGroup } from '@halftone/design-system/primitives/forms/radio-group';
import { Checkbox } from '@halftone/design-system/primitives/forms/checkbox';
import { Textarea } from '@halftone/design-system/primitives/input/textarea';
import { Text } from '@halftone/design-system/typography/text';
import { Caption } from '@halftone/design-system/typography/caption';
import { inboxApi } from '@inbox/api';
import { answerWords } from '@inbox/folding';
import { clockTime } from '@inbox/format';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { Glyph } from './marks';

function answerOf(q: InboxQuestion, patch: Partial<QuestionAnswer>): QuestionAnswer {
  return { v: 1, key: q.key, kind: q.kind as QuestionAnswer['kind'], prompt: q.prompt, selected: [], ...q.answer, ...patch };
}

export function QuestionCard({ question, number, total, onChanged }: { question: InboxQuestion; number: number; total: number; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(question.answer?.text ?? '');
  const live = question.state === 'open' || question.state === 'picked';
  const selected = question.answer?.selected ?? [];
  // The card says Stopped and Holds up itself; the rest of the context stays.
  const context = (question.context ?? '')
    .split('\n')
    .filter((line) => !/^\s*(stopped|holds up):/i.test(line))
    .join('\n')
    .trim();

  const save = async (answer: QuestionAnswer | null) => {
    setError(null);
    try {
      await inboxApi.pick(question.message_id, question.key, question.revision, answer);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const status =
    question.state === 'sent' ? (
      <Badge size="sm" variant="default">Sent</Badge>
    ) : question.state === 'superseded' ? (
      <Badge size="sm" variant="outline">Replaced</Badge>
    ) : question.state === 'closed' ? (
      <Badge size="sm" variant="outline">Closed</Badge>
    ) : question.stopped ? (
      <Badge size="sm" variant="danger">Stopped</Badge>
    ) : question.holds_up.length > 0 ? (
      <Badge size="sm" variant="warning">Holds up {question.holds_up.length}</Badge>
    ) : question.state === 'picked' ? (
      <Badge size="sm" variant="brand">In your draft</Badge>
    ) : null;

  return (
    <div
      id={`q-${question.message_id}-${question.key}`}
      className="w-full max-w-[26rem] rounded-2xl border border-border-default bg-container p-3 shadow-default"
      data-question-card
    >
      <div className="flex items-center justify-between gap-2">
        <Caption color="tertiary" size="lg" className="flex items-center gap-1">
          <Glyph name="question" size={13} /> Question {number} of {total}
        </Caption>
        {status}
      </div>
      <Text size="base" weight="medium" className="mt-1.5">
        {question.prompt}
      </Text>
      {question.stopped && live && (
        <Caption color="danger" size="lg" className="mt-1">
          Stopped: {question.stopped}
        </Caption>
      )}
      {question.holds_up.length > 0 && live && (
        <Caption color="warning" size="lg" className="mt-1">
          Holds up: {question.holds_up.join('; ')}
        </Caption>
      )}
      {context && (
        <Text size="sm" color="secondary" className="mt-1">
          {context}
        </Text>
      )}

      {!live ? (
        <div className="mt-2 rounded-xl bg-component px-3 py-2">
          <Text size="sm">
            {question.answer ? answerWords(question.answer) : 'No answer'}
          </Text>
        </div>
      ) : question.kind === 'text' ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea size="sm" placeholder={question.suggested_text ?? 'Your answer'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" variant="secondary" shape="pill" disabled={!text.trim()} onClick={() => void save(answerOf(question, { text: text.trim() }))}>
              Save answer
            </Button>
          </div>
        </div>
      ) : question.kind === 'multi' ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {question.choices.map((choice) => {
            const on = selected.includes(choice.label);
            return (
              <label
                key={choice.label}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border-default bg-component-on-container-subtle px-3 py-2 hover:bg-transparent-hover has-data-checked:border-brand-border-default has-data-checked:bg-brand-subtle"
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(next) => {
                    const labels = next ? [...selected, choice.label] : selected.filter((l) => l !== choice.label);
                    void save(labels.length ? answerOf(question, { selected: labels, skipped: undefined }) : null);
                  }}
                />
                <Text size="sm" weight="medium" className="flex-1">
                  {choice.label}
                </Text>
                {choice.recommended && <Badge size="sm" variant="brand">Recommended</Badge>}
              </label>
            );
          })}
        </div>
      ) : (
        <RadioGroup
          aria-label={question.prompt}
          className="mt-2 flex flex-col gap-1.5"
          labelPadding={false}
          value={selected[0] ?? null}
          onValueChange={(label) => void save(answerOf(question, { selected: [label], skipped: undefined }))}
        >
          {question.choices.map((choice) => (
            <label
              key={choice.label}
              className="flex w-full items-center gap-2.5 rounded-xl border border-border-default bg-component-on-container-subtle px-3 py-2 hover:bg-transparent-hover has-data-checked:border-brand-border-default has-data-checked:bg-brand-subtle"
            >
              <RadioGroup.ItemButton value={choice.label} />
              <Text size="sm" weight="medium" className="flex-1">
                {choice.label}
              </Text>
              {choice.recommended && <Badge size="sm" variant="brand">Recommended</Badge>}
            </label>
          ))}
        </RadioGroup>
      )}

      {live && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <Caption color="tertiary" size="lg">
            {question.state === 'picked' && question.picked_at ? `Picked ${clockTime(question.picked_at)} · rides your next Send` : 'Answer here, or just reply'}
          </Caption>
          <Button size="xs" variant="transparent" shape="pill" onClick={() => void save(question.answer?.skipped ? null : answerOf(question, { selected: [], skipped: true }))}>
            {question.answer?.skipped ? 'Unskip' : 'Skip'}
          </Button>
        </div>
      )}
      {error && (
        <Caption color="danger" size="lg" className="mt-1">
          {error}
        </Caption>
      )}
    </div>
  );
}
