import { afterEach, describe, expect, it } from 'bun:test';
import * as identityModule from './identity';

const setIdentityProvider = identityModule.setIdentityProvider;
const resetIdentityProvider = identityModule.resetIdentityProvider;
const getIdentity = identityModule.getIdentity;
const isCurrentUser = identityModule.isCurrentUser;
const isIdentityEditable = identityModule.isIdentityEditable;

afterEach(() => {
  resetIdentityProvider();
});

describe('IdentityProvider seam', () => {
  it('routes getIdentity() through the fake provider', () => {
    const calls: string[] = [];
    const fake = {
      getIdentity: () => { calls.push('getIdentity'); return 'workspace-user@example.com'; },
      isCurrentUser: (_author: string | undefined) => false,
    };

    setIdentityProvider(fake);

    const result = getIdentity();

    expect(calls).toEqual(['getIdentity']);
    expect(result).toBe('workspace-user@example.com');
  });

  it('routes isCurrentUser() through the fake provider', () => {
    const checked: Array<string | undefined> = [];
    const fake = {
      getIdentity: () => 'user@example.com',
      isCurrentUser: (author: string | undefined) => {
        checked.push(author);
        return author === 'user@example.com';
      },
    };

    setIdentityProvider(fake);

    expect(isCurrentUser('user@example.com')).toBe(true);
    expect(isCurrentUser('other@example.com')).toBe(false);
    expect(checked).toEqual(['user@example.com', 'other@example.com']);
  });

  it('isIdentityEditable() reflects the fake provider (host owns identity ⇒ false)', () => {
    setIdentityProvider({
      getIdentity: () => 'workspace-user',
      isCurrentUser: () => false,
      isEditable: () => false,
    });
    expect(isIdentityEditable()).toBe(false);
  });

  it('isIdentityEditable() defaults to true when the provider omits isEditable', () => {
    setIdentityProvider({
      getIdentity: () => 'legacy-host',
      isCurrentUser: () => false,
    });
    expect(isIdentityEditable()).toBe(true);
  });

  it('default (tater) provider is editable', () => {
    resetIdentityProvider();
    expect(isIdentityEditable()).toBe(true);
  });

  it('resetIdentityProvider restores the default (ConfigStore-backed) provider', () => {
    const fake = {
      getIdentity: () => 'should-not-appear',
      isCurrentUser: () => false,
    };

    setIdentityProvider(fake);
    resetIdentityProvider();

    const result = getIdentity();
    expect(result).not.toBe('should-not-appear');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
