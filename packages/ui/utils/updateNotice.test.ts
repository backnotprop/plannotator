import { describe, expect, test } from 'bun:test';
import { describeUpdateToast, parseUpdateAdvert, UPDATE_TOAST_INTERVAL_MS, updateToastDue, type UpdateAdvert } from './updateNotice';

const NOW = 1_800_000_000_000;
const advert = (over: Partial<UpdateAdvert> = {}): UpdateAdvert => ({
  version: '0.28.12',
  current: '0.28.10',
  releaseUrl: 'https://github.com/backnotprop/plannotator/releases/tag/v0.28.12',
  action: 'script',
  command: 'curl -fsSL https://plannotator.ai/install.sh | bash',
  ...over,
});

describe('the toast rhythm: once per version, at most every three days', () => {
  test('first time: due', () => {
    expect(updateToastDue('0.28.12', NOW, null)).toBe(true);
  });
  test('the same version never again', () => {
    expect(updateToastDue('0.28.12', NOW + 30 * UPDATE_TOAST_INTERVAL_MS, { version: '0.28.12', at: NOW })).toBe(false);
  });
  test('a newer version waits out the three days since the last toast', () => {
    expect(updateToastDue('0.28.13', NOW + UPDATE_TOAST_INTERVAL_MS - 1, { version: '0.28.12', at: NOW })).toBe(false);
    expect(updateToastDue('0.28.13', NOW + UPDATE_TOAST_INTERVAL_MS, { version: '0.28.12', at: NOW })).toBe(true);
  });
  test('a clock that moved backwards does not hold it back for good', () => {
    expect(updateToastDue('0.28.13', NOW, { version: '0.28.12', at: NOW + 1000 })).toBe(true);
  });
});

describe('the server advert, validated', () => {
  test('a well-formed advert passes; junk does not', () => {
    expect(parseUpdateAdvert(advert())).toEqual(advert());
    expect(parseUpdateAdvert({ ...advert(), version: '1.0.0-rc.1' })).toBeNull();
    expect(parseUpdateAdvert({ ...advert(), releaseUrl: 'https://evil.example/x' })).toBeNull();
    expect(parseUpdateAdvert({ ...advert(), action: 'shell' })).toBeNull();
    expect(parseUpdateAdvert({ ...advert(), command: '' })).toBeNull();
    expect(parseUpdateAdvert(null)).toBeNull();
  });
});

describe('the toast per host', () => {
  test('the binary the script manages: Update runs it', () => {
    expect(describeUpdateToast(advert())).toMatchObject({ title: 'Plannotator 0.28.12 is available', primary: 'update' });
  });
  test('Pi: its own command, never the install script', () => {
    const pi = describeUpdateToast(advert({ action: 'pi', command: 'pi update --extensions' }));
    expect(pi.title).toBe('Plannotator for Pi 0.28.12 is available');
    expect(pi.description).toContain('pi update --extensions');
    expect(pi.primary).toBe('copy');
  });
  test('OpenCode and an unmanaged binary copy the command', () => {
    expect(describeUpdateToast(advert({ action: 'opencode' })).primary).toBe('copy');
    expect(describeUpdateToast(advert({ action: 'copy' })).primary).toBe('copy');
  });
});
