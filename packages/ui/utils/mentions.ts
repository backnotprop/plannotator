import type { ReactNode } from 'react';

export interface MentionPerson {
  readonly id: string;
  readonly kind: 'user' | 'agent';
  readonly label: string;
  readonly detail: string | null;
  readonly avatar?: { readonly url?: string; readonly initials?: string; readonly tint?: string };
  readonly canOpen: boolean;
  readonly group?: string;
}

export interface MentionSource {
  readonly people: readonly MentionPerson[];
  readonly emptyNotice?: string | null;
  readonly heading?: string | null;
  readonly tokenClassName?: string;
  readonly onMentionsChange?: (ids: readonly string[]) => void;
  readonly kinds?: readonly MentionPerson['kind'][];
  readonly matchDetail?: boolean;
  readonly renderNotice?: (tagged: readonly MentionPerson[]) => ReactNode;
  readonly onPickBlocked?: (person: MentionPerson) => void;
}

export const MENTION_QUERY_RE = /@[\w .-]*$/;

export function sanitizeMentionLabel(label: string): string {
  return label
    .replace(/[[\]|\n\r]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface MentionTrigger {
  readonly query: string;
  readonly from: number;
  readonly to: number;
}

export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret);
  const match = MENTION_QUERY_RE.exec(before);
  if (match === null) return null;
  const from = match.index;
  if (from > 0) {
    const prior = before.charAt(from - 1);
    if (!/\s/u.test(prior)) return null;
  }
  return { query: match[0].slice(1).trim().toLowerCase(), from, to: caret };
}

export function mentionMatches(
  people: readonly MentionPerson[],
  trigger: MentionTrigger,
  alreadyTagged: ReadonlySet<string>,
  kinds: readonly MentionPerson['kind'][] = ['user'],
  matchDetail = true,
): readonly MentionPerson[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (!kinds.includes(person.kind)) return false;
    if (alreadyTagged.has(person.id) || seen.has(person.id)) return false;
    seen.add(person.id);
    if (trigger.query === '') return true;
    return (
      person.label.toLowerCase().includes(trigger.query) ||
      (matchDetail && (person.detail ?? '').toLowerCase().includes(trigger.query))
    );
  });
}

export function mentionToken(person: MentionPerson): string {
  return `@${sanitizeMentionLabel(person.label)}`;
}

export function applyMentionPick(
  text: string,
  trigger: MentionTrigger,
  person: MentionPerson,
): { readonly text: string; readonly caret: number } {
  const insert = `${mentionToken(person)} `;
  return {
    text: text.slice(0, trigger.from) + insert + text.slice(trigger.to),
    caret: trigger.from + insert.length,
  };
}

export function survivingMentions(
  text: string,
  tagged: readonly MentionPerson[],
): readonly MentionPerson[] {
  const tokens = tagged.map(mentionToken);
  const standsAt = (token: string, at: number) =>
    !tokens.some((other) => other.length > token.length && other.startsWith(token) && text.startsWith(other, at));
  return tagged.filter((_, index) => {
    const token = tokens[index]!;
    for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
      if (standsAt(token, at)) return true;
    }
    return false;
  });
}
