/**
 * Terminals and many agent UIs make a link of everything from `http` to the next space, so a URL printed with
 * punctuation right after it (`(thread msg_…, http://localhost:19432/#thread=msg_…).`) opens a wrong address.
 * `linksNotEndingClean` lists every link in `text` that a terminal would take with a stray character at its end,
 * or that sits inside brackets or quotes: an empty list means every link ends at whitespace or the end.
 */

/** What a terminal takes into a link: from the scheme to the next whitespace. */
const LINK = /https?:\/\/\S+/g;
/** A link a terminal took this way must not end with one of these: they are the sentence's, not the address's. */
const STRAY_END = /[).,;:\]>"'`…]$/;
/** Nor open inside one of these. */
const OPENS_INSIDE = /[(\["'<`]$/;

export function linksNotEndingClean(text: string): string[] {
  const bad: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const before = text.slice(0, match.index);
    if (STRAY_END.test(match[0]) || OPENS_INSIDE.test(before)) bad.push(`${before.slice(-24)}${match[0]}`);
  }
  return bad;
}
