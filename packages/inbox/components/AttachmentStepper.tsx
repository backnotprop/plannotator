import { useEffect, useId, useRef } from 'react';
import { inboxAttachmentKindLabel, readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { attachmentImageUrl, imageFitsWithin, readableVersion } from '../attachments';
import { plural } from '../format';
import { Icon } from '../icons';
import type { AttachmentStep } from '../stepping';
import { changedLine, iconOf } from './AttachmentTiles';
import { FileName } from './FileName';

/** Where a step came from: it decides where focus goes after it. */
export type StepSource = 'button' | 'menu' | 'key';

export interface AttachmentStepperProps {
  steps: readonly AttachmentStep[];
  /** The open file's place in `steps`. */
  index: number;
  /** Phones: Previous / "3 of 5" / Next as 44 px buttons, the name left to the header. */
  phone: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  /** Step by one (1 next, -1 previous); at an end the pane shows the end note. */
  onStep: (dir: 1 | -1, source: StepSource) => void;
  /** Open the file at this place in `steps` (from the list). */
  onGo: (index: number) => void;
  /** "Last attachment in this thread", shown for a moment beside the stepper. */
  endNote: string | null;
  /** Annotations waiting for a Send, by file path (the tiles' counts). */
  annotationCounts: ReadonlyMap<string, number>;
}

/** Two lines: where the button goes, then its keys. */
function StepTip({ text, keys, children }: { text: string; keys: string[]; children: React.ReactElement }) {
  return (
    <Tooltip
      side="top"
      wide
      content={
        <span className="flex flex-col gap-1">
          <span>{text}</span>
          {keys.length > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              {keys.map((key, i) => (
                <span key={key} className="flex items-center gap-1">
                  {i > 0 && <span>or</span>}
                  <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-none text-foreground/80">
                    {key}
                  </kbd>
                </span>
              ))}
            </span>
          )}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

/**
 * The stepper in the bar under the open file (design record
 * "inbox-attachment-stepping", v2): `‹ 3 of 5 · name ⌄ ›`. The arrows step
 * through every file of the thread in thread order and stop at the ends (the
 * button greys with `aria-disabled`, so focus stays on it); the label opens
 * the list of every file, grouped by message, upward from the bar. The words
 * follow the annotate bundle switcher ("2 of 3 · mock.html").
 */
export function AttachmentStepper(props: AttachmentStepperProps) {
  const { steps, index, phone, menuOpen } = props;
  const total = steps.length;
  const current = steps[index]!;
  const prev = index > 0 ? steps[index - 1]! : null;
  const next = index < total - 1 ? steps[index + 1]! : null;
  const menuId = `ib-steplist-${useId().replace(/:/g, '')}`;
  const labelRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Closed from the keyboard or by a choice: focus goes back to the label (not after a click elsewhere). */
  const refocus = useRef(false);

  // The list opens on the open file (or the first); closing it hands focus back to the label.
  useEffect(() => {
    const menu = menuRef.current;
    if (menuOpen && menu) {
      refocus.current = true;
      (menu.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLElement>('[role="menuitemradio"]'))?.focus();
    } else if (!menuOpen && refocus.current) {
      refocus.current = false;
      labelRef.current?.focus();
    }
  }, [menuOpen]);

  // A click outside the list or its label closes it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (menuRef.current?.contains(target) || labelRef.current?.contains(target))) return;
      refocus.current = false;
      props.onMenuOpenChange(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen, props.onMenuOpenChange]);

  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = items[(at + 1) % items.length];
    else if (event.key === 'ArrowUp') target = items[(at - 1 + items.length) % items.length];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      props.onMenuOpenChange(false);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
  };

  const prevLabel = prev ? `Previous attachment: ${prev.attachment.name}` : 'Previous attachment';
  const nextLabel = next ? `Next attachment: ${next.attachment.name}` : 'Next attachment';
  const label = `${index + 1} of ${total}, ${current.attachment.name}. Show all attachments`;

  const list = menuOpen && (
    <div className="ib-steplist" id={menuId} role="menu" aria-label="Attachments in this thread" ref={menuRef} onKeyDown={onMenuKey} data-step-list="">
      {steps.map((step, i) => {
        const group = i === 0 || steps[i - 1]!.messageId !== step.messageId;
        const { attachment } = step;
        const count = props.annotationCounts.get(attachment.path) ?? 0;
        const changed = changedLine(attachment, true);
        const isImage = readInboxAttachmentKind(attachment.kind) === 'image';
        return (
          <div key={attachment.id} role="none">
            {group && (
              <div className="ib-stepgroup" role="presentation">
                {step.sender}
                {step.sentAt ? `, ${step.sentAt}` : ''}
              </div>
            )}
            <button
              type="button"
              className="ib-stepitem"
              role="menuitemradio"
              aria-checked={i === index}
              tabIndex={-1}
              onClick={() => props.onGo(i)}
              data-step-item={attachment.id}
            >
              <span className="ib-steppn" aria-hidden="true">
                {i + 1}
              </span>
              <span className="ib-fi">
                {isImage ? <img src={attachmentImageUrl(attachment, readableVersion(attachment))} alt="" loading="lazy" decoding="async" draggable={false} data-small={imageFitsWithin(attachment, 26) ? '' : undefined} /> : <Icon name={iconOf(attachment)} size={14} />}
              </span>
              <span className="ib-stept">
                <b>
                  <FileName name={attachment.name} />
                </b>
                {changed ? (
                  <span className="ib-ch">{changed}</span>
                ) : (
                  <span>
                    {inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type)}
                    {count > 0 ? ` · ${plural(count, 'annotation')}` : ''}
                  </span>
                )}
              </span>
              <span className="ib-stepck" aria-hidden="true">
                {i === index && <Icon name="check" size={15} />}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );

  const endNote = (
    <span className={`ib-endnote${props.endNote ? ' ib-on' : ''}`} aria-hidden="true" data-step-end-note="">
      {props.endNote}
    </span>
  );

  if (phone) {
    return (
      <nav className="ib-stepper ib-stepphone" aria-label="Attachments in this thread" data-attachment-stepper="">
        <button type="button" className="ib-stepbig" aria-label={prevLabel} aria-disabled={prev ? undefined : 'true'} onClick={() => props.onStep(-1, 'button')} data-step-prev="">
          <Icon name="chevL" size={16} />
          <span className="ib-stepbig-l">Previous</span>
        </button>
        <button
          type="button"
          ref={labelRef}
          className="ib-steppos ib-stepmid"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={label}
          onClick={() => props.onMenuOpenChange(!menuOpen)}
          data-step-label=""
        >
          {/* The end note takes the count's place for a moment: in the bar, never over the file. */}
          {props.endNote ? (
            <span className="ib-stepn ib-stepnote" aria-hidden="true" data-step-end-note="">
              {props.endNote}
            </span>
          ) : (
            <span className="ib-stepn">
              {index + 1} of {total}
            </span>
          )}
          <Icon name="chevD" size={13} />
        </button>
        <button type="button" className="ib-stepbig" aria-label={nextLabel} aria-disabled={next ? undefined : 'true'} onClick={() => props.onStep(1, 'button')} data-step-next="">
          <span className="ib-stepbig-l">Next</span>
          <Icon name="chevR" size={16} />
        </button>
        {list}
      </nav>
    );
  }

  return (
    <nav className="ib-stepper" aria-label="Attachments in this thread" data-attachment-stepper="">
      <span className="ib-stepbox">
        <StepTip text={prev ? `Previous: ${prev.attachment.name}` : 'This is the first attachment'} keys={['[', '←']}>
          <button type="button" className="ib-stepbtn" aria-label={prevLabel} aria-disabled={prev ? undefined : 'true'} onClick={() => props.onStep(-1, 'button')} data-step-prev="">
            <Icon name="chevL" size={15} />
          </button>
        </StepTip>
        <button
          type="button"
          ref={labelRef}
          className="ib-steppos"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={label}
          onClick={() => props.onMenuOpenChange(!menuOpen)}
          data-step-label=""
        >
          <span className="ib-stepn">
            {index + 1} of {total}
          </span>
          <span className="ib-stepn" aria-hidden="true">
            ·
          </span>
          <span className="ib-stepnm" data-step-name="">
            <FileName name={current.attachment.name} />
          </span>
          <Icon name="chevD" size={13} />
        </button>
        <StepTip text={next ? `Next: ${next.attachment.name}` : 'This is the last attachment'} keys={[']', '→']}>
          <button type="button" className="ib-stepbtn" aria-label={nextLabel} aria-disabled={next ? undefined : 'true'} onClick={() => props.onStep(1, 'button')} data-step-next="">
            <Icon name="chevR" size={15} />
          </button>
        </StepTip>
      </span>
      {endNote}
      {list}
    </nav>
  );
}
