/**
 * "These might help" under the Feedback box: a plain word search over
 * feedbackSearch.data.json, in the window. What is typed goes nowhere.
 *
 * Only meaningful words count: four letters or more, and not filler ("with",
 * "please", "really", "inbox"; FILLER below). A title is similar when it shares
 * at least two of them with what is typed, and most of the shorter side's
 * (approval "inbox-feedback-faq", 2026-11-09: "Pin threads" no longer answers
 * "threads reorder"). A hand-written feature also shows for its one-word name
 * or for another name ("done button") when all its words are typed. A closed
 * issue carries the release that fixed it, so its line says "Fixed in 0.28.52".
 * Only the first 4,000 characters are searched, the send limit: a long paste
 * stays quick.
 */
/// <reference path="./assets.d.ts" />
import { FEEDBACK_MESSAGE_MAX } from '@plannotator/core/product-feedback';

export interface SearchFeature {
  title: string;
  definition: string;
  names: string[];
  url: string;
}
export interface SearchLink {
  title: string;
  path: string;
  /** A closed issue: the release that fixed it, without its "v" ("0.28.52"). */
  fixed?: string;
}
export interface SearchData {
  features: SearchFeature[];
  links: SearchLink[];
}
export interface SearchHit {
  title: string;
  definition?: string;
  href: string;
  /** "Fixed in {fixed}". */
  fixed?: string;
}

const REPO_URL = 'https://github.com/backnotprop/plannotator/';
const MAX_SHOWN = 5;
/** The share of the shorter side's meaningful words in common. */
const SIMILAR = 0.6;
/** And never fewer than this many in common, for anything but a feature's own one-word name. */
const AT_LEAST = 2;
/** A word in this share of the titles or more is common, and never in fewer than COMMON_FLOOR titles. */
const COMMON_SHARE = 1 / 50;
const COMMON_FLOOR = 20;

/**
 * Words that say nothing about what is meant: filler, and the product's own names (in the Inbox's own form, every
 * title is about the Inbox). Four letters or more only: shorter words never count. Contractions split at the
 * apostrophe ("doesn't" is "doesn").
 */
const FILLER = new Set(
  (
    'about above actually after again against almost also always another anyone anything anyway around away back because been before being below ' +
    'better between both cannot could couldn didn does doesn doing down during each either else even ever every everything example feature features ' +
    'from further getting gets give given going gone good great hasn have haven having hello here hope however idea ideas instead into isn issue issues ' +
    'just keep keeps kept kind know less like likely lots love made make makes making many maybe more most much must need needed needs never nice only other others ' +
    'over please plannotator inbox pretty probably problem problems quite rather really request requests right same seem seems should shouldn since ' +
    'some someone something sometimes somewhere soon still such sure than thank thanks that their them then there these they thing things think ' +
    'this those though through together totally very want wanted wants wasn well were what when where whether which while will wish with within ' +
    'without work worked working works would wouldn yeah your yours'
  ).split(' '),
);

function wordsOf(text: string, shortest = 4): string[] {
  const folded = text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  return [...new Set(folded.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length >= shortest && (shortest < 4 || !FILLER.has(word)));
}

/** The same word, give or take an ending of up to 3 letters or one slipped letter: "links" and "link", "archve" and "archive". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if ((a.startsWith(b) || b.startsWith(a)) && Math.abs(a.length - b.length) <= 3) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let at = 0;
  while (a[at] === b[at]) at += 1;
  return a.slice(at + 1) === b.slice(at + 1) || a.slice(at + 1) === b.slice(at) || a.slice(at) === b.slice(at + 1);
}

/** Each title is split once. */
const split = new Map<string, string[]>();
const wordsOfEntry = (entry: string) => split.get(entry) ?? split.set(entry, wordsOf(entry)).get(entry)!;

export function searchFeedback(data: SearchData, text: string): SearchHit[] {
  const searched = text.slice(0, FEEDBACK_MESSAGE_MAX);
  const typed = wordsOf(searched);
  if (!typed.length) return [];
  const typedAll = wordsOf(searched, 1);
  /** The typed words each title or definition has, worked out once per search. */
  const sharedBy = new Map<string, string[]>();
  const shared = (entry: string) => sharedBy.get(entry) ?? sharedBy.set(entry, typed.filter((word) => wordsOfEntry(entry).some((other) => sameWord(other, word)))).get(entry)!;
  // A typed word in one title out of 50 or more ("list", "agent", "review" in 3,000 titles) is too common to make two titles alike: at least one word in common must be rarer.
  const titlesWith = new Map(typed.map((word) => [word, 0]));
  for (const { title } of data.links) for (const word of shared(title)) titlesWith.set(word, titlesWith.get(word)! + 1);
  const rare = (word: string) => titlesWith.get(word)! < Math.max(COMMON_FLOOR, data.links.length * COMMON_SHARE);
  /** Words in common over the entry's length, so of two titles sharing as much, the shorter is closer. `least`: the fewest in common that count. */
  const closeness = (entry: string, least = AT_LEAST) => {
    const words = wordsOfEntry(entry);
    const common = shared(entry);
    return common.length >= least && common.some(rare) && common.length / Math.min(typed.length, words.length || 1) >= SIMILAR ? common.length + common.length / words.length : 0;
  };
  const hits: (SearchHit & { score: number })[] = [
    ...data.features.map(({ title, definition, names, url }) => ({
      title,
      definition,
      href: url,
      score: names.some((name) => wordsOf(name, 1).every((word) => typedAll.some((other) => sameWord(other, word))))
        ? Infinity
        : Math.max(closeness(title, Math.min(AT_LEAST, wordsOfEntry(title).length || AT_LEAST)), closeness(definition)),
    })),
    ...data.links.map(({ title, path, fixed }) => ({ title, href: REPO_URL + path, ...(fixed ? { fixed } : {}), score: closeness(title) })),
  ];
  return hits
    .filter(({ score }) => score > 0)
    .sort((a, b) => (a.score === b.score ? 0 : b.score - a.score))
    .slice(0, MAX_SHOWN)
    .map(({ score: _score, ...hit }) => hit);
}

/** Loaded and parsed at the first search, so a window that never opens the form holds none of it. A failed load shows no lines. */
let shipped: Promise<SearchData> | null = null;
export async function searchShipped(text: string): Promise<SearchHit[]> {
  if (!text.trim()) return [];
  shipped ??= import('./feedbackSearch.data.json?raw').then((file) => JSON.parse(file.default) as SearchData);
  try {
    return searchFeedback(await shipped, text);
  } catch {
    return [];
  }
}
