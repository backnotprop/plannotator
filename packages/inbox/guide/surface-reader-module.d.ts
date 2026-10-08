/**
 * The surface's guide reader as the strict typecheck sees it
 * (`#surface-guide-reader`, packages/inbox/tsconfig.json `paths`), for the
 * same reason as reader-module.d.ts: the reader is checked under the guide
 * chain's settings (tsconfig.guide.json), where it is held to this shape.
 */
import type { ComponentType } from 'react';
import type { SurfaceGuideReaderProps } from './types';

declare const SurfaceGuideReader: ComponentType<SurfaceGuideReaderProps>;
export default SurfaceGuideReader;
