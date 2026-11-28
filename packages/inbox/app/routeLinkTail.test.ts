/**
 * The window opened from a link that carried its sentence's punctuation (an older agent printed
 * `(thread msg_…, http://localhost:19432/#thread=msg_…).` and a terminal linked the `).` too) opens that thread,
 * not a thread that does not exist. Only ids lose the tail: a path or a name in the address keeps every character.
 */
import { describe, expect, test } from 'bun:test';
import { routeOf } from './route';

const THREAD = 'msg_01M7VKGWJTN05MAA6M48FV0HY0';
const GUIDE = 'msg_01M7VKGWJTN05MAA6M48FV0HY1';
const FILE = 'att_01M7VKGWJTN05MAA6M48FV0HY2';

describe('an id with the punctuation after its link', () => {
  test('a thread link with `).` opens that thread', () => {
    for (const tail of [').', '.', ',', ';', ':', ']', '>', '"', "'"]) expect(routeOf(`#thread=${THREAD}${tail}`).thread).toBe(THREAD);
  });

  test('the last id of the address loses it: a guide, a message, a file', () => {
    expect(routeOf(`#thread=${THREAD}&guide=${GUIDE}).`)).toMatchObject({ thread: THREAD, guide: GUIDE });
    expect(routeOf(`#thread=${THREAD}&msg=${THREAD}.`).msg).toBe(THREAD);
    expect(routeOf(`#thread=${THREAD}&file=${FILE}).`).file?.id).toBe(FILE);
  });

  test("a pull request's key keeps the dots of its host and loses only the tail", () => {
    const key = encodeURIComponent('github.com/acme/api#12');
    expect(routeOf(`#reviews&stack=${key}).`).stack).toBe('github.com/acme/api#12');
    expect(routeOf(`#reviews&stack=${key}`).stack).toBe('github.com/acme/api#12');
  });

  test('a path or a name keeps every character', () => {
    expect(routeOf(`#thread=${THREAD}&file=${FILE}&linked=${encodeURIComponent('notes (v2).')}`).file?.linked).toBe('notes (v2).');
    expect(routeOf('#tag=release.').tag).toBe('release.');
    expect(routeOf('#thread=the layoffs.').thread).toBe('the layoffs.');
  });

  test("a plan's artifact path keeps every character; an Inbox file id still loses the tail", () => {
    for (const file of ['notes/bug#12.', 'notes/bug#12)', 'notes/bug#12).', 'report.']) {
      expect(routeOf(`#plans=pln_01M7VKGWJTN05MAA6M48FV0HY3&file=${encodeURIComponent(file)}`).planFile).toBe(file);
    }
    expect(routeOf(`#thread=${THREAD}&file=${FILE}).`).file?.id).toBe(FILE);
  });
});
