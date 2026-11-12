/** Unattended redraws read only public https addresses: no loopback, private or link-local IP literal, in any spelling the URL parser accepts. */
export type DocUrlCheck = { ok: true; url: string } | { ok: false; url: string; reason: string };

function v4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function v6Groups(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  return groups.some(Number.isNaN) ? null : groups;
}

function v6Private(g: number[]): boolean {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const embedded = () => v4Private(g[6]! >> 8, g[6]! & 0xff);
  if (zero(0, 8)) return true;
  if (zero(0, 7) && g[7] === 1) return true;
  if (zero(0, 5) && g[5] === 0xffff) return embedded();
  if (zero(0, 6)) return embedded();
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded();
  if ((g[0]! & 0xfe00) === 0xfc00) return true;
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true;
  if ((g[0]! & 0xff00) === 0xff00) return true;
  return false;
}

export function unattendedDocUrl(input: string): DocUrlCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, url: input, reason: 'not a web address' };
  }
  if (url.protocol !== 'https:') return { ok: false, url: input, reason: 'not https' };
  if (url.username || url.password) return { ok: false, url: input, reason: 'the address carries a sign-in' };
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[')) {
    const groups = v6Groups(host.slice(1, -1));
    if (!groups || v6Private(groups)) return { ok: false, url: input, reason: 'a loopback, private or other non-public IP address' };
    return { ok: true, url: url.href };
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    if (v4Private(Number(v4[1]), Number(v4[2]))) return { ok: false, url: input, reason: 'a loopback, private or other non-public IP address' };
    return { ok: true, url: url.href };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.')) {
    return { ok: false, url: input, reason: 'a name for this computer or its local network' };
  }
  return { ok: true, url: url.href };
}

export function unattendedDocs(docs: readonly string[]): { allowed: string[]; refused: { url: string; reason: string }[] } {
  const allowed: string[] = [];
  const refused: { url: string; reason: string }[] = [];
  for (const d of docs) {
    const c = unattendedDocUrl(d);
    if (c.ok) allowed.push(c.url);
    else refused.push({ url: c.url, reason: c.reason });
  }
  return { allowed, refused };
}
