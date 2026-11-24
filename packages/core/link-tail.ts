/**
 * A link pasted from prose, or clicked in a terminal that linkified it up to the next space, can carry the
 * punctuation the sentence put after it: `(thread msg_…, http://localhost:19432/#thread=msg_…).` arrives with
 * `).` on the thread id. The ids below are looked up in a store, and none of them can end with one of these
 * characters, so a page strips them before the lookup and opens the right thing.
 *
 * Only for ids that are looked up. Never for a path, a name or anything a check guards: those keep every character.
 */

/** What a sentence can put right after a link: `)`, `.`, `,`, `;`, `:`, `]`, `>` and quotes. */
export const LINK_TAIL = /[).,;:\]>"']+$/;

/** An Inbox or plan id: a short lowercase prefix and a ULID (`msg_…`, `prj_…`, `att_…`, `pln_…`). */
export const LINK_ULID_ID = /^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A pull request's key (`forgeRefKey`): `host/owner/repo#12`, a GitLab one `…#7:pull`. */
export const LINK_PULL_KEY = /^[^\s#]+#[1-9][0-9]*(?::[a-z]+)?$/;

/** A share key or payload: base64url without padding. */
export const LINK_BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * `value` without the punctuation a sentence put after it, when what is left is an id of `grammar` and `value`
 * itself is not one; otherwise `value` unchanged (a value that is no id of that kind is never touched).
 */
export function withoutLinkTail(value: string, grammar: RegExp): string;
export function withoutLinkTail(value: string | null, grammar: RegExp): string | null;
export function withoutLinkTail(value: string | null, grammar: RegExp): string | null {
  if (value === null || grammar.test(value) || !LINK_TAIL.test(value)) return value;
  const kept = value.replace(LINK_TAIL, "");
  return grammar.test(kept) ? kept : value;
}

/** A route's id: an Inbox or plan id, or a pull request's key (`#thread=…`, `&guide=…`, `&stack=…`). */
export function routeIdWithoutLinkTail(value: string): string {
  const ulid = withoutLinkTail(value, LINK_ULID_ID);
  return ulid !== value ? ulid : withoutLinkTail(value, LINK_PULL_KEY);
}

/**
 * On the way out: `text` with a space after it when it ends with a link, so the punctuation that follows in a
 * sentence (`Added https://git.example.com/acme/api/pull/3.`) is not taken into the link by a terminal.
 */
export function linkEnd(text: string): string {
  return /\bhttps?:\/\/\S+$/.test(text) ? `${text} ` : text;
}
