import { useState } from 'react';
import {
  DiffFileTree,
  type DiffFileTreeFile,
  type DiffFileTreeProps,
} from '@plannotator/ui/components/DiffFileTree';
import { buildDiffFileTree, type DiffFileTreeNode } from '@plannotator/ui/utils/diffFileTree';

/** Compile-only proof that a host can embed the read-only tree from the
 * published subpaths with only the required props, plus the pure builder. */
export function PublishedDiffFileTreeConsumer(props: { files: DiffFileTreeFile[] }) {
  const [selected, setSelected] = useState<string | null>(props.files[0]?.path ?? null);
  const minimal: DiffFileTreeProps = { files: props.files, selectedPath: selected, onSelect: setSelected };
  const roots: DiffFileTreeNode[] = buildDiffFileTree(props.files);
  return (
    <>
      <DiffFileTree {...minimal} />
      <DiffFileTree {...minimal} defaultExpanded={roots.length > 1 ? 'none' : ['src']} className="h-full" label="Files" />
    </>
  );
}
