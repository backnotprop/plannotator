import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import { resetDigitHexIssueRefs, setDigitHexIssueRefs } from '@plannotator/ui/components/InlineMarkdown';
import { ReplacedQuestionCard } from './components/ReplacedQuestion';

const question: InboxQuestion = {
  key: 'q-00000001',
  position: 0,
  kind: 'single',
  prompt: 'Revert #186379 or #42?',
  context: '',
  choices: [{ label: 'Revert #186379', description: 'see #42', checked: false, recommended: false }],
  recommendation: null,
  suggested_text: null,
  stopped: null,
  holds_up: [],
  asked_by_agent_id: 'ses_a',
  orphaned: false,
  state: 'superseded',
  answer: null,
  revision: 0,
  sent_revision: 0,
  picked_by: null,
  picked_at: null,
  sent_reply_id: null,
  message_id: 'msg_1',
  superseded_by: null,
} as unknown as InboxQuestion;

const render = (refRepo: { display: string; host?: string } | null) =>
  renderToStaticMarkup(
    createElement(ReplacedQuestionCard, {
      question,
      number: 1,
      total: 1,
      replacement: { by: null, message: { id: 'msg_2', created_at: '2026-10-10T10:00:00.000Z', author: { kind: 'agent', name: 'Claude Code' } as never } },
      answer: null,
      onJump: () => {},
      refRepo,
    }),
  );

describe('replaced question refs (#1932)', () => {
  afterEach(() => resetDigitHexIssueRefs());

  test("the prompt and choices link refs into the thread's repo", () => {
    setDigitHexIssueRefs(true);
    const html = render({ display: 'home-assistant/core' });
    expect(html).toContain('href="https://github.com/home-assistant/core/issues/186379"');
    expect(html).toContain('href="https://github.com/home-assistant/core/issues/42"');
    expect(html).not.toContain('background-color');
  });

  test('without a repo nothing links', () => {
    setDigitHexIssueRefs(true);
    expect(render(null)).not.toContain('/issues/');
  });
});
