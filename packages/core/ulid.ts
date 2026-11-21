/**
 * A ULID (48-bit millisecond time + 80 random bits, Crockford base32), so ids
 * sort by creation time and a later sync can keep them as they are. The
 * Inbox's ids (`msg_…`) and Shape's (`shp_…`) use it. No imports: Pi vendors it.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let randomPart = "";
  for (let i = 0; i < 16; i++) randomPart += CROCKFORD[bytes[i]! % 32];
  return timePart + randomPart;
}
