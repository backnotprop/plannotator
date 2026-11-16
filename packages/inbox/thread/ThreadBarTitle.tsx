import { useLayoutEffect, useRef, useState } from 'react';
import { isTextCut, Tip } from '../components/Tip';
import { HeadMark } from '../parts/HeadMark';

type TitleThread = Parameters<typeof HeadMark>[0]['thread'];

/**
 * The thread's title in its bar, the pane's h2 (the owner, 2026-11-15: always in the bar, none in the body). A named
 * thread shows its name with its heading after it on the same line, muted; an unnamed one its heading. The line is
 * cut with "…" when it has no room, and a cut title is a button: a click or a tap opens it to its whole text, wrapped
 * (a few lines at most, then it scrolls), and again closes it. A phone has no hover, so this is how it reads a long
 * subject whole. The tooltip stays for a pointer: the words the cut hides (a name alone: the subject behind it).
 *
 * `name`: the name the bar leads with (the list's rule, `threadChipName`; in Reviews, the review's), or null.
 * `heading`: what the body's heading said before it moved here (the review's title, a PR thread's name, the subject).
 * The caller keys it by thread: another thread's title opens closed.
 */
export function ThreadBarTitle({ thread, name, heading }: { thread: TitleThread; name: string | null; heading: string }) {
  const subject = thread.subject ?? '(no subject)';
  // After a name, the heading, unless it says the same words (a PR thread's heading is its name).
  const after = name !== null && heading !== name ? heading : null;
  const box = useRef<HTMLHeadingElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const toggles = cut || open;
  const text = `${name ?? ''}\u0000${after ?? heading}`;
  useLayoutEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('[data-header-title]');
    // Open, it wraps and cuts nothing: it stays the button that closes it, and is measured again once closed.
    if (!el || open) return;
    const check = () => setCut(isTextCut(el));
    check();
    // The words' box follows the bar's room; the window's own resize too (a box at its widest does not change).
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    watch?.observe(el);
    window.addEventListener('resize', check);
    return () => {
      watch?.disconnect();
      window.removeEventListener('resize', check);
    };
  }, [text, open, toggles]);
  const inner = (
    <>
      <HeadMark thread={thread} />
      {name === null ? (
        heading
      ) : (
        <>
          <span className="ib-phsubj-n" data-header-name-words="">{name}</span>
          {after !== null && (
            <>
              {' '}
              <span className="ib-phsubj-sub" data-header-after="">{after}</span>
            </>
          )}
        </>
      )}
    </>
  );
  const tip = open ? null : name === null ? heading : (after ?? subject);
  return (
    <h2 ref={box} className="ib-phsubj ib-subject" dir="auto" tabIndex={-1} data-header-subject="" data-header-name={name !== null ? '' : undefined} data-open={open ? '' : undefined} aria-label={name !== null ? `${name}: ${after ?? subject}` : undefined}>
      <Tip content={tip} cut={name === null || after !== null}>
        {toggles ? (
          <button type="button" className="ib-phsubj-t" data-header-title="" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {inner}
          </button>
        ) : (
          <span className="ib-phsubj-t" data-header-title="">
            {inner}
          </span>
        )}
      </Tip>
    </h2>
  );
}
