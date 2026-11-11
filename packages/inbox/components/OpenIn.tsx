import { inboxUrl } from '../inboxUrl';
import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode, type Ref } from 'react';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ContextMenu } from '@base-ui/react/context-menu';
import { AppIcon } from '@plannotator/ui/components/icons/AppIcon';
import { CodeSnippetPreview } from '@plannotator/ui/components/CodeSnippetPreview';
import { HostTitle, tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import { CodeSpanContext } from '@plannotator/ui/components/LocalLinkContext';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { ArtifactPinMenuItem } from './ArtifactPinButton';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { useHoverPreview } from '@plannotator/ui/hooks/useHoverPreview';
import { useOpenInApps, useRememberedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi, type OpenInFileCode, type OpenInFileScope } from '../api';
import { Icon } from '../icons';
import { newTabUrl, openInMenu, openInMenuFor, remembersOpenInItem, type OpenInItem, type OpenInMenu } from '../openIn';
import { attachmentDownloadUrl, readableVersion } from '../attachments';
import { projectFileOfLink } from '../links';
import { useInboxFileSource } from '../fileSource';
import { usePhone, useTouchScreen } from '../phone';
import { Tip } from './Tip';
import { useContextMenuTrigger } from './useContextMenuTrigger';
import { copyImageToClipboard } from '../copyImage';
import { useMessageArm } from '../messageArming';

export type OpenInSurface = 'apps' | 'tab';

export const INBOX_OPEN_IN_APPS_URL = inboxUrl('/open-in/apps');

const ERROR_MS = 4000;

function useOpenInActions(path: string | null, open: (id: string) => Promise<{ ok: boolean; error?: string }>, remember: (id: string) => void) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = (text: string, error: boolean) => {
    setStatus({ text, error });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(null), ERROR_MS);
  };

  const launch = async (item: OpenInItem) => {
    if (item.kind === 'browser' || busy) return;
    if (remembersOpenInItem(item)) remember(item.id);
    setBusy(true);
    setStatus(null);
    try {
      const result = await open(item.id);
      if (!result.ok) flash(result.error || `Could not open ${item.label}`, true);
    } catch (cause) {
      flash(cause instanceof InboxApiError ? cause.message : `Could not open ${item.label}`, true);
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async () => {
    const ok = path !== null && (await copyTextToClipboard(path));
    flash(ok ? 'Path copied' : 'Could not copy the path', !ok);
  };

  return { busy, status, launch, copyPath, flash };
}

function useOpenIn(attachment: InboxAttachmentState, version: 'current' | 'sent', enabled = true) {
  const answer = useOpenInApps(INBOX_OPEN_IN_APPS_URL, enabled, attachment.id);
  const [remembered, remember] = useRememberedOpenInApp();
  const menu: OpenInMenu | null = answer?.available ? openInMenu(attachment, answer.apps, answer.platform ?? 'linux', remembered, version) : null;
  const actions = useOpenInActions(attachment.path, (id) => inboxApi.openIn(attachment.id, id), remember);
  return { answer, menu, ...actions };
}

function ItemIcon({ item, kind }: { item: OpenInItem; kind: unknown }) {
  if (item.kind === 'browser') return <Icon name="globe" size={15} className="ib-appi ib-glyph" />;
  if (item.kind === 'default') return <Icon name={readInboxAttachmentKind(kind) === 'image' ? 'photo' : 'doc'} size={15} className="ib-appi ib-glyph" />;
  return <AppIcon id={item.icon} className="ib-appi" />;
}

function missingLabel(attachment: InboxAttachmentState): string {
  return attachment.unavailable?.code === 'attachment_missing' ? 'Missing' : 'Changed';
}

function OpenInMenuItems({ kind, missingWord, menu, onLaunch, onCopyPath }: { kind: unknown; missingWord: string; menu: OpenInMenu; onLaunch: (item: OpenInItem) => void; onCopyPath: () => void }) {
  return (
    <>
      {menu.items.map((item) =>
        item.kind === 'browser' ? (
          <DropdownMenuItem
            key={item.id}
            className="text-xs"
            render={<a href={item.href} target="_blank" rel="noopener noreferrer" />}
            data-open-in-item={item.id}
          >
            <ItemIcon item={item} kind={kind} />
            <span className="flex-1 truncate">{item.label}</span>
            {item === menu.primary && <Icon name="check" size={14} className="ib-openin-check" />}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            key={item.id}
            className="text-xs"
            disabled={menu.missing}
            onClick={() => onLaunch(item)}
            data-open-in-item={item.id}
          >
            <ItemIcon item={item} kind={kind} />
            <span className="flex-1 truncate">{item.label}</span>
            {menu.missing && <span className="ib-openin-miss">{missingWord}</span>}
            {item === menu.primary && <Icon name="check" size={14} className="ib-openin-check" />}
          </DropdownMenuItem>
        ),
      )}
      {menu.items.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem className="text-xs" onClick={onCopyPath} data-open-in-item="copy-path">
        <Icon name="copy" size={15} className="ib-appi ib-glyph" />
        <span className="flex-1">Copy path</span>
      </DropdownMenuItem>
    </>
  );
}

function Status({ status }: { status: { text: string; error: boolean } | null }) {
  return (
    <span className={`ib-openin-status${status?.error ? ' ib-err' : ' ib-sr'}`} role="status" aria-live="polite" data-open-in-status="">
      {status?.text ?? ''}
    </span>
  );
}

export function OpenInControl({
  attachment,
  version,
  surface,
  label,
  big = false,
}: {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  surface: OpenInSurface;
  label: boolean;
  big?: boolean;
}) {
  if (surface === 'tab') return <NewTabButton attachment={attachment} version={version} big={big} />;
  return <OpenInSplit attachment={attachment} version={version} label={label} />;
}

function NewTabButton({ attachment, version, big }: { attachment: InboxAttachmentState; version: 'current' | 'sent'; big: boolean }) {
  const href = newTabUrl(attachment, version);
  if (!href) return null;
  return (
    <Tip content="Open in new tab">
      <a className="ib-iconbtn" href={href} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" data-open-in-tab="">
        <Icon name="external" size={big ? 18 : 16} />
      </a>
    </Tip>
  );
}

function OpenInSplit({ attachment, version, label }: { attachment: InboxAttachmentState; version: 'current' | 'sent'; label: boolean }) {
  const { answer, menu, busy, status, launch, copyPath } = useOpenIn(attachment, version);
  if (!answer) return null;
  if (!menu) return <NewTabButton attachment={attachment} version={version} big={false} />;
  return <SplitButton id={attachment.id} kind={attachment.kind} missingWord={missingLabel(attachment)} menu={menu} label={label} busy={busy} status={status} launch={launch} copyPath={copyPath} />;
}

function SplitButton({
  id,
  kind,
  missingWord,
  menu,
  label,
  busy,
  status,
  launch,
  copyPath,
  onOpenChange,
  note,
}: {
  id: string;
  kind: unknown;
  missingWord: string;
  menu: OpenInMenu;
  label: boolean;
  busy: boolean;
  status: { text: string; error: boolean } | null;
  launch: (item: OpenInItem) => Promise<void>;
  copyPath: () => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  note?: string;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const primary = menu.primary;
  const disabled = !primary || busy || (menu.missing && primary.kind !== 'browser');
  const title = !primary ? 'Open in…' : menu.missing && primary.kind !== 'browser' ? missingWord : primary.label;
  const face = (
    <>
      {primary && <ItemIcon item={primary} kind={kind} />}
      {label && <span>Open</span>}
    </>
  );
  return (
    <span className="ib-openin" data-open-in={id}>
      <span className={`ib-split${open ? ' ib-on' : ''}${menu.missing ? ' ib-dis' : ''}`}>
        {primary?.kind === 'browser' ? (
          <Tip content={title}>
            <a className="ib-sa" href={primary.href} target="_blank" rel="noopener noreferrer" aria-label="Open in Browser" data-open-in-primary="browser">
              {face}
            </a>
          </Tip>
        ) : (
          <Tip content={note ? `${title}: ${note}` : title}>
            <button
              type="button"
              className="ib-sa"
              disabled={disabled}
              onClick={() => primary && void launch(primary)}
              aria-label={primary ? `Open in ${primary.label}` : 'Open'}
              data-open-in-primary={primary?.id ?? ''}
            >
              {face}
            </button>
          </Tip>
        )}
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <Tip content="Open in…">
            <DropdownMenuTrigger render={<button type="button" className="ib-st" aria-label="Open in…" data-open-in-caret="" />}>
              <Icon name="chevD" size={12} />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[12rem]" finalFocus={false} data-open-in-menu={id}>
            <OpenInMenuItems kind={kind} missingWord={missingWord} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <Status status={status} />
    </span>
  );
}

const knownFiles = new Map<string, { path: string; kind: string } | null>();

export function OpenInFile({ scope, path, line, label = false, onListOpenChange, note }: { scope: OpenInFileScope; path: string; line?: number; label?: boolean; onListOpenChange?: (open: boolean) => void; note?: string }) {
  const phone = usePhone();
  const { writes } = useInboxFileSource();
  if (phone || !writes) return null;
  return <OpenInFileSplit scope={scope} path={path} line={line} label={label} onListOpenChange={onListOpenChange} note={note} />;
}

async function checkOpenInFile(scope: OpenInFileScope, path: string): Promise<{ path: string; kind: string } | null> {
  const key = JSON.stringify([scope, path]);
  try {
    const found = await inboxApi.openInFileCheck(scope, path);
    const next = found.found && found.path && found.kind ? { path: found.path, kind: found.kind } : null;
    knownFiles.set(key, next);
    return next;
  } catch {
    knownFiles.delete(key);
    return null;
  }
}

function OpenInFileSplit({ scope, path, line, label, onListOpenChange, note }: { scope: OpenInFileScope; path: string; line?: number; label: boolean; onListOpenChange?: (open: boolean) => void; note?: string }) {
  const answer = useOpenInApps(INBOX_OPEN_IN_APPS_URL, true, path);
  const [remembered, remember] = useRememberedOpenInApp();
  const key = JSON.stringify([scope, path]);
  const [file, setFile] = useState(() => knownFiles.get(key) ?? null);
  const available = answer?.available === true;
  useEffect(() => {
    setFile(knownFiles.get(key) ?? null);
    if (!available) return;
    let live = true;
    void checkOpenInFile(scope, path).then((next) => {
      if (live) setFile(next);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, available]);
  const { busy, status, launch, copyPath } = useOpenInActions(file?.path ?? null, (id) => inboxApi.openInFile(scope, path, id, line), remember);
  if (!answer?.available || !file) return null;
  const menu = openInMenuFor(file, answer.apps, answer.platform ?? 'linux', remembered, null, false);
  return <SplitButton id={path} kind={file.kind} missingWord="" menu={menu} label={label} busy={busy} status={status} launch={launch} copyPath={copyPath} onOpenChange={onListOpenChange} note={note} />;
}

export function OpenInCodeSpan({ scope, text, children }: { scope: OpenInFileScope; text: string; children: ReactNode }) {
  const named = projectFileOfLink(text);
  if (!named) return <>{children}</>;
  return <OpenInCodeHover scope={scope} path={named.path} line={named.line} lineEnd={named.lineEnd}>{children}</OpenInCodeHover>;
}

export function OpenInCodeSpans({ scope, on, children }: { scope: OpenInFileScope; on: boolean; children: ReactNode }) {
  const key = JSON.stringify(scope);
  const render = useMemo(
    () => (on ? (text: string, code: ReactNode) => <OpenInCodeSpan scope={scope} text={text}>{code}</OpenInCodeSpan> : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, on],
  );
  return <CodeSpanContext.Provider value={render}>{children}</CodeSpanContext.Provider>;
}

const FILE_TOP_LINES = 40;
const CONTEXT_LINES = 6;

export function OpenInCodeHover({ scope, path, line, lineEnd, title, children }: { scope: OpenInFileScope; path: string; line?: number; lineEnd?: number; title?: string; children: ReactNode }) {
  const { writes } = useInboxFileSource();
  if (!writes) return <>{title ? <HostTitle title={title}>{children as ReactElement}</HostTitle> : children}</>;
  return <CodeHoverWindow scope={scope} path={path} line={line} lineEnd={lineEnd} title={title}>{children}</CodeHoverWindow>;
}

interface CodeHoverWords {
  scope: OpenInFileScope;
  path: string;
  line?: number;
  lineEnd?: number;
}

function useCodeHover({ scope, path, line, lineEnd }: CodeHoverWords, raised = false) {
  const phone = usePhone();
  const touch = useTouchScreen();
  const [missing, setMissing] = useState(false);
  const [told, setTold] = useState(false);
  const hover = useHoverPreview<Extract<OpenInFileCode, { found: true }>>(async () => {
    const [answer] = await Promise.all([inboxApi.openInFileCode(scope, path).catch(() => null), phone ? null : checkOpenInFile(scope, path)]);
    setMissing(!answer?.found);
    if (!answer?.found && (pointerIn.current || document.activeElement === hover.anchorRef.current)) setTold(true);
    return answer?.found ? answer : null;
  });
  const { preview, anchorRef, dismiss: close } = hover;
  const windowEl = useRef<HTMLDivElement | null>(null);
  // The editor list portals away from the window: while it is open, leaving the window closes nothing.
  const listOpen = useRef(false);
  const pointerIn = useRef(false);
  const dismiss = useCallback(() => {
    if (!listOpen.current) close();
  }, [close]);
  const enter = (event?: { buttons: number }) => {
    pointerIn.current = true;
    if (!event?.buttons) hover.onEnter();
  };
  const leave = () => {
    pointerIn.current = false;
    setTold(false);
    if (!listOpen.current) hover.onLeave();
  };
  const controls = () => Array.from(windowEl.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);

  const open = !!preview;
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || listOpen.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (windowEl.current?.contains(document.activeElement)) anchorRef.current?.focus();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, close, anchorRef]);

  const element = (
    // Always drawn: a comment's marks move the text beside the words, so nothing may be inserted among them later.
    // A portal's events still reach the page's own handlers through React: not a click in here.
    <span
      style={{ display: 'contents' }}
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const to = event.relatedTarget;
        if (touch || pointerIn.current || (to instanceof Node && (windowEl.current?.contains(to) || anchorRef.current?.contains(to)))) return;
        leave();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const list = controls();
        const atEdge = document.activeElement === (event.shiftKey ? list[0] : list.at(-1));
        if (!atEdge) return;
        if (event.shiftKey) event.preventDefault();
        anchorRef.current?.focus();
      }}
    >
      {preview && (
        <CodeHoverPreview
          anchorEl={anchorRef.current}
          contents={preview.contents}
          path={path}
          line={line}
          lineEnd={lineEnd}
          pull={preview.pull}
          sheet={touch}
          windowRef={(el) => {
          windowEl.current = el;
          if (el && raised) el.dataset.codeHoverRaised = '';
        }}
          onDismiss={dismiss}
          onMouseEnter={() => {
            pointerIn.current = true;
            hover.previewHandlers.onMouseEnter();
          }}
          onMouseLeave={leave}
          actions={
            <>
              {preview.pull && (
                <a className="ib-code-hover-forge" href={withLines(preview.pull, line, lineEnd)} target="_blank" rel="noopener noreferrer" data-code-hover-forge="">
                  Open on {preview.pull.platform === 'gitlab' ? 'GitLab' : 'GitHub'}
                </a>
              )}
              <OpenInFile
                scope={scope}
                path={path}
                line={line}
                label
                note={preview.pull ? "opens this computer's copy" : undefined}
                onListOpenChange={(next) => {
                  listOpen.current = next;
                  if (!next && !pointerIn.current && !touch) hover.onLeave();
                }}
              />
              {touch && (
                <button type="button" className="ib-code-hover-close" onClick={() => hover.dismiss()} data-code-hover-close="">
                  Close
                </button>
              )}
            </>
          }
        />
      )}
    </span>
  );
  return { hover, touch, open, missing, told, enter, leave, controls, windowEl, pointerIn, element };
}

function CodeHoverWindow({ title, children, ...words }: CodeHoverWords & { title?: string; children: ReactNode }) {
  const { hover, touch, open, missing, told, enter, leave, controls, windowEl, pointerIn, element } = useCodeHover(words);
  const anchor = (
    <span
      ref={(el) => {
        hover.anchorRef.current = el;
      }}
      className="ib-code-hover"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-description={title && missing ? title : undefined}
      data-code-hover={words.path}
      onMouseEnter={touch ? undefined : enter}
      onMouseLeave={touch ? undefined : leave}
      onFocus={(event) => {
        if (!touch && event.target.matches(':focus-visible')) hover.onEnter();
      }}
      onBlur={(event) => {
        if (touch || (event.relatedTarget instanceof Node && windowEl.current?.contains(event.relatedTarget))) return;
        if (!pointerIn.current) leave();
      }}
      onClick={(event) => {
        if (!touch) return;
        event.stopPropagation();
        if (window.getSelection()?.isCollapsed !== false) hover.onEnter();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (open) controls()[0]?.focus();
          else hover.onEnter();
        } else if (event.key === 'Tab' && !event.shiftKey && open) {
          const first = controls()[0];
          if (first) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      {children}
    </span>
  );

  return (
    <>
      {/* Always this tooltip, closed until the file is known to be missing: redrawing the words would lose a comment's highlight on them. */}
      {title ? (
        <Tooltip
          content={title}
          wide
          escapePassesThrough
          forceOpen={told}
          shouldOpen={() => missing && !touch}
          container={hover.anchorRef.current ? tooltipContainerOf(hover.anchorRef.current) : null}
        >
          {anchor}
        </Tooltip>
      ) : (
        anchor
      )}
      {element}
    </>
  );
}

export function useOpenInCodeRegion(scope: OpenInFileScope, on: boolean): { handlers?: Pick<HTMLAttributes<HTMLElement>, 'onMouseOver' | 'onClick'>; window: ReactNode } {
  const touch = useTouchScreen();
  const { writes } = useInboxFileSource();
  const [at, setAt] = useState<{ el: HTMLElement; turn: number; path: string; line?: number; lineEnd?: number } | null>(null);
  const turns = useRef(0);
  if (!on || !writes) return { window: null };
  const namedBy = (target: EventTarget) => {
    const el = target instanceof Element ? target.closest<HTMLElement>('code, a') : null;
    if (!el || el.closest('pre, [data-code-snippet-preview]')) return null;
    const words = el.tagName === 'A' ? el.getAttribute('href') ?? '' : el.textContent ?? '';
    if (el.tagName === 'A' && /^[a-z][a-z0-9+.-]*:|^\/\//i.test(words)) return null;
    const named = projectFileOfLink(words);
    return named && { el, ...named };
  };
  const show = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.buttons) return;
    const named = namedBy(event.target);
    if (!named) return;
    // A tap on a link stays here: its address means nothing to a browser.
    if (touch && named.el.tagName === 'A') event.preventDefault();
    if (named.el === at?.el) return;
    if (touch && window.getSelection()?.isCollapsed === false) return;
    setAt({ ...named, turn: (turns.current += 1) });
  };
  return {
    handlers: {
      onMouseOver: touch ? undefined : show,
      onClick: (event) => {
        if (touch) show(event);
        else if (namedBy(event.target)?.el.tagName === 'A') event.preventDefault();
      },
    },
    window: at && <CodeRegionWindow key={at.turn} scope={scope} anchor={at.el} path={at.path} line={at.line} lineEnd={at.lineEnd} />,
  };
}

function CodeRegionWindow({ anchor, ...words }: CodeHoverWords & { anchor: HTMLElement }) {
  const { hover, touch, enter, leave, element } = useCodeHover(words, true);
  useEffect(() => {
    hover.anchorRef.current = anchor;
    const open = touch ? () => hover.onEnter() : enter;
    open();
    const type = touch ? 'click' : 'mouseenter';
    anchor.addEventListener(type, open);
    if (!touch) anchor.addEventListener('mouseleave', leave);
    return () => {
      anchor.removeEventListener(type, open);
      anchor.removeEventListener('mouseleave', leave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);
  return <>{element}</>;
}

function withLines(pull: { platform: 'github' | 'gitlab'; url: string }, line?: number, lineEnd?: number): string {
  if (!line) return pull.url;
  if (!lineEnd || lineEnd === line) return `${pull.url}#L${line}`;
  return `${pull.url}#L${line}-${pull.platform === 'gitlab' ? '' : 'L'}${lineEnd}`;
}

function CodeHoverPreview({ contents, path, line, lineEnd, pull, ...window }: {
  contents: string;
  path: string;
  line?: number;
  lineEnd?: number;
  pull?: { label: string };
  anchorEl: HTMLElement | null;
  sheet: boolean;
  windowRef: Ref<HTMLDivElement>;
  onDismiss: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  actions: ReactNode;
}) {
  const text = useMemo(() => contents.replace(/\r?\n$/, ''), [contents]);
  const count = useMemo(() => text.split('\n').length, [text]);
  const named = line && line <= count ? line : null;
  return (
    <CodeSnippetPreview
      {...window}
      container={window.anchorEl ? tooltipContainerOf(window.anchorEl) : null}
      contents={text}
      filepath={path}
      title={pull ? `${path} · ${pull.label}` : path}
      line={named ?? 1}
      lineEnd={named ? (lineEnd && lineEnd > named ? Math.min(lineEnd, count) : undefined) : Math.min(FILE_TOP_LINES, count)}
      contextLines={named ? CONTEXT_LINES : 0}
    />
  );
}

function TileMenuItems({
  attachment,
  version,
  onOpenAs,
  download,
  onCopyImage,
  menu,
  onLaunch,
  onCopyPath,
}: {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  onOpenAs?: (view: 'full' | 'side') => void;
  download: string | null;
  onCopyImage: (() => void) | null;
  menu: OpenInMenu | null;
  onLaunch: (item: OpenInItem) => void;
  onCopyPath: () => void;
}) {
  return (
    <>
      {onOpenAs && (
        <>
          <DropdownMenuItem className="text-xs" onClick={() => onOpenAs('side')} data-open-as="side">
            <Icon name="sideBySide" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">Open side by side</span>
          </DropdownMenuItem>
          <DropdownMenuItem className="text-xs" onClick={() => onOpenAs('full')} data-open-as="full">
            <Icon name="frame" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">Open full screen</span>
          </DropdownMenuItem>
          {(download || onCopyImage || menu) && <DropdownMenuSeparator />}
        </>
      )}
      {download && (
        <>
          <DropdownMenuItem className="text-xs" render={<a href={download} download={attachment.name} />} data-tile-download={attachment.id}>
            <Icon name="download" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">{version === 'sent' ? 'Download the sent version' : 'Download'}</span>
          </DropdownMenuItem>
        </>
      )}
      {onCopyImage && (
        <DropdownMenuItem className="text-xs" onClick={onCopyImage} data-tile-copy-image={attachment.id}>
          <Icon name="copy" size={15} className="ib-appi ib-glyph" />
          <span className="flex-1">Copy image</span>
        </DropdownMenuItem>
      )}
      {(download || onCopyImage) && menu && <DropdownMenuSeparator />}
      {menu && <OpenInMenuItems kind={attachment.kind} missingWord={missingLabel(attachment)} menu={menu} onLaunch={onLaunch} onCopyPath={onCopyPath} />}
    </>
  );
}

const TILE_CONTEXT_POPUP =
  'z-50 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md origin-[var(--transform-origin)] transition-[opacity,scale] duration-150 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95';
const TILE_CONTROL = '[data-attachment-id], [data-artifact-tile], [data-gallery-image]';
const NO_SLOT = { order: [], fallback: () => null };

export function TileMenu({
  attachment,
  surface,
  onOpenAs,
  render,
}: {
  attachment: InboxAttachmentState;
  surface?: OpenInSurface;
  onOpenAs?: (view: 'full' | 'side') => void;
  render: (more: ReactNode, status: ReactNode) => ReactElement;
}) {
  const version = readableVersion(attachment);
  const source = useInboxFileSource();
  const apps = surface === 'apps';
  const { menu, status, launch, copyPath, flash } = useOpenIn(attachment, version, apps);
  const arm = useMessageArm();
  const [open, setOpen] = useState(false);
  const download = source.writes ? source.downloadUrl(attachment, version) : null;
  const copyImage =
    source.writes && readInboxAttachmentKind(attachment.kind) === 'image'
      ? () => void copyImageToClipboard(source.imageUrl(attachment, version), attachment.name).then((ok) => flash(ok ? 'Image copied' : 'Could not copy the image', !ok))
      : null;
  const empty = !onOpenAs && !download && !menu;
  const trigger = useRef<HTMLDivElement>(null);
  const control = (): HTMLElement | null => {
    const el = trigger.current;
    return el ? (el.matches(TILE_CONTROL) ? el : el.querySelector<HTMLElement>(TILE_CONTROL)) : null;
  };
  const context = useContextMenuTrigger({
    // Anywhere on the tile (its ⋯ and add-to-reply too); never the ⋯'s own popup, which React bubbles here.
    itemOf: (target) => (target instanceof Node && trigger.current?.contains(target) ? control() : null),
    idOf: () => attachment.id,
    has: () => !empty,
    buttonFor: control,
    slotOf: () => NO_SLOT,
    stateOf: () => '',
    disabled: empty,
    onTarget: () => {},
  });
  const { onKeyDown: _key, ...triggerProps } = context.trigger;
  const items = (
    <TileMenuItems attachment={attachment} version={version} onOpenAs={onOpenAs} download={download} onCopyImage={copyImage} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
  );
  // Only the ⋯ changes: the tile stays the same element, so arming never remounts a tile or its picture (a phone's thread would lose its place).
  const plain =
    apps && !empty ? (
      <button
        type="button"
        className="ib-att-more"
        aria-label={`More: ${attachment.name}`}
        aria-haspopup="menu"
        aria-expanded={false}
        data-open-in-more={attachment.id}
        onClick={() => {
          setOpen(true);
          arm.arm();
        }}
      >
        <Icon name="dots" size={16} />
      </button>
    ) : null;
  const more = !arm.armed
    ? plain
    : apps && !empty ? (
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tip content="More">
          <DropdownMenuTrigger render={<button type="button" className="ib-att-more" aria-label={`More: ${attachment.name}`} data-open-in-more={attachment.id} />}>
            <Icon name="dots" size={16} />
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[12rem]" finalFocus={false} data-open-in-menu={attachment.id}>
          {items}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  return (
    <ContextMenu.Root {...context.root}>
      <ContextMenu.Trigger ref={trigger} render={render(more, <Status status={status} />)} {...triggerProps} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="isolate z-50 outline-none">
          <ContextMenu.Popup className={TILE_CONTEXT_POPUP} aria-label={attachment.name} data-open-in-menu={attachment.id} data-tile-context="" {...context.popup}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export interface FullScreenVersionAction {
  label: string;
  onSelect: () => void;
}

interface FullScreenMoreProps {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  surface?: OpenInSurface;
  phone: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionAction: FullScreenVersionAction | null;
  pin?: { threadId: string; key: string; name: string } | null;
}

export function FullScreenMore(props: FullScreenMoreProps) {
  return props.surface === 'apps' ? <FullScreenMoreApps {...props} /> : <FullScreenMoreMenu {...props} openIn={null} />;
}

function FullScreenMoreApps(props: FullScreenMoreProps) {
  const { menu, status, launch, copyPath } = useOpenIn(props.attachment, props.version);
  return (
    <>
      <FullScreenMoreMenu
        {...props}
        openIn={
          menu ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-[11px] text-muted-foreground">Open in</DropdownMenuLabel>
              <OpenInMenuItems kind={props.attachment.kind} missingWord={missingLabel(props.attachment)} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
            </DropdownMenuGroup>
          ) : null
        }
      />
      <Status status={status} />
    </>
  );
}

function FullScreenMoreMenu(props: FullScreenMoreProps & { openIn: React.ReactNode }) {
  const { attachment, version } = props;
  const { writes } = useInboxFileSource();
  const tab = writes && props.openIn === null && props.surface !== undefined ? newTabUrl(attachment, version) : null;
  const named = [props.openIn || tab ? 'open in' : null, writes ? 'download' : null, props.versionAction ? 'versions' : null].filter(Boolean).join(', ') || 'not in the tour';
  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger
        render={<button type="button" className={`ib-fvb ib-fvmore${props.open ? ' ib-open' : ''}`} aria-label={`More: ${named}`} data-full-view-more="" />}
      >
        <Icon name="dots" size={props.phone ? 20 : 17} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side={props.phone ? 'top' : 'bottom'} sideOffset={8} className="min-w-[14rem]" data-full-view-menu={attachment.id}>
        {props.pin && <ArtifactPinMenuItem threadId={props.pin.threadId} artifactKey={props.pin.key} name={props.pin.name} />}
        {props.openIn}
        {tab && (
          <DropdownMenuItem className="text-xs" render={<a href={tab} target="_blank" rel="noopener noreferrer" />} data-open-in-tab="">
            <Icon name="external" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">Open in new tab</span>
          </DropdownMenuItem>
        )}
        {writes && (props.openIn || tab) && <DropdownMenuSeparator />}
        {writes ? (
          <DropdownMenuItem className="text-xs" render={<a href={attachmentDownloadUrl(attachment, version)} download={attachment.name} />} data-attachment-download="">
            <Icon name="download" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">{version === 'sent' ? 'Download the sent version' : 'Download'}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="text-xs" disabled data-full-view-not-in-tour="">
            <Icon name="download" size={15} className="ib-appi ib-glyph" />
            <span className="flex-1">Open in, Download: not in the tour</span>
          </DropdownMenuItem>
        )}
        {props.versionAction && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onClick={props.versionAction.onSelect} data-full-view-version="">
              <Icon name="clock" size={15} className="ib-appi ib-glyph" />
              <span className="flex-1">{props.versionAction.label}</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
