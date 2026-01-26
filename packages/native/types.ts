/**
 * @plannotator/native - Type definitions for React Native components
 */

import type { Annotation, Block, EditorMode } from '@plannotator/core';

// Re-export core types
export * from '@plannotator/core';

// Selection range from text highlighting
export interface SelectionRange {
  start: number;
  end: number;
  text: string;
  blockId: string;
}

// Toolbar position
export interface ToolbarPosition {
  x: number;
  y: number;
  width: number;
}

// Theme colors
export interface PlannotatorTheme {
  background: string;
  surface: string;
  text: string;
  textMuted: string;
  primary: string;
  border: string;
  deletion: string;
  insertion: string;
  replacement: string;
  comment: string;
  success: string;
  warning: string;
}

// Default themes
export const lightTheme: PlannotatorTheme = {
  background: '#ffffff',
  surface: '#f9fafb',
  text: '#1f2937',
  textMuted: '#6b7280',
  primary: '#6366f1',
  border: '#e5e7eb',
  deletion: '#fee2e2',
  insertion: '#dcfce7',
  replacement: '#e0e7ff',
  comment: '#fef3c7',
  success: '#22c55e',
  warning: '#f59e0b',
};

export const darkTheme: PlannotatorTheme = {
  background: '#1f2937',
  surface: '#374151',
  text: '#f9fafb',
  textMuted: '#9ca3af',
  primary: '#818cf8',
  border: '#4b5563',
  deletion: '#7f1d1d',
  insertion: '#166534',
  replacement: '#3730a3',
  comment: '#78350f',
  success: '#16a34a',
  warning: '#d97706',
};
