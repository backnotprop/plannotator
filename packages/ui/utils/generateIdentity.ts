/**
 * Tater name generator: pure function, no storage dependencies.
 *
 * Extracted to its own module to avoid circular imports:
 * settings.ts needs this for the default value, and identity.ts
 * needs configStore (which imports settings.ts).
 *
 * The full `unique-username-generator` dictionary is NOT imported here. It is
 * registered into the slot below by `./identity-tater`, which every
 * Plannotator entry imports eagerly, so Plannotator mints names from the
 * full dictionary exactly as before. A host that provides its own
 * `identityProvider` never calls the generator and, with the static import
 * gone, no longer ships the word lists.
 *
 * The slot is SYNCHRONOUS on purpose: `configStore.ensureLoaded()` evaluates
 * this default during the first settings read (a render-time read) and
 * persists the result to the identity cookie at once, so a name that arrived
 * later would be a visible identity change. The built-in fallback below keeps
 * the same `{adjective}-{noun}-tater` shape from a small inline pool.
 */

export type IdentityGenerator = () => string;

const FALLBACK_ADJECTIVES = [
  'swift', 'gentle', 'brave', 'calm', 'clever', 'bright', 'quiet', 'bold',
  'eager', 'kind', 'lucky', 'merry', 'nimble', 'proud', 'sunny', 'witty',
] as const;

const FALLBACK_NOUNS = [
  'falcon', 'crystal', 'river', 'meadow', 'harbor', 'comet', 'maple', 'otter',
  'summit', 'lantern', 'willow', 'ember', 'pebble', 'breeze', 'orchid', 'canyon',
] as const;

/** Pool words: exported for tests only. */
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

/**
 * Register the generator `generateIdentity()` delegates to. Must return a
 * string synchronously. `./identity-tater` registers the full dictionary;
 * a host may register its own via `configurePlannotatorUI({ identityGenerator })`.
 */
export function setIdentityGenerator(next: IdentityGenerator): void {
  generator = next;
}

/** The active generator. Exported so a test can assert which one is registered. */
export function getIdentityGenerator(): IdentityGenerator {
  return generator;
}

/** Reset to the built-in fallback pool. Mainly for tests. */
export function resetIdentityGenerator(): void {
  generator = fallbackIdentityGenerator;
}

/**
 * Generate a new random tater identity.
 * Format: {adjective}-{noun}-tater
 * Examples: "swift-falcon-tater", "gentle-crystal-tater"
 */
export function generateIdentity(): string {
  return generator();
}
