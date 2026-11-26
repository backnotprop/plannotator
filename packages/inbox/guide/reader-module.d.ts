/**
 * The guide reader as the window's strict typecheck sees it (`#guide-reader`,
 * packages/inbox/tsconfig.json `paths`). The reader itself imports the guide
 * chain and review-editor's AllFilesCodeView, which do not compile under the
 * window's strict settings, so it is checked under their settings instead
 * (tsconfig.guide.json), where GuideReader.tsx is held to this shape.
 */
import type { ComponentType } from 'react';
import type { GuideReaderProps } from './types';
import type { PullAllFilesProps, PullChangesTreeProps, PullRepoFileProps } from './pullRepoTypes';

declare const GuideReader: ComponentType<GuideReaderProps>;
export default GuideReader;
/** The PR page's rail (PullRepoParts.tsx, PullChangesTree.tsx), in the same chunk. */
export declare const PullAllFiles: ComponentType<PullAllFilesProps>;
export declare const PullRepoFile: ComponentType<PullRepoFileProps>;
export declare const PullChangesTree: ComponentType<PullChangesTreeProps>;
/** The review app's keys beside a review's reader (ReviewKeys.tsx), in the same chunk. */
export declare const ReviewKeys: ComponentType<{ diff: string; viewed: boolean }>;
