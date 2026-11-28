/**
 * A plan version in the Inbox's own reader: the frame a Markdown file opened beside a thread is read in
 * (components/AttachmentPane.tsx: `.ib-docscroll`, the Clean look on the card colour, the 640 px column, and ui's
 * contents rail in the page's right gutter with the Contents button and sheet where it yields, contents.ts), around
 * the same Viewer (@plannotator/ui), read only. Under the rules for a plan's own words (planContent.tsx): no picture
 * is fetched but one written into the plan, no link but a web one does anything, and a diagram that could load
 * something is shown as its source.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { CONTENTS_RAIL_MIN_PANE_WIDTH } from '@plannotator/ui/utils/annotationHelpers';
import { planPictureTypeOf, type PlanDocumentKind } from '@plannotator/core/plans';
import { PlanContentRules, PlanHtmlFrame, planBlocks, resolvePlanLink } from './planContent';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { diagramDocumentBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { contentsButtonMode, showsContents, useContentsRailWaited, useContentsShown } from '../contents';
import { ContentsPanel } from '../components/ContentsPanel';
import { FileContentsRail } from '../parts/FileContentsRail';
import { useVersionText } from './store';
import { plansApi } from './client';
import { tableRows } from '../wallFaceText';

/** The reader's column, as a file beside a thread (AttachmentPane's Side by side). */
const READER_COLUMN = 640;

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

/** A data page's table on the plan page: its first rows and columns (a spreadsheet's top, read only). */
const DATA_ROWS = 500;
const DATA_COLS = 40;

type PlanDocumentProps = { id: string; version: number; doc?: string | null; kind?: PlanDocumentKind; title?: string; phone?: boolean };

/**
 * `doc` null: the plan's main page. A document's kind sets how it is drawn: Markdown by the Viewer; a Mermaid or
 * Graphviz file as its one diagram (under the same diagram rules); an HTML page in a frame that runs nothing; a
 * picture as a picture (its type read from its bytes; an SVG drawn as a picture, so it runs nothing); a table as cells.
 */
export function PlanDocument(props: PlanDocumentProps) {
  if (props.kind === 'image') return <PlanPicture key={`${props.id}:${props.doc ?? ''}:${props.version}`} {...props} />;
  if (props.kind === 'data') return <PlanData {...props} />;
  return <PlanTextDocument {...props} />;
}

