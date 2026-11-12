import React, { useCallback, useMemo, useState } from 'react';
import type { CodeGuideData } from '@plannotator/core/guide';
import type { ShapeCodeView } from '@plannotator/core/shape';
import { GuideHostProvider, type GuideDiffRendererProps, type GuideHostValue } from './host';
import { GuideView } from './GuideView';
import { parseDiffToFiles } from './diffParser';
import { renderInlineMarkdown } from './renderInlineMarkdown';

export interface ShapeCodeGuideProps {
  code: ShapeCodeView;
  renderDiff: (file: { path: string; patch: string }) => React.ReactNode;
  openLine?: (path: string) => number | null;
  onOpenFile?: (path: string, line: number) => void;
  headerActions?: React.ReactNode;
  fileAction?: (path: string) => React.ReactNode;
}

const noProps = () => ({});

export function ShapeCodeGuide({ code, renderDiff, openLine, onOpenFile, headerActions, fileAction }: ShapeCodeGuideProps) {
  const before = code.stage === 'before';
  const files = useMemo(() => (code.patch ? parseDiffToFiles(code.patch) : []), [code.patch]);
  const guide = useMemo<CodeGuideData>(() => {
    const placed = new Set(code.guide.sections.flatMap((s) => s.diffs.map((d) => d.file)));
    const unplaced = code.guide.unplacedFiles ?? (before ? [] : files.map((f) => f.path).filter((p) => !placed.has(p)));
    return { ...code.guide, unplacedFiles: unplaced, reviewed: code.guide.sections.map(() => false) };
  }, [code.guide, files, before]);
  const [reviewed, setReviewed] = useState<boolean[]>(() => code.guide.sections.map(() => false));
  const [focused, setFocused] = useState<string | null>(null);

  const DiffRenderer = useMemo(() => {
    function ShapeGuideDiff({ files: shown }: GuideDiffRendererProps) {
      const file = shown[0];
      if (!file) return null;
      return <div className="shp-gdiff">{renderDiff({ path: file.path, patch: file.patch })}</div>;
    }
    return ShapeGuideDiff;
  }, [renderDiff]);

  const renderFileActions = useCallback(
    (file: { path: string }) => {
      const action = fileAction?.(file.path);
      if (before) return <>{action}<span className="shp-proposed" title="A proposed change. Nothing is applied yet.">Proposed · not applied</span></>;
      const line = openLine?.(file.path);
      if (!line || !onOpenFile) return action ?? null;
      return (
        <>
          {action}
          <button type="button" className="shp-g-open" onClick={() => onOpenFile(file.path, line)} title={`Open ${file.path} at line ${line}`}>
            Open at line {line}
          </button>
        </>
      );
    },
    [before, openLine, onOpenFile, fileAction],
  );

  const renderLink = useCallback(
    (href: string, label: React.ReactNode, key: string | number) => {
      if (/^https?:\/\//i.test(href)) {
        return <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary">{label}</a>;
      }
      const m = href.match(/^code:([^#]+)#L(\d+)/);
      if (!m || before || !onOpenFile || openLine?.(m[1]!) == null) return null;
      return (
        <button key={key} type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onOpenFile(m[1]!, Number(m[2]))}>
          {label}
        </button>
      );
    },
    [before, onOpenFile, openLine],
  );

  const renderSectionEmpty = useCallback(
    (index: number) => {
      if (!before) return null;
      const planned = code.planned?.[index] ?? [];
      return (
        <div className="shp-g-planned">
          <p className="shp-g-planned-h">Not built yet · no diff until the change exists</p>
          {planned.length > 0 && (
            <ul>
              {planned.map((f) => (
                <li key={f.path}>
                  <span className={`shp-g-kind ${f.kind}`}>{f.kind === 'new' ? 'new' : 'changes'}</span>
                  <code>{f.path}</code>
                  {f.kind !== 'new' && fileAction?.(f.path)}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    },
    [before, code.planned, fileAction],
  );

  const host = useMemo(
    () => ({ files, DiffRenderer, getDiffRendererProps: noProps, renderFileActions, renderLink, renderSectionEmpty }) as GuideHostValue<Record<string, never>>,
    [files, DiffRenderer, renderFileActions, renderLink, renderSectionEmpty],
  );

  const proposed = before ? files.length : 0;
  const sourceLine = code.source
    ? <>{renderInlineMarkdown(code.source, { renderLink })}</>
    : before
      ? <>Before implementation · nothing applied{proposed ? ` · ${proposed} proposed diff${proposed === 1 ? '' : 's'}` : ''}</>
      : undefined;

  return (
    <div className="shp-guide" data-stage={code.stage}>
      <GuideHostProvider value={host}>
        <GuideView
          guide={guide}
          reviewed={reviewed}
          onToggleReviewed={(i) => setReviewed((r) => r.map((v, j) => (j === i ? !v : v)))}
          focusedFile={focused}
          onFocusFile={setFocused}
          sourceLine={sourceLine}
          headerActions={headerActions}
        />
      </GuideHostProvider>
    </div>
  );
}
