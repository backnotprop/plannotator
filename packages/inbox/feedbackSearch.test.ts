import { describe, expect, test } from 'bun:test';
import shipped from './feedbackSearch.data.json';
import { searchFeedback, type SearchData } from './feedbackSearch';

const data: SearchData = {
  features: [{ title: 'Pelican', definition: 'Carries threads across the harbor.', names: ['beak button'], url: 'https://plannotator.ai/docs/pelican' }],
  links: [
    { title: 'Lighthouse lamp flickers at dusk', path: 'issues/12' },
    { title: 'Café lighthouse menu', path: 'pull/34' },
    { title: 'Harbor charts', path: 'releases/tag/v1.2.3' },
    { title: 'Lighthouse lamp', path: 'pull/56' },
    { title: 'Beacon beacons glow', path: 'pull/78' },
  ],
};
const titles = (text: string) => searchFeedback(data, text).map((hit) => hit.title);

describe('searchFeedback', () => {
  test('similar text finds the item, despite an ending, a slipped letter or an accent', () => {
    expect(titles('harbor charts')).toEqual(['Harbor charts']);
    expect(titles('a chart of the harbors')).toEqual(['Harbor charts']);
    expect(titles('harbr charts')).toEqual(['Harbor charts']);
    expect(titles('cafe menu')).toEqual(['Café lighthouse menu']);
  });

  test('a feature is found by its name, its definition or another name, and brings its definition', () => {
    const hit = { title: 'Pelican', definition: 'Carries threads across the harbor.', href: 'https://plannotator.ai/docs/pelican' };
    expect(searchFeedback(data, 'pelican')).toEqual([hit]);
    expect(searchFeedback(data, 'the carries threads')).toEqual([hit]);
    expect(searchFeedback(data, 'I want a beak button')).toEqual([hit]);
  });

  test('anything else is only its title and its link', () => {
    expect(searchFeedback(data, 'harbor charts')).toEqual([{ title: 'Harbor charts', href: 'https://github.com/backnotprop/plannotator/releases/tag/v1.2.3' }]);
  });

  test('unrelated or short words find nothing', () => {
    for (const text of ['', 'the', 'the a of it', 'zebras dancing on saturn', 'lamp ideas for my garden', 'beacon zebras', 'light']) expect(titles(text)).toEqual([]);
  });

  test('only the first 4,000 characters are searched', () => {
    expect(titles(`${'x '.repeat(1990)}harbor charts`)).toEqual(['Harbor charts']);
    expect(titles(`${'x '.repeat(2000)}harbor charts`)).toEqual([]);
  });

  test('the closest comes first, and only a handful show', () => {
    expect(titles('lighthouse lamp')).toEqual(['Lighthouse lamp', 'Lighthouse lamp flickers at dusk']);
    const many = { features: [], links: Array.from({ length: 40 }, (_, at) => ({ title: `Lighthouse ${at}`, path: `pull/${at}` })) };
    expect(searchFeedback(many, 'lighthouse').length).toBeLessThanOrEqual(5);
  });

  test('the shipped file links only to the public docs and repo', () => {
    for (const { url } of shipped.features) expect(url).toMatch(/^https:\/\/(plannotator\.ai\/docs\/|github\.com\/backnotprop\/plannotator\/)/);
    for (const { path } of shipped.links) expect(path).toMatch(/^(issues|pull)\/\d+$|^releases\/tag\/v\d+\.\d+\.\d+$/);
  });
});
