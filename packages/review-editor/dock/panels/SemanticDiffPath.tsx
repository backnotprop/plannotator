import React from 'react';
import { EllipsisName } from '../../components/EllipsisName';

export const SemanticDiffPath: React.FC<{ filePath: string }> = ({ filePath }) => {
  const slash = filePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : filePath.slice(0, slash + 1);
  const name = filePath.slice(slash + 1);
  return (
    <span className="semantic-diff-path" title={filePath}>
      {dir && (
        <span className="semantic-diff-path-dir" data-semantic-diff-dir="">
          <bdi>{dir}</bdi>
        </span>
      )}
      <EllipsisName text={name} className="semantic-diff-path-name" />
    </span>
  );
};
