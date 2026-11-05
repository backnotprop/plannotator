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
import type { ReactNode } from 'react';

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
  /**
   * Optional group heading: consecutive people with the same
   * `group` are drawn under one heading, as a `role="group"` labelled by it
   * (the Inbox groups agents by kind). Absent on every person → the flat
   * list, exactly as before.
   */
  readonly group?: string;
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
  /**
   * Optional class appended to each `@Label` chip the composer paints in its
   * text (0.44.0), for a host that wants its own chip look.
   *
   * THE METRIC RULE IS THE HOST'S TO KEEP: the chip is painted by an overlay
   * mirrored behind a transparent-text textarea, so it may change COLOR,
   * BACKGROUND, BORDER-RADIUS, BOX-SHADOW and TEXT-DECORATION only. Anything
   * that moves a glyph — padding, margin, border width, font-weight,
   * letter-spacing, font-size — drifts the painted text off the textarea's
   * own layout and takes the caret with it. Fake a pill's breathing room
   * with `box-shadow: 0 0 0 Npx <background>`, which paints without
   * occupying space.
   */
  readonly tokenClassName?: string;
  /** Fires on every text change with the ids whose token still survives in the body. */
  readonly onMentionsChange?: (ids: readonly string[]) => void;
  /**
   * Which kinds of people this composer offers. Absent → users only,
   * as before (an agent is not taggable in a host's comments by default). A
   * host whose agents can be tagged (the Inbox) passes `['agent']` or both.
   */
  readonly kinds?: readonly MentionPerson['kind'][];
  /**
   * Whether a query also matches the `detail` line. Absent → true, as
   * before. A host whose detail is incidental (the Inbox's "billing-api ·
   * idle") passes false, so `@p` finds Pi, not every row with a "p" in it.
   */
  readonly matchDetail?: boolean;
  /**
   * Optional line drawn under the composer field, from the people
   * the draft still tags: a host's "Goes to …" and heads-up. Absent → nothing
   * is drawn, as before.
   */
  readonly renderNotice?: (tagged: readonly MentionPerson[]) => ReactNode;
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
 * The people this trigger offers: users only by default (an agent is not
 * taggable in a comment unless the host says so with `kinds`), never one
 * already tagged in this draft, de-duplicated by id, and filtered on label or
 * detail once a query character exists.
 */
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
  const tokens = tagged.map(mentionToken);
  // An occurrence that is the start of a longer tagged token belongs to that
  // token ("@Fix" in "@Fix login" when "Fix login" is tagged too). Anything
  // else still counts as before, whatever follows it ("@Ann2", "@Annさん").
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
