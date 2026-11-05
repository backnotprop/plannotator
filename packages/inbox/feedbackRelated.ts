/**
 * "Might be related" under the Feedback box (components/FeedbackRelated.tsx):
 * plain word matching against feedbackRelated.data.json, in the window. The
 * person's words go nowhere: no request, not even to this Inbox's server.
 *
 * Strict on purpose. The owner's rule is that a wrong suggestion is worse than
 * none, and silence leaves the form exactly as it was. A line shows only when
 * its title is close to what was typed; see the gate in `relatedLinks`.
 * Measured on 100 sentences before this shipped (PR notes): about one in four
 * real requests gets a line, and most of those are right.
 */

/** A feature people ask for by another name. Whole phrases only: a single word fires under praise and bug reports ("this tool is trash"), and then says "Already there". */
export interface RelatedFeature {
  title: string;
  phrases: string[];
  reason: string;
  url: string;
}
export interface RelatedRelease {
  title: string;
  version: string;
}
export interface RelatedIssue {
  title: string;
  number: number;
  /** Titles of open PRs that cite this issue. They count for matching and are never shown. */
  prWords?: string;
}
/** The whole of feedbackRelated.data.json (scripts/feedback-related-index.ts writes it, newest first). */
export interface RelatedData {
  features: RelatedFeature[];
  releases: RelatedRelease[];
  issues: RelatedIssue[];
}

export interface RelatedLink {
  /** Whole: the row cuts it to one line, and the window offers the rest on hover. */
  title: string;
  reason: string;
  href: string;
  kind: Kind;
}

const REPO_URL = 'https://github.com/backnotprop/plannotator';

/** Under this many characters there is nothing to match yet. */
const MIN_CHARS = 8;
/** At most this much of the message is read; a line needs a short ask anyway. */
const MAX_CHARS = 4000;
const MAX_LINKS = 3;
const MIN_SCORE = 6;
/** A second line must score this close to the best one. */
const NEAR_BEST = 0.85;
/** The hand-written list stays out of a message with more real words than this. */
const FEATURE_MAX_WORDS = 4;
/** A run-on has no clauses: its first words count as one. */
const FEATURE_FIRST_WORDS = 8;

const STOP = new Set(
  `a about above after again all also am an and any are as at be because been before being below between both but by can cannot could did do does doing don down during each few for from further had has have having he her here hers him his how i if in into is it its itself just let like lets make made me more most my myself need needs no nor not now of off on once only or other our out over own please same she should so some such than that the their them then there these they this those through to too under until up us use using very instead want wanted wants was we were what when where which while who whom why will wish with would you your yours get gets got thing things way really still lot much many keep see able add adding allow allows support feature option maybe new`.split(
    /\s+/,
  ),
);
/** The product itself: said in most messages and most titles, so it never makes a match. "Inbox: show" asks nothing yet. */
const notProduct = (term: string) => term !== 'inbox';
/** One word alone must be this rare to count: "memory" says what is wrong, "show" says nothing yet. */
const ONE_WORD_MAX_SEEN = 10;
/** Words every other title has: they lift a match and never make one alone. */
const WEAK = new Set(
  `plannotator inbox app window page file files thread threads message messages agent agents session sessions fix fixes fixed error issue bug work works working update updates updated button review reviews reply replies`.split(
    /\s+/,
  ),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  const undouble = (x: string) => (/(bb|dd|gg|mm|nn|pp|rr|tt)$/.test(x) ? x.slice(0, -1) : x);
  if (word.length > 5 && word.endsWith('ing')) return undouble(word.slice(0, -3));
  if (word.length > 4 && word.endsWith('ed')) return undouble(word.slice(0, -2));
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

const words = (text: string): string[] => text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? [];

function tokens(text: string): string[] {
  return words(text)
    .filter((word) => word.length > 1 && !STOP.has(word))
    .map(stem)
    .filter((word) => !STOP.has(word));
}

/** Only these addresses are ever drawn as a link: the file is data, and a link must not be able to go anywhere else. */
export function isPublicRelatedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
    if (parsed.hostname === 'plannotator.ai') return parsed.pathname.startsWith('/docs/');
    return parsed.hostname === 'github.com' && parsed.pathname.startsWith('/backnotprop/plannotator/');
  } catch {
    return false;
  }
}

export type Kind = 'feature' | 'release' | 'issue';

interface Entry {
  kind: Kind;
  link: RelatedLink;
  terms: string[];
  key: string;
  phrases: string[][];
}

export interface RelatedIndex {
  entries: Entry[];
  documents: Map<string, number>;
  averageLength: number;
}

