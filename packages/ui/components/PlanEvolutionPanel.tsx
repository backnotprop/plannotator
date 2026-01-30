/**
 * Plan Evolution Panel
 *
 * Split view showing block-level diffs between plan versions.
 * Git-diff style colors: green (added), red (removed), yellow (modified), grey (unchanged).
 */

import React, { useState, useEffect } from 'react';
import type { Block, BlockDiff, DiffType } from '@plannotator/core';

interface PlanVersion {
  version: number;
  timestamp: string;
  hash: string;
  path: string;
  slug: string;
}

interface PlanEvolutionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  currentSlug?: string;
}

interface DiffSummary {
  unchanged: number;
  added: number;
  removed: number;
  modified: number;
}

const DIFF_COLORS: Record<DiffType, { bg: string; border: string; text: string }> = {
  unchanged: {
    bg: 'bg-muted/50',
    border: 'border-l-4 border-muted-foreground/30',
    text: 'text-muted-foreground',
  },
  added: {
    bg: 'bg-green-500/10',
    border: 'border-l-4 border-green-500',
    text: 'text-foreground',
  },
  removed: {
    bg: 'bg-red-500/10',
    border: 'border-l-4 border-red-500',
    text: 'text-foreground line-through opacity-70',
  },
  modified: {
    bg: 'bg-yellow-500/10',
    border: 'border-l-4 border-yellow-500',
    text: 'text-foreground',
  },
};

const BlockRenderer: React.FC<{ block: Block; diffType: DiffType }> = ({ block, diffType }) => {
  const colors = DIFF_COLORS[diffType];

  const renderContent = () => {
    switch (block.type) {
      case 'heading':
        const HeadingTag = `h${block.level || 1}` as keyof JSX.IntrinsicElements;
        const headingSizes: Record<number, string> = {
          1: 'text-xl font-bold',
          2: 'text-lg font-semibold',
          3: 'text-base font-semibold',
          4: 'text-sm font-semibold',
          5: 'text-sm font-medium',
          6: 'text-xs font-medium',
        };
        return (
          <HeadingTag className={headingSizes[block.level || 1]}>
            {block.content}
          </HeadingTag>
        );

      case 'code':
        return (
          <pre className="text-xs font-mono bg-black/20 p-2 rounded overflow-x-auto">
            <code>{block.content}</code>
          </pre>
        );

      case 'list-item':
        const indent = (block.level || 0) * 16;
        return (
          <div className="flex items-start gap-2" style={{ paddingLeft: indent }}>
            <span className="text-muted-foreground">•</span>
            <span>{block.content}</span>
          </div>
        );

      case 'blockquote':
        return (
          <blockquote className="italic text-muted-foreground border-l-2 border-muted-foreground/50 pl-3">
            {block.content}
          </blockquote>
        );

      case 'hr':
        return <hr className="border-border my-2" />;

      case 'table':
        return (
          <pre className="text-xs font-mono overflow-x-auto">
            {block.content}
          </pre>
        );

      default:
        return <p>{block.content}</p>;
    }
  };

  return (
    <div className={`p-2 my-1 rounded-r ${colors.bg} ${colors.border} ${colors.text}`}>
      {renderContent()}
    </div>
  );
};

const DiffColumn: React.FC<{
  title: string;
  version: number;
  timestamp: string;
  diffs: BlockDiff[];
  side: 'old' | 'new';
}> = ({ title, version, timestamp, diffs, side }) => {
  const formattedDate = new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="sticky top-0 bg-card border-b border-border p-3 z-10">
        <div className="flex items-center justify-between">
          <span className="font-medium">Version {version}</span>
          <span className="text-xs text-muted-foreground">{formattedDate}</span>
        </div>
      </div>
      <div className="p-3 space-y-1">
        {diffs.map((diff, idx) => {
          // For the old side, show removed and unchanged blocks
          if (side === 'old') {
            if (diff.type === 'added') {
              // Empty placeholder for alignment
              return (
                <div key={idx} className="p-2 my-1 rounded-r bg-transparent border-l-4 border-transparent min-h-[2rem]" />
              );
            }
            if (diff.oldBlock) {
              return (
                <BlockRenderer
                  key={idx}
                  block={diff.oldBlock}
                  diffType={diff.type === 'unchanged' ? 'unchanged' : diff.type === 'modified' ? 'modified' : 'removed'}
                />
              );
            }
            return null;
          }

          // For the new side, show added and unchanged blocks
          if (side === 'new') {
            if (diff.type === 'removed') {
              // Empty placeholder for alignment
              return (
                <div key={idx} className="p-2 my-1 rounded-r bg-transparent border-l-4 border-transparent min-h-[2rem]" />
              );
            }
            if (diff.newBlock) {
              return (
                <BlockRenderer
                  key={idx}
                  block={diff.newBlock}
                  diffType={diff.type === 'unchanged' ? 'unchanged' : diff.type === 'modified' ? 'modified' : 'added'}
                />
              );
            }
            return null;
          }

          return null;
        })}
      </div>
    </div>
  );
};

