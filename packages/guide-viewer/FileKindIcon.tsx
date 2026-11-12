import React from 'react';
import type { FileKind } from '@plannotator/core/file-kind';

const KIND_PATHS: Record<FileKind, string> = {
  code: 'M8 6l-6 6 6 6M16 6l6 6-6 6',
  test: 'M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7.5 15h9',
  generated: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
};

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  code: 'Code',
  test: 'Tests',
  generated: 'Generated',
};

export const FileKindIcon: React.FC<{ kind: FileKind; size?: number; className?: string; title?: string }> = ({
  kind,
  size = 12,
  className,
  title,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className ?? 'flex-shrink-0 text-muted-foreground'}
    data-file-kind-icon={kind}
    role={title ? 'img' : undefined}
    aria-label={title}
    aria-hidden={title ? undefined : true}
  >
    {title && <title>{title}</title>}
    <path d={KIND_PATHS[kind]} />
  </svg>
);
