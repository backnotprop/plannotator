/**
 * words/words.json and generated/swift/Words.swift: the window's words that
 * the product keeps as constants or pure functions, so the app shows the same
 * words and never hard-codes one.
 *
 *   bun scripts/mobile/words.ts [--check]
 *
 * A word that takes a part (a name, a number) is made by calling the product's
 * own function with a marker for each part, so the template is exactly what
 * the window prints: `{name}` in words.json, a Swift function in Words.swift.
 *
 * Only words the product exports are here. Words written inside a React
 * component, and the server's refusal messages (the error body carries them),
 * are not constants yet: add a constant to the product first, then a row here.
 */
import { INBOX_ACTION_LABEL } from '../../packages/core/inbox-actions';
import { INBOX_STOPPED_REPLY_TEXT, TURN_ENDED_TEXT, autoAfterText, reaskRowLine, sentRowLine } from '../../packages/core/inbox-delivery-line';
import { INBOX_TURN_FAILED_WORDS } from '../../packages/core/inbox-run-line';
import { INBOX_SNOOZED_BAND } from '../../packages/core/inbox-snooze';
import { INBOX_ACK_LABEL, INBOX_AGENT_LABELS, INBOX_PRIORITY_GROUP, INBOX_SECTIONS } from '../../packages/core/inbox-types';
import { ATTACHMENT_FEEDBACK_HEADING, SENT_VERSION_SUFFIX } from '../../packages/inbox/attachments';
import { MARKUP_ONLY_TEXT } from '../../packages/inbox/markup';
import { OUT, cli, jsonText, type Output } from './lib';

/** One word: its text (`{part}` where a part goes), its parts, and where it comes from. */
export type Word = { text: string; parts: string[]; source: string };

const mark = (part: string) => `\u0001${part}\u0001`;

/** Call a product function with a marker for each part and read the template back. */
function template(source: string, parts: string[], make: (...marks: string[]) => string): Word {
  const raw = make(...parts.map(mark));
  if (/[{}]/.test(raw.replace(/\u0001\w+\u0001/g, ''))) throw new Error(`words.ts: a brace in ${source}; the template cannot hold it`);
  for (const part of parts) if (!raw.includes(mark(part))) throw new Error(`words.ts: ${source} does not show its ${part}`);
  return { text: raw.replace(/\u0001(\w+)\u0001/g, '{$1}'), parts, source };
}

const fixed = (text: string, source: string): Word => template(source, [], () => text);

const DELIVERY = 'packages/core/inbox-delivery-line.ts';

/** Every word, by its key: `<group>.<name>`. */
export function buildWords(): Record<string, Word> {
  const words: Record<string, Word> = {};
  for (const { id, label } of INBOX_SECTIONS) words[`section.${id}`] = fixed(label, `packages/core/inbox-types.ts INBOX_SECTIONS ${id}`);
  words['group.priority'] = fixed(INBOX_PRIORITY_GROUP.label, 'packages/core/inbox-types.ts INBOX_PRIORITY_GROUP');
  words['group.snoozed'] = fixed(INBOX_SNOOZED_BAND.label, 'packages/core/inbox-snooze.ts INBOX_SNOOZED_BAND');
  for (const [id, label] of Object.entries(INBOX_AGENT_LABELS)) words[`agent.${id}`] = fixed(label, `packages/core/inbox-types.ts INBOX_AGENT_LABELS ${id}`);
  words['label.ack'] = fixed(INBOX_ACK_LABEL, 'packages/core/inbox-types.ts INBOX_ACK_LABEL');
  words['label.action_item'] = fixed(INBOX_ACTION_LABEL, 'packages/core/inbox-actions.ts INBOX_ACTION_LABEL');
  words['delivery.stopped_reply'] = fixed(INBOX_STOPPED_REPLY_TEXT, `${DELIVERY} INBOX_STOPPED_REPLY_TEXT`);
  words['delivery.turn_ended'] = fixed(TURN_ENDED_TEXT, `${DELIVERY} TURN_ENDED_TEXT`);
  words['delivery.auto_after'] = template(`${DELIVERY} autoAfterText(minutes)`, ['minutes'], (m) => autoAfterText(m as unknown as number));
  words['delivery.sent_queued'] = template(`${DELIVERY} sentRowLine(name, true)`, ['name'], (n) => sentRowLine(n!, true));
  words['delivery.sent_saved'] = template(`${DELIVERY} sentRowLine(name, false)`, ['name'], (n) => sentRowLine(n!, false));
  words['delivery.reask_waiting'] = template(`${DELIVERY} reaskRowLine(name, checkedAt, _)`, ['name'], (n) => reaskRowLine(n!, '2026-01-01T00:00:00.000Z', true));
  words['delivery.reask_queued'] = template(`${DELIVERY} reaskRowLine(name, null, true)`, ['name'], (n) => reaskRowLine(n!, null, true));
  words['delivery.reask_saved'] = template(`${DELIVERY} reaskRowLine(name, null, false)`, ['name'], (n) => reaskRowLine(n!, null, false));
  words['run.turn_failed'] = fixed(INBOX_TURN_FAILED_WORDS, 'packages/core/inbox-run-line.ts INBOX_TURN_FAILED_WORDS');
  // The text a Send carries for comments on attached files (the phone writes it itself; vectors/feedback.json holds the rest of it).
  words['feedback.files_title'] = fixed(ATTACHMENT_FEEDBACK_HEADING.title, 'packages/inbox/attachments.ts ATTACHMENT_FEEDBACK_HEADING title');
  words['feedback.files_intro'] = fixed(ATTACHMENT_FEEDBACK_HEADING.intro, 'packages/inbox/attachments.ts ATTACHMENT_FEEDBACK_HEADING intro');
  words['feedback.sent_yours'] = fixed(SENT_VERSION_SUFFIX.yours, 'packages/inbox/attachments.ts SENT_VERSION_SUFFIX yours');
  words['markup.only'] = fixed(MARKUP_ONLY_TEXT, 'packages/inbox/markup.ts MARKUP_ONLY_TEXT');
  return words;
}

