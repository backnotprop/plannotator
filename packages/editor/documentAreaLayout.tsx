/** Keep as TSX: index.css scans root *.tsx files for the Tailwind classes emitted here. */
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
