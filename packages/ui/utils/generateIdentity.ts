/** Tater name generator: pure function, no storage dependencies. */

export type IdentityGenerator = () => string;

const FALLBACK_ADJECTIVES = [
  'swift', 'gentle', 'brave', 'calm', 'clever', 'bright', 'quiet', 'bold',
  'eager', 'kind', 'lucky', 'merry', 'nimble', 'proud', 'sunny', 'witty',
] as const;

const FALLBACK_NOUNS = [
  'falcon', 'crystal', 'river', 'meadow', 'harbor', 'comet', 'maple', 'otter',
  'summit', 'lantern', 'willow', 'ember', 'pebble', 'breeze', 'orchid', 'canyon',
] as const;

export const FALLBACK_IDENTITY_POOL: {
  readonly adjectives: readonly string[];
  readonly nouns: readonly string[];
} = {
  adjectives: FALLBACK_ADJECTIVES,
  nouns: FALLBACK_NOUNS,
};

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Built-in generator: same shape as the dictionary one, from a 16 x 16 pool. */
export const fallbackIdentityGenerator: IdentityGenerator = () =>
  `${pick(FALLBACK_ADJECTIVES)}-${pick(FALLBACK_NOUNS)}-tater`;

let generator: IdentityGenerator = fallbackIdentityGenerator;

/** Register the generator `generateIdentity()` delegates to. Must return a string synchronously. */
export function setIdentityGenerator(next: IdentityGenerator): void {
  generator = next;
}

/** The active generator. Exported so a test can assert which one is registered. */
export function getIdentityGenerator(): IdentityGenerator {
  return generator;
}

export function resetIdentityGenerator(): void {
  generator = fallbackIdentityGenerator;
}

export function generateIdentity(): string {
  return generator();
}