/** `section.stopped` → `sectionStopped`, `agent.claude-code` → `agentClaudeCode`. */
export function swiftName(key: string): string {
  const [first, ...rest] = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return first!.toLowerCase() + rest.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
}

/** A Swift string literal; `{part}` becomes `\(part)`. */
function swiftLiteral(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return `"${escaped.replace(/\{(\w+)\}/g, '\\($1)')}"`;
}

const SWIFT_PART_TYPE: Record<string, string> = { minutes: 'Int' };

export function swiftWords(words: Record<string, Word>): string {
  const lines = [
    '// GENERATED by scripts/mobile/words.ts from the product\'s constants. Do not edit.',
    '// docs/agent-guides/mobile.md',
    '',
    `/// The window's words. A key in words.json is a name here: section.stopped is sectionStopped.`,
    'public enum Words {',
  ];
  for (const [key, word] of Object.entries(words)) {
    lines.push(`  /// ${key}: ${word.source}`);
    if (!word.parts.length) lines.push(`  public static let ${swiftName(key)} = ${swiftLiteral(word.text)}`);
    else {
      const params = word.parts.map((p) => `${p}: ${SWIFT_PART_TYPE[p] ?? 'String'}`).join(', ');
      lines.push(`  public static func ${swiftName(key)}(${params}) -> String { ${swiftLiteral(word.text)} }`);
    }
  }
  const table = (prefix: string, name: string, doc: string) => {
    lines.push('', `  /// ${doc}`, `  public static let ${name}: [String: String] = [`);
    for (const key of Object.keys(words).filter((k) => k.startsWith(prefix))) lines.push(`    ${swiftLiteral(key.slice(prefix.length))}: ${swiftName(key)},`);
    lines.push('  ]');
  };
  table('section.', 'sections', 'A section\'s name by its id (InboxSectionId\'s raw value).');
  table('agent.', 'agents', 'An agent\'s name by its id.');
  lines.push('}', '');
  return lines.join('\n');
}

export function generateWords(): Output[] {
  const words = buildWords();
  const names = new Map<string, string>();
  for (const key of Object.keys(words)) {
    const name = swiftName(key);
    if (names.has(name)) throw new Error(`words.ts: ${key} and ${names.get(name)} make the same Swift name ${name}`);
    names.set(name, key);
  }
  return [
    { path: OUT.words, text: jsonText({ about: 'GENERATED by scripts/mobile/words.ts from the product\'s constants. Do not edit.', words }) },
    { path: OUT.wordsSwift, text: swiftWords(words) },
  ];
}

if (import.meta.main) cli('words', generateWords);
