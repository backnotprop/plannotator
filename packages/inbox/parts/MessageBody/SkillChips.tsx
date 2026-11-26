/**
 * The skill chips in the person's sent words open that skill's file beside the thread (SkillFilePane). The chips are
 * painted with the CSS Custom Highlight API (skillHighlight.ts), so the Viewer's DOM is never changed; a real button
 * is laid over each one in a layer of our own (as the tag marks are, tagHighlight.ts) for the keyboard and screen
 * readers: focusable, named "Open <skill>", opened with Enter or Space, in the words' order (before the skills line).
 *
 * The pointer goes through the layer to the words, so they select as any words do (a drag, a double-click, a long
 * press; a message that takes comments offers its comment tools). The body hears the press instead: a plain click or
 * tap on a chip opens it; a press that moved or left a selection opens nothing; a double-click's second press takes
 * back the open its first click made and selects the chip's words, wherever the open moved the text to. On a mouse
 * the chip shows a pointer and a chip's hover wash. The layer adds no stacking level (no z-index): being positioned,
 * it paints above the words' in-flow text, within the thread's own level, so never over a sheet, the peek or a tip;
 * its hover wash is see-through. Only a sent message has them; the reply box's chip is part of the words being written.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { InboxSkillReference } from '@plannotator/core/skill-reference-block';
import { skillReferenceSpots } from '../../skillHighlight';
import { openSkillFile, takeBackSkillFile } from '../../skillOpener';

interface ChipPlace {
  name: string;
  /** Which reference in the words it is (`skillReferenceSpots`' order). */
  spot: number;
  /** A chip broken over two lines has a box on each: the first is the one focus lands on. */
  part: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How far a press may move and still be a click, as a task line counts it (actionLineToggle.ts). */
const MOVE_MOUSE = 4;
const MOVE_TOUCH = 10;
/** A second press this soon after a chip's click opened its file is a double-click: it takes the open back. */
const DOUBLE_CLICK_MS = 500;

export function SkillChips({
  bodyRef,
  messageId,
  skills,
  onOpen,
}: {
  bodyRef: RefObject<HTMLDivElement | null>;
  messageId: string;
  skills: readonly InboxSkillReference[];
  onOpen: (name: string, from: HTMLElement) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<ChipPlace[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    const body = bodyRef.current;
    const layer = layerRef.current;
    if (!body || !layer) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      // Measured from the layer's own box (a zero-height block in the body), so the body needs no positioning.
      const box = layer.getBoundingClientRect();
      const next = skillReferenceSpots(body, skills).flatMap((spot, at) =>
        [...spot.range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect, part) => ({
            name: spot.name,
            spot: at,
            part,
            left: Math.round(rect.left - box.left),
            top: Math.round(rect.top - box.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          })),
      );
      setChips((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const observer = new MutationObserver((records) => {
      // The chips' own layer changing is not a reason to measure again.
      if (records.every((r) => layer.contains(r.target))) return;
      schedule();
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    resize?.observe(body);
    void body.ownerDocument?.fonts?.ready.then(schedule).catch(() => {});

    /** The chip under a point of the window, or null. */
    const chipAt = (x: number, y: number): ChipPlace | null => {
      const box = layer.getBoundingClientRect();
      return chipsRef.current.find((chip) => x >= box.left + chip.left && x <= box.left + chip.left + chip.width && y >= box.top + chip.top && y <= box.top + chip.top + chip.height) ?? null;
    };
    const buttonOf = (chip: ChipPlace) => layer.querySelector<HTMLElement>(`[data-skill-spot="${chip.spot}"][data-skill-place="words"]`);
    let press: { x: number; y: number; touch: boolean } | null = null;
    let selected = false;
    let opened: { id: number; spot: number; at: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' };
    };
    // Read on the way up: the comment tools take the selection away at this mouseup, so the click finds none.
    const onMouseUp = () => {
      const selection = window.getSelection();
      selected = !!selection && !selection.isCollapsed && selection.toString().trim() !== '';
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.detail < 2 || event.button !== 0 || !opened || Date.now() - opened.at > DOUBLE_CLICK_MS) return;
      const was = opened;
      opened = null;
      takeBackSkillFile(was.id);
      // The open may have moved the words: select the chip's own, not whatever is under the pointer now.
      const spot = skillReferenceSpots(body, skills)[was.spot];
      if (!spot) return;
      event.preventDefault();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(spot.range);
    };
    const onClick = (event: MouseEvent) => {
      const at = press;
      press = null;
      // The buttons' own click (Enter, Space) is theirs.
      if (event.target instanceof Node && layer.contains(event.target)) return;
      if (event.button !== 0 || event.detail > 1 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
      if (selected) return;
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > (at.touch ? MOVE_TOUCH : MOVE_MOUSE)) return;
      const chip = chipAt(event.clientX, event.clientY);
      if (!chip) return;
      if ((event.target as Element | null)?.closest?.('a, button, input, textarea, select, [data-question-option]')) return;
      const button = buttonOf(chip);
      if (!button) return;
      opened = { id: openSkillFile(() => openRef.current(chip.name, button)), spot: chip.spot, at: Date.now() };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const chip = chipAt(event.clientX, event.clientY);
      setHover(chip ? chip.spot : null);
    };
    const onPointerLeave = () => setHover(null);
    body.addEventListener('pointerdown', onPointerDown, true);
    body.addEventListener('mouseup', onMouseUp, true);
    // On the document: the open may have moved this message out from under the pointer before the second press.
    const doc = body.ownerDocument;
    doc.addEventListener('mousedown', onMouseDown, true);
    body.addEventListener('click', onClick);
    body.addEventListener('pointermove', onPointerMove, { passive: true });
    body.addEventListener('pointerleave', onPointerLeave);
    return () => {
      disposed = true;
      observer.disconnect();
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      body.removeEventListener('pointerdown', onPointerDown, true);
      body.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('mousedown', onMouseDown, true);
      body.removeEventListener('click', onClick);
      body.removeEventListener('pointermove', onPointerMove);
      body.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [bodyRef, messageId, skills]);

  // The pointer over a chip: the body's pointer (the words under it set none of their own).
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (hover === null) body.removeAttribute('data-skill-hover');
    else body.setAttribute('data-skill-hover', '');
    return () => body.removeAttribute('data-skill-hover');
  }, [bodyRef, hover]);

  return (
    <div className="ib-skchips" ref={layerRef} data-skill-chips="">
      {chips.map((chip, index) => (
        <button
          key={index}
          type="button"
          className="ib-skchip"
          tabIndex={chip.part === 0 ? 0 : -1}
          aria-hidden={chip.part === 0 ? undefined : true}
          aria-label={`Open ${chip.name}`}
          data-skill-open={chip.name}
          data-skill-spot={chip.spot}
          data-skill-place={chip.part === 0 ? 'words' : 'words-more'}
          data-hover={hover === chip.spot ? '' : undefined}
          style={{ left: chip.left, top: chip.top, width: chip.width, height: chip.height }}
          onClick={(event) => onOpen(chip.name, event.currentTarget)}
        />
      ))}
    </div>
  );
}
