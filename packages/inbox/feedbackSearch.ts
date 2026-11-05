/**
 * "These might help" under the Feedback box: a plain word search over
 * feedbackSearch.data.json, in the window. What is typed goes nowhere.
 *
 * Words of four letters or more count, so "the" finds nothing. A title or a
 * definition is similar when it shares most of the shorter side's words with
 * what is typed. A feature's other name ("done button") finds it when all its
 * words are typed.
 */
/// <reference path="./assets.d.ts" />
import shipped from './feedbackSearch.data.json?raw';

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

/** The same word, give or take an ending or one slipped letter: "links" and "link", "archve" and "archive". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  let at = 0;
  while (a[at] === b[at]) at += 1;
  return a.slice(at + 1) === b.slice(at + 1) || a.slice(at + 1) === b.slice(at) || a.slice(at) === b.slice(at + 1);
}

export function searchFeedback(data: SearchData, text: string): SearchHit[] {
  const typed = wordsOf(text);
  if (!typed.length) return [];
  const typedAll = wordsOf(text, 1);
  /** Common words over the entry's length, so of two titles sharing as much, the shorter is closer. */
  const closeness = (entry: string) => {
    const words = wordsOf(entry);
    const common = words.filter((word) => typed.some((other) => sameWord(other, word))).length;
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

/** Parsed at the first search: a window that never opens the form holds only the string (#2593). */
let parsed: SearchData | null = null;
export const searchShipped = (text: string) => searchFeedback((parsed ??= JSON.parse(shipped) as SearchData), text);
