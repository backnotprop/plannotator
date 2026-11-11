import { useEffect, useId, useMemo, useRef } from 'react';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImagePeek, type ImagePeekRow } from '@plannotator/ui/components/ImagePeek';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { attachmentImageUrl, readableVersion } from '../attachments';
import { drawnImageUrl, GALLERY_IMAGE_WIDTH } from '../images';
import { Icon } from '../icons';
import type { AttachmentStep } from '../stepping';
import { changedLine } from './AttachmentTiles';
import { FileName } from './FileName';
import { inboxFileViewerShortcuts } from '../shortcuts/fileViewer.shortcuts';
import { TipKeys } from '../shortcuts/hint';

export type StepSource = 'button' | 'menu' | 'key';

export interface AttachmentStepperProps {
  steps: readonly AttachmentStep[];
  index: number;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onStep: (dir: 1 | -1, source: StepSource) => void;
  onGo: (index: number) => void;
  endNote: string | null;
  annotationCounts: ReadonlyMap<string, number>;
  peek?: { steps: readonly AttachmentStep[]; index: number; onGo: (index: number) => void };
}

export function peekTile(attachment: Pick<InboxAttachmentState, 'name' | 'kind'>): string {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(attachment.name)?.[1];
  if (ext) return ext.toUpperCase();
  return readInboxAttachmentKind(attachment.kind).toUpperCase().slice(0, 5);
}

export function peekRows(steps: readonly AttachmentStep[], counts: ReadonlyMap<string, number>): ImagePeekRow[] {
  const rows: ImagePeekRow[] = [];
  for (const step of steps) {
    const { attachment } = step;
    let row = rows.at(-1);
    if (!row || row.key !== step.messageId) {
      row = { key: step.messageId, label: step.sentAt || step.sender, items: [] };
      rows.push(row);
    }
    const isImage = readInboxAttachmentKind(attachment.kind) === 'image';
    const changed = changedLine(attachment, true);
    row.items.push({
      key: attachment.id,
      name: attachment.name,
      thumb: isImage ? drawnImageUrl(attachmentImageUrl(attachment, readableVersion(attachment)), attachment.width, GALLERY_IMAGE_WIDTH) : null,
      tile: peekTile(attachment),
      count: counts.get(attachment.path) ?? 0,
      attached: !step.inline,
      ...(changed ? { detail: changed.toLowerCase() } : {}),
    });
  }
  return rows;
}

export function peekSheetHost(near: Element | null): Element | null {
  if (typeof document === 'undefined') return null;
  return near?.closest('.pn-inbox') ?? document.querySelector('.pn-inbox') ?? document.body;
}

export function FilePeek(props: {
  id: string;
  steps: readonly AttachmentStep[];
  index: number;
  phone: boolean;
  annotationCounts: ReadonlyMap<string, number>;
  onClose: (reason: 'key' | 'outside') => void;
  onGo: (index: number) => void;
  within?: { steps: readonly AttachmentStep[]; index: number; noun: 'option' };
  onStep?: (dir: 1 | -1) => void;
}) {
  const { steps, phone, index } = props;
  const rows = useMemo(() => peekRows(steps, props.annotationCounts), [steps, props.annotationCounts]);
  const onStep = props.onStep;
  const stepping = props.within ?? { steps, index, noun: 'file' as const };
  const prev = stepping.steps[stepping.index - 1];
  const next = stepping.steps[stepping.index + 1];
  const noun = stepping.noun;
  const header =
    phone && onStep ? (
      <div className="ib-peekstep" role="group" aria-label={`Step through the ${noun}s`} data-peek-step="">
        <button
          type="button"
          className="ib-peekstep-b"
          aria-label={prev ? `Previous ${noun}: ${prev.attachment.name}` : `Previous ${noun}: this is the first`}
          aria-disabled={prev ? undefined : true}
          onClick={() => onStep(-1)}
          data-peek-step-prev=""
        >
          <Icon name="chevL" size={18} />
          <span>Previous</span>
        </button>
        <span className="ib-peekstep-n" aria-hidden="true">
          {stepping.index + 1} of {stepping.steps.length}
        </span>
        <button
          type="button"
          className="ib-peekstep-b"
          aria-label={next ? `Next ${noun}: ${next.attachment.name}` : `Next ${noun}: this is the last`}
          aria-disabled={next ? undefined : true}
          onClick={() => onStep(1)}
          data-peek-step-next=""
        >
          <span>Next</span>
          <Icon name="chevR" size={18} />
        </button>
      </div>
    ) : null;
  return (
    <ImagePeek
      id={props.id}
      rows={rows}
      current={steps[index]?.attachment.id ?? null}
      label="Files in this thread"
      variant={phone ? 'sheet' : 'popover'}
      onClose={props.onClose}
      onPick={(key) => {
        const at = steps.findIndex((s) => s.attachment.id === key);
        if (at >= 0) props.onGo(at);
      }}
      className={phone ? 'ib-peek-sheet' : ''}
      sheetHeader={header}
    />
  );
}

