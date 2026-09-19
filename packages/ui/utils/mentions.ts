/**
 * The `@` grammar for a PLAIN TEXTAREA comment composer, and the one place it
 * is spelled in this package.
 *
 * These are the host's own rules, ported as pure functions so the package can
 * own the typing behavior while the host owns the people: the trigger regex,
 * the word-boundary guard that keeps `a@b.com` from opening a menu, the
 * readable `@Label` insertion, and the surviving-token rule that keeps the
 * body and the reported mention ids from ever disagreeing about who was named.
 *
 * Nothing here touches the DOM, fetches, or persists. A composer with no
 * `mentionSource` never calls any of it.
 */

/** One pickable identity, supplied by the host. */
export interface MentionPerson {
  /** Opaque host id (a user id, a credential id). Reported back verbatim. */
  readonly id: string;
  readonly kind: 'user' | 'agent';
  readonly label: string;
  /** Right-aligned hint shown after the label (an email, "Agent"), or null. */
  readonly detail: string | null;
  /**
   * Optional avatar drawn before the label (0.43.2): an image when `url` is
   * given, else `initials` on a tinted disc (`tint` is any CSS color; absent
   * means the muted surface). Absent → no avatar column, the 0.43.1 row.
   */
  readonly avatar?: { readonly url?: string; readonly initials?: string; readonly tint?: string };
  /**
   * Whether this person can open the document. Host data: rows render
   * identically either way, and a `false` row is only special when the host
   * supplied `onPickBlocked` (see `MentionSource`).
   */
  readonly canOpen: boolean;
}

/** The opt-in `@` mention source for `CommentPopover`'s composer. */
export interface MentionSource {
  /** The people this composer may offer. An empty list shows `emptyNotice`. */
  readonly people: readonly MentionPerson[];
  /**
   * The honest-empty row's text when there is no one to offer, or null/absent
   * to keep the menu closed instead.
   */
  readonly emptyNotice?: string | null;
  /** Optional heading drawn above the list ("People in this workspace"). Absent → no heading row. */
  readonly heading?: string | null;
  /** Fires on every text change with the ids whose token still survives in the body. */
  readonly onMentionsChange?: (ids: readonly string[]) => void;
  /**
   * A `canOpen: false` person was picked. When supplied, NOTHING is inserted
   * and the host shows its own no-access affordance. When absent, such a
   * person inserts like any other.
   */
  readonly onPickBlocked?: (person: MentionPerson) => void;
}

/**
 * THE trigger: `@` plus a word-ish query, anchored at the caret. The
 * word-boundary check that makes `a@b.com` safe is the caller's (below),
 * because a textarea walks the string.
 */
export const MENTION_QUERY_RE = /@[\w .-]*$/;

/**
 * Sanitize a display label for the inserted token: byte shapes that would
 * break a `[@…](…)` link grammar are replaced and whitespace collapsed, so a
 * host that later rewrites the body into links reads back what it wrote.
 */
export function sanitizeMentionLabel(label: string): string {
  return label
    .replace(/[[\]|\n\r]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export interface MentionTrigger {
  /** What was typed after the `@`, trimmed and lowercased for matching. */
  readonly query: string;
  /** Offset of the `@` itself, so a pick can swallow it. */
  readonly from: number;
  /** Offset just past the typed query (the caret). */
  readonly to: number;
}

/**
 * The trigger under the caret, or null. The word-boundary check is the whole
 * email guard: the character before the `@` must be a line start or
 * whitespace, so typing `a@b.com` never opens the picker.
 */
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

/**
 * The people this trigger offers: users only (an agent is not taggable in a
 * comment), never one already tagged in this draft, de-duplicated by id, and
 * filtered on label or detail once a query character exists.
 */
export function mentionMatches(
  people: readonly MentionPerson[],
  trigger: MentionTrigger,
  alreadyTagged: ReadonlySet<string>,
): readonly MentionPerson[] {
  const seen = new Set<string>();
  return people.filter((person) => {
    if (person.kind !== 'user') return false;
    if (alreadyTagged.has(person.id) || seen.has(person.id)) return false;
    seen.add(person.id);
    if (trigger.query === '') return true;
    return (
      person.label.toLowerCase().includes(trigger.query) ||
      (person.detail ?? '').toLowerCase().includes(trigger.query)
    );
  });
}

/** The readable token this person's name becomes in the body. */
export function mentionToken(person: MentionPerson): string {
  return `@${sanitizeMentionLabel(person.label)}`;
}

/**
 * Picking: the typed `@query` is replaced by the readable token plus one
 * space, and the caret lands after it.
 */
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

/**
 * The people a draft still tags. A token the author deleted from the text
 * stops being a tag: the body and the reported ids never disagree about who
 * was named, which is what makes the readable `@Name` honest.
 */
export function survivingMentions(
  text: string,
  tagged: readonly MentionPerson[],
): readonly MentionPerson[] {
  return tagged.filter((person) => text.includes(mentionToken(person)));
}
