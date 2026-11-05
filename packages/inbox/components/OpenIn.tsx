import { inboxUrl } from '../inboxUrl';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { AppIcon } from '@plannotator/ui/components/icons/AppIcon';
import { CodeSnippetPreview } from '@plannotator/ui/components/CodeSnippetPreview';
import { HostTitle, tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import { CodeSpanContext } from '@plannotator/ui/components/LocalLinkContext';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { useHoverPreview } from '@plannotator/ui/hooks/useHoverPreview';
import { useOpenInApps, useRememberedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi, type OpenInFileCode, type OpenInFileScope } from '../api';
import { Icon } from '../icons';
import { newTabUrl, openInMenu, openInMenuFor, remembersOpenInItem, type OpenInItem, type OpenInMenu } from '../openIn';
import { attachmentDownloadUrl } from '../attachments';
import { projectFileOfLink } from '../links';
import { useInboxFileSource } from '../fileSource';
import { usePhone, useTouchScreen } from '../phone';
import { Tip } from './Tip';

/**
 * "Open in" for an attachment (design record "inbox-open-in", approved
 * 2026-10-14; the look is mock-v2): a compact split button in the pane's
 * header (the app's icon and "Open", and a caret for the list), a ⋯ menu on
 * each tile with the same list, and over the tailnet or on a phone a single
 * "Open in new tab" icon for HTML and images. No keyboard shortcut.
 *
 * Where the window is: `apps` on this computer, `tab` through the tailnet
 * or on a phone (launching an app is loopback-only on the server too).
 */
export type OpenInSurface = 'apps' | 'tab';

/** The Inbox's own, local-only app list (GET; 403 through the tailnet). */
export const INBOX_OPEN_IN_APPS_URL = inboxUrl('/open-in/apps');

const ERROR_MS = 4000;

/** Picking from a menu: the launch, what it says while it runs, and Copy path. */
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

  return { busy, status, launch, copyPath };
}

/** Everything an attachment's control needs: the menu, and picking from it. */
function useOpenIn(attachment: InboxAttachmentState, version: 'current' | 'sent') {
  // A read that did not answer (a restarting Inbox) is asked again for the next file.
  const answer = useOpenInApps(INBOX_OPEN_IN_APPS_URL, true, attachment.id);
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

/** The list both menus show: the apps, then Copy path. */
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
            {/* The file is gone or changed type: the apps are disabled and say so. */}
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

/**
 * The pane header's control. On this computer: the split button (or, while
 * the apps are unknown to this server, the new-tab icon). Over the tailnet
 * and on a phone: the new-tab icon for HTML and images, nothing otherwise.
 */
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
  /** Show "Open" beside the icon (a pane wide enough for it). */
  label: boolean;
  /** A phone's 44 px icon. */
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
  // A server without the local app list (an older Inbox): a new tab is all there is.
  if (!menu) return <NewTabButton attachment={attachment} version={version} big={false} />;
  return <SplitButton id={attachment.id} kind={attachment.kind} missingWord={missingLabel(attachment)} menu={menu} label={label} busy={busy} status={status} launch={launch} copyPath={copyPath} />;
}

/** The split button: the app's icon (and "Open"), and a caret for the list. */
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
          <Tip content={title}>
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

/** The last answer for each referenced file: a header drawn again (a diff scrolled back) shows its control at once while it asks again. */
const knownFiles = new Map<string, { path: string; kind: string } | null>();

/**
 * "Open in" for a file something references, by its project-relative path (Shape's references and Code view, a review's
 * diff headers). The split button, without "Open". Nothing at all when the file is not on this computer, through the
 * tailnet (the apps route refuses it) or on a phone, as for an attachment there is no app to launch. `line` goes along
 * when the app's launcher takes one. `label`: the word "Open" on the button (the code window's header).
 */
export function OpenInFile({ scope, path, line, label = false, onListOpenChange }: { scope: OpenInFileScope; path: string; line?: number; label?: boolean; onListOpenChange?: (open: boolean) => void }) {
  const phone = usePhone();
  const { writes } = useInboxFileSource();
  if (phone || !writes) return null;
  return <OpenInFileSplit scope={scope} path={path} line={line} label={label} onListOpenChange={onListOpenChange} />;
}

