import { uniqueUsernameGenerator, adjectives, nouns } from 'unique-username-generator';
import { setIdentityGenerator, type IdentityGenerator } from './generateIdentity';

/** The dictionary generator Plannotator has always used. */
export const generateTaterIdentity: IdentityGenerator = () => {
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
