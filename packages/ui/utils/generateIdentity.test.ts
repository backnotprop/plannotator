/**
 * Identity generator slot (utils/generateIdentity.ts) and its eager entry.
 *
 * What regresses if these fail:
 * - the built-in fallback stops producing the `adjective-noun-tater` shape
 *   synchronously (configStore persists the first name to the cookie during
 *   the first render-time settings read, so an async or malformed name would
 *   be a visible identity change);
 * - importing `identity-tater` no longer registers the full dictionary, which
 *   would silently move Plannotator's names onto the 16 x 16 pool;
 * - `configurePlannotatorUI({ identityGenerator })` is ignored.
 *
 * Bun shares one process across files: the generator is restored after each
 * test so files that rely on the dictionary keep it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FALLBACK_IDENTITY_POOL,
  fallbackIdentityGenerator,
  generateIdentity,
  getIdentityGenerator,
  resetIdentityGenerator,
  setIdentityGenerator,
} from './generateIdentity';
import { generateTaterIdentity } from './identity-tater';
import { configurePlannotatorUI } from '../configure';

const TATER = /^[a-z]+(?:-[a-z]+)*-[a-z]+(?:-[a-z]+)*-tater$/;
const saved = getIdentityGenerator();

afterEach(() => {
  setIdentityGenerator(saved);
});

describe('fallback generator', () => {
  test('produces the tater shape from the built-in pool without any registration', () => {
    resetIdentityGenerator();
    for (let i = 0; i < 32; i += 1) {
      const name = generateIdentity();
      expect(name).toMatch(/^[a-z]+-[a-z]+-tater$/);
      const [adjective, noun] = name.split('-');
      expect(FALLBACK_IDENTITY_POOL.adjectives).toContain(adjective);
      expect(FALLBACK_IDENTITY_POOL.nouns).toContain(noun);
    }
    expect(getIdentityGenerator()).toBe(fallbackIdentityGenerator);
  });
});

describe('identity-tater eager entry', () => {
  test('importing it registers the full dictionary generator', () => {
    // The import at the top of this file already ran the side effect once;
    // re-registering here makes the assertion independent of test order.
    setIdentityGenerator(generateTaterIdentity);
    expect(getIdentityGenerator()).toBe(generateTaterIdentity);
    expect(generateIdentity()).toMatch(TATER);
  });

  test('the dictionary generator draws from beyond the fallback pool', () => {
    // 1,400+ adjectives against a 16-word pool: 64 draws all inside the pool
    // has probability well under 1e-100, so this is deterministic in practice.
    const pool = new Set<string>(FALLBACK_IDENTITY_POOL.adjectives);
    const outside = Array.from({ length: 64 }, () => generateTaterIdentity()).some((name) => {
      const adjective = name.slice(0, name.indexOf('-'));
      return !pool.has(adjective);
    });
    expect(outside).toBe(true);
  });
});

describe('configurePlannotatorUI({ identityGenerator })', () => {
  test('installs the host generator', () => {
    configurePlannotatorUI({ identityGenerator: () => 'host-picked-tater' });
    expect(generateIdentity()).toBe('host-picked-tater');
  });
});
