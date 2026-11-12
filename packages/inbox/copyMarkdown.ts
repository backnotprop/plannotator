import { findDirectiveBlocks, findQuestionBlocks } from '@plannotator/core/question-block';
import { INBOX_REPLY_SENTENCE_LINE, parseInboxQuestionBlocks, splitInboxReplyBody } from '@plannotator/core/inbox-questions';
import { parseInboxActionBlocks, withoutInboxActionsSection } from '@plannotator/core/inbox-actions';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { isInboxActionReport, isInboxNote, type InboxMessageWire, type InboxQuestion, type InboxThread } from '@plannotator/core/inbox-types';
import { chatMarkdownToHtml } from '@plannotator/ui/utils/aiChatFormat';
import { copyRichTextToClipboard, plainTextClipboardHtml, sanitizeRichHtml } from '@plannotator/ui/utils/richClipboard';
import { pickWords } from './components/ReplacedQuestion';
import { isActionRecord } from './actions';
import { agentName, plural } from './format';

export function copyAuthor(message: InboxMessageWire): string {
  return message.author.kind === 'agent' ? agentName(message.author) : 'You';
}

export function copyTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`.replace(/\s/g, ' ');
}

interface QuestionShape {
  prompt: string;
  context: string | null;
  choices: { label: string; description: string | null; recommended: boolean }[];
  recommendation: string | null;
  suggested: string | null;
}

function answerLine(question: InboxQuestion): string | null {
  if (question.state === 'superseded') return 'Replaced by a later question.';
  const answer = question.answer;
  if (!answer || (question.state !== 'sent' && question.state !== 'closed')) return null;
  if (question.state === 'closed' && answer.skipped) return 'Answer: Set aside';
  const words = pickWords(answer);
  const note = answer.note?.trim();
  const said = note ? (words ? `${words} · Note: ${note}` : `Note: ${note}`) : words;
  return said ? `Answer: ${said}` : null;
}

function questionLines(number: number, shape: QuestionShape, record: InboxQuestion | null): string[] {
  const out = [`**Q${number}.** ${oneLine(shape.prompt)}`];
  if (shape.context) out.push(shape.context.trim());
  for (const choice of shape.choices) {
    const recommended = choice.recommended || (shape.recommendation !== null && shape.recommendation === choice.label);
    out.push(`- ${choice.label}${choice.description ? ` — ${choice.description}` : ''}${recommended ? ' (recommended)' : ''}`);
  }
  if (shape.choices.length === 0 && shape.suggested) out.push(`Suggested: ${shape.suggested}`);
  const answer = record ? answerLine(record) : null;
  if (answer) out.push('', answer);
  return out;
}

function actionLines(number: number, parsed: ReturnType<typeof parseInboxActionBlocks>[number], record: InboxQuestion | null): string[] {
  const out = [`**A${number}.** ${oneLine(parsed.prompt)}`];
  if (parsed.why) out.push(parsed.why);
  const { where, where_url: url, run } = parsed.action;
  if (where) out.push(`Where: ${url ? `[${where}](${url})` : where}`);
  else if (url) out.push(`Where: ${url}`);
  if (run) out.push(`Run: ${codeSpan(run)}`);
  const result = record?.action_result;
  if (result && !result.staged) {
    const note = result.note?.trim();
    out.push('', result.outcome === 'done' ? `Result: Done${note ? ` · ${note}` : ''}` : `Result: Can't do it${note ? ` · ${note}` : ''}`);
  } else if (record?.state === 'superseded') {
    out.push('', 'Replaced by a later action item.');
  }
  return out;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function agentMarkdown(message: InboxMessageWire): string {
  const body = message.body;
  if (!body.includes(':::')) return body.trim();
  const records = [...(message.questions ?? []), ...(message.actions ?? [])];
  const questionRecords = new Map(records.filter((q) => !isActionRecord(q)).map((q) => [q.key, q]));
  const actionRecords = new Map(records.filter(isActionRecord).map((q) => [q.key, q]));
  const parsedQuestions = new Map(parseInboxQuestionBlocks(body).map((q) => [q.key, q]));
  const parsedActions = new Map(parseInboxActionBlocks(body).map((a) => [a.startLine, a]));
  const directiveEnds = new Map(findDirectiveBlocks(body, { frontmatter: false }).map((d) => [d.startLine, d.endLine]));
  const swaps: { start: number; end: number; lines: string[] }[] = [];
  findQuestionBlocks(body, { frontmatter: false }).forEach((location, index) => {
    const record = questionRecords.get(location.key) ?? null;
    const parsed = parsedQuestions.get(location.key);
    const shape: QuestionShape | null = record
      ? { prompt: record.prompt, context: record.context, choices: record.choices, recommendation: record.recommendation, suggested: record.suggested_text }
      : parsed
        ? { prompt: parsed.prompt, context: parsed.parsed.context, choices: parsed.parsed.choices, recommendation: parsed.parsed.recommendation, suggested: parsed.parsed.suggested_text }
        : null;
    if (!shape) return;
    const number = (record?.position ?? parsed?.position ?? index) + 1;
    swaps.push({ start: location.startLine, end: location.endLine, lines: questionLines(number, shape, record) });
  });
  for (const [startLine, parsed] of parsedActions) {
    const end = directiveEnds.get(startLine);
    if (end === undefined) continue;
    const record = actionRecords.get(parsed.key) ?? [...actionRecords.values()].find((a) => a.position === parsed.position) ?? null;
    swaps.push({ start: startLine, end, lines: actionLines((record?.position ?? parsed.position) + 1, parsed, record) });
  }
  const lines = body.split('\n');
  for (const swap of swaps.sort((a, b) => b.start - a.start)) lines.splice(swap.start - 1, swap.end - swap.start + 1, ...swap.lines);
  return lines.join('\n').trim();
}

