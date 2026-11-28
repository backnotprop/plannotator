import type { ReactNode } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';

export function RailFilesHead({ files, viewed, lead }: { files: readonly DiffFile[]; viewed: ReadonlySet<string>; lead?: ReactNode }) {
  const seen = files.filter((file) => viewed.has(file.path)).length;
  return (
    <div className="ib-prp-fileshead" aria-live="polite">
      {lead ?? <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>}
      <span className="ib-sp" />
      {seen > 0 && <span>{seen} viewed</span>}
    </div>
  );
}