/** Whether a referenced file is here and what kind, remembered for the next control drawn for it. */
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

function OpenInFileSplit({ scope, path, line, label, onListOpenChange }: { scope: OpenInFileScope; path: string; line?: number; label: boolean; onListOpenChange?: (open: boolean) => void }) {
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
    // `key` names the scope and the path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, available]);
  const { busy, status, launch, copyPath } = useOpenInActions(file?.path ?? null, (id) => inboxApi.openInFile(scope, path, id, line), remember);
  if (!answer?.available || !file) return null;
  const menu = openInMenuFor(file, answer.apps, answer.platform ?? 'linux', remembered, null, false);
  return <SplitButton id={path} kind={file.kind} missingWord="" menu={menu} label={label} busy={busy} status={status} launch={launch} copyPath={copyPath} onOpenChange={onListOpenChange} />;
}

/**
 * A code span that names a file (`src/retry.ts:12`) in a message: it looks as it does without this, and resting on it
 * shows the code (`OpenInCodeHover`).
 */
export function OpenInCodeSpan({ scope, text, children }: { scope: OpenInFileScope; text: string; children: ReactNode }) {
  const named = projectFileOfLink(text);
  if (!named) return <>{children}</>;
  return <OpenInCodeHover scope={scope} path={named.path} line={named.line} lineEnd={named.lineEnd}>{children}</OpenInCodeHover>;
}

/**
 * Code spans in what `children` draws (a message, a board, and a guide through its reader): each that names a file
 * shows its code. `on` is Code review.
 */
export function OpenInCodeSpans({ scope, on, children }: { scope: OpenInFileScope; on: boolean; children: ReactNode }) {
  const key = JSON.stringify(scope);
  const render = useMemo(
    () => (on ? (text: string, code: ReactNode) => <OpenInCodeSpan scope={scope} text={text}>{code}</OpenInCodeSpan> : null),
    // `key` names the scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, on],
  );
  return <CodeSpanContext.Provider value={render}>{children}</CodeSpanContext.Provider>;
}

/** A file named with no line shows this much of its top. */
const FILE_TOP_LINES = 40;
/** Lines kept around a named line or range. */
const CONTEXT_LINES = 6;

/**
 * Words that name a file, in a line of text: they stay as they are, and hovering them shows the code in ui's code
 * window (the one plan review's and annotate's code links use), with Open and its editor list in the window's header.
 * Nothing is asked until the pointer rests. A name that is no file here or in the PR shows nothing, then `title` if given.
 *
 * With no hover (a touch screen), a tap shows the same window as a sheet from the bottom edge. A phone has no editor
 * to open, so its sheet has the code, and the forge's link for a PR's file. By keyboard, focus shows the window, Tab or
 * Enter goes into it and Escape closes it.
 */
export function OpenInCodeHover({ scope, path, line, lineEnd, title, children }: { scope: OpenInFileScope; path: string; line?: number; lineEnd?: number; title?: string; children: ReactNode }) {
  const { writes } = useInboxFileSource();
  if (!writes) return <>{title ? <HostTitle title={title}>{children as ReactElement}</HostTitle> : children}</>;
  return <CodeHoverWindow scope={scope} path={path} line={line} lineEnd={lineEnd} title={title}>{children}</CodeHoverWindow>;
}

