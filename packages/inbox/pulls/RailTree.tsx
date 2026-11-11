import { useMemo, useState, type ReactNode } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';
import { ChangeTypeLetter } from '@plannotator/ui/components/DiffFileTree';
import { CountColumns, ViewedControl } from '@plannotator/ui/components/FileRowAtoms';
import { splitFileName } from '../components/FileName';
import { Tip } from '../components/Tip';
import { Icon } from '../icons';

type Row =
  | { kind: 'file'; file: DiffFile; dir: string; name: string; depth: number }
  | { kind: 'dir'; path: string; name: string; depth: number; rows: Row[]; additions: number; deletions: number };

function compact(nodes: DiffFileTreeNode<DiffFile>[], depth: number): Row[] {
  return nodes.map((node): Row => {
    if (node.type === 'file') return { kind: 'file', file: node.file!, dir: '', name: node.name, depth };
    let rows = compact(node.children ?? [], depth + 1);
    if (rows.length === 1) {
      const only = rows[0]!;
      if (only.kind === 'file') return { ...only, dir: `${node.name}/${only.dir}`, depth };
      return { ...only, name: `${node.name}/${only.name}`, depth, rows: reindent(only.rows, -1) };
    }
    return { kind: 'dir', path: node.path, name: node.name, depth, rows, additions: node.additions, deletions: node.deletions };
  });
}

function reindent(rows: Row[], by: number): Row[] {
  return rows.map((row) => (row.kind === 'file' ? { ...row, depth: row.depth + by } : { ...row, depth: row.depth + by, rows: reindent(row.rows, by) }));
}

const pad = (depth: number) => 6 + depth * 10;

export function middleCut(text: string): [head: string, tail: string] {
  const path = /^(.+?)(\/[^/]+\/?)$/.exec(text);
  if (path) return [path[1]!, path[2]!];
  return splitFileName(text);
}

function Cut({ text, className }: { text: string; className: string }) {
  const [head, tail] = middleCut(text);
  const [lead, end] = tail ? splitFileName(tail) : ['', ''];
  return (
    <span className={`ib-prp-cutbox ${className}`}>
      <span className="ib-prp-cut"><bdi>{head}</bdi></span>
      {tail && (
        <span className="ib-prp-keep" data-split={end ? '' : undefined}>
          {end ? (
            <>
              <span className="ib-prp-cut2"><bdi>{lead}</bdi></span>
              <span className="ib-prp-end"><bdi>{end}</bdi></span>
            </>
          ) : (
            <bdi>{tail}</bdi>
          )}
        </span>
      )}
    </span>
  );
}

export function RailTree({ tree, loose, files, viewed, commentCount, threadCount, onSelect, onToggleViewed, head }: {
  tree: DiffFileTreeNode<DiffFile>[];
  loose: readonly DiffFile[];
  files: readonly DiffFile[];
  viewed: ReadonlySet<string>;
  commentCount: (path: string) => number;
  threadCount?: (path: string) => number;
  onSelect: (path: string) => void;
  onToggleViewed?: (path: string) => void;
  head?: ReactNode;
}) {
  const rows = useMemo(() => compact(tree, 0), [tree]);
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const seenCount = files.filter((f) => viewed.has(f.path)).length;
  // A path changed twice (a symlink turned into a file) has two rows: a screen reader tells them apart by the change.
  const doubled = useMemo(() => {
    const paths = new Set<string>();
    const twice = new Set<string>();
    for (const file of files) (paths.has(file.path) ? twice : paths).add(file.path);
    return twice;
  }, [files]);
  const fileRow = ({ file, dir, name, depth }: { file: DiffFile; dir: string; name: string; depth: number }, key: string) => {
    const seen = viewed.has(file.path);
    const n = commentCount(file.path);
    const t = threadCount?.(file.path) ?? 0;
    return (
      <li key={key}>
        <Tip content={file.path}>
          <button type="button" className="ib-prp-file" data-seen={seen ? '' : undefined} style={{ paddingLeft: pad(depth) }} aria-label={`${file.path}${doubled.has(file.path) ? `, ${file.status}` : ''}${seen ? ', viewed' : ''}${t ? `, ${t} open ${t === 1 ? 'thread' : 'threads'}` : ''}`} onClick={() => onSelect(file.path)} data-review-file={file.path}>
            {onToggleViewed && <ViewedControl isViewed={seen} name={file.path} onToggle={() => onToggleViewed(file.path)} />}
            <span className="review-change-letter"><ChangeTypeLetter status={file.status} oldPath={file.oldPath} /></span>
            <span className="ib-prp-fname" data-has-dir={dir ? '' : undefined}>
              {dir && <Cut text={dir} className="ib-prp-dir" />}
              <Cut text={name} className="ib-prp-base" />
            </span>
            {n > 0 && <span className="ib-prp-c">{n}</span>}
            {t > 0 && (
              <span className="ib-prp-t" data-pull-file-threads={t} aria-hidden="true">
                <Icon name="comment" size={12} />
                {t}
              </span>
            )}
            <CountColumns additions={file.additions} deletions={file.deletions} />
          </button>
        </Tip>
      </li>
    );
  };
  const draw = (list: Row[]): ReactNode =>
    list.map((row) => {
      if (row.kind === 'file') return fileRow(row, row.file.path);
      const open = !shut.has(row.path);
      return (
        <li key={`dir:${row.path}`} data-review-folder={row.path}>
          <Tip content={row.path}>
            <button type="button" className="ib-prp-folder" style={{ paddingLeft: pad(row.depth) }} aria-expanded={open} aria-label={row.path} onClick={() => setShut((was) => { const next = new Set(was); if (open) next.add(row.path); else next.delete(row.path); return next; })}>
              <svg className={open ? 'ib-prp-open' : ''} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
              <span className="ib-prp-fname"><Cut text={row.name} className="ib-prp-dirname" /></span>
              <CountColumns additions={row.additions} deletions={row.deletions} tone="quiet" />
            </button>
          </Tip>
          {open && <ul className="ib-prp-list">{draw(row.rows)}</ul>}
        </li>
      );
    });
  return (
    <div className="ib-prp-files">
      <div className="ib-prp-fileshead" aria-live="polite">
        {head ?? <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>}
        <span className="ib-sp" />
        {seenCount > 0 && <span>{seenCount} viewed</span>}
      </div>
      <ul className="ib-prp-list" data-review-files="">
        {draw(rows)}
        {loose.map((file, index) => fileRow({ file, dir: '', name: file.path, depth: 0 }, `loose:${index}:${file.path}`))}
      </ul>
    </div>
  );
}
