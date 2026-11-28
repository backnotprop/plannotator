/**
 * Code review's rendered files on the Inbox's diffs (review parity B3): a changed Markdown file's Source / Changes /
 * Read menu and its rendered card, and a changed SVG's Image / Source, wired as code review's All files wires them
 * (review-editor's dock/panels/ReviewAllFilesDiffPanel.tsx) through `AllFilesCodeView`'s `markdownPreview` seam:
 * review-editor's own `useMarkdownPreview` state (the same starting view, remembered in the same cookie),
 * `MarkdownViewMenu`, `MarkdownFilePreview` (loaded the first time a file is shown rendered, as there) and
 * `useSvgViews`. Only the reads differ: the file's two texts come from the host's own reader (the one the expand
 * arrows use; an added or deleted file is whole in its patch), and its pictures from the host's routes
 * (`GuideReaderImages.markdownImageUrl`, packages/inbox/reviewImages.ts).
 *
 * In the reader's lazy chunk only (GuideReader.tsx imports it; tests/entry-assets.test.ts).
 */
import { createContext, lazy, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DiffFile } from '@plannotator/core/diff-files';
import type { AllFilesCodeViewProps } from '@plannotator/review-editor/components/AllFilesCodeView';
import { MarkdownViewMenu } from '@plannotator/review-editor/components/MarkdownViewMenu';
import { MarkdownPreviewFailed } from '@plannotator/review-editor/components/MarkdownPreviewFailed';
import { useSvgViews } from '@plannotator/review-editor/components/image-diff/SvgViews';
import { fileViewOfRendered, renderedViewOf, useMarkdownPreview, type MarkdownPreviewController } from '@plannotator/review-editor/hooks/useMarkdownPreview';
import type { UseFileContentsResult } from '@plannotator/review-editor/hooks/useFileContents';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import type { GuideReaderImages } from './types';

// Lazy, as in code review: loaded the first time a Markdown file is shown rendered.
const MarkdownFilePreview = lazy(async () => ({ default: (await import('@plannotator/review-editor/components/MarkdownFilePreview')).MarkdownFilePreview }));

type RenderedFiles = NonNullable<AllFilesCodeViewProps['markdownPreview']>;
/** The host's whole-file reader (GuideReader's, for the expand arrows): null when it has none for this file. */
type ReadFile = NonNullable<AllFilesCodeViewProps['fetchFileContent']>;

interface Rendered {
  controller: MarkdownPreviewController;
  read: ReadFile;
  images: GuideReaderImages | undefined;
  filePaths: ReadonlySet<string>;
  openFile: (path: string) => void;
}

// Pierre's header slot republishes only when its item changes; a reader of this context inside it still draws again,
// so a pick updates the menu and the card without touching the item (as code review's ReviewState does there).
const RenderedContext = createContext<Rendered | null>(null);

/** One side of a file whose patch holds it whole (an added or a deleted file): its lines, as git wrote them. */
export function sideOfPatch(patch: string, side: 'old' | 'new'): string | null {
  const at = patch.search(/^@@ /m);
  if (at < 0) return null;
  const mark = side === 'new' ? '+' : '-';
  const lines: string[] = [];
  let endsWithNewline = true;
  for (const line of patch.slice(at).split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('\\')) {
      endsWithNewline = false;
      continue;
    }
    if (line.startsWith(mark) || line.startsWith(' ')) lines.push(line.slice(1));
  }
  return lines.join('\n') + (endsWithNewline && lines.length > 0 ? '\n' : '');
}

