/**
 * The thread canvas beside the thread (docs/agent-guides/inbox-canvas.md): the same place a file opens, side by side
 * or full screen, a screen of its own on a phone. The whiteboard (packages/ui/components/canvas/CanvasBoard.tsx,
 * Excalidraw) loads only when the canvas opens. The person's changes save by themselves; the agent's new version
 * updates the open canvas in place with one quiet line saying what changed. An older version (`&cv=N`) shows read
 * only, with the way back to now.
 */
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { relativeWords } from '../relativeTime';
import { shortTime } from '../format';
import { canvasApi, type CanvasVersionWire } from './client';
import type { ThreadCanvas } from './useThreadCanvas';
import './canvas.css';

const CanvasBoard = lazy(() => import('@plannotator/ui/components/canvas/CanvasBoard'));

export interface CanvasPaneProps {
  threadId: string;
  canvas: ThreadCanvas;
  view: 'side' | 'full';
  /** An older version, read only; null: now. */
  version: number | null;
  phone: boolean;
  theme: 'light' | 'dark';
  /** The agent that drew on this canvas, as the thread names it. */
  agent: string;
  projectName: string | null;
  onView: (view: 'side' | 'full') => void;
  onVersion: (n: number | null) => void;
  onClose: () => void;
  /** Full screen: the floating reply box, which owns the bottom (the dock moves to the top). */
  composer?: ReactNode;
}

const QUIET_LINE_MS = 9000;

export function CanvasPane({ threadId, canvas, view, version, phone, theme, agent, projectName, onView, onVersion, onClose, composer }: CanvasPaneProps) {
  const { wire } = canvas;
  const full = phone || view === 'full';
  const [old, setOld] = useState<CanvasVersionWire | null>(null);
  const [flash, setFlash] = useState<string[]>([]);
  const [line, setLine] = useState<ThreadCanvas['agentChange']>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setOld(null);
    if (!version) return;
    let live = true;
    void canvasApi.version(threadId, version).then((v) => live && setOld(v), () => live && setOld(null));
    return () => {
      live = false;
    };
  }, [threadId, version]);

  // The agent's new version: one quiet line, for a while.
  useEffect(() => {
    if (!canvas.agentChange) return;
    setLine(canvas.agentChange);
    const t = setTimeout(() => setLine(null), QUIET_LINE_MS);
    return () => clearTimeout(t);
  }, [canvas.agentChange]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const latestAgent = wire?.versions.filter((v) => v.by === 'agent').at(-1) ?? null;
  const total = wire?.versions.length ?? 0;
  const oldSummary = version ? wire?.versions.find((v) => v.n === version) ?? null : null;
  const marks = wire?.marks.length ?? 0;
  const meta = version
    ? `Version ${version} · ${oldSummary ? `${shortTime(oldSummary.at)}, as ${oldSummary.by === 'agent' ? `${agent} drew it` : 'you left it'}` : ''}`
    : latestAgent
      ? `${agent} · version ${latestAgent.n} · ${relativeWords(latestAgent.at, now)}`
      : 'Draw, type or paste a picture';
  const scene = version ? (old?.scene ?? null) : (wire?.scene ?? null);
  const ready = version ? old !== null : wire !== null;

  return (
    <section
      className={`ib-view ib-nopanel ib-canvasview${full ? ' ib-full' : ''}${phone ? ' ib-phone' : ''}`}
      aria-label="Canvas"
      data-canvas-pane={threadId}
      data-canvas-view={full ? 'full' : 'side'}
    >
      <div className="ib-vhead">
        {phone && (
          <Tip content="Back to the thread">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Back to the thread" data-canvas-back="">
              <Icon name="chevL" />
            </button>
          </Tip>
        )}
        <span className="ib-cv-name" data-header-name="">
          <Icon name="brush" size={14} />
          Canvas
        </span>
        <span className="ib-from ib-cv-meta" data-canvas-meta="">
          {meta}
          {!version && projectName ? (
            <>
              {' · in '}
              <span className="ib-cv-proj">{projectName}</span>
            </>
          ) : null}
          {!version && marks > 0 ? ` · ${marks} ${marks === 1 ? 'mark' : 'marks'} of yours` : ''}
        </span>
        <span className="ib-sp" />
        {!phone && (
          <div className="ib-seg ib-viewseg" role="group" aria-label="View" data-view-switch="">
            <Tip content="Side by side">
              <button type="button" className="ib-seg-o" aria-pressed={!full} data-on={!full ? '' : undefined} onClick={() => onView('side')} aria-label="Side by side" data-view-side="">
                <Icon name="sideBySide" size={14} />
              </button>
            </Tip>
            <Tip content="Full screen">
              <button type="button" className="ib-seg-o" aria-pressed={full} data-on={full ? '' : undefined} onClick={() => onView('full')} aria-label="Full screen" data-full-screen-toggle="">
                <Icon name="frame" size={14} />
              </button>
            </Tip>
          </div>
        )}
        {!phone && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the canvas" data-canvas-close="">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div />
      <div className="ib-vbody ib-cv-body">
        {canvas.failed && !wire ? (
          <div className="ib-error ib-view-error" role="alert">
            The canvas did not load. It loads again when the Inbox answers.
          </div>
        ) : ready ? (
          <Suspense fallback={<div className="ib-cv-wait" aria-hidden="true" />}>
            <CanvasBoard
              key={version ? `v${version}` : 'now'}
              scene={scene}
              sceneKey={version ? `v${version}` : canvas.sceneKey}
              fileUrl={(name) => canvasApi.fileUrl(threadId, name)}
              theme={theme}
              readOnly={!!version}
              dockAtTop={full}
              penWhenEmpty
              flash={flash}
              onChange={version ? undefined : (change) => canvas.save(change)}
              emptyHint={{ title: 'Draw, type or paste a picture', body: `${agent} reads what you add with your next reply, and can draw here too.` }}
            />
          </Suspense>
        ) : (
          <div className="ib-cv-wait" aria-hidden="true" />
        )}
        {version ? (
          <div className="ib-cv-pill" role="status" data-canvas-older="">
            <span>
              Version {version} of {total}
            </span>
            <button type="button" className="ib-btn ib-sm ib-pri" onClick={() => onVersion(null)} data-canvas-now="">
              Back to now
            </button>
          </div>
        ) : null}
        {!version && line ? (
          <div className={`ib-cv-line${full ? ' ib-cv-line-top' : ''}`} role="status" data-canvas-changed="">
            <span>
              <b>{agent}</b> changed {line.changed} {line.changed === 1 ? 'part' : 'parts'} just now
            </span>
            {line.ids.length > 0 && (
              <button type="button" className="ib-btn ib-sm" onClick={() => setFlash([...line.ids])} data-canvas-show="">
                Show
              </button>
            )}
          </div>
        ) : null}
      </div>
      {full && !version ? composer : null}
    </section>
  );
}