function CodeHoverWindow({ scope, path, line, lineEnd, title, children }: { scope: OpenInFileScope; path: string; line?: number; lineEnd?: number; title?: string; children: ReactNode }) {
  const phone = usePhone();
  const touch = useTouchScreen();
  const [missing, setMissing] = useState(false);
  const hover = useHoverPreview<Extract<OpenInFileCode, { found: true }>>(async () => {
    // Open's own answer comes with the code, so the window opens whole.
    const [answer] = await Promise.all([inboxApi.openInFileCode(scope, path).catch(() => null), phone ? null : checkOpenInFile(scope, path)]);
    setMissing(!answer?.found);
    return answer?.found ? answer : null;
  });
  const { preview, anchorRef } = hover;
  const windowEl = useRef<HTMLDivElement | null>(null);
  // The editor list portals away from the window: while it is open, leaving the window closes nothing.
  const listOpen = useRef(false);
  const pointerIn = useRef(false);
  const { dismiss: close } = hover;
  const dismiss = useCallback(() => {
    if (!listOpen.current) close();
  }, [close]);
  const enter = () => {
    pointerIn.current = true;
    hover.onEnter();
  };
  const leave = () => {
    pointerIn.current = false;
    if (!listOpen.current) hover.onLeave();
  };
  const controls = () => Array.from(windowEl.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);

  // While open, Escape closes it, focus back on the words when it was inside. Used: the window's own Escape skips it.
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

  const anchor = (
    <span
      ref={(element) => {
        anchorRef.current = element;
      }}
      className="ib-code-hover"
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-code-hover={path}
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
      {title && missing ? <HostTitle title={title}>{anchor}</HostTitle> : anchor}
      {preview && (
        // A portal's events still reach the page's own handlers through React: not a click in here.
        <span
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
            // Back to the words: from there, Tab goes on through the page.
            if (event.shiftKey) event.preventDefault();
            anchorRef.current?.focus();
          }}
        >
          <CodeHoverPreview
            anchorEl={anchorRef.current}
            contents={preview.contents}
            path={path}
            line={line}
            lineEnd={lineEnd}
            pull={preview.pull}
            sheet={touch}
            windowRef={windowEl}
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
                  onListOpenChange={(next) => {
                    listOpen.current = next;
                    // Closed with the pointer gone: the window goes too.
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
        </span>
      )}
    </>
  );
}

/** A file's address on its forge, at the lines the words name. */
function withLines(pull: { platform: 'github' | 'gitlab'; url: string }, line?: number, lineEnd?: number): string {
  if (!line) return pull.url;
  if (!lineEnd || lineEnd === line) return `${pull.url}#L${line}`;
  return `${pull.url}#L${line}-${pull.platform === 'gitlab' ? '' : 'L'}${lineEnd}`;
}

/** The lines the code window shows for the words: around what they name, or the file's top when they name no line (or one past its end). */
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
  // A file's last newline ends its last line: no empty row after it.
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

/**
 * A tile's ⋯ (a sibling of the tile's own button, never inside it): the
 * same list as the header's. Shown on hover and keyboard focus, and always
 * on a touch screen.
 */
export function OpenInTileMenu({ attachment, version, onOpenAs }: { attachment: InboxAttachmentState; version: 'current' | 'sent'; onOpenAs?: (view: 'full' | 'side') => void }) {
  const { menu, status, launch, copyPath } = useOpenIn(attachment, version);
  if (!menu) return null;
  return (
    <>
      <DropdownMenu>
        <Tip content="Open in…">
          <DropdownMenuTrigger render={<button type="button" className="ib-att-more" aria-label={`Open in…, ${attachment.name}`} data-open-in-more={attachment.id} />}>
            <Icon name="dots" size={16} />
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[12rem]" finalFocus={false} data-open-in-menu={attachment.id}>
          {onOpenAs && (
            <>
              {/* This file in that view; the remembered choice is unchanged (fileView.ts). */}
              <DropdownMenuItem className="text-xs" onClick={() => onOpenAs('side')} data-open-as="side">
                <Icon name="sideBySide" size={15} className="ib-appi ib-glyph" />
                <span className="flex-1">Open side by side</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="text-xs" onClick={() => onOpenAs('full')} data-open-as="full">
                <Icon name="frame" size={15} className="ib-appi ib-glyph" />
                <span className="flex-1">Open full screen</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <OpenInMenuItems kind={attachment.kind} missingWord={missingLabel(attachment)} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Status status={status} />
    </>
  );
}

/** The other version of the file, offered in full screen's ⋯ (the changed chip offers it too). */
export interface FullScreenVersionAction {
  label: string;
  onSelect: () => void;
}

interface FullScreenMoreProps {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  /** Where the window is (as the header's control); absent: no Open in. */
  surface?: OpenInSurface;
  phone: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versionAction: FullScreenVersionAction | null;
}

/**
 * Full screen's ⋯ (approval "inbox-one-fullscreen"): with no header left,
 * Open in, Download and the other version live here. On this computer the
 * Open in list is the header's; through the tailnet or on a phone, a new tab.
 */
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
  // A source that writes nothing (the tour): no Open in, no Download; the menu says so.
  const { writes } = useInboxFileSource();
  // Through the tailnet or on a phone (or a server without the app list): a new tab, for HTML and images.
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
