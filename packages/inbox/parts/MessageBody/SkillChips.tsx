/**
 * The skill chips in the person's sent words open that skill's file beside the thread (SkillFilePane). The chips are
 * painted with the CSS Custom Highlight API (skillHighlight.ts), so the Viewer's DOM is never changed; a real button
 * is laid over each one in a layer of our own (as the tag marks are, tagHighlight.ts): focusable, opened with a click,
 * Enter or Space, its pointer and hover those of an inline chip. Only a sent message has them; the reply box's chip is
 * part of the words being written and stays as it is.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { InboxSkillReference } from '@plannotator/core/skill-reference-block';
import { skillReferenceSpots } from '../../skillHighlight';

interface ChipPlace {
  name: string;
  /** A chip broken over two lines has a box on each: the first is the one focus lands on. */
  part: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

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
  useEffect(() => {
    const body = bodyRef.current;
    const layer = layerRef.current;
    if (!body || !layer) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      // Measured from the layer's own box (a zero-height block in the body), so the body needs no positioning.
      const box = layer.getBoundingClientRect();
      const next = skillReferenceSpots(body, skills).flatMap((spot) =>
        [...spot.range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect, part) => ({
            name: spot.name,
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
    return () => {
      disposed = true;
      observer.disconnect();
      resize?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bodyRef, messageId, skills]);
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
          data-skill-place={chip.part === 0 ? 'words' : 'words-more'}
          style={{ left: chip.left, top: chip.top, width: chip.width, height: chip.height }}
          onClick={(event) => onOpen(chip.name, event.currentTarget)}
        />
      ))}
    </div>
  );
}
