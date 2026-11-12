/**
 * Words that name people, in parts (the owner, q-331c0466: a small face by every person's name in Reviews and the Pull
 * requests board). A status is plain text and people: "Review requested · " then tomas with "'s" riding on the name,
 * then " PR". The window draws a person with their face (`Named`); the text (`wordsText`) is what a tooltip, a screen
 * reader and the tests read, the same words as before.
 */

/** A person in the words: their login, the letters that stay on the name ("'s"), and whether their face shows. */
export interface PersonPart {
  person: string;
  tail?: string;
  /** False when this person is already pictured in the same row (`facesOnce`): the name shows without a face. */
  face?: false;
}

export type WordPart = string | PersonPart;
export type Words = readonly WordPart[];

export const person = (login: string, tail?: string): PersonPart => (tail ? { person: login, tail } : { person: login });

export const isPerson = (part: WordPart): part is PersonPart => typeof part !== 'string';

/** The words as one string. */
export function wordsText(words: Words): string {
  return words.map((part) => (isPerson(part) ? part.person + (part.tail ?? '') : part)).join('');
}

/**
 * Not twice in a row (the owner: "Everywhere, but not twice in a row"): a person already pictured in the row (its
 * left circle, `pictured`), or named earlier in the same words, keeps their name but not a second face.
 */
export function facesOnce(words: Words, pictured: readonly (string | null | undefined)[] = []): Words {
  const seen = new Set(pictured.filter((who): who is string => !!who));
  return words.map((part) => {
    if (!isPerson(part)) return part;
    if (seen.has(part.person)) return { ...part, face: false as const };
    seen.add(part.person);
    return part;
  });
}

/** "tomas's", "james'": the letters a possessive adds to a name. */
export const possessiveTail = (name: string, apostrophe = "'"): string => (name.endsWith('s') ? apostrophe : `${apostrophe}s`);
