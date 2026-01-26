/**
 * @plannotator/core - Validation Markers
 *
 * Functions to inject and extract validation markers (HTML comments) in markdown.
 * These markers persist across sessions so Claude knows which sections are validated.
 *
 * Format: <!-- @OK --> or <!-- @APPROVED --> or <!-- @LOCKED -->
 * With metadata: <!-- @APPROVED by="julien" date="2025-01-24" -->
 */

import { type Annotation, ReviewTag, REVIEW_TAG_CATEGORIES } from './types';

// --- Types ---

export interface ValidationMarker {
  /** The validation tag (@OK, @APPROVED, @LOCKED) */
  tag: ReviewTag;
  /** Position in the markdown where this marker appears */
  position: number;
  /** Line number (1-based) where the marker appears */
  line: number;
  /** The text/heading this marker applies to (if context can be determined) */
  context?: string;
  /** Optional attributes (author, date, reason, etc.) */
  attributes?: Record<string, string>;
}

export interface MarkerInjectionResult {
  /** The modified markdown with markers injected */
  markdown: string;
  /** Number of markers added */
  markersAdded: number;
  /** Details about each marker added */
  markers: Array<{ tag: ReviewTag; context: string; line: number }>;
}

// --- Constants ---

/** Tags that can be persisted as validation markers */
const VALIDATION_TAGS = REVIEW_TAG_CATEGORIES.validation;

/** Regex to match validation markers in markdown */
const MARKER_REGEX = /<!--\s*(@(?:OK|APPROVED|LOCKED))(?:\s+(\w+)="([^"]*)")*\s*-->/g;

/** Regex to match a specific marker with all attributes */
const MARKER_WITH_ATTRS_REGEX = /<!--\s*(@(?:OK|APPROVED|LOCKED))((?:\s+\w+="[^"]*")*)\s*-->/;

// --- Extraction ---

/**
 * Extract all validation markers from markdown content.
 *
 * @param markdown - The markdown content to scan
 * @returns Array of validation markers found
 *
 * @example
 * ```typescript
 * const markers = extractValidationMarkers(markdown);
 * // => [{ tag: '@APPROVED', position: 245, line: 12, context: 'Step 1: Initialize' }]
 * ```
 */
export function extractValidationMarkers(markdown: string): ValidationMarker[] {
  const markers: ValidationMarker[] = [];
  const lines = markdown.split('\n');

  let charOffset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const match = line.match(MARKER_WITH_ATTRS_REGEX);

    if (match) {
      const tag = match[1] as ReviewTag;
      const attrsString = match[2] || '';

      // Parse attributes
      const attributes: Record<string, string> = {};
      const attrMatches = attrsString.matchAll(/(\w+)="([^"]*)"/g);
      for (const attrMatch of attrMatches) {
        attributes[attrMatch[1]] = attrMatch[2];
      }

      // Find context (look at previous non-empty line for heading/content)
      let context: string | undefined;
      for (let i = lineIndex - 1; i >= 0; i--) {
        const prevLine = lines[i].trim();
        if (prevLine) {
          // Extract heading text if it's a heading
          const headingMatch = prevLine.match(/^#{1,6}\s+(.+)$/);
          context = headingMatch ? headingMatch[1] : prevLine.slice(0, 50);
          break;
        }
      }

      markers.push({
        tag,
        position: charOffset + line.indexOf(match[0]),
        line: lineIndex + 1,
        context,
        attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      });
    }

    charOffset += line.length + 1; // +1 for newline
  }

  return markers;
}

/**
 * Check if a specific tag already exists near a given text context.
 */
function hasExistingMarker(markdown: string, context: string, tag: ReviewTag): boolean {
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line contains the context
    if (line.includes(context.slice(0, 30))) {
      // Check next few lines for existing marker
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (lines[j].includes(`<!-- ${tag}`)) {
          return true;
        }
      }
    }
  }

  return false;
}

// --- Injection ---

