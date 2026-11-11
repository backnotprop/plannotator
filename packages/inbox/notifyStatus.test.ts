import { describe, expect, test } from 'bun:test';
import { blockedSteps, browserAppName, browserName, notifyStatusKind, notifyStatusText, reachText, testMissHint } from './notifyStatus';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
const EDGE = `${CHROME} Edg/141.0.0.0`;
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0';

describe('the browser by name', () => {
  test('Chrome, Edge, Safari and Firefox are told apart; the macOS app names', () => {
    expect(browserName(CHROME)).toBe('Chrome');
    expect(browserName(EDGE)).toBe('Edge');
    expect(browserName(SAFARI)).toBe('Safari');
    expect(browserName(FIREFOX)).toBe('Firefox');
    expect(browserName('curl/8')).toBe('this browser');
    expect(browserName(CHROME.replace('Chrome/', 'HeadlessChrome/'))).toBe('Chrome');
    expect(browserAppName('Chrome')).toBe('Google Chrome');
    expect(browserAppName('Edge')).toBe('Microsoft Edge');
  });
});

describe('the status in Settings', () => {
  test('each permission and the switch has its own status', () => {
    expect(notifyStatusText(notifyStatusKind(true, 'granted'), 'Chrome')).toBe('On for this address');
    expect(notifyStatusText(notifyStatusKind(false, 'granted'), 'Chrome')).toBe('Off');
    expect(notifyStatusText(notifyStatusKind(true, 'default'), 'Chrome')).toBe('Not allowed in Chrome for this address');
    expect(notifyStatusText(notifyStatusKind(true, 'denied'), 'Chrome')).toBe('Blocked in Chrome for this address');
    expect(notifyStatusKind(true, 'unsupported')).toBe('unsupported');
  });
  test('the blocked steps name the address and the browser’s own path', () => {
    expect(blockedSteps('Chrome', 'localhost:59812')).toContain('localhost:59812');
    expect(blockedSteps('Chrome', 'localhost:59812')).toContain('Site settings → Notifications → Allow');
    expect(blockedSteps('Safari', 'localhost:59812')).toContain('Websites → Notifications');
  });
  test("a test the browser accepted may still be hidden by the system: the owner's words on macOS", () => {
    expect(testMissHint('Chrome', true)).toBe("Didn't see it? Check System Settings → Notifications → Google Chrome, and Focus.");
    expect(testMissHint('Chrome', false)).toContain('Do Not Disturb');
  });
});

describe('notifications reach you', () => {
  const reach = (windows: number, allowed: number, origins: string[] = []) => ({ enabled: true, windows, allowed, allowed_origins: origins });
  const here = 'http://localhost:59812';
  test('this tab may notify', () => {
    expect(reachText({ here: true, enabled: true, reach: reach(1, 1, [here]), origin: here })).toEqual({ yes: true, text: 'Yes, through this tab, while it stays open.' });
    expect(reachText({ here: true, enabled: true, reach: reach(3, 3, [here]), origin: here }).text).toBe(
      'Yes, through this tab and 2 other Inbox tabs, while one stays open.',
    );
  });
  test('this tab may not, another one may: named by its address', () => {
    expect(reachText({ here: false, enabled: true, reach: reach(2, 1, ['http://localhost:61000']), origin: 'http://127.0.0.1:59812' })).toEqual({
      yes: true,
      text: 'Yes, through another Inbox tab (localhost:61000).',
    });
  });
  test('none may, none open, or the switch off: no, said plainly', () => {
    expect(reachText({ here: false, enabled: true, reach: reach(1, 0), origin: here })).toEqual({ yes: false, text: 'No: no open Inbox tab may notify.' });
    expect(reachText({ here: false, enabled: true, reach: reach(3, 0), origin: here }).text).toBe('No: none of the 3 open Inbox tabs may notify.');
    expect(reachText({ here: false, enabled: true, reach: reach(0, 0), origin: here }).text).toBe('No: no Inbox tab is open.');
    expect(reachText({ here: false, enabled: false, reach: reach(1, 1), origin: here }).yes).toBe(false);
  });
  test('an older Inbox that does not count windows: only this tab is known', () => {
    expect(reachText({ here: true, enabled: true, reach: null, origin: here }).yes).toBe(true);
    expect(reachText({ here: false, enabled: true, reach: undefined, origin: here }).yes).toBe(false);
  });
});
