/**
 * Option lines (approval "inbox-question-tradeoffs"): `Pros:`, `Cons:` and
 * `Prototype:` indented under a `- [ ]` choice, and a question's own
 * `Prototype:` line, read only when a host asks (`optionLines`, the Inbox).
 * Plan review, annotate and every older reader keep each line as text, so the
 * key, labels and answers never change.
 */
import { describe, expect, test } from 'bun:test';
import { parseQuestionBlock } from './question-block';
import { parseInboxQuestionBlocks, prototypeTargets } from './inbox-questions';

const BODY = [
  'Which checkout ships?',
  '- [ ] A · Classic — today\'s layout',
  '    Pros: known; no retraining',
  '    Cons: Pay sits below the fold',
  '    Prototype: http://localhost:4000/checkout?v=a',
  '- [ ] B · Total first — the amount and Pay at the top',
  '    **Pros:** the amount due is seen first',
  '    Trade-off: accounting checks a new layout; a long invoice runs to two pages',
  '    Try: [Total first](proto/b.html)',
  '    Pros: a second Pros line is description',
  '- [ ] C · Statement',
  'Why: B tested better with the pilot.',
  'Recommended: B · Total first',
].join('\n');

describe('option lines', () => {
  test('read into the choice, items split on ";", first of each wins; the label, key and recommendation are the default parse\'s', () => {
    const plain = parseQuestionBlock('question', BODY)!;
    const read = parseQuestionBlock('question', BODY, { optionLines: true })!;
    expect(read.key).toBe(plain.key);
    expect(read.choices.map((c) => c.label)).toEqual(plain.choices.map((c) => c.label));
    expect(read.choices.map((c) => c.recommended)).toEqual([false, true, false]);
    const [a, b, c] = read.choices;
    expect(a).toMatchObject({ description: "today's layout", pros: ['known', 'no retraining'], cons: ['Pay sits below the fold'], prototype: { target: 'http://localhost:4000/checkout?v=a' } });
    expect(b).toMatchObject({
      description: 'the amount and Pay at the top Pros: a second Pros line is description',
      pros: ['the amount due is seen first'],
      cons: ['accounting checks a new layout', 'a long invoice runs to two pages'],
      prototype: { target: 'proto/b.html', label: 'Total first' },
    });
    expect(c!.pros).toBeUndefined();
    expect(c!.prototype).toBeUndefined();
    expect(read.why).toBe('B tested better with the pilot.');
  });

  test('off (plan review, annotate): every line stays in the description, word for word', () => {
    const plain = parseQuestionBlock('question', BODY)!;
    expect(plain.choices[0]!.description).toBe("today's layout Pros: known; no retraining Cons: Pay sits below the fold Prototype: http://localhost:4000/checkout?v=a");
    expect(plain.choices.some((c) => c.pros || c.cons || c.prototype)).toBe(false);
    expect(plain.prototype).toBeUndefined();
  });

  test("a question's own Prototype: line is its shared page, never context; off, it stays context", () => {
    const body = ['Which invoice?', '- [ ] A · Classic', '- [ ] B · Total first', 'Prototype: proto/invoice.html', 'Recommended: B · Total first'].join('\n');
    const read = parseQuestionBlock('question', body, { optionLines: true })!;
    expect(read.prototype).toEqual({ target: 'proto/invoice.html' });
    expect(read.context).toBe('');
    expect(parseQuestionBlock('question', body)!.context).toBe('Prototype: proto/invoice.html');
  });

  test('prose is never a prototype: a value with spaces, an empty list, a line inside a code fence', () => {
    const body = ['Which?', '- [ ] A', '    Try: run it twice before you pick', '    Pros:', '- [ ] B', '    ```', '    Prototype: proto/b.html', '    ```'].join('\n');
    const read = parseQuestionBlock('question', body, { optionLines: true })!;
    expect(read.choices[0]!.prototype).toBeUndefined();
    expect(read.choices[0]!.pros).toBeUndefined();
    expect(read.choices[0]!.description).toBe('Try: run it twice before you pick Pros:');
    expect(read.choices[1]!.prototype).toBeUndefined();
  });

  test('the Inbox keeps them on the record, and lists each prototype with the question and option that name it', () => {
    const markdown = `:::question\n${BODY}\n:::\n\n:::question\nWhich invoice?\n- [ ] Lean\n- [ ] Full\nPrototype: <proto/invoice.html>\n:::`;
    const [first, second] = parseInboxQuestionBlocks(markdown);
    expect(first!.parsed.choices[0]).toMatchObject({ pros: ['known', 'no retraining'], prototype: { target: 'http://localhost:4000/checkout?v=a' } });
    expect(second!.parsed.prototype).toEqual({ target: 'proto/invoice.html' });
    expect(prototypeTargets(markdown)).toEqual([
      { target: 'http://localhost:4000/checkout?v=a', prompt: 'Which checkout ships?', label: 'A · Classic', kind: 'app' },
      { target: 'proto/b.html', prompt: 'Which checkout ships?', label: 'B · Total first', kind: 'file' },
      { target: 'proto/invoice.html', prompt: 'Which invoice?', label: null, kind: 'file' },
    ]);
  });
});
