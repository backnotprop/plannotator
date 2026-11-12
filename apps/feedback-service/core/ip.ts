function ipv6Prefix64(ip: string): string | null {
  const address = ip.split("%")[0]!.toLowerCase();
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

export function limitKey(ip: string): string {
  const prefix = ipv6Prefix64(ip);
  return prefix === null ? ip : `${prefix}::/64`;
}
