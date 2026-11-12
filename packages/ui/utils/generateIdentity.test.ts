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
    setIdentityGenerator(generateTaterIdentity);
    expect(getIdentityGenerator()).toBe(generateTaterIdentity);
    expect(generateIdentity()).toMatch(TATER);
  });

  test('the dictionary generator draws from beyond the fallback pool', () => {
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
