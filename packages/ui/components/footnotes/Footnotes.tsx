/**
 * Footnotes in a rendered document (`utils/footnotes.ts` has the model).
 *
 * `useFootnotes(blocks)` indexes a document's notes; null (the document
 * defines none) leaves every surface exactly as it was. With notes, the
 * surface draws `index.bodyBlocks` in its flow, wraps it in
 * `<FootnoteProvider>` so `InlineMarkdown` draws each reference as a
 * superscript link, and puts `<FootnoteList>` at the end.
 *
 * Ids are per mount (`useId`), so two documents on one page (an Inbox thread
 * of messages) never share one. The links scroll and move focus themselves
 * instead of changing the page's address: a host may keep state in the hash
 * (share links do).
 */
import React, { useMemo } from 'react';
import type { Block } from '../../types';
import { footnoteBody, type FootnoteIndex, type FootnoteNote } from '../../utils/footnotes';
import { goTo, inPlaceLinkHandlers, noteId, useFootnoteScope, type FootnoteScope } from './footnoteScope';
import { sourceLineAttrs } from '../../utils/sourceLineAttrs';
import { InlineMarkdown } from '../InlineMarkdown';
import { CalloutBlocks, isProseQuote, parseQuoteBody } from '../blocks/BlockquoteBlock';

export { FootnoteProvider, FootnoteRef, useFootnotes, useFootnoteScope } from './footnoteScope';

type InlineProps = Omit<React.ComponentProps<typeof InlineMarkdown>, 'text' | 'linkLabel'>;

const BackLink: React.FC<{ scope: FootnoteScope; note: FootnoteNote }> = ({ scope, note }) => (
  <a
    href="#"
    role="doc-backlink"
    aria-label={`Back to reference ${note.number}`}
    className="annotation-exclude ml-1 text-primary no-underline hover:underline focus-visible:underline"
    {...inPlaceLinkHandlers((link) => {
      const root = link.closest('[data-footnotes]')?.parentElement ?? document;
      const last = scope.lastRef.current;
      const target = last?.isConnected && last.getAttribute('data-footnote-ref')?.toLowerCase() === note.key
        ? last
        : root.querySelector<HTMLElement>(`a[data-footnote-ref][href="#${noteId(scope, note.number)}"]`);
      if (target) goTo(target);
      return true;
    })}
  >
    {'\u21a9\ufe0e'}
  </a>
);

/** One note's text: its paragraphs (the back link closing the last), or its blocks. */
const NoteBody: React.FC<{ scope: FootnoteScope; note: FootnoteNote; inline: InlineProps }> = ({ scope, note, inline }) => {
  const body = footnoteBody(note.block.content);
  const inner = useMemo(() => parseQuoteBody(body), [body]);
  const back = note.referenced ? <BackLink scope={scope} note={note} /> : null;
  if (isProseQuote(inner)) {
    const paragraphs = inner.length > 0 ? inner : [{ content: '' } as Block];
    return (
      <>
        {paragraphs.map((p, i) => (
          <p key={i} className={i > 0 ? 'mt-2' : undefined}>
            <InlineMarkdown {...inline} text={p.content} />
            {i === paragraphs.length - 1 && back}
          </p>
        ))}
      </>
    );
  }
  return (
    <>
      <CalloutBlocks inner={inner} {...inline} />
      {back && <p>{back}</p>}
    </>
  );
};

/**
 * The notes, numbered, at the end of the document. Each note is the
 * definition's block (`data-block-id`), so a comment on a note anchors and
 * exports like any other block's.
 */
export const FootnoteList: React.FC<{ index: FootnoteIndex } & InlineProps> = ({ index, ...inline }) => {
  const scope = useFootnoteScope();
  if (!scope || index.notes.length === 0) return null;
  return (
    <section
      role="doc-endnotes"
      aria-label="Footnotes"
      data-footnotes=""
      className="mt-10 border-t border-border/30 pt-5 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere]"
    >
      <ol className="list-decimal space-y-2 pl-6 marker:text-muted-foreground">
        {index.notes.map((note) => (
          <li
            key={note.block.id}
            id={noteId(scope, note.number)}
            value={note.number}
            tabIndex={-1}
            className="relative rounded-sm pl-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            data-block-id={note.block.id}
            data-footnote={note.key}
            {...sourceLineAttrs(note.block)}
          >
            <NoteBody scope={scope} note={note} inline={inline} />
          </li>
        ))}
      </ol>
    </section>
  );
};
