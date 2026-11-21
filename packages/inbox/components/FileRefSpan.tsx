/**
 * A file an agent's message names in its words (approval "inbox-file-refs-open-viewer"): a code span that is a path
 * (`packages/inbox/App.tsx:42`, `docs/plan.md`, `shots/after.png`) or a bare path in the text (`docs/plan.md:6-13`)
 * opens that file beside the thread. Both are buttons: focusable, opened with Enter or Space. On a computer with Code
 * review on, a code file still shows its code on hover (OpenInCodeHover) and the click opens the pane; on a touch
 * screen the tap goes straight to the pane.
 */
import { useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { BarePathContext, CodeSpanContext, CodeSpanMatchContext, type BarePathWrap } from '@plannotator/ui/components/LocalLinkContext';
import { isCodeFilePath } from '@plannotator/core/code-file';
import { fileRefOf, findBarePaths, looksLikeFilePath, type FileRef } from '../fileRefs';
import { openAttachmentTitle } from '../links';
import { OpenInCodeHover } from './OpenIn';
import { useTouchScreen } from '../phone';

function FileRefSpan({ text, children, bare, hover, scope, openRef }: { text: string; children: ReactNode; bare: boolean; hover: boolean; scope: { thread: string; message: string }; openRef: MutableRefObject<((ref: FileRef) => void) | undefined> }) {
  const touch = useTouchScreen();
  const ref = fileRefOf(text, bare);
  const el = useRef<HTMLSpanElement>(null);
  // Inside a question's choice (a label) or another control, the words stay that control's: a click picks the choice.
  const [inControl, setInControl] = useState(false);
  useLayoutEffect(() => {
    // From outside its own hover (whose trigger is a button).
    const from = el.current ? (el.current.closest('[data-code-hover]') ?? el.current).parentElement : null;
    if (from?.closest('label, button, a, [role="button"], [role="radio"], [role="checkbox"], [role="option"]')) setInControl(true);
  }, []);
  if (!ref) return <>{children}</>;
  const open = () => openRef.current?.(ref);
  const peek = hover && !touch && isCodeFilePath(text);
  if (inControl) return peek ? <OpenInCodeHover scope={scope} path={ref.path} line={ref.line} lineEnd={ref.lineEnd}>{children}</OpenInCodeHover> : <>{children}</>;
  const span = (
    <span
      ref={el}
      className={`ib-fileref${bare ? ' ib-fileref-bare' : ''}`}
      // With the peek, its trigger is the button (Enter shows the code); a click on the words opens the pane.
      role={peek ? undefined : 'button'}
      tabIndex={peek ? -1 : 0}
      title={peek ? undefined : openAttachmentTitle(ref.path)}
      data-file-ref={ref.path}
      onClick={(event) => {
        if (window.getSelection()?.isCollapsed === false) return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
    >
      {children}
    </span>
  );
  if (!peek) return span;
  return (
    <OpenInCodeHover scope={scope} path={ref.path} line={ref.line} lineEnd={ref.lineEnd}>
      {span}
    </OpenInCodeHover>
  );
}

/**
 * Every code span and bare path in `children` that is a file's path opens it (`on`); `hover`: Code review's peek on a
 * computer. Off: ui draws them exactly as before.
 */
export function FileRefCodeSpans({ on, hover, scope, openRef, children }: { on: boolean; hover: boolean; scope: { thread: string; message: string }; openRef: MutableRefObject<((ref: FileRef) => void) | undefined>; children: ReactNode }) {
  const key = JSON.stringify(scope);
  const render = useMemo(
    () =>
      on
        ? (text: string, code: ReactNode) => (
            <FileRefSpan text={text} bare={false} hover={hover} scope={scope} openRef={openRef}>
              {code}
            </FileRefSpan>
          )
        : null,
    // `key` names the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, on, hover],
  );
  const bare = useMemo<BarePathWrap | null>(
    () =>
      on
        ? {
            find: findBarePaths,
            wrap: (text) => (
              <FileRefSpan text={text} bare hover={hover} scope={scope} openRef={openRef}>
                {text}
              </FileRefSpan>
            ),
          }
        : null,
    // `key` names the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, on, hover],
  );
  if (!on) return <>{children}</>;
  return (
    <CodeSpanMatchContext.Provider value={looksLikeFilePath}>
      <CodeSpanContext.Provider value={render}>
        <BarePathContext.Provider value={bare}>{children}</BarePathContext.Provider>
      </CodeSpanContext.Provider>
    </CodeSpanMatchContext.Provider>
  );
}