export function relatedIndex(data: RelatedData): RelatedIndex {
  const entries: Entry[] = [];
  const add = (kind: Kind, title: string, reason: string, href: string, extra = '', phrases: string[][] = []) => {
    if (!isPublicRelatedUrl(href)) return;
    entries.push({ kind, link: { title: title.replace(/\.$/, ''), reason, href, kind }, terms: tokens(`${title} ${extra}`), key: tokens(title).join(' '), phrases });
  };
  for (const feature of data.features) add('feature', feature.title, feature.reason, feature.url, '', feature.phrases.map((phrase) => phrase.split(' ').map(stem)));
  for (const release of data.releases) {
    if (/^v\d+\.\d+\.\d+$/.test(release.version)) add('release', release.title, `Release note, ${release.version}`, `${REPO_URL}/releases/tag/${release.version}`);
  }
  for (const issue of data.issues) {
    if (Number.isSafeInteger(issue.number) && issue.number > 0) add('issue', issue.title, `Open issue #${issue.number}`, `${REPO_URL}/issues/${issue.number}`, issue.prWords);
  }
  const documents = new Map<string, number>();
  let length = 0;
  for (const entry of entries) {
    for (const term of new Set(entry.terms)) documents.set(term, (documents.get(term) ?? 0) + 1);
    length += entry.terms.length * 2.5;
  }
  return { entries, documents, averageLength: entries.length ? length / entries.length : 1 };
}

/** Every word of the phrase, in order, with at most one word between neighbours: "close a thread", "mark a thread as unread". */
function saysPhrase(said: string[], phrase: string[]): boolean {
  return said.some((word, start) => {
    if (word !== phrase[0]) return false;
    let at = start;
    for (const next of phrase.slice(1)) {
      if (said[at + 1] === next) at += 1;
      else if (said[at + 2] === next) at += 2;
      else return false;
    }
    return true;
  });
}

/** The most a first sentence counts as the opening. */
const OPENING_WORDS = 16;
/** An opening needs this many words that count: "Hi team," says nothing yet. */
const OPENING_MIN_TERMS = 3;
/** A title of at least this many words, named whole and in order, holds however long the sentence around it gets. */
const NAMED_MIN_TERMS = 4;
/** What a later part must score to add a line, on top of naming a title outright. */
const LATER_MIN_SCORE = MIN_SCORE * 2;
/** Later parts add at most this many lines, and never replace one. */
const LATER_LINKS = 1;

/** The message by line and sentence, with a run-on first sentence cut after OPENING_WORDS words so it cannot gather loose ones. */
function partsOf(typed: string): string[] {
  const [first = '', ...rest] = typed.split(/\n+|(?<=[.?!])\s+/);
  const all = first.split(/\s+/);
  const cut = all.length > OPENING_WORDS ? [all.slice(0, OPENING_WORDS).join(' '), all.slice(OPENING_WORDS).join(' ')] : [first];
  return [...cut, ...rest].filter(Boolean);
}

/** Every word of a title of at least NAMED_MIN_TERMS words, in order: "Question cards" in passing does not count. */
function namesTitle(said: string[], terms: string[]): boolean {
  if (new Set(terms).size < NAMED_MIN_TERMS) return false;
  let at = -1;
  for (const term of terms) {
    at = said.indexOf(term, at + 1);
    if (at < 0) return false;
  }
  return true;
}

