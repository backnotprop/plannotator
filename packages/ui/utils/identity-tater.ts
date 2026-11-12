import { uniqueUsernameGenerator, adjectives, nouns } from 'unique-username-generator';
import { setIdentityGenerator, type IdentityGenerator } from './generateIdentity';

export const generateTaterIdentity: IdentityGenerator = () => {
  const generated = uniqueUsernameGenerator({
    dictionaries: [adjectives, nouns],
    separator: '|||',
    style: 'lowerCase',
    randomDigits: 0,
    length: 50,
  });

  const [adjective, noun] = generated.split('|||');
  return `${adjective}-${noun}-tater`;
};

setIdentityGenerator(generateTaterIdentity);
