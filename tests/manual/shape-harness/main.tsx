// The Shape dev harness: ShapeSurface over the in-memory fixture host, for
// screenshots and trying the board by hand. Nothing ships this page.
//
//   ?view=picture|how|know|code   the view to open on
//   ?panel=ask|thread|refs        open the panel
//   ?theme=light|dark
//   ?stage=before                 the Code view before implementation
//   ?since=1                      open on v2 and move to v3 ("since you looked")
//   ?session=gone|busy            the drawing session ended / is mid-turn
//   ?notes=1                      seed an answered ask (and, with gone, a waiting change)
//   ?diagram=1                    ShapeDiagram alone: How it works with code links
import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ShapeDiagram, ShapeSurface, type ShapeCodeHoverCardProps, type ShapePanelTab } from '@plannotator/ui/components/shape';
import { ShapeCodeGuide } from '@plannotator/guide-viewer/ShapeCodeGuide';
import { TokenHoverCard } from '@review-editor/components/TokenHoverCard';
import type { ShapeViewId } from '@plannotator/core/shape';
import { createHarnessHost } from './host';
import { hoverFor } from './hover';
import { snoozeBoard, THREAD, V3 } from './fixture';
import './harness.css';

configurePlannotatorUI({ serverSync: () => {} });

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
const view = (['picture', 'how', 'know', 'code'].includes(q.get('view') ?? '') ? q.get('view') : 'picture') as ShapeViewId;
const panel = (['ask', 'thread', 'refs'].includes(q.get('panel') ?? '') ? q.get('panel') : null) as ShapePanelTab | null;

function HoverCard(props: ShapeCodeHoverCardProps) {
  return (
    <TokenHoverCard
      hover={props.hover as never}
      onPointerEnter={props.onPointerEnter ?? (() => {})}
      onPointerLeave={props.onPointerLeave ?? (() => {})}
      onSelectLocation={(loc) => props.onSelectLocation?.({ filePath: loc.filePath, line: loc.line })}
    />
  );
}

function Diagram() {
  const [opened, setOpened] = useState<string | null>(null);
  const how = snoozeBoard(V3).views.how!;
  return (
    <div style={{ padding: 32, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--muted-foreground)' }}>ShapeDiagram, alone. Click a part that opens code (outlined on hover): {opened ?? 'nothing opened yet'}</p>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ShapeDiagram drawn={how} refs={snoozeBoard(V3).refs} onCode={(at) => setOpened(`${at.path}:${at.line}`)} />
      </div>
    </div>
  );
}

function Harness() {
  const host = useMemo(() => createHarnessHost({
    stage: q.get('stage') === 'before' ? 'before' : 'after',
    since: q.get('since') === '1',
    session: (['gone', 'busy'].includes(q.get('session') ?? '') ? q.get('session') : 'live') as 'live' | 'gone' | 'busy',
    notes: q.get('notes') === '1',
  }), []);
  if (q.get('diagram') === '1') return <Diagram />;
  return (
    <ShapeSurface
      host={{ ...host, codeHover: async (_id, req) => hoverFor(req.symbol) }}
      id={host.id}
      CodeGuide={ShapeCodeGuide}
      CodeHoverCard={HoverCard}
      initialView={view}
      initialPanel={panel}
      renderThread={({ flash }) => (
        <div className="harness-thread">
          {THREAD.map((m) => (
            <div key={m.id} data-shape-message={m.id} className={flash === m.id ? 'shp-flash' : ''}>
              <div className="who">{m.who}<span className="at">{m.at}</span></div>
              <p>{m.text}</p>
            </div>
          ))}
        </div>
      )}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme={theme} storageKey={`shape-harness-${theme}`} colorThemeStorageKey={`shape-harness-color-${theme}`}>
      <Harness />
    </ThemeProvider>
  </React.StrictMode>,
);
