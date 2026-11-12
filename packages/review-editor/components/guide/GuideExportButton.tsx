import React, { useEffect, useState } from 'react';
import { Download, Link2 } from 'lucide-react';
import { GuideShareDialog, formatShareBytes, type GuideShareCreated, type GuideShareExisting } from './GuideShareDialog';

interface GuideExportButtonProps {
  jobId: string;
}

interface ExportInfo {
  bytes: number;
  filename: string;
}

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
