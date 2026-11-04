/**
 * `#platform-post` as the window's strict typecheck sees it (packages/inbox/tsconfig.json `paths`). PlatformPost.tsx
 * imports review-editor's submit dialog, which does not compile under the window's settings, so it is checked with
 * the guide reader (tsconfig.guide.json) and held to this shape.
 */
import type { ComponentType } from 'react';
import type { PlatformPostProps } from './platform-post-types';

declare const PlatformPost: ComponentType<PlatformPostProps>;
export default PlatformPost;