function StepTip({ text, action, children }: { text: string; action: 'previous' | 'next'; children: React.ReactElement }) {
  return (
    <Tooltip
      side="top"
      wide
      content={
        <span className="flex flex-col gap-1">
          <span>{text}</span>
          <span className="flex items-center gap-1 text-muted-foreground empty:hidden">
            <TipKeys scope={inboxFileViewerShortcuts} action={action} />
          </span>
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

export function AttachmentStepper(props: AttachmentStepperProps) {
  const { steps, index, menuOpen } = props;
  const total = steps.length;
  const current = steps[index]!;
  const prev = index > 0 ? steps[index - 1]! : null;
  const next = index < total - 1 ? steps[index + 1]! : null;
  const peekId = `ib-peek-${useId().replace(/:/g, '')}`;
  const labelRef = useRef<HTMLButtonElement>(null);
  /** Closed from the keyboard or by a choice: focus goes back to the label (not after a click elsewhere). */
  const refocus = useRef(false);

  useEffect(() => {
    if (menuOpen) refocus.current = true;
    else if (refocus.current) {
      refocus.current = false;
      labelRef.current?.focus();
    }
  }, [menuOpen]);

  const close = (reason: 'key' | 'outside') => {
    if (reason === 'outside') refocus.current = false;
    props.onMenuOpenChange(false);
  };

  const prevLabel = prev ? `Previous file: ${prev.attachment.name}` : 'Previous file';
  const nextLabel = next ? `Next file: ${next.attachment.name}` : 'Next file';
  const label = `${index + 1} of ${total}, ${current.attachment.name}. Show every file in this thread`;
  const onLabelKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !menuOpen) {
      event.preventDefault();
      props.onMenuOpenChange(true);
    }
  };

  const listed = props.peek ?? { steps, index, onGo: props.onGo };
  const peek = menuOpen && <FilePeek id={peekId} steps={listed.steps} index={listed.index} phone={false} annotationCounts={props.annotationCounts} onClose={close} onGo={listed.onGo} />;

  const endNote = (
    <span className={`ib-endnote${props.endNote ? ' ib-on' : ''}`} aria-hidden="true" data-step-end-note="">
      {props.endNote}
    </span>
  );

  return (
    <nav className="ib-stepper" aria-label="Files in this thread" data-attachment-stepper="">
      <span className="ib-stepbox">
        <StepTip text={prev ? `Previous: ${prev.attachment.name}` : 'This is the first file'} action="previous">
          <button type="button" className="ib-stepbtn" aria-label={prevLabel} aria-disabled={prev ? undefined : 'true'} onClick={() => props.onStep(-1, 'button')} data-step-prev="">
            <Icon name="chevL" size={15} />
          </button>
        </StepTip>
        <button
          type="button"
          ref={labelRef}
          className="ib-steppos"
          aria-haspopup="grid"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? peekId : undefined}
          aria-label={label}
          onClick={() => props.onMenuOpenChange(!menuOpen)}
          onKeyDown={onLabelKey}
          data-step-label=""
          data-peek-opener=""
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
          <span className={`ib-stepchev${menuOpen ? ' ib-on' : ''}`} aria-hidden="true">
            <Icon name="chevD" size={13} />
          </span>
        </button>
        <StepTip text={next ? `Next: ${next.attachment.name}` : 'This is the last file'} action="next">
          <button type="button" className="ib-stepbtn" aria-label={nextLabel} aria-disabled={next ? undefined : 'true'} onClick={() => props.onStep(1, 'button')} data-step-next="">
            <Icon name="chevR" size={15} />
          </button>
        </StepTip>
      </span>
      {endNote}
      {peek && (
        <div className="ib-filepeek" data-step-list="">
          {peek}
        </div>
      )}
    </nav>
  );
}
