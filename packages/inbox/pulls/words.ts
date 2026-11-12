export interface PersonPart {
  person: string;
  tail?: string;
  face?: false;
}

export type WordPart = string | PersonPart;
export type Words = readonly WordPart[];

export const person = (login: string, tail?: string): PersonPart => (tail ? { person: login, tail } : { person: login });

export const isPerson = (part: WordPart): part is PersonPart => typeof part !== 'string';

export function wordsText(words: Words): string {
  return words.map((part) => (isPerson(part) ? part.person + (part.tail ?? '') : part)).join('');
}

export function facesOnce(words: Words, pictured: readonly (string | null | undefined)[] = []): Words {
  const seen = new Set(pictured.filter((who): who is string => !!who));
  return words.map((part) => {
    if (!isPerson(part)) return part;
    if (seen.has(part.person)) return { ...part, face: false as const };
    seen.add(part.person);
    return part;
  });
}

export const possessiveTail = (name: string, apostrophe = "'"): string => (name.endsWith('s') ? apostrophe : `${apostrophe}s`);
