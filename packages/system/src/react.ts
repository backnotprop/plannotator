// @plannotator/system/react: the drawing as React components that take props.
// No fetching, no routes, no storage. Browser-safe: nothing here reaches Node
// or Bun APIs. Load the styles once with `@plannotator/system/system.css`; they read
// the Inbox's tokens (packages/ui and packages/inbox), light and dark.
export { SystemView, type Reading, type SystemViewProps } from './view/SystemView.tsx';
export { SystemThumb, type SystemThumbProps } from './view/SystemThumb.tsx';
export { SystemChangePicture, ChangeLine, changeCrop, type SystemChangePictureProps } from './view/SystemChangePicture.tsx';
export { PartsList, type PartsListProps } from './view/PartsList.tsx';
export { Sheet, type Lod, type SheetProps } from './draw/Sheet.tsx';
export { hasSimple, layoutSheet, layoutSystem, restLayout, type LayoutOpts, type SystemLayouts } from './layout/compose.ts';
export { fontsReady, setText, type TextSetting } from './layout/measure.ts';
export type { SheetLayout } from './layout/types.ts';
