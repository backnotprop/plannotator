/**
 * The guide reader as the window's strict typecheck sees it (`#guide-reader`,
 * packages/inbox/tsconfig.json `paths`). The reader itself imports the guide
 * chain and review-editor's AllFilesCodeView, which do not compile under the
 * window's strict settings, so it is checked under their settings instead
 * (tsconfig.guide.json), where GuideReader.tsx is held to this shape.
 */
import type { ComponentType } from 'react';
import type { GuideReaderProps } from './types';
import type { PullAllFilesProps, PullRepoFileProps } from './pullRepoTypes';

declare const GuideReader: ComponentType<GuideReaderProps>;
export default GuideReader;
/** The PR page's All files (PullRepoParts.tsx), in the same chunk. */
export declare const PullAllFiles: ComponentType<PullAllFilesProps>;
export declare const PullRepoFile: ComponentType<PullRepoFileProps>;