/** The file's two texts for its rendered card, from the host's reader; an added or deleted file from its patch. */
function useHostContents(file: DiffFile, read: ReadFile): UseFileContentsResult {
  const whole = file.status === 'added' ? 'new' : file.status === 'deleted' ? 'old' : null;
  const [state, setState] = useState<UseFileContentsResult>(() =>
    whole
      ? { fileContents: { forPath: file.path, old: whole === 'old' ? sideOfPatch(file.patch, 'old') : null, new: whole === 'new' ? sideOfPatch(file.patch, 'new') : null }, loading: false, stale: false }
      : { fileContents: null, loading: true, stale: false },
  );
  useEffect(() => {
    if (whole) return;
    const controller = new AbortController();
    setState({ fileContents: null, loading: true, stale: false });
    read(file, controller.signal)
      .then((contents) => {
        if (controller.signal.aborted) return;
        const found = contents && (contents.oldContent !== null || contents.newContent !== null);
        setState({ fileContents: found ? { forPath: file.path, old: contents.oldContent, new: contents.newContent } : null, loading: false, stale: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ fileContents: null, loading: false, stale: false });
      });
    return () => controller.abort();
    // The file's patch names what is read; a new patch reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.patch, whole, read]);
  return state;
}

function MarkdownCard({ file, onHeightChange }: { file: DiffFile; onHeightChange: () => void }) {
  const rendered = useContext(RenderedContext)!;
  const contents = useHostContents(file, rendered.read);
  const { controller, images } = rendered;
  return (
    <MarkdownFilePreview
      filePath={file.path}
      oldPath={file.oldPath}
      status={file.status}
      patch={file.patch}
      contents={contents}
      imagesAvailable={!!images}
      {...(images ? { imageSnapshotId: images.snapshotId, imageUrl: images.markdownImageUrl } : {})}
      reviewFilePaths={rendered.filePaths}
      onOpenReviewFile={rendered.openFile}
      variant="all-files"
      onHeightChange={onHeightChange}
      view={renderedViewOf(controller.viewOf(file.path))}
      onViewChange={(view) => controller.show(file.path, fileViewOfRendered(view))}
      // The window loads only its own pictures (a PR's or a local guide's): a web picture is code review's quiet
      // placeholder, with nothing offering to load it.
      neverLoadRemoteImages
      diagramEngine={null}
    />
  );
}

function MarkdownViewControl({ file, iconOnly, touch }: { file: DiffFile; iconOnly: boolean; touch: boolean }) {
  const controller = useContext(RenderedContext)?.controller;
  if (!controller) return null;
  return (
    <MarkdownViewMenu
      filePath={file.path}
      view={controller.viewOf(file.path)}
      views={controller.viewsFor(file)}
      status={file.status}
      onChoose={(view) => controller.choose(file.path, view)}
      iconOnly={iconOnly}
      touch={touch}
      disabledReason={controller.lockReason(file.path)}
      // Selecting rendered text does not comment here and P is not bound: neither is offered.
      withoutCommentAndKeyHints
    />
  );
}

/**
 * The reader's rendered files: the `markdownPreview` seam for each file's `AllFilesCodeView`, and the provider its
 * menus and cards read. Off (`read` absent: the host reads no whole files; or `enabled` false, a walkthrough of code
 * as it is): Markdown files are their source diff, as before; SVGs need `images` too.
 */
export function useRenderedFiles(options: {
  files: readonly DiffFile[];
  read: ReadFile | undefined;
  images: GuideReaderImages | undefined;
  enabled: boolean;
  compact: boolean;
  openFile: (path: string) => void;
}): { markdownPreview: RenderedFiles | undefined; rendered: Rendered | null } {
  const { files, read, images, enabled, compact, openFile } = options;
  const controller = useMarkdownPreview({ files, supported: enabled && !!read });
  const filePaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
  const base = useMemo<RenderedFiles | undefined>(
    () =>
      controller
        ? {
            previewedPaths: controller.previewedPaths,
            isPreviewable: controller.isPreviewable,
            show: controller.show,
            onEditingFileChange: controller.setEditingFile,
            registerViewTarget: controller.registerViewTarget,
            renderViewControl: (args) => <MarkdownViewControl {...args} />,
            render: ({ file, onHeightChange }) => (
              <LazyBlockBoundary key={file.path} fallback={(notice) => <MarkdownPreviewFailed notice={notice} />}>
                <Suspense fallback={null}>
                  <MarkdownCard file={file} onHeightChange={onHeightChange} />
                </Suspense>
              </LazyBlockBoundary>
            ),
          }
        : undefined,
    [controller],
  );
  const markdownPreview = useSvgViews(base, { files, enabled: enabled && !!images, snapshotId: images?.snapshotId, compact, ...(images ? { fetchImpl: images.fetchImpl } : {}) });
  const rendered = useMemo<Rendered | null>(
    () => (controller && read ? { controller, read, images, filePaths, openFile } : null),
    [controller, read, images, filePaths, openFile],
  );
  return { markdownPreview, rendered };
}

/** What the reader's rendered files' menus and cards read (`useRenderedFiles`'s `rendered`), around the reader's view. */
export function RenderedFilesProvider({ value, children }: { value: Rendered | null; children: ReactNode }) {
  return <RenderedContext.Provider value={value}>{children}</RenderedContext.Provider>;
}
