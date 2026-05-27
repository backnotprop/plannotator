import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { useCodeNavPreview, type PreviewData } from '../../hooks/useCodeNavPreview';
import { HighlightedCode } from '../../components/HighlightedCode';
import { detectLanguage } from '../../utils/detectLanguage';
import type { CodeNavLocation } from '@plannotator/shared/code-nav';

function basename(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? filePath : filePath.slice(i + 1);
}

function dirname(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? '' : filePath.slice(0, i);
}

interface FileGroup {
  filePath: string;
  locations: CodeNavLocation[];
}

function groupByFile(locations: CodeNavLocation[]): FileGroup[] {
  const map = new Map<string, CodeNavLocation[]>();
  for (const loc of locations) {
    const existing = map.get(loc.filePath);
    if (existing) existing.push(loc);
    else map.set(loc.filePath, [loc]);
  }
  return Array.from(map.entries()).map(([filePath, locations]) => ({
    filePath,
    locations,
  }));
}

const CodePreview: React.FC<{
  preview: PreviewData | null;
  isLoading: boolean;
}> = ({ preview, isLoading }) => {
  const targetRef = useRef<HTMLTableRowElement>(null);

  useEffect(() => {
    if (targetRef.current) {
      targetRef.current.scrollIntoView({ block: 'center' });
    }
  }, [preview?.targetLine, preview?.filePath]);
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select a reference to preview
      </div>
    );
  }

  const language = detectLanguage(preview.filePath);

  return (
    <div className="code-nav-peek font-mono text-[12px] leading-[20px]">
      <table className="w-full border-collapse">
        <tbody>
          {preview.lines.map((line, i) => {
            const lineNum = preview.startLine + i;
            const isTarget = lineNum === preview.targetLine;
            const targetStyle = isTarget ? { backgroundColor: 'var(--muted)' } : undefined;
            return (
              <tr key={lineNum} ref={isTarget ? targetRef : undefined}>
                <td
                  className="text-right pr-3 pl-2 select-none text-muted-foreground/50 w-[1%] whitespace-nowrap align-top"
                  style={targetStyle}
                >
                  {lineNum}
                </td>
                <td
                  className="pr-4 whitespace-pre"
                  style={targetStyle}
                >
                  <HighlightedCode code={line || ' '} language={language} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const ReferenceList: React.FC<{
  groups: FileGroup[];
  selectedLocation: CodeNavLocation | null;
  onSelect: (loc: CodeNavLocation) => void;
}> = ({ groups, selectedLocation, onSelect }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapse = (filePath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  return (
    <div className="text-[11px]">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.filePath);
        return (
          <div key={group.filePath}>
            <button
              className="w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-muted/50 transition-colors sticky top-0 bg-card/95 backdrop-blur-sm z-10"
              onClick={() => toggleCollapse(group.filePath)}
              title={group.filePath}
            >
              <svg
                className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium truncate text-foreground">
                {basename(group.filePath)}
              </span>
              <span className="text-muted-foreground/60 truncate text-[10px]">
                {dirname(group.filePath)}
              </span>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
                ({group.locations.length})
              </span>
            </button>
            {!isCollapsed && (
              <div>
                {group.locations.map((loc, i) => {
                  const isSelected =
                    selectedLocation?.filePath === loc.filePath &&
                    selectedLocation?.line === loc.line;
                  return (
                    <button
                      key={`${loc.line}-${i}`}
                      className={`w-full text-left pl-7 pr-2 py-0.5 flex items-center gap-1.5 transition-colors ${
                        isSelected
                          ? 'bg-primary/15 text-primary'
                          : 'hover:bg-muted/40 text-muted-foreground'
                      }`}
                      onClick={() => onSelect(loc)}
                    >
                      <span className="font-mono text-[10px] flex-shrink-0 w-8 text-right">
                        :{loc.line}
                      </span>
                      <span className="truncate font-mono text-[10px]">
                        {loc.snippet.trim()}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const ReviewCodeNavPanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  const preview = useCodeNavPreview();
  const containerRef = useRef<HTMLDivElement>(null);
  const { codeNavResult, codeNavIsLoading, codeNavActiveSymbol } = state;

  const allLocations = useMemo(() => {
    if (!codeNavResult) return [];
    return [...codeNavResult.definitions, ...codeNavResult.references];
  }, [codeNavResult]);

  const groups = useMemo(() => groupByFile(allLocations), [allLocations]);

  const [selectedLocation, setSelectedLocation] = useState<CodeNavLocation | null>(null);

  useEffect(() => {
    if (allLocations.length > 0) {
      const first = allLocations[0];
      setSelectedLocation(first);
      preview.selectLocation(first.filePath, first.line);
    } else {
      setSelectedLocation(null);
      preview.clear();
    }
  }, [allLocations]);

  const handleSelect = useCallback(
    (loc: CodeNavLocation) => {
      setSelectedLocation(loc);
      preview.selectLocation(loc.filePath, loc.line);
    },
    [preview.selectLocation],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.api.close();
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [props.api]);

  if (codeNavIsLoading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs gap-2">
        <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-muted-foreground rounded-full animate-spin" />
        Searching for <code className="bg-muted px-1 py-0.5 rounded">{codeNavActiveSymbol}</code>
      </div>
    );
  }

  if (codeNavResult?.backend === 'unavailable') {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        Install <a href="https://github.com/BurntSushi/ripgrep" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline mx-1">ripgrep</a> for code navigation
      </div>
    );
  }

  if (!codeNavResult || allLocations.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
        No results for <code className="bg-muted px-1 py-0.5 rounded ml-1">{codeNavActiveSymbol}</code>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-full flex flex-col border-t border-border/50"
    >
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-auto border-r border-border/30">
          <CodePreview preview={preview.previewData} isLoading={preview.isLoading} />
        </div>
        <div className="w-[260px] flex-shrink-0 overflow-auto">
          <ReferenceList
            groups={groups}
            selectedLocation={selectedLocation}
            onSelect={handleSelect}
          />
        </div>
      </div>
    </div>
  );
};
