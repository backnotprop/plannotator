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
 * Get current identity from ConfigStore.
 */
export function getIdentity(): string {
  return configStore.get('displayName');
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
 * Check if an identity belongs to the current user.
 */
export function isCurrentUser(author: string | undefined): boolean {
  if (!author) return false;
  return author === configStore.get('displayName');
}
