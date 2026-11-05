/**
 * "These might help" under the Feedback box: a plain word search over
 * feedbackSearch.data.json, in the window. What is typed goes nowhere.
 *
 * Words of four letters or more count, so "the" finds nothing. A title or a
 * definition is similar when it shares most of the shorter side's words with
 * what is typed. A feature's other name ("done button") finds it when all its
 * words are typed. Only the first 4,000 characters are searched, the send
 * limit: a long paste stays quick.
 */
/// <reference path="./assets.d.ts" />
import { FEEDBACK_MESSAGE_MAX } from '@plannotator/core/product-feedback';

export interface SearchFeature {
  title: string;
  definition: string;
  names: string[];
  url: string;
}
export interface SearchData {
  features: SearchFeature[];
  links: { title: string; path: string }[];
}
export interface SearchHit {
  title: string;
  definition?: string;
  href: string;
}

const REPO_URL = 'https://github.com/backnotprop/plannotator/';
const MAX_SHOWN = 5;
/** The one threshold: the share of the shorter side's words in common. */
const SIMILAR = 0.6;

function wordsOf(text: string, shortest = 4): string[] {
  const folded = text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
  return [...new Set(folded.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((word) => word.length >= shortest);
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
  /** Common words over the entry's length, so of two titles sharing as much, the shorter is closer. */
  const closeness = (entry: string) => {
    const words = wordsOfEntry(entry);
    const common = typed.filter((word) => words.some((other) => sameWord(other, word))).length;
    return common / Math.min(typed.length, words.length || 1) >= SIMILAR ? common + common / words.length : 0;
  };
  const hits = [
    ...data.features.map(({ title, definition, names, url }) => ({
      title,
      definition,
      href: url,
      score: names.some((name) => wordsOf(name, 1).every((word) => typedAll.some((other) => sameWord(other, word)))) ? Infinity : Math.max(closeness(title), closeness(definition)),
    })),
    ...data.links.map(({ title, path }) => ({ title, href: REPO_URL + path, score: closeness(title) })),
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
