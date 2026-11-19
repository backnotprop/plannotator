/**
 * Is this IP address on the public internet? Worked out on the address's
 * bytes, never on how it happens to be written, so every spelling of
 * loopback is loopback: `127.0.0.1`, `[::1]`, `[::ffff:7f00:1]`,
 * `[64:ff9b::7f00:1]`, `[2002:7f00:1::]`.
 */

/** The four bytes of a dotted IPv4 address, or null. */
export function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : null;
}

/** The sixteen bytes of an IPv6 address (brackets and a zone allowed), or null. */
export function parseIPv6(text: string): number[] | null {
  let value = text.replace(/^\[|\]$/g, '').toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (!value.includes(':')) return null;
  // A dotted IPv4 tail counts as the last two groups.
  let tail: number[] = [];
  const lastColon = value.lastIndexOf(':');
  if (value.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(value.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    value = value.slice(0, lastColon + 1) + '0:0';
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  if (!head || !rest) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const bytes: number[] = [];
  for (const group of groups) bytes.push(group >> 8, group & 0xff);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function privateV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

function privateV6(bytes: number[]): boolean {
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const embedded = bytes.slice(12, 16);
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return privateV4(embedded); // IPv4-mapped
  if (zeros(0, 12)) return true; // unspecified, loopback, and the old IPv4-compatible form
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return privateV4(embedded); // NAT64
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return privateV4(bytes.slice(2, 6)); // 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // documentation
  if ((bytes[0] & 0xfe) === 0xfc) return true; // unique local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true; // site-local (deprecated)
  return bytes[0] === 0xff; // multicast
}

/** Whether `text` is an IP address at all (either family). */
export const isIpAddress = (text: string): boolean => !!parseIPv4(text) || !!parseIPv6(text);

/**
 * Whether an IP address is this machine, a private or link-local network,
 * or otherwise not a public address. Text that is not an IP address is
 * private: when in doubt, do not go there.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return privateV4(v4);
  const v6 = parseIPv6(address);
  return v6 ? privateV6(v6) : true;
}
