/**
 * @plannotator/ui - Markers utility re-exports
 * Re-exports marker functions from @plannotator/core for use in UI components
 */

export {
  extractValidationMarkers,
  injectValidationMarkers,
  stripValidationMarkers,
  formatMarkerForDisplay,
  isValidationTag,
  countValidationAnnotations,
  type ValidationMarker,
  type MarkerInjectionResult,
} from '@plannotator/core';
