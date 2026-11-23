import { useMemo } from 'react';
import type { DiffFile } from '../../types';
import type { AllFilesCodeViewProps } from '../AllFilesCodeView';
import { ImageDiffPreview } from '../ImageDiffPreview';
import { ImageViewMenu } from './ImageViewMenu';
import { differencesSupported } from './differences';
import { isSvgPath, setSvgView, svgViewOf, useSvgView, useSvgViewVersion } from './svgView';

/** The All files view's rendered-file seam (Markdown previews, and SVGs through `useSvgViews`). */
export type RenderedFilesSeam = NonNullable<AllFilesCodeViewProps['markdownPreview']>;

const isSvgFile = (file: Pick<DiffFile, 'path' | 'oldPath'>) => isSvgPath(file.path) || isSvgPath(file.oldPath);

/** An SVG's view control: the image menu with Image / Source. */
export function SvgViewControl({ file, iconOnly, touch }: { file: DiffFile; iconOnly: boolean; touch: boolean }) {
  const view = useSvgView(file.path);
  return (
    <ImageViewMenu
      filePath={file.path}
      comparable={file.status !== 'added' && file.status !== 'deleted'}
      differencesAvailable={differencesSupported()}
      source={{ active: view === 'source', onChoose: (source) => setSvgView(file.path, source ? 'source' : 'image') }}
      iconOnly={iconOnly}
      touch={touch}
    />
  );
}

/**
 * A changed SVG shown as a picture (Image) or its source diff (Source), through the same seam as a rendered Markdown
 * file: `base` (the Markdown previews, or none) with every SVG of `files` added. Off (`enabled` false, or no SVG): `base`
 * as it is. `fetchImpl`: where the image reads go (absent, code review's own `/api/review-image`), as `ImageDiffPreview`'s.
 */
export function useSvgViews(
  base: RenderedFilesSeam | undefined,
  options: { files: readonly DiffFile[]; enabled: boolean; snapshotId: string | undefined; compact: boolean; fetchImpl?: typeof fetch },
): RenderedFilesSeam | undefined {
  const { files, enabled, snapshotId, compact, fetchImpl } = options;
  const svgVersion = useSvgViewVersion();
  const svgFiles = useMemo(() => (enabled ? files.filter(isSvgFile) : []), [enabled, files]);
  return useMemo(() => {
    if (svgFiles.length === 0) return base;
    const svgImagePaths = svgFiles.filter((file) => svgViewOf(file.path) === 'image').map((file) => file.path);
    return {
      previewedPaths: new Set([...(base?.previewedPaths ?? []), ...svgImagePaths]),
      isPreviewable: (file: DiffFile) => isSvgFile(file) || (base?.isPreviewable(file) ?? false),
      show: (filePath: string, view: Parameters<RenderedFilesSeam['show']>[1]) => {
        if (isSvgPath(filePath)) setSvgView(filePath, view === 'source' ? 'source' : 'image');
        else base?.show(filePath, view);
      },
      onEditingFileChange: base?.onEditingFileChange,
      registerViewTarget: base?.registerViewTarget,
      renderViewControl: (args: { file: DiffFile; iconOnly: boolean; touch: boolean }) =>
        isSvgFile(args.file) ? <SvgViewControl {...args} /> : base?.renderViewControl(args) ?? null,
      render: (args: { file: DiffFile; onHeightChange: () => void }) =>
        isSvgFile(args.file) ? (
          <ImageDiffPreview
            key={`${snapshotId ?? ''}:${args.file.path}`}
            filePath={args.file.path}
            status={args.file.status}
            patch={args.file.patch}
            snapshotId={snapshotId}
            variant="all-files"
            compact={compact}
            fallback={null}
            onHeightChange={args.onHeightChange}
            {...(fetchImpl ? { fetchImpl } : {})}
          />
        ) : (
          base?.render(args) ?? null
        ),
    };
    // svgVersion: an Image / Source pick moves `previewedPaths`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, svgFiles, svgVersion, snapshotId, compact, fetchImpl]);
}
