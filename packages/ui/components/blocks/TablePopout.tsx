import React, { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { Block } from '../../types';
import { InlineMarkdown } from '../InlineMarkdown';
import { parseTableContent, buildCsvFromRows, buildMarkdownTable } from './TableBlock';

interface TablePopoutProps {
  block: Block;
  open: boolean;
  onClose: () => void;
  /** Portal target — pass Viewer's annotation containerRef so annotation */
  /** hooks can walk into the popout's text nodes. Null falls back to body. */
  container?: HTMLElement | null;
  onOpenLinkedDoc?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
}

// A row is a dict of columnId → cell text. Column ids are derived from the
// header label (or index fallback) so the data shape matches what TanStack
// Table expects for an accessor-based column definition.
type Row = Record<string, string>;

const TablePopoutImpl: React.FC<TablePopoutProps> = ({
  block,
  open,
  onClose,
  container,
  onOpenLinkedDoc,
  onNavigateAnchor,
  imageBaseDir,
  onImageClick,
  githubRepo,
}) => {
  const { headers, rows } = useMemo(() => parseTableContent(block.content), [block.content]);

  // Build stable column ids from headers — duplicates get suffixed so
  // TanStack Table doesn't collide on accessor keys.
  const columnIds = useMemo(() => {
    const seen = new Map<string, number>();
    return headers.map((h, i) => {
      const base = h.trim() || `col-${i}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}-${n}`;
    });
  }, [headers]);

  const data = useMemo<Row[]>(
    () =>
      rows.map((row) => {
        const obj: Row = {};
        columnIds.forEach((id, i) => {
          obj[id] = row[i] ?? '';
        });
        return obj;
      }),
    [rows, columnIds],
  );

  const columns = useMemo<ColumnDef<Row, string>[]>(() => {
    const helper = createColumnHelper<Row>();
    return columnIds.map((id, i) =>
      helper.accessor((row) => row[id], {
        id,
        header: headers[i],
        cell: (info) => (
          <InlineMarkdown
            imageBaseDir={imageBaseDir}
            onImageClick={onImageClick}
            text={info.getValue()}
            onOpenLinkedDoc={onOpenLinkedDoc}
            onNavigateAnchor={onNavigateAnchor}
            githubRepo={githubRepo}
          />
        ),
      }),
    );
  }, [columnIds, headers, imageBaseDir, onImageClick, onOpenLinkedDoc, onNavigateAnchor, githubRepo]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedCsv, setCopiedCsv] = useState(false);

  // Copy reflects what the user currently sees — filter + sort applied.
  // Read is one-shot on click; no subscription, no derived state to sync.
  const getVisibleRowsData = (): string[][] =>
    table.getRowModel().rows.map((row) =>
      columnIds.map((id) => row.getValue<string>(id) ?? ''),
    );

  const handleCopyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(buildMarkdownTable(headers, getVisibleRowsData()));
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleCopyCsv = async () => {
    try {
      await navigator.clipboard.writeText(buildCsvFromRows(headers, getVisibleRowsData()));
      setCopiedCsv(true);
      setTimeout(() => setCopiedCsv(false), 1500);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: 'includesString',
  });

  const visibleRows = table.getRowModel().rows;
  const totalRows = data.length;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }} modal={false}>
      <Dialog.Portal container={container ?? undefined}>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-4rem)] max-w-[min(calc(100vw-4rem),1500px)] max-h-[calc(100vh-4rem)] -translate-x-1/2 -translate-y-1/2 bg-background border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
          data-block-id={block.id}
          data-popout="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // With modal={false}, Radix treats any click outside Dialog.Content
            // as dismissal. Our annotation stack (toolbar, comment popover,
            // quick-label picker) portals to document.body — clicks on them
            // are outside the dialog DOM but logically part of this session.
            // Keep the dialog open when the interaction lands on any of them.
            const target = e.target as Node | null;
            if (!target || !(target instanceof Element)) return;
            if (
              target.closest('.annotation-toolbar') ||
              target.closest('[data-comment-popover="true"]') ||
              target.closest('[data-floating-picker="true"]')
            ) {
              e.preventDefault();
            }
          }}
        >
          <Dialog.Title className="sr-only">Table</Dialog.Title>
          <Dialog.Close asChild>
            <button
              className="absolute top-3 right-3 z-20 p-1.5 rounded-md text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </Dialog.Close>

          <div className="flex items-center gap-3 px-5 pt-4 pb-3 pr-12">
            <div className="relative max-w-sm flex-1">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M10 18a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
              <input
                type="text"
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
                placeholder="Filter rows…"
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-muted/40 border border-border/60 rounded-md focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50"
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {visibleRows.length === totalRows
                ? `${totalRows} row${totalRows === 1 ? '' : 's'}`
                : `${visibleRows.length} of ${totalRows}`}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={handleCopyMarkdown}
                title={
                  copiedMd
                    ? 'Copied!'
                    : visibleRows.length === totalRows
                      ? 'Copy as markdown'
                      : `Copy ${visibleRows.length} row${visibleRows.length === 1 ? '' : 's'} as markdown`
                }
                className={`p-1.5 rounded-md transition-colors ${
                  copiedMd ? 'text-success' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {copiedMd ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleCopyCsv}
                title={
                  copiedCsv
                    ? 'Copied as CSV!'
                    : visibleRows.length === totalRows
                      ? 'Copy as CSV'
                      : `Copy ${visibleRows.length} row${visibleRows.length === 1 ? '' : 's'} as CSV`
                }
                className={`px-2 py-1 rounded-md text-[10px] font-bold tracking-tight uppercase leading-none transition-colors ${
                  copiedCsv ? 'text-success' : 'text-primary hover:bg-primary/10'
                }`}
              >
                {copiedCsv ? '✓' : 'CSV'}
              </button>
            </div>
          </div>

          <div className="overflow-auto flex-1 px-5 pb-5">
            <table className="min-w-full border-collapse text-sm">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id} className="border-b border-border">
                    {headerGroup.headers.map((header) => {
                      const sort = header.column.getIsSorted();
                      return (
                        <th
                          key={header.id}
                          onClick={header.column.getToggleSortingHandler()}
                          className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30 sticky top-0 z-10 select-none cursor-pointer hover:bg-muted/50 transition-colors"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <SortIndicator dir={sort} />
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {visibleRows.length === 0 ? (
                  <tr>
                    <td colSpan={columnIds.length} className="px-3 py-8 text-center text-sm text-muted-foreground">
                      No rows match the filter.
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((row) => (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/20">
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-3 py-2 text-foreground/80">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

// Memoize on meaningful props (block identity, content, open, container).
// Upstream Viewer re-renders (annotation toolbar opening, selection change,
// hover state shuffling) keep firing while the popout is mounted. Without
// this memo, TanStack's flexRender re-evaluates every cell on every parent
// re-render, which conflicts with web-highlighter's DOM mutations (the
// library inserts <mark> tags into the live DOM) and React's reconciler
// throws NotFoundError trying to remove nodes it doesn't own.
// Callback identity is intentionally ignored — the behavior is stable even
// if the parent hands us new function references.
export const TablePopout = React.memo(
  TablePopoutImpl,
  (prev, next) =>
    prev.block.id === next.block.id &&
    prev.block.content === next.block.content &&
    prev.open === next.open &&
    prev.container === next.container &&
    prev.imageBaseDir === next.imageBaseDir &&
    prev.githubRepo === next.githubRepo,
);

const SortIndicator: React.FC<{ dir: false | 'asc' | 'desc' }> = ({ dir }) => {
  const activeUp = dir === 'asc';
  const activeDown = dir === 'desc';
  return (
    <span className="inline-flex flex-col leading-none text-[9px]">
      <span className={activeUp ? 'text-foreground' : 'text-muted-foreground/40'}>▲</span>
      <span className={activeDown ? 'text-foreground' : 'text-muted-foreground/40'}>▼</span>
    </span>
  );
};
