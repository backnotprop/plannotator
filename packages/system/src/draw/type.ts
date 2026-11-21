// Font sizes as the Inbox writes them: var(--ib-fs-N, Npx). The drawing only
// uses sizes the Inbox has a token for; `fs` snaps any other size to the
// nearest one, so a size computed from a mark's size still follows the
// person's Text size setting.
const TOKENS = [9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 17, 18, 20, 22, 24, 30, 32, 34];

export function fs(n: number): string {
  let t = TOKENS[0]!;
  for (const k of TOKENS) if (Math.abs(k - n) < Math.abs(t - n)) t = k;
  const name = String(t).replace('.', '-');
  return `var(--ib-fs-${name}, ${t}px)`;
}
