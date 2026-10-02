// Keep this as TSX: packages/editor/index.css scans root *.tsx files for the
// Tailwind utility emitted below.

/**
 * Resolve the document-area classes while keeping collapsed sidebar shortcuts
 * outside both Markdown and raw-HTML content.
 */
export function resolveDocumentAreaClassName(options: Readonly<{
  isHtmlSurface: boolean;
  gridEnabled: boolean;
  hasCollapsedSidebarTabs: boolean;
}>): string {
  const surfaceClass = options.isHtmlSurface
    ? 'bg-background'
    : options.gridEnabled
      ? 'bg-grid'
      : 'bg-card';

  return [
    'flex-1',
    'min-w-0',
    surfaceClass,
    options.hasCollapsedSidebarTabs ? 'lg:pl-[30px]' : '',
  ].filter(Boolean).join(' ');
}
