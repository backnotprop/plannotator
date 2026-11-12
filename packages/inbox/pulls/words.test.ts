import { expect, test } from 'bun:test';
import { facesOnce, person, wordsText } from './words';

test('not twice in a row: the person the row already pictures keeps their name without a second face', () => {
  const words = ['Review requested · ', person('tomas', "'s"), ' PR'];
  expect(facesOnce(words, ['tomas'])).toEqual(['Review requested · ', { person: 'tomas', tail: "'s", face: false }, ' PR']);
  expect(facesOnce(words, ['dana'])).toEqual(words);
  expect(facesOnce(words, [null, undefined])).toEqual(words);
  expect(facesOnce(['Waits on ', person('nina-k'), ' and ', person('nina-k')])).toEqual(['Waits on ', { person: 'nina-k' }, ' and ', { person: 'nina-k', face: false }]);
  expect(wordsText(facesOnce(words, ['tomas']))).toBe("Review requested · tomas's PR");
});

