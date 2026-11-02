import { afterEach, expect, test } from 'bun:test';
import { newUuid } from './uuid';

const original = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
afterEach(() => {
  // randomUUID lives on Crypto.prototype, so there is usually no own descriptor: delete the shadow so the prototype's shows again.
  if (original) Object.defineProperty(crypto, 'randomUUID', original);
  else delete (crypto as unknown as Record<string, unknown>).randomUUID;
});

test('newUuid still returns a valid v4 id when randomUUID is unavailable (insecure context)', () => {
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
  const ids = new Set(Array.from({ length: 50 }, () => newUuid()));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
