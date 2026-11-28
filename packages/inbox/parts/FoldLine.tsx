/** What a folded message's line shows besides its sender: its snippet, and the chips for what it holds. */
import type { FoldSnippet, Holding } from '../folding';
import { Icon } from '../icons';

/** A folded line's snippet: the message's first words, or the person's answers. */
export function SnippetText({ snippet }: { snippet: FoldSnippet }) {
  if (snippet.kind === 'words') return <>{snippet.text}</>;
  return (
    <>
      {snippet.parts.map((part, index) => (
        <span key={index} className="ib-fl-ans">
          {index > 0 && <span className="ib-fl-sep"> · </span>}
          {part.prompt} <span className="ib-fl-arr">→</span> <b>{part.answer}</b>
        </span>
      ))}
    </>
  );
}

/** What a folded line says a message holds. */
export function HoldingChips({ holdings }: { holdings: Holding[] }) {
  if (holdings.length === 0) return <span className="ib-fl-chips" />;
  return (
    <span className="ib-fl-chips" data-holdings="">
      {holdings.map((h) => (
        <span key={h.kind} className={`ib-fl-chip${h.kind === 'open' || h.kind === 'todo' ? ' ib-fl-open' : h.kind === 'picks' ? ' ib-fl-pick' : ''}`} data-holding={h.kind}>
          {h.kind === 'answered' || h.kind === 'delivered' ? <Icon name="check" size={14} /> : null}
          {h.kind === 'files' ? <Icon name="clip" size={14} /> : null}
          {h.kind === 'annotations' ? <Icon name="doc" size={14} /> : null}
          {h.kind === 'guide' ? <Icon name="book" size={14} /> : null}
          {h.text}
        </span>
      ))}
    </span>
  );
}
