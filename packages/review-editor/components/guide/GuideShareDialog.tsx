import React, { useEffect, useState } from 'react';
import { Link2, Lock, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@plannotator/ui/components/ui/dialog';
import { CopyButton } from '../CopyButton';

/** What `/api/guide/:jobId/share-info` reports about a link that already exists. */
export interface GuideShareExisting {
  url: string;
  createdAt: string;
}

/** The one-time response of `POST /api/guide/:jobId/share`. */
export interface GuideShareCreated {
  id: string;
  url: string;
  deleteToken: string;
  bytes: number;
  /**
   * Whether the server wrote the link (and its delete token) to the saved
   * guide, so Remove link works here later. False when the guide has no
   * persisted envelope (guide history off): then only the token removes it.
   */
  recorded: boolean;
}

interface GuideShareDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Live guide job id or `saved:{id}`. */
  jobId: string;
  /** Size of the portable export (guide + diff), from `/export-info`. */
  bytes: number;
  /** Base URL of the share service, from `/share-info`. */
  serviceUrl: string;
  /** Link the server already remembers for this guide, if any. */
  existing: GuideShareExisting | null;
  /** Result of a Create earlier in this guide view; owned by the caller so it outlives close/reopen. */
  created: GuideShareCreated | null;
  onCreated: (share: GuideShareCreated) => void;
  onRemoved: () => void;
}

export function formatShareBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function serviceHost(serviceUrl: string): string {
  try {
    return new URL(serviceUrl).host;
  } catch {
    return serviceUrl;
  }
}

function parseCreated(input: unknown): GuideShareCreated | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.url !== 'string' || typeof r.deleteToken !== 'string') return null;
  return {
    id: r.id,
    url: r.url,
    deleteToken: r.deleteToken,
    bytes: typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? r.bytes : 0,
    recorded: r.recorded === true,
  };
}

/**
 * Reads the `{ error }` body the review server sends on 403/404/502 so the
 * dialog can show the server's own words; falls back to the status line.
 */
async function readServerError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as unknown;
    if (typeof data === 'object' && data !== null) {
      const message = (data as Record<string, unknown>).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
  } catch {
    // Not JSON (or empty). The status line is the best we have.
  }
  return `Request failed (HTTP ${res.status})`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

interface LinkRowProps {
  label: string;
  value: string;
  testId: string;
  mono?: boolean;
}

/** One labelled value with its own Copy button. */
function LinkRow({ label, value, testId, mono = true }: LinkRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <code
          className={`min-w-0 flex-1 truncate text-[12px] text-foreground ${mono ? 'font-mono' : ''}`}
          title={value}
          data-testid={testId}
        >
          {value}
        </code>
        <CopyButton text={value} variant="inline" label="Copy" className="shrink-0" />
      </div>
    </div>
  );
}

/**
 * "Create share link" dialog for a Guided Review. Nothing is uploaded until
 * the user clicks Create: the dialog first states exactly what goes to the
 * share service (the guide plus the diff it describes, at the size the export
 * would be) and that the upload is end-to-end encrypted by default with the
 * key carried in the link fragment. "Allow link previews" opts into storing
 * the guide unencrypted (`{ public: true }`) so the hosted page can carry a
 * title and og: tags. After Create the URL and the delete token are shown,
 * each with Copy; the token is returned by the server exactly once, so this
 * dialog is the only place it can be copied from, and the caller keeps that
 * result so a reopen shows it again instead of a second Create. When the
 * server already remembers a link for this guide the dialog shows it with
 * Remove link.
 */