function personMarkdown(message: InboxMessageWire): string {
  if (isInboxNote(message) || isInboxActionReport(message) || (message.reask?.length ?? 0) > 0) return message.body.trim();
  const text = withoutInboxActionsSection(splitInboxSkillsBlock(message.body)?.before ?? message.body);
  const parts = splitInboxReplyBody(text);
  if (!parts.changed) return text.trim();
  const words = [parts.words, parts.rest].map((part) => part.trim()).filter(Boolean).join('\n\n');
  if (words) return words;
  const first = text.split('\n')[0]?.trim() ?? '';
  return INBOX_REPLY_SENTENCE_LINE.test(first) ? first : '';
}

function plainMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]<>|~&!#]/g, '\\$&');
}

function filesLine(message: InboxMessageWire): string | null {
  const names = (message.attachments ?? []).map((file) => plainMarkdownText(file.name));
  return names.length > 0 ? `Files: ${names.join(', ')}` : null;
}

export function messageMarkdown(message: InboxMessageWire): string {
  const text = message.author.kind === 'agent' ? agentMarkdown(message) : personMarkdown(message);
  const files = filesLine(message);
  return files ? [text, files].filter(Boolean).join('\n\n') : text;
}

export function threadMarkdown(thread: InboxThread): string {
  const out = [`# ${thread.subject ?? '(no subject)'}`, '', `${thread.project.name} · ${plural(thread.messages.length, 'message')}`];
  for (const message of thread.messages) {
    out.push('', '---', '', `**${copyAuthor(message)}** · ${copyTime(message.created_at)}`);
    const text = messageMarkdown(message);
    if (text) out.push('', text);
  }
  return out.join('\n');
}

export function markdownClipboardHtml(markdown: string): string {
  try {
    return sanitizeRichHtml(chatMarkdownToHtml(markdown)) ?? '';
  } catch {
    return '';
  }
}

export async function copyMarkdown(markdown: string | Promise<string>): Promise<boolean> {
  if (typeof markdown === 'string') return (await copyRichTextToClipboard(markdownClipboardHtml(markdown), markdown)) !== false;
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': markdown.then((text) => new Blob([markdownClipboardHtml(text) || plainTextClipboardHtml(text)], { type: 'text/html' })),
        'text/plain': markdown.then((text) => new Blob([text], { type: 'text/plain' })),
      });
      await navigator.clipboard.write([item]);
      return true;
    } catch {
    }
  }
  let text: string;
  try {
    text = await markdown;
  } catch {
    return false;
  }
  return copyMarkdown(text);
}
