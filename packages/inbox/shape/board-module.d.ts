/**
 * The board as the window's strict typecheck sees it (`#shape-board`,
 * packages/inbox/tsconfig.json `paths`). ShapeBoard.tsx imports review-editor's
 * hover card, which does not compile under the window's strict settings, so it
 * is checked under tsconfig.guide.json, held to this shape.
 */
import type { ComponentType } from 'react';
import type { ShapeBoardProps } from './types';

declare const ShapeBoard: ComponentType<ShapeBoardProps>;
export default ShapeBoard;
