/**
 * Code review's image preview on the Inbox's diffs (review parity B2): the review app's own `ImageDiffPreview` in
 * place of a changed image's binary notice, and its `ImageViewMenu` (Side by side, Swipe, Onion skin, Differences)
 * on the file's header, wired as its All files wires them (review-editor ReviewAllFilesDiffPanel.tsx). Only the
 * reads differ: they go to the host's route (`images.fetchImpl`, packages/inbox/reviewImages.ts), under the host's
 * snapshot id. In the reader's lazy chunk, with the rest of the review app's diff code.
 */
import { useMemo } from 'react';
import type { AllFilesCodeViewProps } from '@plannotator/review-editor/components/AllFilesCodeView';
import { ImageDiffPreview } from '@plannotator/review-editor/components/ImageDiffPreview';
import { differencesSupported, ImageViewMenu } from '@plannotator/review-editor/components/image-diff/ImageViewMenu';
import { usePhone } from '../phone';
import type { GuideReaderImages } from './types';

export interface ImagePreviewProps {
  renderImagePreview?: AllFilesCodeViewProps['renderImagePreview'];
  renderImageViewControl?: AllFilesCodeViewProps['renderImageViewControl'];
}

const NONE: ImagePreviewProps = {};

/** The two render props for `AllFilesCodeView`, stable while `images` and the layout are (no header churn). */
export function useImagePreviews(images: GuideReaderImages | undefined): ImagePreviewProps {
  const compact = usePhone();
  const snapshotId = images?.snapshotId;
  const fetchImpl = images?.fetchImpl;
  return useMemo<ImagePreviewProps>(() => {
    if (!snapshotId || !fetchImpl) return NONE;
    return {
      renderImagePreview: ({ file, fallback, tooLargeFallback, onHeightChange }) => (
        <ImageDiffPreview
          key={`${snapshotId}:${file.path}`}
          filePath={file.path}
          status={file.status}
          patch={file.patch}
          snapshotId={snapshotId}
          variant="all-files"
          compact={compact}
          fallback={fallback}
          tooLargeFallback={tooLargeFallback}
          onHeightChange={onHeightChange}
          fetchImpl={fetchImpl}
        />
      ),
      renderImageViewControl: ({ file, iconOnly, touch }) => (
        <ImageViewMenu
          filePath={file.path}
          comparable={file.status !== 'added' && file.status !== 'deleted'}
          differencesAvailable={differencesSupported()}
          iconOnly={iconOnly}
          touch={touch}
        />
      ),
    };
  }, [snapshotId, fetchImpl, compact]);
}