/**
 * Inject validation markers into markdown based on annotations.
 *
 * Validation annotations (@OK, @APPROVED, @LOCKED) are persisted as HTML comments
 * after the annotated block. This allows Claude to see them in future sessions.
 *
 * @param markdown - The original markdown content
 * @param annotations - All annotations (will filter for validation tags)
 * @returns Result with modified markdown and injection details
 *
 * @example
 * ```typescript
 * const result = injectValidationMarkers(markdown, annotations);
 * // markdown now contains: ## Step 1\n<!-- @APPROVED -->
 * ```
 */
export function injectValidationMarkers(
  markdown: string,
  annotations: Annotation[]
): MarkerInjectionResult {
  // Filter to only validation annotations
  const validationAnnotations = annotations.filter(
    (ann) => ann.tag && VALIDATION_TAGS.includes(ann.tag)
  );

  if (validationAnnotations.length === 0) {
    return { markdown, markersAdded: 0, markers: [] };
  }

  const lines = markdown.split('\n');
  const markersToAdd: Array<{
    lineIndex: number;
    tag: ReviewTag;
    context: string;
  }> = [];

  // For each validation annotation, find where to insert the marker
  for (const ann of validationAnnotations) {
    const tag = ann.tag!;
    const context = ann.originalText.split('\n')[0].slice(0, 50); // First line as context

    // Skip if marker already exists
    if (hasExistingMarker(markdown, context, tag)) {
      continue;
    }

    // Find the line containing the annotated text
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check if this line starts the annotated content
      if (line.includes(ann.originalText.slice(0, 30)) ||
          ann.originalText.includes(line.trim())) {

        // For headings, insert marker right after the heading line
        if (line.trim().startsWith('#')) {
          markersToAdd.push({ lineIndex: i, tag, context: line.trim() });
          break;
        }

        // For other content, find the end of the block
        let endLine = i;
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j];
          // Stop at empty line, heading, or horizontal rule
          if (!nextLine.trim() || nextLine.trim().startsWith('#') || /^-{3,}$/.test(nextLine.trim())) {
            endLine = j - 1;
            break;
          }
          endLine = j;
        }

        markersToAdd.push({ lineIndex: endLine, tag, context });
        break;
      }
    }
  }

  // Sort by line index descending (to insert from bottom up)
  markersToAdd.sort((a, b) => b.lineIndex - a.lineIndex);

  // Insert markers
  const resultLines = [...lines];
  const addedMarkers: Array<{ tag: ReviewTag; context: string; line: number }> = [];

  for (const marker of markersToAdd) {
    const markerComment = `<!-- ${marker.tag} -->`;

    // Insert after the target line
    resultLines.splice(marker.lineIndex + 1, 0, markerComment);
    addedMarkers.push({
      tag: marker.tag,
      context: marker.context,
      line: marker.lineIndex + 2, // +1 for 1-based, +1 for inserted line
    });
  }

  return {
    markdown: resultLines.join('\n'),
    markersAdded: addedMarkers.length,
    markers: addedMarkers,
  };
}

// --- Stripping ---

/**
 * Remove all validation markers from markdown.
 * Useful when exporting to formats that don't need markers (Notion, HTML, etc.)
 *
 * @param markdown - Markdown content with markers
 * @returns Clean markdown without markers
 */
export function stripValidationMarkers(markdown: string): string {
  // Remove marker lines and any trailing empty line left behind
  return markdown
    .replace(/<!--\s*@(?:OK|APPROVED|LOCKED)[^>]*-->\n?/g, '')
    .replace(/\n{3,}/g, '\n\n'); // Collapse multiple empty lines
}

// --- Utilities ---

/**
 * Format a marker for display in the UI.
 */
export function formatMarkerForDisplay(marker: ValidationMarker): string {
  const parts = [marker.tag];

  if (marker.attributes?.by) {
    parts.push(`by ${marker.attributes.by}`);
  }
  if (marker.attributes?.date) {
    parts.push(`on ${marker.attributes.date}`);
  }

  return parts.join(' ');
}

/**
 * Check if a tag is a validation tag that can be persisted.
 */
export function isValidationTag(tag: ReviewTag | undefined): tag is ReviewTag {
  return tag !== undefined && VALIDATION_TAGS.includes(tag);
}

/**
 * Get the count of validation annotations in a list.
 */
export function countValidationAnnotations(annotations: Annotation[]): number {
  return annotations.filter((ann) => isValidationTag(ann.tag)).length;
}
