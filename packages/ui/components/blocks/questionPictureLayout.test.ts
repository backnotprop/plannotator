/**
 * The facts a host lays a question's picture choices out from, before any
 * picture loads (approval "picture-choices-layout", Adaptive).
 *
 * What regresses if this fails: an iPhone screenshot is taken for a full-page
 * capture (and cropped to its top) or the other way round, a terminal strip is
 * not a panorama, a set of phone screenshots stops getting narrow columns, a
 * picture of unknown size breaks a set into "mixed", or the words' length is
 * read from the raw markdown (a long hidden link URL, or Japanese counted as
 * half its drawn width), which moves three choices between Rows and columns.
 */
import { describe, expect, test } from 'bun:test';
import {
  drawnTextColumns,
  questionChoiceWords,
  questionPictureShape,
  questionPicturesShape,
  readQuestionPictureSize,
} from './questionPictureLayout';

describe('a picture\'s shape from its size', () => {
  test.each([
    [3840, 600, 'pano'],
    [1440, 900, 'wide'],
    [64, 64, 'square'],
    [1170, 2532, 'tall'], // an iPhone screenshot
    [1080, 2520, 'tall'], // a 9:21 phone
    [1170, 8000, 'scroll'], // a full-page capture
  ] as const)('%i x %i is %s', (width, height, shape) => {
    expect(questionPictureShape({ width, height })).toBe(shape);
  });

  test('a size that is missing, zero or not a number is unknown', () => {
    expect(readQuestionPictureSize(null)).toBeNull();
    expect(readQuestionPictureSize({ width: 0, height: 10 })).toBeNull();
    expect(readQuestionPictureSize({ width: '640', height: 480 })).toBeNull();
    expect(readQuestionPictureSize({ width: Number.NaN, height: 480 })).toBeNull();
    expect(readQuestionPictureSize({ width: 640, height: 480 })).toEqual({ width: 640, height: 480 });
  });
});

describe('a set\'s shape', () => {
  test('phone screenshots and full-page captures together are tall', () => {
    expect(questionPicturesShape(['tall', 'scroll', 'tall'])).toBe('tall');
  });
  test('only panoramas are a panorama set; one among others is mixed', () => {
    expect(questionPicturesShape(['pano', 'pano'])).toBe('pano');
    expect(questionPicturesShape(['pano', 'wide'])).toBe('mixed');
  });
  test('a picture of unknown size counts as wide: wide pictures stay a wide set, a phone screenshot beside it is mixed', () => {
    expect(questionPicturesShape(['wide', null, 'square'])).toBe('wide');
    expect(questionPicturesShape(['tall', null])).toBe('mixed');
  });
});

describe('how long the words run', () => {
  test('a link counts its text, not its URL; an image and the code and emphasis marks count nothing', () => {
    expect(drawnTextColumns('see [the notes](https://example.com/a/very/long/path/that/is/never/drawn?tab=comments)')).toBe('see the notes'.length);
    expect(drawnTextColumns('![a picture](shots/a.png) **bold** and `code`')).toBe('bold and code'.length);
  });
  test('CJK counts two columns a character', () => {
    expect(drawnTextColumns('設定ページ')).toBe(10);
  });
  test('a long hidden URL does not make short words long; Japanese of the same drawn width is as long as Latin', () => {
    const hidden = `A · Short — [link](https://example.com/${'x'.repeat(400)})`;
    expect(questionChoiceWords([{ label: hidden }])).toBe('short');
    // 50 CJK characters draw about as wide as 100 Latin ones.
    expect(questionChoiceWords([{ label: 'あ'.repeat(50) }])).toBe('medium');
    expect(questionChoiceWords([{ label: 'a'.repeat(50) }])).toBe('short');
  });
  test('the longest choice decides, label and description together', () => {
    expect(questionChoiceWords([{ label: 'A', description: 'b'.repeat(300) }, { label: 'B' }])).toBe('long');
    expect(questionChoiceWords([{ label: 'A', description: 'b'.repeat(500) }])).toBe('essay');
  });
});