const SummaryBadge: React.FC<{ type: DiffType; count: number }> = ({ type, count }) => {
  if (count === 0) return null;

  const styles: Record<DiffType, string> = {
    unchanged: 'bg-muted text-muted-foreground',
    added: 'bg-green-500/20 text-green-600 dark:text-green-400',
    removed: 'bg-red-500/20 text-red-600 dark:text-red-400',
    modified: 'bg-yellow-500/20 text-yellow-600 dark:text-yellow-400',
  };

  const labels: Record<DiffType, string> = {
    unchanged: 'unchanged',
    added: 'added',
    removed: 'removed',
    modified: 'modified',
  };

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${styles[type]}`}>
      {count} {labels[type]}
    </span>
  );
};

export const PlanEvolutionPanel: React.FC<PlanEvolutionPanelProps> = ({
  isOpen,
  onClose,
  currentSlug,
}) => {
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [selectedV1, setSelectedV1] = useState<number | null>(null);
  const [selectedV2, setSelectedV2] = useState<number | null>(null);
  const [diffs, setDiffs] = useState<BlockDiff[]>([]);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch versions when panel opens
  useEffect(() => {
    if (!isOpen) return;

    setLoading(true);
    setError(null);

    const slugParam = currentSlug ? `?slug=${encodeURIComponent(currentSlug)}` : '';
    fetch(`/api/plan/versions${slugParam}`)
      .then(res => res.json())
      .then((data: { versions: PlanVersion[]; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setVersions(data.versions || []);

        // Auto-select latest two versions for comparison
        if (data.versions && data.versions.length >= 2) {
          const sorted = [...data.versions].sort((a, b) => a.version - b.version);
          setSelectedV1(sorted[sorted.length - 2].version);
          setSelectedV2(sorted[sorted.length - 1].version);
        } else if (data.versions && data.versions.length === 1) {
          setSelectedV1(data.versions[0].version);
          setSelectedV2(data.versions[0].version);
        }
      })
      .catch(err => {
        setError(err.message || 'Failed to load versions');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, currentSlug]);

  // Fetch diff when versions are selected
  useEffect(() => {
    if (selectedV1 === null || selectedV2 === null || selectedV1 === selectedV2) {
      setDiffs([]);
      setSummary(null);
      return;
    }

    setLoading(true);
    const slugParam = currentSlug ? `&slug=${encodeURIComponent(currentSlug)}` : '';
    fetch(`/api/plan/diff?v1=${selectedV1}&v2=${selectedV2}${slugParam}`)
      .then(res => res.json())
      .then((data: { diff: BlockDiff[]; summary: DiffSummary; error?: string }) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setDiffs(data.diff || []);
        setSummary(data.summary || null);
      })
      .catch(err => {
        setError(err.message || 'Failed to compute diff');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [selectedV1, selectedV2, currentSlug]);

  if (!isOpen) return null;

  const v1Data = versions.find(v => v.version === selectedV1);
  const v2Data = versions.find(v => v.version === selectedV2);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-6xl h-[80vh] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <h2 className="font-semibold text-lg">Plan Evolution</h2>
            </div>

            {/* Version selectors */}
            <div className="flex items-center gap-2 text-sm">
              <select
                value={selectedV1 ?? ''}
                onChange={e => setSelectedV1(parseInt(e.target.value, 10))}
                className="bg-muted border border-border rounded px-2 py-1 text-sm"
              >
                {versions.map(v => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">→</span>
              <select
                value={selectedV2 ?? ''}
                onChange={e => setSelectedV2(parseInt(e.target.value, 10))}
                className="bg-muted border border-border rounded px-2 py-1 text-sm"
              >
                {versions.map(v => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                  </option>
                ))}
              </select>
            </div>

            {/* Summary badges */}
            {summary && (
              <div className="flex items-center gap-2">
                <SummaryBadge type="added" count={summary.added} />
                <SummaryBadge type="removed" count={summary.removed} />
                <SummaryBadge type="modified" count={summary.modified} />
              </div>
            )}
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-md hover:bg-muted transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-muted-foreground">
                <p className="text-red-500 mb-2">{error}</p>
                <button
                  onClick={onClose}
                  className="text-sm text-accent hover:underline"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {!loading && !error && versions.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-muted-foreground">
                <p className="mb-2">No versions found</p>
                <p className="text-sm">Versions are saved automatically when you review a plan.</p>
              </div>
            </div>
          )}

          {!loading && !error && versions.length === 1 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-muted-foreground">
                <p className="mb-2">Only one version available</p>
                <p className="text-sm">Review the plan again to create a second version for comparison.</p>
              </div>
            </div>
          )}

          {!loading && !error && versions.length >= 2 && selectedV1 !== selectedV2 && v1Data && v2Data && (
            <div className="flex h-full divide-x divide-border">
              <DiffColumn
                title="Previous"
                version={v1Data.version}
                timestamp={v1Data.timestamp}
                diffs={diffs}
                side="old"
              />
              <DiffColumn
                title="Current"
                version={v2Data.version}
                timestamp={v2Data.timestamp}
                diffs={diffs}
                side="new"
              />
            </div>
          )}

          {!loading && !error && selectedV1 === selectedV2 && selectedV1 !== null && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-muted-foreground">
                <p>Select two different versions to compare</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
