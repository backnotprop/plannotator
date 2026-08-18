import React, { useEffect, useState } from 'react';
import { Download, Link2 } from 'lucide-react';
import { GuideShareDialog, formatShareBytes, type GuideShareCreated, type GuideShareExisting } from './GuideShareDialog';

interface GuideExportButtonProps {
  /** Live guide job id or `saved:{id}`. */
  jobId: string;
}

interface ExportInfo {
  bytes: number;
  filename: string;
}

/** What `/api/guide/:jobId/share-info` reports. */
interface ShareInfo {
  enabled: boolean;
  serviceUrl: string;
  existing: GuideShareExisting | null;
}

function parseExportInfo(input: unknown): ExportInfo | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || typeof r.filename !== 'string') return null;
  return { bytes: r.bytes, filename: r.filename };
}

function parseShareInfo(input: unknown): ShareInfo | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || typeof r.serviceUrl !== 'string') return null;
  let existing: GuideShareExisting | null = null;
  if (typeof r.existing === 'object' && r.existing !== null) {
    const e = r.existing as Record<string, unknown>;
    if (typeof e.url === 'string' && typeof e.createdAt === 'string') existing = { url: e.url, createdAt: e.createdAt };
  }
  return { enabled: r.enabled, serviceUrl: r.serviceUrl, existing };
}

const HEADER_CONTROL_CLASS =
  'inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border hover:text-foreground';

/**
 * The guide header's Share menu: "Download portable guide" — one HTML file
 * with this guide and the exact diff it describes; the viewer loads from
 * guides.show (decision record D1, D9) — and "Create share link", which
 * uploads the same guide + diff to the share service through
 * `POST /api/guide/:jobId/share` (contract in
 * `adr/implementation/guide-share-hosting.md` §7), only ever from the
 * dialog's Create click.
 *
 * Renders nothing when the server reports the guide is not exportable (its
 * diff was not retained) or the export preflight fails, so a guide that
 * cannot be exported never shows a dead control; the share control is
 * additionally hidden when `/share-info` says sharing is disabled
 * (`PLANNOTATOR_SHARE=disabled`) or that preflight fails. When the server
 * already remembers a link for this guide the control reads "Share link"
 * and the dialog offers Remove link.
 *
 * The result of a Create is held here for the life of this guide view, so
 * reopening the dialog shows the same link and one-time delete token instead
 * of offering a second upload — an unrecorded link (guide history off) can
 * only ever be removed with that token, so it must never be silently orphaned.
 */
export const GuideExportButton: React.FC<GuideExportButtonProps> = ({ jobId }) => {
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [created, setCreated] = useState<GuideShareCreated | null>(null);
  const encoded = encodeURIComponent(jobId);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setShare(null);
    setShareOpen(false);
    setCreated(null);
    fetch(`/api/guide/${encoded}/export-info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setInfo(parseExportInfo(data));
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    fetch(`/api/guide/${encoded}/share-info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setShare(parseShareInfo(data));
      })
      .catch(() => {
        if (!cancelled) setShare(null);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded]);

  if (!info) return null;

  const shareEnabled = share !== null && share.enabled;
  const hasLink = shareEnabled && (share.existing !== null || created !== null);

  return (
    <>
      <a
        href={`/api/guide/${encoded}/export`}
        download={info.filename}
        className={HEADER_CONTROL_CLASS}
        title="Download this guide as one portable HTML file — opens anywhere, no Plannotator needed"
        data-testid="guide-export"
      >
        <Download size={13} />
        <span>Download portable guide</span>
        <span className="font-mono text-[10px] text-muted-foreground/60">{formatShareBytes(info.bytes)}</span>
      </a>
      {shareEnabled && (
        <button
          type="button"
          onClick={() => setShareOpen(true)}
          className={HEADER_CONTROL_CLASS}
          title={
            hasLink
              ? 'This guide has a share link. Open to copy or remove it.'
              : 'Upload this guide and its diff to the share service and get a link anyone can open'
          }
          data-testid="guide-share"
        >
          <Link2 size={13} />
          <span>{hasLink ? 'Share link' : 'Create share link'}</span>
        </button>
      )}
      {shareEnabled && (
        <GuideShareDialog
          isOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          jobId={jobId}
          bytes={info.bytes}
          serviceUrl={share.serviceUrl}
          existing={share.existing}
          created={created}
          onCreated={(next) => {
            setCreated(next);
            // Only a link the server recorded can be removed from here; an
            // `existing` entry otherwise would offer a Remove that 404s.
            if (!next.recorded) return;
            setShare((prev) =>
              prev ? { ...prev, existing: { url: next.url, createdAt: new Date().toISOString() } } : prev,
            );
          }}
          onRemoved={() => {
            setCreated(null);
            setShare((prev) => (prev ? { ...prev, existing: null } : prev));
          }}
        />
      )}
    </>
  );
};
