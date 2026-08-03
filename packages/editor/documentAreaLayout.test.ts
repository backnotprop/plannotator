import { describe, expect, test } from 'bun:test';
import { resolveDocumentAreaClassName } from './documentAreaLayout';

describe('resolveDocumentAreaClassName', () => {
  test('insets raw HTML when collapsed sidebar shortcuts are visible', () => {
    expect(resolveDocumentAreaClassName({
      isHtmlSurface: true,
      gridEnabled: false,
      hasCollapsedSidebarTabs: true,
    })).toBe('flex-1 min-w-0 bg-background lg:pl-[30px]');
  });

  test('does not inset raw HTML when the shortcuts are hidden', () => {
    expect(resolveDocumentAreaClassName({
      isHtmlSurface: true,
      gridEnabled: false,
      hasCollapsedSidebarTabs: false,
    })).toBe('flex-1 min-w-0 bg-background');
  });

  test('preserves Markdown surface styling with the same shortcut inset', () => {
    expect(resolveDocumentAreaClassName({
      isHtmlSurface: false,
      gridEnabled: true,
      hasCollapsedSidebarTabs: true,
    })).toBe('flex-1 min-w-0 bg-grid lg:pl-[30px]');

    expect(resolveDocumentAreaClassName({
      isHtmlSurface: false,
      gridEnabled: false,
      hasCollapsedSidebarTabs: false,
    })).toBe('flex-1 min-w-0 bg-card');
  });
});
