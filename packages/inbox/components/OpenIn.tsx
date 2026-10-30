import { inboxUrl } from '../inboxUrl';
import { useEffect, useRef, useState } from 'react';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { AppIcon } from '@plannotator/ui/components/icons/AppIcon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@plannotator/ui/components/ui/dropdown-menu';
import { useOpenInApps, useRememberedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { InboxApiError, inboxApi } from '../api';
import { Icon } from '../icons';
import { newTabUrl, openInMenu, remembersOpenInItem, type OpenInItem, type OpenInMenu } from '../openIn';
import { attachmentDownloadUrl } from '../attachments';
import { useInboxFileSource } from '../fileSource';
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

/** Everything a control needs: the menu, and picking from it. */
function useOpenIn(attachment: InboxAttachmentState, version: 'current' | 'sent') {
  // A read that did not answer (a restarting Inbox) is asked again for the next file.
  const answer = useOpenInApps(INBOX_OPEN_IN_APPS_URL, true, attachment.id);
  const [remembered, remember] = useRememberedOpenInApp();
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

  const menu: OpenInMenu | null = answer?.available ? openInMenu(attachment, answer.apps, answer.platform ?? 'linux', remembered, version) : null;

  const launch = async (item: OpenInItem) => {
    if (item.kind === 'browser' || busy) return;
    if (remembersOpenInItem(item)) remember(item.id);
    setBusy(true);
    setStatus(null);
    try {
      const result = await inboxApi.openIn(attachment.id, item.id);
      if (!result.ok) flash(result.error || `Could not open ${item.label}`, true);
    } catch (cause) {
      flash(cause instanceof InboxApiError ? cause.message : `Could not open ${item.label}`, true);
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async () => {
    const ok = await copyTextToClipboard(attachment.path);
    flash(ok ? 'Path copied' : 'Could not copy the path', !ok);
  };

  return { answer, menu, busy, status, launch, copyPath };
}

function ItemIcon({ item, attachment }: { item: OpenInItem; attachment: InboxAttachmentState }) {
  if (item.kind === 'browser') return <Icon name="globe" size={15} className="ib-appi ib-glyph" />;
  if (item.kind === 'default') return <Icon name={readInboxAttachmentKind(attachment.kind) === 'image' ? 'photo' : 'doc'} size={15} className="ib-appi ib-glyph" />;
  return <AppIcon id={item.icon} className="ib-appi" />;
}

function missingLabel(attachment: InboxAttachmentState): string {
  return attachment.unavailable?.code === 'attachment_missing' ? 'Missing' : 'Changed';
}

/** The list both menus show: the apps, then Copy path. */
function OpenInMenuItems({ attachment, menu, onLaunch, onCopyPath }: { attachment: InboxAttachmentState; menu: OpenInMenu; onLaunch: (item: OpenInItem) => void; onCopyPath: () => void }) {
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
            <ItemIcon item={item} attachment={attachment} />
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
            <ItemIcon item={item} attachment={attachment} />
            <span className="flex-1 truncate">{item.label}</span>
            {/* The file is gone or changed type: the apps are disabled and say so. */}
            {menu.missing && <span className="ib-openin-miss">{missingLabel(attachment)}</span>}
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
  const [open, setOpen] = useState(false);
  if (!answer) return null;
  // A server without the local app list (an older Inbox): a new tab is all there is.
  if (!menu) return <NewTabButton attachment={attachment} version={version} big={false} />;
  const primary = menu.primary;
  const disabled = !primary || busy || (menu.missing && primary.kind !== 'browser');
  const title = !primary ? 'Open in…' : menu.missing && primary.kind !== 'browser' ? missingLabel(attachment) : primary.label;
  const face = (
    <>
      {primary && <ItemIcon item={primary} attachment={attachment} />}
      {label && <span>Open</span>}
    </>
  );
  return (
    <span className="ib-openin" data-open-in={attachment.id}>
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
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-[12rem]" finalFocus={false} data-open-in-menu={attachment.id}>
            <OpenInMenuItems attachment={attachment} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      <Status status={status} />
    </span>
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
          <OpenInMenuItems attachment={attachment} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
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
              <OpenInMenuItems attachment={props.attachment} menu={menu} onLaunch={(item) => void launch(item)} onCopyPath={() => void copyPath()} />
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
