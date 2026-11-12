import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bySheetOrder, formatIssue, gate, loadFiles, parseRevision, type ChangedFile, type ChangeFile, type GateResult, type Revision, type SystemFiles, type SystemModel, type Touch } from '../src/index.ts';
import { fontsReady, SystemChangePicture, SystemThumb, SystemView, type Reading } from '../src/react.ts';

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
        keys={q.get('keys') !== 'off'}
        onNavigate={setSheet}
        onReading={setReading}
        onOpenFull={layout === 'pane' ? () => {} : undefined}
        onClose={() => {}}
      />
    </div>
  );
}

type Fixtures = { prs: Record<string, ChangeFile[]>; before2563: SystemFiles; open2563: string; plan: string; removes: string; touches: { label: string; files: ChangedFile[] }[] };
type Change = { model: SystemModel; change: Revision | GateResult; files: ChangeFile[]; pr: number; title: string; state: 'open' | 'merged' };

function pickChange(model: SystemModel, fx: Fixtures): Change {
  const n = q.get('pr') === '2563' || q.get('open') ? 2563 : 2543;
  const files = fx.prs[n]!;
  if (q.get('removes')) {
    const { revision } = parseRevision(model, fx.removes);
    return { model, change: revision!, files: [], pr: 9001, title: revision!.title, state: 'open' };
  }
  if (q.get('open')) {
    const base = loadFiles(fx.before2563).model!;
    const { revision } = parseRevision(base, fx.open2563);
    return { model: base, change: revision!, files, pr: n, title: revision!.title, state: 'open' };
  }
  const r = model.revisions['PR-' + n]!;
  if (q.get('gate')) return { model, change: gate({ files: files.map((f) => ({ ...f, status: f.status ?? 'M' })), model }), files, pr: n, title: r.title, state: 'open' };
  return { model, change: r, files, pr: n, title: r.title, state: 'merged' };
}

const CHAPTERS: Record<number, string[]> = {
  2543: ['The ping and what it sends', 'Who pings, and when', 'Turning it off'],
  2563: ['T3 Code as a host', 'Finding the thread', 'Sending your reply'],
};

function Card({ c }: { c: Change }) {
  const add = c.files.reduce((n, f) => n + (f.additions ?? 0), 0), del = c.files.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="demo-page">
      <div className="demo-msg">
        <div className="demo-who"><b>Claude Code</b><span>in plannotator · to you</span></div>
        <div className="demo-text">The guided review of PR {c.pr}: three sections, read in order.</div>
        <div className="ib-rvcard" data-review-card="">
          <div className="ib-rvc-top"><span className="ib-rvc-kind">Review</span><span className="ib-rvc-state">Waiting on you</span></div>
          <div className="ib-rvc-title"><bdi>{c.title}</bdi></div>
          <div className="ib-rvc-meta">{c.files.length} files <span className="ib-add">+{add.toLocaleString('en-US')}</span> <span className="ib-del">-{del}</span></div>
          <SystemChangePicture model={c.model} change={c.change} files={c.files} onOpen={() => { document.body.dataset.opened = '1'; }} />
          <ol className="ib-rvc-chapters">
            {(CHAPTERS[c.pr] ?? []).map((t, i) => <li key={t}><span className="ib-rvc-n">{i + 1}</span><span className="ib-rvc-ct">{t}</span></li>)}
          </ol>
          <div className="ib-rvc-foot"><button type="button" className="ib-btn ib-pri">Start review</button></div>
        </div>
      </div>
    </div>
  );
}

function ChangeView({ c }: { c: Change }) {
  const [sheet, setSheet] = useState<string | undefined>(q.get('sheet') ?? undefined);
  const [reading, setReading] = useState<Reading>('full');
  const [view, setView] = useState<'before' | 'after' | 'steps'>((q.get('view') as 'before') ?? 'after');
  const [opened, setOpened] = useState('');
  return (
    <div className="demo-window" data-opened={opened || undefined}>
      <SystemView
        model={c.model} revision={c.change} files={c.files} pr={{ state: c.state, title: c.title, number: c.pr }} sheet={sheet} project="plannotator" reading={reading} layout="window" view={view}
        onNavigate={setSheet} onReading={setReading} onView={setView} onOpenFile={(path) => setOpened(path)} onOpenDetails={() => {}} onClose={() => {}}
      />
    </div>
  );
}

function PlanView({ model, plan }: { model: SystemModel; plan: Revision }) {
  const [sheet, setSheet] = useState<string | undefined>(undefined);
  return (
    <div className="demo-window">
      <SystemView model={model} revision={plan} mode="plan" sheet={sheet} project="plannotator" layout="window" onNavigate={setSheet} />
    </div>
  );
}

function TouchesView({ model, touches }: { model: SystemModel; touches: Touch[] }) {
  const [sheet, setSheet] = useState<string | undefined>(q.get('sheet') ?? undefined);
  const [reading, setReading] = useState<Reading>('full');
  const layout = q.get('layout') === 'pane' ? 'pane' : 'window';
  const lead = q.get('lead') ? <button type="button" className="demo-back">‹ Reviews</button> : undefined;
  return (
    <div className="demo-window">
      <SystemView
        model={model} touches={touches} leading={lead} sheet={sheet} project="plannotator" reading={reading} layout={layout}
        onNavigate={setSheet} onReading={setReading} onOpenFull={layout === 'pane' ? () => {} : undefined}
      />
    </div>
  );
}

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
  const shot = q.get('shot');
  let node = shot === 'thumb' ? <Thumb model={model} /> : <View model={model} />;
  if (shot === 'card' || shot === 'change' || shot === 'plan' || shot === 'touches') {
    const fx = (await (await fetch('/change.json')).json()) as Fixtures;
    if (shot === 'touches') {
      node = <TouchesView model={model} touches={fx.touches.map((t) => ({ label: t.label, change: gate({ files: t.files, model }) }))} />;
    } else if (shot === 'plan') {
      const { revision, errors: pe } = parseRevision(model, fx.plan);
      if (!revision) throw new Error(pe.map(formatIssue).join('\n'));
      node = <PlanView model={model} plan={revision} />;
    } else {
      const c = pickChange(model, fx);
      node = shot === 'card' ? <Card c={c} /> : <ChangeView c={c} />;
    }
  }
  createRoot(el).render(node);
  document.body.dataset.ready = '1';
}
void main();
