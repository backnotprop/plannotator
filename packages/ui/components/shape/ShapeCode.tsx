import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import type { CodeAnnotation } from '../../types';
import { CodeFileView, type CodeFileAnnotationInput, type CodeFileTokenTarget } from '../CodeFilePopout';
import type { CommentExtraAction } from '../CommentPopover';
import { useTheme } from '../ThemeProvider';
import type { ShapeVersion } from '@plannotator/core/shape';
import type { ShapeCodeGuideProps, ShapeCodeHoverCardProps, ShapeCodeHoverRequest } from './types';
import { ShapeInline } from './inline';

type Code = NonNullable<ShapeVersion['views']['code']>;

export interface ShapeFileTarget {
  path: string;
  line: number;
  token: number;
}

export function ShapePatch({ patch }: { patch: string }) {
  const dark = useTheme().resolvedMode === 'dark';
  return <PatchDiff patch={patch} options={{ themeType: dark ? 'dark' : 'light', diffStyle: 'unified', overflow: 'scroll' }} />;
}

/** Without the guide chain: the steps as text, so the view still says what the code does. */
function GuideFallback({ code }: { code: Code }) {
  return (
    <div className="shp-guide-fallback">
      <h2>{code.guide.title}</h2>
      {code.guide.intent && <p>{code.guide.intent}</p>}
      <ol>
        {code.guide.sections.map((s, i) => (
          <li key={i}>
            <b>{s.title}</b>
            <p>{s.overview}</p>
            {s.diffs.length > 0 && <ul>{s.diffs.map((d) => <li key={d.file}><code>{d.file}</code>{d.summary ? ` · ${d.summary}` : ''}</li>)}</ul>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ShapeCode({
  code,
  CodeGuide,
  CodeHoverCard,
  file,
  onOpenFile,
  onCloseFile,
  readFile,
  codeHover,
  annotations,
  onComment,
  onAsk,
  lineAction,
  generalComment,
  phone,
  fileAction,
}: {
  code: Code;
  CodeGuide?: React.ComponentType<ShapeCodeGuideProps>;
  CodeHoverCard?: React.ComponentType<ShapeCodeHoverCardProps>;
  file: ShapeFileTarget | null;
  onOpenFile: (path: string, line: number) => void;
  onCloseFile: () => void;
  readFile?: (path: string) => Promise<string | null>;
  codeHover?: (request: ShapeCodeHoverRequest) => Promise<unknown | null>;
  annotations: CodeAnnotation[];
  onComment: (input: CodeFileAnnotationInput) => void;
  onAsk: (input: CodeFileAnnotationInput) => void;
  lineAction?: (lines: { filePath: string; lineStart: number; lineEnd: number }) => CommentExtraAction | undefined;
  generalComment: React.ReactNode;
  phone: boolean;
  fileAction?: (file: { path: string; line?: number }) => React.ReactNode;
}) {
  const openable = new Map((code.files ?? []).map((f) => [f.path, f.line ?? 1]));
  const openLine = useCallback((path: string) => (readFile && openable.has(path) ? openable.get(path)! : null), [readFile, code.files]); // eslint-disable-line react-hooks/exhaustive-deps
  const renderDiff = useCallback((f: { path: string; patch: string }) => <ShapePatch patch={f.patch} />, []);
  const guideFileAction = useCallback((path: string) => fileAction?.({ path, line: openable.get(path) }) ?? null, [fileAction, code.files]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="shp-guidewrap" data-stage={code.stage}>
        {CodeGuide ? (
          <CodeGuide code={code} renderDiff={renderDiff} openLine={openLine} onOpenFile={onOpenFile} headerActions={generalComment} fileAction={fileAction ? guideFileAction : undefined} />
        ) : (
          <>
            <div className="shp-guide-fallback-acts">{generalComment}</div>
            <GuideFallback code={code} />
          </>
        )}
      </div>
      {file && readFile && (
        <WholeFile
          code={code}
          file={file}
          onFile={(path, line) => onOpenFile(path, line ?? openable.get(path) ?? 1)}
          onClose={onCloseFile}
          readFile={readFile}
          codeHover={codeHover}
          CodeHoverCard={CodeHoverCard}
          annotations={annotations}
          onComment={onComment}
          onAsk={onAsk}
          lineAction={lineAction}
          phone={phone}
          fileAction={fileAction}
        />
      )}
    </>
  );
}

type Hover = ShapeCodeHoverCardProps['hover'];

function WholeFile({
  code,
  file,
  onFile,
  onClose,
  readFile,
  codeHover,
  CodeHoverCard,
  annotations,
  onComment,
  onAsk,
  lineAction,
  phone,
  fileAction,
}: {
  code: Code;
  file: ShapeFileTarget;
  onFile: (path: string, line?: number) => void;
  onClose: () => void;
  readFile: (path: string) => Promise<string | null>;
  codeHover?: (request: ShapeCodeHoverRequest) => Promise<unknown | null>;
  CodeHoverCard?: React.ComponentType<ShapeCodeHoverCardProps>;
  annotations: CodeAnnotation[];
  onComment: (input: CodeFileAnnotationInput) => void;
  onAsk: (input: CodeFileAnnotationInput) => void;
  lineAction?: (lines: { filePath: string; lineStart: number; lineEnd: number }) => CommentExtraAction | undefined;
  phone: boolean;
  fileAction?: (file: { path: string; line?: number }) => React.ReactNode;
}) {
  const [contents, setContents] = useState<string | null | undefined>(undefined);
  const [hover, setHover] = useState<Hover | null>(null);
  const openTimer = useRef(0);
  const closeTimer = useRef(0);
  const files = code.files ?? [{ path: file.path }];

  useEffect(() => {
    let live = true;
    setContents(undefined);
    readFile(file.path).then((text) => live && setContents(text), () => live && setContents(null));
    return () => {
      live = false;
    };
  }, [file.path, readFile]);

  useEffect(() => setHover(null), [file.path]);
  useEffect(() => () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  const onToken = useCallback(
    (kind: 'enter' | 'leave' | 'click', t: CodeFileTokenTarget) => {
      if (!codeHover || !CodeHoverCard) return;
      if (kind === 'enter') {
        window.clearTimeout(openTimer.current);
        window.clearTimeout(closeTimer.current);
        openTimer.current = window.setTimeout(async () => {
          const request: ShapeCodeHoverRequest = { symbol: t.tokenText.trim(), filePath: file.path, line: t.lineNumber, charStart: t.lineCharStart, side: 'new' };
          if (!/^[A-Za-z_$][\w$]{2,}$/.test(request.symbol)) return;
          const data = await codeHover(request);
          if (data) setHover({ request, data: data as never, rect: t.tokenElement.getBoundingClientRect() });
        }, 380);
      } else if (kind === 'leave') {
        window.clearTimeout(openTimer.current);
        closeTimer.current = window.setTimeout(() => setHover(null), 260);
      }
    },
    [codeHover, CodeHoverCard, file.path],
  );

  return (
    <div className="shp-file-over">
      <div className="shp-file-bar">
        <button type="button" onClick={onClose}>← Guide</button>
        {code.source && <span className="shp-file-src"><ShapeInline text={code.source} /></span>}
      </div>
      <div className={`shp-codeview${phone ? ' phone' : ''}`}>
        {files.length > 1 && (
          <nav className="shp-files" aria-label="Files">
            {phone ? (
              <select value={file.path} onChange={(e) => onFile(e.target.value)} aria-label="File">
                {files.map((f) => <option key={f.path} value={f.path}>{f.path.split('/').pop()}</option>)}
              </select>
            ) : (
              files.map((f) => (
                <button key={f.path} type="button" className={f.path === file.path ? 'on' : ''} onClick={() => onFile(f.path)} title={f.path}>
                  <span className="fn">{f.path.split('/').pop()}</span>
                  <span className="fr">{f.path.split('/').slice(0, -1).join('/')}</span>
                </button>
              ))
            )}
          </nav>
        )}
        <div className="shp-code-main">
          <div className="shp-code-head"><span className="path">{file.path}</span>{fileAction?.({ path: file.path, line: file.line })}</div>
          {contents === undefined ? (
            <p className="shp-empty-note">Opening…</p>
          ) : contents === null ? (
            <p className="shp-empty-note">This file could not be read.</p>
          ) : (
            <CodeFileView
              filepath={file.path}
              contents={contents}
              className="shp-code-file"
              overflow={phone ? 'wrap' : 'scroll'}
              allowImages={false}
              annotations={annotations.filter((a) => a.filePath === file.path)}
              onAddAnnotation={onComment}
              onAskAnnotation={onAsk}
              commentSubmitLabel="Change it"
              commentAskLabel="Ask"
              commentExtraAction={lineAction}
              revealLine={{ line: file.line, token: file.token }}
              onTokenTarget={codeHover && CodeHoverCard ? onToken : undefined}
            />
          )}
        </div>
      </div>
      {hover && CodeHoverCard && (
        <CodeHoverCard
          hover={hover}
          onPointerEnter={() => window.clearTimeout(closeTimer.current)}
          onPointerLeave={() => {
            closeTimer.current = window.setTimeout(() => setHover(null), 200);
          }}
          onSelectLocation={(loc) => {
            setHover(null);
            if (files.some((f) => f.path === loc.filePath)) onFile(loc.filePath, loc.line);
          }}
        />
      )}
    </div>
  );
}
