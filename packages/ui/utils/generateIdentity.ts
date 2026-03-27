/**
 * Tater name generator — pure function, no storage dependencies.
 *
 * Extracted to its own module to avoid circular imports:
 * settings.ts needs this for the default value, and identity.ts
 * needs configStore (which imports settings.ts).
 */

import { uniqueUsernameGenerator, adjectives, nouns } from 'unique-username-generator';

/**
 * Generate a new random tater identity.
 * Format: {adjective}-{noun}-tater
 * Examples: "swift-falcon-tater", "gentle-crystal-tater"
 */
export function generateIdentity(): string {
  // Use a unique separator to split adjective from noun, avoiding issues
  // with compound words that contain hyphens (e.g., "behind-the-scenes")
  const generated = uniqueUsernameGenerator({
    dictionaries: [adjectives, nouns],
    separator: '|||',
    style: 'lowerCase',
    randomDigits: 0,
    length: 50, // Prevent word truncation (default is too short)
  });

  const [adjective, noun] = generated.split('|||');
  return `${adjective}-${noun}-tater`;
}
