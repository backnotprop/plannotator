/**
 * A skill the person's message used, opened beside the thread from its chip in the sent words or its name on the
 * skills line: its SKILL.md drawn as a document, read only (no comment tools: a comment on a skill's file is nothing
 * to send an agent). Titled with the skill's name and where it comes from ("Your skill", "Plannotator skill"). It
 * sits in the referenced file pane's frame (ReferencedFilePane opens it for a `skill` ref), so a phone, a narrow
 * window and the close and back controls are the same. It is read where the reply was written when the message says,
 * else here, else on a linked computer, else from what the message carried (data/skillFile.ts); one found nowhere
 * says so calmly, in the referenced file's own words. Only SKILL.md is shown: a link in it to another file of the
 * skill is plain text.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { attachmentBlocks } from '../attachments';
import { readSkillFile, type SkillFileView, type SkillFileWhere } from '../data/skillFile';
import { linkedMachineFacts, machineOf } from '../inboxUrl';
import { Icon } from '../icons';
import { holdSkillFile, returnFocusToSkillOpener } from '../skillOpener';
import { FileName } from './FileName';
import { Tip } from './Tip';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

export function SkillFilePane({
  threadId,
  name,
  message,
  phone,
  full,
  onClose,
}: {
  threadId: string;
  name: string;
  /** The person's message that used it: where it was written and what it carried (data/skillFile.ts). */
  message?: SkillFileWhere['message'];
  phone: boolean;
  full: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<SkillFileView | null>(null);
  const machine = machineOf(threadId);
  const messageRef = useRef(message);
  messageRef.current = message;
  const sentKey = `${message?.body ?? ''}\u0000${JSON.stringify(message?.sent_from ?? null)}`;
  useEffect(() => {
    let live = true;
    setView(null);
    void readSkillFile(name, { thread: machine, message: messageRef.current }).then((read) => live && setView(read));
    return () => {
      live = false;
    };
  }, [name, machine, sentKey]);

  const close = useCallback(() => {
    onClose();
    returnFocusToSkillOpener();
  }, [onClose]);
  // Open while drawn: another thread, or Back, forgets its opener (skillOpener.ts).
  useLayoutEffect(() => holdSkillFile(threadId), [threadId]);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, [name]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (!sectionRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  const found = view?.found ? view : null;
  const text = found && !found.tooLarge ? found.text : null;
  const where = found?.machine ? linkedMachineFacts(found.machine)?.name : null;
  const from = found ? `${found.source === 'plannotator' ? 'Plannotator skill' : 'Your skill'}${where ? ` · ${where}` : ''}` : '';

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={`ib-view ib-nopanel ib-refview ib-skillview${full ? ' ib-full' : ''}${phone ? ' ib-phone' : ''}`}
      aria-label={name}
      data-skill-file={name}
    >
      <div className="ib-vhead">
        {full && (
          <Tip content="Back to the thread">
            <button type="button" className="ib-iconbtn" onClick={close} aria-label="Back to the thread" data-ref-back="">
              <Icon name="chevL" />
            </button>
          </Tip>
        )}
        <span className="ib-fn" data-header-name="">
          <FileName name={name} />
        </span>
        {from && (
          <span className="ib-from" data-header-from="">
            {from}
          </span>
        )}
        <span className="ib-sp" />
        {!full && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={close} aria-label={`Close ${name}`}>
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div />
      <div className="ib-vbody">
        <div className="ib-docarea">
          {!view && <div className="ib-refwait" aria-hidden="true" />}
          {view && text === null && (
            <div className="ib-refmissing" role="status" data-ref-missing={found?.tooLarge ? 'kind' : 'missing'}>
              <span className="ib-refmissing-ic">
                <Icon name="doc" size={22} />
              </span>
              <span className="ib-refmissing-name">{name}</span>
              <span className="ib-refmissing-t">{found?.tooLarge ? 'is too large to show here.' : 'is not on this computer.'}</span>
            </div>
          )}
          {text !== null && <SkillDocument key={name} text={text} />}
        </div>
      </div>
    </section>
  );
}

/** SKILL.md as a document (its frontmatter as the viewer shows a Markdown file's), read only. */
function SkillDocument({ text }: { text: string }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const blocks = useMemo(() => attachmentBlocks('markdown', text, 'SKILL.md'), [text]);
  // A link to the skill's other files (references/, scripts/) is inert: only SKILL.md is shown.
  const resolveLocalLink = useCallback<LocalLinkResolver>(() => ({ kind: 'unavailable', title: '' }), []);
  return (
    <div className="ib-docscroll ib-linkeddoc bg-card" data-look="clean" data-skill-doc="" ref={setViewport}>
      <ScrollViewportProvider viewport={viewport}>
        <Viewer
          blocks={blocks}
          markdown={text}
          annotations={NO_ANNOTATIONS}
          onAddAnnotation={noop}
          onSelectAnnotation={noop}
          selectedAnnotationId={null}
          resolveLocalLink={resolveLocalLink}
          questionDecisionLines={false}
          stickyActions={false}
          disableCodePathValidation
          copyLabel="Copy file"
          maxWidth={760}
          mode="selection"
          taterMode={false}
          gridEnabled={false}
          allowImages={false}
          quickLabels={false}
          readOnly
        />
      </ScrollViewportProvider>
    </div>
  );
}
