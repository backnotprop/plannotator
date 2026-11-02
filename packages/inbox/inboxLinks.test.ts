/**
 * Which links open in this window (links.ts `inboxLinkHash`): the address has
 * to be this Inbox, under any of its spellings, and the hash a route the window
 * reads. Everything else stays the browser's new tab, so a linked machine's
 * thread never opens as an empty one here.
 */
import { describe, expect, test } from 'bun:test';
import { inboxLinkHash, type InboxHere } from './links';

const LOCAL = 'http://localhost:19432';
const TAILNET = 'https://mac-mini.tail1234.ts.net';
const onThisComputer: InboxHere = { origin: LOCAL, addresses: [`${LOCAL}/`, TAILNET] };
const overTheTailnet: InboxHere = { origin: TAILNET, addresses: [`${LOCAL}/`, TAILNET] };

describe('this Inbox', () => {
  test('the window\'s own origin', () => {
    expect(inboxLinkHash(`${LOCAL}/#thread=msg_T2`, onThisComputer)).toBe('#thread=msg_T2');
    expect(inboxLinkHash(`${LOCAL}#thread=msg_T2`, onThisComputer)).toBe('#thread=msg_T2');
  });

  test('another spelling of this computer on the same port', () => {
    expect(inboxLinkHash('http://127.0.0.1:19432/#thread=msg_T2', onThisComputer)).toBe('#thread=msg_T2');
    expect(inboxLinkHash('http://[::1]:19432/#thread=msg_T2', onThisComputer)).toBe('#thread=msg_T2');
  });

  test('the tailnet address from a window on this computer', () => {
    expect(inboxLinkHash(`${TAILNET}/#thread=msg_T2`, onThisComputer)).toBe('#thread=msg_T2');
  });

  test('the address agents are given, from a window over the tailnet where it would not load', () => {
    expect(inboxLinkHash(`${LOCAL}/#thread=msg_T2`, overTheTailnet)).toBe('#thread=msg_T2');
    expect(inboxLinkHash('http://127.0.0.1:19432/#thread=msg_T2', overTheTailnet)).toBe('#thread=msg_T2');
  });

  test('before the settings load only the window\'s own address counts', () => {
    const early: InboxHere = { origin: LOCAL, addresses: [undefined, null] };
    expect(inboxLinkHash(`${LOCAL}/#thread=msg_T2`, early)).toBe('#thread=msg_T2');
    expect(inboxLinkHash(`${TAILNET}/#thread=msg_T2`, early)).toBeNull();
  });
});

describe('not this Inbox', () => {
  test('another port on this computer', () => {
    expect(inboxLinkHash('http://localhost:19433/#thread=msg_T2', onThisComputer)).toBeNull();
    expect(inboxLinkHash('http://127.0.0.1:19433/#thread=msg_T2', onThisComputer)).toBeNull();
  });

  test('another host, a linked machine or the web', () => {
    expect(inboxLinkHash('https://macbook.tail1234.ts.net/#thread=msg_T2', onThisComputer)).toBeNull();
    expect(inboxLinkHash('https://example.com/#thread=msg_T2', onThisComputer)).toBeNull();
    expect(inboxLinkHash('http://192.168.1.9:19432/#thread=msg_T2', onThisComputer)).toBeNull();
  });

  test('another scheme on the same port', () => {
    expect(inboxLinkHash('https://localhost:19432/#thread=msg_T2', onThisComputer)).toBeNull();
  });

  test('another page of the same server', () => {
    expect(inboxLinkHash(`${LOCAL}/api/inbox/threads#thread=msg_T2`, onThisComputer)).toBeNull();
    expect(inboxLinkHash('notes.md#thread=msg_T2', onThisComputer)).toBeNull();
  });

  test('what never parses as a link', () => {
    expect(inboxLinkHash('http://', onThisComputer)).toBeNull();
    expect(inboxLinkHash('mailto:someone@example.com', onThisComputer)).toBeNull();
    expect(inboxLinkHash('', onThisComputer)).toBeNull();
  });
});

describe('the route', () => {
  test('keeps the message or the file the link names', () => {
    expect(inboxLinkHash(`${LOCAL}/#thread=msg_T2&msg=msg_M2`, onThisComputer)).toBe('#thread=msg_T2&msg=msg_M2');
    expect(inboxLinkHash(`${LOCAL}/#thread=msg_T2&file=att_F1`, onThisComputer)).toBe('#thread=msg_T2&file=att_F1');
  });

  test('a project and Settings open in place', () => {
    expect(inboxLinkHash(`${LOCAL}/#project=prj_A`, onThisComputer)).toBe('#project=prj_A');
    expect(inboxLinkHash(`${LOCAL}/#settings`, onThisComputer)).toBe('#settings');
    expect(inboxLinkHash(`${LOCAL}/#settings/agents`, onThisComputer)).toBe('#settings/agents');
  });

  test('no route in the hash leaves the link alone', () => {
    expect(inboxLinkHash(`${LOCAL}/`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#a-heading`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#thread=`, onThisComputer)).toBeNull();
  });

  test('the other pages of the window stay new tabs', () => {
    expect(inboxLinkHash(`${LOCAL}/#board=shipped`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#board&project=prj_A`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#drafts`, onThisComputer)).toBeNull();
    expect(inboxLinkHash(`${LOCAL}/#tour=3`, onThisComputer)).toBeNull();
  });
});

describe('a bare hash', () => {
  test('is on this page, whatever the window\'s address', () => {
    expect(inboxLinkHash('#thread=msg_T2', overTheTailnet)).toBe('#thread=msg_T2');
    expect(inboxLinkHash('#thread=msg_T2&msg=msg_M2', onThisComputer)).toBe('#thread=msg_T2&msg=msg_M2');
    expect(inboxLinkHash('#project=prj_A', onThisComputer)).toBe('#project=prj_A');
  });

  test('a heading of a document stays a heading, even one called Settings', () => {
    expect(inboxLinkHash('#settings', onThisComputer)).toBeNull();
    expect(inboxLinkHash('#a-heading', onThisComputer)).toBeNull();
  });

  test('the window\'s own Settings links are left to the anchors that draw them', () => {
    expect(inboxLinkHash('#settings/archived', onThisComputer)).toBeNull();
  });
});