/** A picture page: its bytes as a picture of the type they are (never the type a name claims). */
export function PlanPicture({ id, version, doc = null, title = '' }: PlanDocumentProps) {
  const [state, setState] = useState<{ src: string | null; error: string | null }>({ src: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    void fetch(plansApi.versionUrl(id, version, doc))
      .then(async (res) => {
        if (!res.ok) throw new Error(`The Inbox answered ${res.status}.`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const type = planPictureTypeOf(bytes);
        if (!type) throw new Error('It is not a picture this window draws.');
        url = URL.createObjectURL(new Blob([bytes], { type }));
        if (live) setState({ src: url, error: null });
        else URL.revokeObjectURL(url);
      })
      .catch((error: unknown) => live && setState({ src: null, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, version, doc, retry]);
  if (state.error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>Version {version} could not be read. {state.error}</p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!state.src) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading v{version}…</p>
      </div>
    );
  }
  return (
    <div className="ib-plan-docscroll ib-plan-picture" data-plan-document={version}>
      <img src={state.src} alt={title || `Version ${version}`} draggable={false} />
    </div>
  );
}

/** A data page (CSV or TSV): its rows as cells, the first as the header, row numbers down the side. */
function PlanData({ id, version, doc = null, title = '' }: PlanDocumentProps) {
  const [retry, setRetry] = useState(0);
  const { text, error } = useVersionText(id, version, retry, doc);
  const rows = useMemo(() => (text === null ? [] : tableRows(text, (text.split('\n', 1)[0] ?? '').includes('\t'), DATA_ROWS + 1, DATA_COLS)), [text]);
  if (error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>Version {version} could not be read. {error}</p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading v{version}…</p>
      </div>
    );
  }
  const [head = [], ...body] = rows;
  const width = Math.max(head.length, ...body.map((r) => r.length));
  return (
    <div className="ib-plan-docscroll ib-plan-data" data-plan-document={version}>
      <table aria-label={title || `Version ${version}`}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: width }, (_, c) => (
              <th key={c} scope="col" dir="auto">
                {head[c] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              <th scope="row">{r + 1}</th>
              {Array.from({ length: width }, (_, c) => (
                <td key={c} dir="auto">
                  {row[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanTextDocument({ id, version, doc = null, kind = 'markdown', title = '', phone = false }: PlanDocumentProps) {
  const [retry, setRetry] = useState(0);
  const { text, error } = useVersionText(id, version, retry, doc);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const blocks = useMemo(() => {
    if (text === null || kind === 'html') return [];
    return planBlocks(kind === 'mermaid' || kind === 'graphviz' ? diagramDocumentBlocks(text, kind) : parseMarkdownToBlocks(text));
  }, [text, kind]);
  // Contents, as the reader's: ui's rail in the right gutter where the page is wide enough, else (and on a phone, or
  // hidden) the Contents button and sheet. Shown or hidden is the person's one choice for every document.
  const docKey = `${id}:${doc ?? ''}:${version}`;
  const [contentsShown, setContentsShown] = useContentsShown();
  const hasContents = text !== null && kind === 'markdown' && showsContents(blocks);
  const [railFit, setRailFit] = useState<{ key: string; fits: boolean } | null>(null);
  const railFits = railFit?.key === docKey ? railFit.fits : null;
  const [pageWidth, setPageWidth] = useState(0);
  useLayoutEffect(() => {
    if (!viewport) return;
    const measure = () => setPageWidth(viewport.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [viewport]);
  const sideFits = !phone && pageWidth >= CONTENTS_RAIL_MIN_PANE_WIDTH;
  const railGutter = hasContents && sideFits && contentsShown;
  const waited = useContentsRailWaited(hasContents && !phone, `${docKey}:${contentsShown}`);
  const contentsButton = contentsButtonMode({ hasContents, phone, shown: contentsShown, sideFits, railFits, waited });
  if (error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>Version {version} could not be read. {error}</p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading v{version}…</p>
      </div>
    );
  }
  if (kind === 'html') {
    return (
      <div className="ib-plan-docscroll ib-plan-framewrap" data-plan-document={version}>
        <PlanHtmlFrame html={text} title={title || `Version ${version}`} />
      </div>
    );
  }
  return (
    <div className="ib-plan-docarea">
      {contentsButton && <ContentsPanel key={`contents:${docKey}`} mode={contentsButton} blocks={blocks} annotations={NO_ANNOTATIONS} scrollViewport={viewport} onShow={() => setContentsShown(true)} phone={phone} />}
    <div className="ib-docscroll ib-plan-reader bg-card" data-look="clean" data-contents-gutter={railGutter ? '' : undefined} ref={setViewport} data-plan-document={version}>
      <ScrollViewportProvider viewport={viewport}>
        <PlanContentRules>
          <Viewer
            key={`${id}:${doc ?? ''}:${version}`}
            blocks={blocks}
            markdown={text}
            annotations={NO_ANNOTATIONS}
            onAddAnnotation={noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            maxWidth={railGutter ? null : READER_COLUMN}
            mode="selection"
            taterMode={false}
            readOnly
            resolveLocalLink={resolvePlanLink}
          />
        </PlanContentRules>
      </ScrollViewportProvider>
    </div>
      {hasContents && !phone && (
        <FileContentsRail
          key={`rail:${docKey}`}
          blocks={blocks}
          scrollViewport={viewport}
          hidden={!contentsShown}
          onAvailableChange={(fits) => setRailFit({ key: docKey, fits })}
          onHide={() => setContentsShown(false)}
        />
      )}
    </div>
  );
}
