const LINK_MODE = /^(?:new file mode|deleted file mode|new mode|old mode) 120000$|^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m;

export function changeNotice(patch: string): string | null {
  const hunkAt = patch.search(/^@@/m);
  const head = hunkAt === -1 ? patch : patch.slice(0, hunkAt);
  if (LINK_MODE.test(head)) {
    const body = hunkAt === -1 ? '' : patch.slice(hunkAt);
    const removed = body.match(/^-(.*)$/m)?.[1];
    const added = body.match(/^\+(.*)$/m)?.[1];
    if (removed !== undefined && added !== undefined) return `Symlink: ${removed} → ${added}`;
    if (added !== undefined) return `Symlink to ${added}`;
    if (removed !== undefined) return `Symlink to ${removed}, removed`;
    return 'Symlink';
  }
  if (hunkAt !== -1 || /^(?:Binary files|GIT binary patch)/m.test(patch)) return null;
  const mode = head.match(/^old mode (\d+)\r?\nnew mode (\d+)$/m);
  if (mode) return `Mode changed ${mode[1]} → ${mode[2]}`;
  if (/^new file mode/m.test(head)) return 'Empty file';
  if (/^deleted file mode/m.test(head)) return 'Empty file, deleted';
  return null;
}