export const GuideShareDialog: React.FC<GuideShareDialogProps> = ({
  isOpen,
  onClose,
  jobId,
  bytes,
  serviceUrl,
  existing,
  created,
  onCreated,
  onRemoved,
}) => {
  const [publicPreview, setPublicPreview] = useState(false);
  const [busy, setBusy] = useState<'create' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const encoded = encodeURIComponent(jobId);
  // An existing link names its own host (it may have been created against a
  // different share URL than the one configured now); a new upload goes to
  // the configured one.
  const host = serviceHost(existing && !created ? existing.url : serviceUrl);

  useEffect(() => {
    if (!isOpen) return;
    setBusy(null);
    setError(null);
    // The checkbox describes the link once created, so it only resets with the form.
    if (!created) setPublicPreview(false);
  }, [isOpen, created]);

  const handleCreate = async () => {
    if (busy) return;
    setBusy('create');
    setError(null);
    try {
      const res = await fetch(`/api/guide/${encoded}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publicPreview ? { public: true } : {}),
      });
      if (!res.ok) {
        setError(await readServerError(res));
        return;
      }
      const share = parseCreated(await res.json().catch(() => null));
      if (!share) {
        setError('The server returned an unexpected response.');
        return;
      }
      onCreated(share);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not reach the review server.');
    } finally {
      setBusy(null);
    }
  };

  const handleRemove = async () => {
    if (busy) return;
    setBusy('remove');
    setError(null);
    try {
      const res = await fetch(`/api/guide/${encoded}/share`, { method: 'DELETE' });
      if (!res.ok) {
        setError(await readServerError(res));
        return;
      }
      onRemoved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not reach the review server.');
    } finally {
      setBusy(null);
    }
  };

  const showExisting = !created && existing !== null;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        backdropClassName="bg-background/80 backdrop-blur-sm"
        className="max-w-md rounded-xl bg-card p-0 text-foreground shadow-2xl transition-none"
        data-testid="guide-share-dialog"
      >
        <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary"
            >
              <Link2 size={15} />
            </span>
            <DialogTitle className="tracking-normal">
              {created ? 'Share link created' : showExisting ? 'Share link' : 'Create share link'}
            </DialogTitle>
          </div>

          {created ? (
            <div className="flex flex-col gap-4">
              <DialogDescription>
                Anyone with this link can open the guide.{' '}
                {publicPreview
                  ? 'The guide is stored unencrypted so link previews can show its title.'
                  : 'The key that opens it is the part after # and never leaves this link.'}
              </DialogDescription>
              <LinkRow label="Link" value={created.url} testId="guide-share-url" />
              <LinkRow label="Delete token" value={created.deleteToken} testId="guide-share-delete-token" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Keep the delete token somewhere safe: it is shown only this once, and it is what removes the
                link later.{' '}
                {created.recorded ? (
                  <>
                    Use Remove link here while this Plannotator remembers it, or{' '}
                    <code className="font-mono text-[11px]">plannotator guide unshare {created.id} --token …</code> anywhere.
                  </>
                ) : (
                  <>
                    This guide is not saved locally, so{' '}
                    <code className="font-mono text-[11px]">plannotator guide unshare {created.id} --token …</code> is the
                    only way to remove it.
                  </>
                )}
              </p>
            </div>
          ) : showExisting ? (
            <div className="flex flex-col gap-4">
              <DialogDescription>
                This guide already has a share link, created {formatDate(existing.createdAt)}. Removing it deletes the
                upload from {host}; the link stops working right away.
              </DialogDescription>
              <LinkRow label="Link" value={existing.url} testId="guide-share-url" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <DialogDescription>
                This uploads the guide and the diff it describes ({formatShareBytes(bytes)}) to {host}. Anyone
                with the link can open it, without Plannotator.
              </DialogDescription>
              <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/25 p-3">
                <Lock size={14} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">End-to-end encrypted:</span> {host} never sees the
                  code. The key is in the link, after the #, and is not sent to the server.
                </p>
              </div>
              <label className="flex cursor-pointer select-none items-start gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={publicPreview}
                  onChange={(e) => setPublicPreview(e.target.checked)}
                  className="mt-0.5 rounded border-border"
                  data-testid="guide-share-public"
                />
                <span>
                  Allow link previews
                  <span className="block text-xs text-muted-foreground/80">Stores the guide unencrypted so chat apps can show its title.</span>
                </span>
              </label>
            </div>
          )}

          {error && (
            <p
              role="alert"
              className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="guide-share-error"
            >
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              data-pn-touch-target
              onClick={onClose}
              disabled={busy !== null}
              className="rounded-md bg-muted px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/80 disabled:opacity-50"
            >
              {created || showExisting ? 'Close' : 'Cancel'}
            </button>
            {(showExisting || created?.recorded) && (
              <button
                type="button"
                data-pn-touch-target
                onClick={handleRemove}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                data-testid="guide-share-remove"
              >
                <Trash2 size={13} />
                {busy === 'remove' ? 'Removing…' : 'Remove link'}
              </button>
            )}
            {!created && !showExisting && (
              <button
                type="button"
                data-pn-touch-target
                onClick={handleCreate}
                disabled={busy !== null}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                data-testid="guide-share-create"
              >
                {busy === 'create' ? 'Uploading…' : 'Create'}
              </button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
