/** The layer review's file rail: a flat list, or files grouped under folder headings when their names repeat. */

/** One row of the review's file rail: a folder heading (only when the rail groups), or a file. */
export type RailRow = { kind: 'folder'; key: string; text: string; full: string } | { kind: 'file'; path: string; dir: string; name: string };

/**
 * The review rail's rows. As a flat list (the folder before each name, cut at its start when long) while that reads
 * each file apart; when two files share their name and last folder (`…/vpc-peering/main.tf` in five regions), the
 * rail groups the files under folder headings instead: the folders past what every file shares, a long one cut in
 * the middle (`eu-west-1/…/vpc-peering/`), each file by its name.
 */
export function railRows(paths: readonly string[]): RailRow[] {
  const file = (path: string): RailRow => {
    const slash = path.lastIndexOf('/');
    return { kind: 'file', path, dir: slash >= 0 ? path.slice(0, slash + 1) : '', name: path.slice(slash + 1) };
  };
  const tails = new Set<string>();
  let alike = false;
  for (const path of paths) {
    const tail = path.split('/').slice(-2).join('/');
    if (tails.has(tail)) alike = true;
    tails.add(tail);
  }
  if (!alike) return paths.map(file);
  const dirOf = (path: string) => path.split('/').slice(0, -1);
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = dirOf(path).join('/');
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  // The folders every (non-root) group shares are left out of the headings: one group alone keeps its last two.
  const dirs = [...groups.keys()].filter(Boolean).map((key) => key.split('/'));
  let shared = 0;
  while (dirs.length > 1 && dirs.every((d) => d.length > shared + 1 && d[shared] === dirs[0]![shared])) shared++;
  const own = (key: string) => key.split('/').filter(Boolean).slice(dirs.length > 1 ? shared : -2);
  const cut = (parts: string[]) => (parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}/` : `${parts.join('/')}/`);
  const cuts = [...groups.keys()].filter(Boolean).map((key) => cut(own(key)));
  // Two headings the middle cut would make alike keep their whole own path (the line cuts it at its start).
  const alikeCut = new Set(cuts).size < cuts.length;
  const rows: RailRow[] = [];
  for (const [key, members] of groups) {
    const full = key ? `${key}/` : '/';
    const text = !key ? full : alikeCut ? `${own(key).join('/')}/` : cut(own(key));
    rows.push({ kind: 'folder', key, text, full });
    for (const path of members) rows.push({ ...(file(path) as Extract<RailRow, { kind: 'file' }>), dir: '' });
  }
  return rows;
}
