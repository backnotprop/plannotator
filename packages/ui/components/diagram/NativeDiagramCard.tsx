import { placeNativeNote } from './nativeNotePlacement';
import { ArrowUp, Code2, ExternalLink, Link2, MessageCircle, Paperclip, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiagramPart, DiagramReference } from '@plannotator/diagrams';
import type { ScreenRect } from '../../utils/diagram-projection';
import { refCardTarget, loadRefCard, peekRefCard } from '../../utils/refCard';
import { RefCardView } from '../RefHoverCard';
import { SparklesIcon } from '../SparklesIcon';
import { Button } from '../ui/button';
import type { NativeDiagramFileReference } from './nativeDiagramDrawing';

export type SubmitResult = boolean | void | Promise<boolean | void>;

function LinkDetail({ reference, showTitle }: { reference: Extract<DiagramReference, { kind: 'link' }>; showTitle: boolean }) {
  const { url, title } = reference;
  const target = useMemo(() => refCardTarget(url), [url]);
  const [result, setResult] = useState(() => target ? peekRefCard(target) : null);
  useEffect(() => {
    if (!target) return;
    let active = true;
    void loadRefCard(url, target).then(answer => { if (active) setResult(answer); });
    return () => { active = false; };
  }, [target, url]);
  if (target && result?.ok) return <RefCardView href={url} target={target} result={result} />;
  return <>
    {showTitle && <strong className="ndr-reference-title"><Link2 size={15} />{title}</strong>}
    <a className="ndr-link" href={url} target="_blank" rel="noopener noreferrer">{url}<ExternalLink size={13} /></a>
  </>;
}

export function ReferenceDetails({ part, onOpenFile, pin }: {
  part: DiagramPart;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  pin: () => void;
}) {
  const [index, setIndex] = useState(0);
  const reference = part.refs[index] ?? part.refs[0];
  if (!reference) return null;
  return <div className="ndr-references">
    {part.refs.length > 1 && <ul aria-label="References">{part.refs.map((ref, i) => <li key={i}>
      <button type="button" aria-current={i === index || undefined} onClick={() => { pin(); setIndex(i); }}>
        {ref.kind === 'file' ? <Code2 size={15} /> : <Link2 size={15} />}<span>{ref.title}</span>
      </button>
    </li>)}</ul>}
    {reference.kind === 'link' ? <LinkDetail key={reference.url} reference={reference} showTitle={part.refs.length === 1} /> : <>
      {part.refs.length === 1 && <strong className="ndr-reference-title"><Code2 size={15} />{reference.title}</strong>}
      <div className="ndr-file-path">{reference.path}</div>
      <div className="ndr-file-actions">
        {reference.start !== undefined && <span>{reference.end !== undefined && reference.end !== reference.start ? `Lines ${reference.start}–${reference.end}` : `Line ${reference.start}`}</span>}
        {reference.url ? <a className="ndr-link" href={reference.url} target="_blank" rel="noopener noreferrer">Open file <ExternalLink size={13} /></a>
          : onOpenFile && <Button size="xs" variant="secondary" onClick={() => onOpenFile(reference)}>Open file</Button>}
      </div>
    </>}
  </div>;
}

