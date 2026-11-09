// The key the per-IP limits count by. IPv4: the address. IPv6: its /64, since
// one host usually holds a whole /64 and could rotate through it. Used only in
// memory and as a rate-limit key; never stored.

/** The first four 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Prefix64(ip: string): string | null {
  const address = ip.split("%")[0]!.toLowerCase();
  // Only plain IPv6. An address with an IPv4 part (::ffff:1.2.3.4) keeps its whole self:
  // its /64 would be shared by every IPv4 caller.
  if (!/^[0-9a-f:]+$/.test(address) || !address.includes(":")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part ? part.split(":") : []);
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const full = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (full.some((g) => g.length === 0 || g.length > 4)) return null;
  const first4 = full.slice(0, 4);
  return first4.map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

/** The limit key for a caller IP: an IPv6 address's /64, anything else as given. */
export function limitKey(ip: string): string {
  const prefix = ipv6Prefix64(ip);
  return prefix === null ? ip : `${prefix}::/64`;
}
