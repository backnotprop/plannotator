/**
 * Eager identity registration: installs the full `unique-username-generator`
 * dictionary into the generator slot in `./generateIdentity` at module
 * evaluation, before any settings read can mint a name.
 *
 * Every Plannotator entry (`packages/editor/App.tsx`, `packages/review-editor/App.tsx`)
 * imports this module for its side effect, which keeps Plannotator's tater
 * names byte-identical to before: same library, same config, same call. A host
 * that wants the full dictionary without its own identity provider imports it
 * too:
 *
 *   import '@plannotator/ui/utils/identity-tater';
 *
 * A host that provides `identityProvider` never calls the generator and should
 * NOT import this, so the word lists stay out of its bundle.
 */
import { uniqueUsernameGenerator, adjectives, nouns } from 'unique-username-generator';
import { setIdentityGenerator, type IdentityGenerator } from './generateIdentity';

/** The dictionary generator Plannotator has always used. */
export const generateTaterIdentity: IdentityGenerator = () => {
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
};

setIdentityGenerator(generateTaterIdentity);
