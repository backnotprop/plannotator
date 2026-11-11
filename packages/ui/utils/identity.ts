import { configStore } from '../config';
import { generateIdentity } from './generateIdentity';

export interface IdentityProvider {
  getIdentity(): string;
  isCurrentUser(author: string | undefined): boolean;
  isEditable?(): boolean;
}

const defaultIdentityProvider: IdentityProvider = {
  getIdentity(): string {
    return configStore.get('displayName');
  },
  isCurrentUser(author: string | undefined): boolean {
    if (!author) return false;
    return author === configStore.get('displayName');
  },
  isEditable(): boolean {
    return true;
  },
};

let identityProvider: IdentityProvider = defaultIdentityProvider;

export function setIdentityProvider(p: IdentityProvider): void {
  identityProvider = p;
}

export function resetIdentityProvider(): void {
  identityProvider = defaultIdentityProvider;
}

export function getIdentity(): string {
  return identityProvider.getIdentity();
}

export function setCustomIdentity(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return getIdentity(); // reject empty
  configStore.set('displayName', trimmed);
  return trimmed;
}

export function regenerateIdentity(): string {
  const identity = generateIdentity();
  configStore.set('displayName', identity);
  return identity;
}

export function isCurrentUser(author: string | undefined): boolean {
  return identityProvider.isCurrentUser(author);
}

/**
 * Whether the current identity is user-editable (drives whether the Settings rename/regenerate
 * controls are shown).
 */
export function isIdentityEditable(): boolean {
  return identityProvider.isEditable ? identityProvider.isEditable() : true;
}
