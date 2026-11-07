// The screenshot page. See serve.ts for the addresses.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bySheetOrder, formatIssue, loadFiles, type SystemModel } from '../src/index.ts';
import { fontsReady, SystemThumb, SystemView, type Reading } from '../src/react.ts';

const q = new URLSearchParams(location.search);
const root = document.documentElement;
root.classList.add('theme-plannotator');
root.classList.toggle('light', q.get('mode') === 'light');

function Thumb({ model }: { model: SystemModel }) {
  const top = model.sheets[model.root] ? model.root : Object.keys(model.sheets).sort(bySheetOrder(model.sheets))[0];
  const n = Object.keys(model.sheets).length;
  return (
    <div className="demo-page">
      <div className="demo-msg">
        <div className="demo-who"><b>Claude Code</b><span>in plannotator · to you</span></div>
        <div className="demo-text">The first drawing is ready: {n} sheets. I will redraw it when main moves.</div>
        <div className="demo-card">
          <div className="demo-card-head">
            <b>{model.name}</b>
            <span className="demo-code">{top}</span>
            <span className="demo-dim">· top sheet of {n}</span>
            <button type="button" className="demo-open">Open</button>
          </div>
          <SystemThumb model={model} width={690} />
        </div>
      </div>
    </div>
  );
}

function View({ model }: { model: SystemModel }) {
  const [sheet, setSheet] = useState(q.get('sheet') ?? undefined);
  const [reading, setReading] = useState<Reading>(q.get('reading') === 'simple' ? 'simple' : 'full');
  const layout = q.get('layout') === 'pane' ? 'pane' : 'window';
  return (
    <div className="demo-window">
      <SystemView
        model={model}
        sheet={sheet}
        project="plannotator"
        reading={reading}
        layout={layout}
        onNavigate={setSheet}
        onReading={setReading}
        onOpenFull={layout === 'pane' ? () => {} : undefined}
        onClose={() => {}}
      />
    </div>
  );
}

/** The faces, the default theme, the Inbox's tokens, the drawing's sheet, then the page's frame. */
const SHEETS = ['/css/inter/index.css', '/css/geist-mono/index.css', '/css/themes/plannotator.css', '/css/inbox/inbox.css', '/css/system/system.css', '/css/demo/demo.css'];
const linked = () =>
  Promise.all(
    SHEETS.map((href) => new Promise((done) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = l.onerror = done;
      document.head.append(l);
    })),
  );

async function main() {
  await linked();
  const el = document.getElementById('root')!;
  el.className = 'pn-inbox';
  const files = (await (await fetch('/files.json')).json()) as Record<string, string>;
  const { model, errors } = loadFiles(files);
  await fontsReady();
  if (!model) {
    el.innerHTML = `<div class="demo-error"></div>`;
    el.firstElementChild!.textContent = errors.map(formatIssue).join('\n');
    return;
  }
  createRoot(el).render(q.get('shot') === 'thumb' ? <Thumb model={model} /> : <View model={model} />);
  document.body.dataset.ready = '1';
}
void main();