/** Keep the card beside its part as the drawing moves. Its header can also be dragged clear of the drawing. */
export function FloatingCard({ anchor, heading, children, mode, host, pinned, pinBounds, onClose, onEnter, onLeave, keyboardOpen }: {
  anchor: ScreenRect;
  heading: string;
  children: ReactNode;
  mode: 'references' | 'write' | 'note';
  host: HTMLElement | null;
  pinned: boolean;
  pinBounds?: readonly ScreenRect[];
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
  keyboardOpen: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [geometry, setGeometry] = useState({ width: 0, height: 0, roomWidth: 0, roomHeight: 0, controls: [] as ScreenRect[] });
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  // Replacing the references with a narrower editor keeps the card at the same place.
  const previous = useRef<{ mode: typeof mode; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const last = previous.current;
    if (!pinBounds && mode === 'write' && last && last.mode !== 'write') {
      setOffset({ x: last.left - anchor.left, y: last.top - anchor.top });
    }
    previous.current = { mode, left: box.offsetLeft, top: box.offsetTop };
  });
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !host) return;
    const controls = [...host.querySelectorAll('[data-diagram-zoom-strip], [data-native-ask], [data-native-latest]')];
    const measure = () => {
      const room = host.getBoundingClientRect();
      setGeometry({ width: node.offsetWidth, height: node.offsetHeight, roomWidth: host.clientWidth, roomHeight: host.clientHeight,
        controls: controls.map(control => { const box = control.getBoundingClientRect(); return { left: box.left - room.left, top: box.top - room.top, width: box.width, height: box.height }; }) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(host);
    for (const control of controls) observer.observe(control);
    return () => observer.disconnect();
  }, [host, mode]);
  useEffect(() => {
    if (keyboardOpen && mode !== 'write') ref.current?.focus({ preventScroll: true });
  }, [keyboardOpen, mode]);

  const { width, height, roomWidth, roomHeight } = geometry;
  const gap = 8;
  const right = anchor.left + anchor.width + gap;
  const left = anchor.left - width - gap;
  const below = anchor.top + anchor.height + gap;
  const beside = right + width <= roomWidth - gap || left >= gap;
  const x = offset ? anchor.left + offset.x : beside ? (right + width <= roomWidth - gap ? right : left) : anchor.left;
  const y = offset ? anchor.top + offset.y : beside ? anchor.top : below + height <= roomHeight - gap ? below : anchor.top - height - gap;
  const clamp = (value: number, max: number) => Math.max(gap, Math.min(max - gap, value));
  const note = !offset && pinBounds ? placeNativeNote(anchor, width, height, roomWidth, roomHeight, [...pinBounds, ...geometry.controls]) : null;
  return <div ref={ref} role="dialog" aria-label={heading} tabIndex={-1} data-diagram-control="" className="ndr-card"
    data-mode={mode} data-positioned-note={pinBounds ? '' : undefined} data-pinned={pinned || undefined}
    style={note ?? { left: clamp(x, roomWidth - width), top: clamp(y, roomHeight - height) }}
    onWheelCapture={e => e.stopPropagation()} onPointerEnter={onEnter} onPointerLeave={onLeave}
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    onPointerDown={e => {
      if (!pinned || !e.isPrimary || !(e.target instanceof Element) || !e.target.closest('.ndr-card-head') || e.target.closest('button,a')) return;
      if (roomWidth <= 640) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: e.currentTarget.offsetLeft, top: e.currentTarget.offsetTop };
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={e => {
      const start = drag.current;
      if (!start || e.pointerId !== start.id) return;
      setOffset({ x: start.left + e.clientX - start.x - anchor.left, y: start.top + e.clientY - start.y - anchor.top });
    }}
    onLostPointerCapture={() => { drag.current = null; }}>
    {children}
  </div>;
}

export function RefActions({ onComment, onAsk }: { onComment?: () => void; onAsk?: () => void }) {
  if (!onComment && !onAsk) return null;
  return <div className="ndr-actions">
    {onComment && <Button size="xs" variant="ghost" onClick={onComment}><MessageCircle />Comment</Button>}
    {onAsk && <Button size="xs" variant="ghost" onClick={onAsk}><SparklesIcon />Ask AI</Button>}
  </div>;
}

export function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button className="ndr-close" size="icon" variant="ghost" aria-label={label} onClick={onClick}><X size={15} /></Button>;
}

export function TextEditor({ initial, label, ask, original, onSubmit, onDone, onCancel, onChange }: {
  initial: string; label: string; ask?: 'side' | 'thread'; original?: string;
  onSubmit: (body: string) => SubmitResult; onDone: (body: string) => void; onCancel: () => void; onChange?: (body: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<{ message: string; unavailable: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    input.current?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);
  async function submit() {
    const body = text.trim();
    if (!body || pending.current || error?.unavailable) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (await onSubmit(body) === false) throw new Error();
      if (mounted.current) onDone(body);
    } catch (cause) {
      if (mounted.current) {
        const unavailable = !ask && cause instanceof DOMException && cause.name === 'NotSupportedError';
        const message = unavailable ? cause.message : ask ? 'Couldn’t send the question. Try again.' : 'Couldn’t save the comment. Try again.';
        setError({ message, unavailable });
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <div className="ndr-editor" data-ask-destination={ask} aria-busy={busy}>
    <textarea ref={input} rows={2} aria-label={label} value={text} readOnly={busy}
      placeholder={ask ? 'Ask a question…' : 'Add a comment…'} onChange={e => { setText(e.target.value); onChange?.(e.target.value); }}
      onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key === 'Enter' && (ask ? !e.shiftKey : e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
      }} />
    {error && <div className="ndr-error" role="alert">{error.message}</div>}
    <div className="ndr-editor-actions">
      {!ask && <Button size="xs" variant="ghost" onClick={onCancel} type="button">Cancel</Button>}
      <Button size={ask === 'side' ? 'icon' : 'xs'} disabled={busy || error?.unavailable || !text.trim() || (text.trim() === original)} type="button" onClick={() => void submit()} aria-label={ask === 'side' ? 'Send question' : undefined}>
        {ask === 'thread' ? 'Send question to thread' : ask === 'side' ? <ArrowUp /> : original !== undefined ? 'Save' : 'Add comment'}
      </Button>
    </div>
  </div>;
}

export function AskDrawer({ title, part, onClose, children }: { title: string; part?: DiagramPart; onClose: () => void; children: ReactNode }) {
  return <aside className="ndr-ask" data-diagram-control="" role="dialog" aria-label="Ask AI" onWheelCapture={e => e.stopPropagation()}
    onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
    <header><strong>Ask AI</strong><CloseButton label="Close Ask AI" onClick={onClose} /></header>
    <div className="ndr-ask-context">{part ? <Paperclip size={15} /> : <MessageCircle size={15} />}{part?.title ?? title}</div>
    {children}
  </aside>;
}