function matches(index: RelatedIndex, text: string, later: boolean): { entry: Entry; score: number }[] {
  const query = [...new Set(tokens(text))];
  if (!query.length) return [];
  const real = query.filter((term) => !WEAK.has(term));
  const said = tokens(text);
  const spoken = words(text).map(stem);
  // In the opening a feature is read clause by clause, and in its first few words: what follows cannot take it away. Later, a clause is too
  // easily a mention ("tried marking it unread"), so the whole part must be short.
  const clauses = (later ? [] : [...text.split(/[,;]\s/), text.split(/\s+/).slice(0, FEATURE_FIRST_WORDS).join(' ')]).map((clause) => ({ words: words(clause).map(stem), real: [...new Set(tokens(clause))].filter((term) => !WEAK.has(term)).length }));
  const weight = (term: string) => {
    const seen = index.documents.get(term) ?? 0;
    return Math.log(1 + (index.entries.length - seen + 0.5) / (seen + 0.5)) * (WEAK.has(term) ? 0.25 : 1);
  };

  const found: { entry: Entry; score: number }[] = [];
  for (const entry of index.entries) {
    if (entry.kind === 'feature') {
      const asked = clauses.some((clause) => clause.real <= FEATURE_MAX_WORDS && entry.phrases.some((phrase) => saysPhrase(clause.words, phrase)));
      if (asked || (real.length <= FEATURE_MAX_WORDS && entry.phrases.some((phrase) => saysPhrase(spoken, phrase)))) found.push({ entry, score: Infinity });
      continue;
    }
    const titleTerms = entry.terms.filter(notProduct);
    const length = entry.terms.length * 2.5;
    let score = 0;
    for (const term of query) {
      const count = entry.terms.filter((other) => other === term).length;
      if (!count) continue;
      const weighted = count * 2.5;
      score += weight(term) * ((weighted * 2.2) / (weighted + 1.2 * (0.25 + 0.75 * (length / index.averageLength))));
    }
    if (!score) continue;
    // Words in a row in the title count for more: in order, at most one word between ("blanks the entire page").
    const places = (term: string) => entry.terms.flatMap((other, at) => (other === term ? [at] : []));
    let inARow = 0;
    for (let at = 0; at + 1 < query.length; at++) {
      const next = places(query[at + 1]!);
      if (places(query[at]!).some((a) => next.some((b) => b > a && b - a <= 2))) inARow += 1;
    }
    score *= 1 + 0.4 * inARow;
    if (later) {
      if (score >= LATER_MIN_SCORE && namesTitle(said, titleTerms)) found.push({ entry, score });
      continue;
    }
    // The gate: a word in common is not enough.
    const realInTitle = real.filter((term) => entry.terms.includes(term)).length;
    const titleAsked = titleTerms.length ? titleTerms.filter((term) => query.includes(term)).length / titleTerms.length : 0;
    // "Mark unread": the title is what they asked for, in its own words and in about half of theirs.
    const snug = new Set(titleTerms).size >= 2 && titleAsked >= 0.6 && realInTitle >= 1 && query.filter((term) => titleTerms.includes(term)).length >= query.length / 2;
    // Two of three words through a long title, in the other order, are a coincidence.
    const firsts = real.map((term) => entry.terms.indexOf(term)).filter((at) => at >= 0);
    const sameOrder = firsts.every((at, n) => n === 0 || at > firsts[n - 1]!);
    const covered = real.length >= 2 && realInTitle >= Math.max(2, Math.ceil(real.length * 0.67)) && sameOrder;
    const oneWord = real.length === 1 && inARow >= 1 && (index.documents.get(real[0]!) ?? 0) <= ONE_WORD_MAX_SEEN; // One real word needs its neighbour beside it: "blank page", not "blank lines".
    if ((snug || covered || oneWord || namesTitle(said, titleTerms)) && score >= MIN_SCORE) found.push({ entry, score });
  }
  // Stable: at the same score the file's order, newest first, decides.
  return found.sort((a, b) => (a.score === b.score ? 0 : b.score - a.score));
}

/**
 * Up to three lines for what is typed, best first; none is the usual answer.
 * Never throws on any text. The same text always gives the same lines.
 *
 * The opening (the first line or sentence) decides, so what it found holds
 * however much is written after it. A later part may only add a line, and only
 * by naming a title outright or asking for a feature in a few words: scored
 * across a whole message, loose words kept replacing the good answer.
 */
export function relatedLinks(index: RelatedIndex, text: string): RelatedLink[] {
  const typed = text.trim().slice(0, MAX_CHARS);
  if (typed.length < MIN_CHARS) return [];
  const parts = partsOf(typed);
  let opened = 0;
  let opening = '';
  while (opened < parts.length && tokens(opening).length < OPENING_MIN_TERMS) opening = `${opening} ${parts[opened++]}`.trim();

  const found = matches(index, opening, false);
  // The hand-written list answered it: release notes on the same word only repeat it.
  const answered = found.some(({ entry }) => entry.kind === 'feature');
  const best = found.find(({ entry }) => entry.kind !== 'feature')?.score ?? 0;
  const room: Record<Kind, number> = { feature: 1, release: answered ? 0 : 2, issue: 1 };
  const shown = new Set<string>();
  const links: RelatedLink[] = [];
  const add = (entry: Entry): boolean => {
    if (shown.has(entry.key) || room[entry.kind] <= 0 || links.length === MAX_LINKS) return false;
    room[entry.kind] -= 1;
    shown.add(entry.key);
    links.push(entry.link);
    return true;
  };
  for (const { entry, score } of found) if (entry.kind === 'feature' || score >= best * NEAR_BEST) add(entry);

  let added = 0;
  for (const part of parts.slice(opened)) {
    for (const { entry } of matches(index, part, true)) if (added < LATER_LINKS && add(entry)) added += 1;
    if (added === LATER_LINKS) break;
  }
  return links;
}
