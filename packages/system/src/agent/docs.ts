// Doc sites an unattended redraw may read. A redraw runs on a schedule with
// nobody watching, from a setup a person typed once, so its agent is handed
// only public https addresses: never a loopback, private, link-local or other
// non-public IP literal (in any spelling the URL parser accepts: 0x7f.1,
// 2130706433, [::ffff:127.0.0.1]), never a name that only means this computer
// or its network (localhost, *.localhost, *.local, a name with no dot), and
// never an address with a sign-in in it. A name that resolves to a private
// address is not caught here: that needs a DNS lookup at fetch time, which is
// the fetching agent's.

export type DocUrlCheck = { ok: true; url: string } | { ok: false; url: string; reason: string };

function v4Private(a: number, b: number): boolean {
  return (
    a === 0 || // this network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier NAT)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The 8 groups of an IPv6 address as the URL parser prints it (compressed, lowercase, no dotted tail), or null. */
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
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  if (zero(0, 5) && g[5] === 0xffff) return embedded(); // ::ffff:a.b.c.d
  if (zero(0, 6)) return embedded(); // ::a.b.c.d, the old compatible form
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return embedded(); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // link-local, old site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Whether an unattended redraw may hand this doc site to its agent, and why not. */
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

/** The doc sites an unattended redraw may read, and the ones it leaves out with why. */
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
