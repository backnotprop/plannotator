import { MAX_REVIEW_IMAGE_PREVIEW_LABEL } from '@plannotator/shared/diff-paths';
import { formatImageBytes, type ReviewImageError } from '../../utils/reviewImage';
import type { Size } from './geometry';

export function describeImageError(error: Pick<ReviewImageError, 'reason' | 'bytes' | 'width' | 'height'>): string {
  switch (error.reason) {
    case 'lfs-pointer':
      return 'stored in Git LFS';
    case 'not-image':
      return 'not a recognized image format';
    case 'decode':
      return 'could not be decoded';
    case 'too-large':
      if (error.width && error.height) return `${error.width} × ${error.height} px is over the preview limit`;
      return `larger than ${MAX_REVIEW_IMAGE_PREVIEW_LABEL}${error.bytes ? ` (${formatImageBytes(error.bytes)})` : ''}`;
    case 'missing':
      return 'not found at this version';
    case 'stale':
      return 'the diff changed; refresh the review';
    case 'network':
      return 'the server could not be reached';
    default:
      return 'could not be loaded';
  }
}

export function imageCaption(label: string, size: Size | null, bytes: number): string {
  return [label, size ? `${size.width} × ${size.height}` : null, formatImageBytes(bytes)].filter(Boolean).join(' · ');
}

function signed(value: number, text: string): string {
  return `${value > 0 ? '+' : '−'}${text}`;
}

export function sizeChange(before: Size | null, after: Size | null, beforeBytes: number, afterBytes: number): string {
  const parts: string[] = [];
  if (before && after && before.width !== after.width) parts.push(`${signed(after.width - before.width, String(Math.abs(after.width - before.width)))} wide`);
  if (before && after && before.height !== after.height) parts.push(`${signed(after.height - before.height, String(Math.abs(after.height - before.height)))} tall`);
  const bytes = afterBytes - beforeBytes;
  parts.push(bytes === 0 ? 'same size' : signed(bytes, formatImageBytes(Math.abs(bytes))));
  return `(${parts.join(', ')})`;
}
