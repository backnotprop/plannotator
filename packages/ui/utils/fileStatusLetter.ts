export type FileStatusKey = 'added' | 'deleted' | 'renamed' | 'modified' | 'binary' | 'untracked';

export interface FileStatusLetter {
  letter: string;
  title: string;
  className: string;
}

const NEUTRAL = 'font-medium text-muted-foreground';

const LETTERS: Record<FileStatusKey, FileStatusLetter> = {
  added: { letter: 'A', title: 'Added file', className: 'font-medium text-success' },
  deleted: { letter: 'D', title: 'Deleted file', className: 'font-medium text-destructive' },
  renamed: { letter: 'R', title: 'Renamed file', className: NEUTRAL },
  modified: { letter: 'M', title: 'Modified file', className: NEUTRAL },
  binary: { letter: 'B', title: 'Binary file', className: NEUTRAL },
  untracked: { letter: 'U', title: 'Untracked file', className: NEUTRAL },
};

export function fileStatusLetter(status: string, options: { oldPath?: string; untracked?: boolean } = {}): FileStatusLetter {
  const key: FileStatusKey = options.untracked ? 'untracked' : status in LETTERS ? (status as FileStatusKey) : 'modified';
  const meta = LETTERS[key];
  if (key === 'renamed' && options.oldPath) return { ...meta, title: `Renamed from ${options.oldPath}` };
  return meta;
}
