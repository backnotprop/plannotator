/**
 * @plannotator/core
 * Core logic for Plannotator - portable across platforms (web, React Native, Node)
 */

// Types
export {
  AnnotationType,
  ReviewTag,
  REVIEW_TAG_CATEGORIES,
  type EditorMode,
  type Annotation,
  type Block,
  type DiffResult,
  type CodeAnnotationType,
  type CodeAnnotation,
  type DiffAnnotationMetadata,
  type SelectedLineRange,
} from './types';

// Parser
export {
  parseMarkdownToBlocks,
  exportDiff,
  extractFrontmatter,
  type Frontmatter,
} from './parser';

// Validation Markers
export {
  extractValidationMarkers,
  injectValidationMarkers,
  stripValidationMarkers,
  formatMarkerForDisplay,
  isValidationTag,
  countValidationAnnotations,
  type ValidationMarker,
  type MarkerInjectionResult,
} from './markers';
