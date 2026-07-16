/**
 * Tater Identity System
 *
 * Generates anonymous identities for collaborative annotation sharing.
 * Format: {adjective}-{noun}-tater
 * Examples: "swift-falcon-tater", "gentle-crystal-tater"
 *
 * Resolution is delegated to ConfigStore (packages/ui/config/configStore.ts)
 * which handles: server config file > cookie > generated tater name.
 * This module provides the identity-specific API surface.
 */

import { configStore } from '../config';
import { generateIdentity } from './generateIdentity';

/**
 * Host-overridable identity provider.
 *
 * Default = today's tater behavior (ConfigStore-backed nickname + cookie match).
 * A host (e.g. Workspaces) calls setIdentityProvider once at startup to stamp its
 * logged-in user on comments and drive the `(me)` badge instead. Mirrors the
 * swappable storage backend in ./storage.ts (StorageBackend/setStorageBackend).
 */
export interface IdentityProvider {
  /** Display name stamped as `author` on new annotations. */
  getIdentity(): string;
  /** Whether an annotation's `author` is the current user (drives the `(me)` badge). */
  isCurrentUser(author: string | undefined): boolean;
  /**
   * Whether the user may change their own display name from the Settings UI.
   * Default (Plannotator's cookie identity) is editable. A host whose identity
   * is owned by its auth system (e.g. a logged-in Workspaces user, whose author
   * is the server-stamped account id) returns `false` so the rename/regenerate
   * controls are hidden — preventing a locally-chosen name from diverging from
   * the server-stamped author. Optional for backward-compat: absent ⇒ editable.
   */
  isEditable?(): boolean;
}

/**
 * Default provider: today's literal Plannotator behavior.
 * `displayName` resolution stays in ConfigStore (server config > cookie > tater).
 */
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

// Active provider. Defaults to the tater identity so Plannotator is unchanged.
let identityProvider: IdentityProvider = defaultIdentityProvider;

/** Override the identity provider. Call once at app startup. */
export function setIdentityProvider(p: IdentityProvider): void {
  identityProvider = p;
}

/** Reset to the default (tater) provider. Mainly for tests. */
export function resetIdentityProvider(): void {
  identityProvider = defaultIdentityProvider;
}

/**
 * Get current identity. Delegates to the active provider (default = ConfigStore tater).
 */
export function getIdentity(): string {
  return identityProvider.getIdentity();
}

/**
 * Set a custom display name.
 * Writes to cookie (sync) + queues server write-back (async) via ConfigStore.
 */
export function setCustomIdentity(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return getIdentity(); // reject empty
  configStore.set('displayName', trimmed);
  return trimmed;
}

/**
 * Regenerate identity with a new random tater name.
 * Writes to cookie + queues server write-back via ConfigStore.
 */
export function regenerateIdentity(): string {
  const identity = generateIdentity();
  configStore.set('displayName', identity);
  return identity;
}

/**
 * Check if an identity belongs to the current user. Delegates to the active provider.
 */
export function isCurrentUser(author: string | undefined): boolean {
  return identityProvider.isCurrentUser(author);
}

/**
 * Whether the current identity is user-editable (drives whether the Settings
 * rename/regenerate controls are shown). Delegates to the active provider;
 * defaults to editable when the provider doesn't implement `isEditable`.
 */
export function isIdentityEditable(): boolean {
  return identityProvider.isEditable ? identityProvider.isEditable() : true;
}
