import React, { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  sortPackageChanges,
  type IndirectPackageChange,
  type PackageChange,
  type PackageMetadata,
} from '@plannotator/core/package-changes';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { usePackageChangesSetting } from '@plannotator/ui/hooks/usePackageChangesSetting';
import {
  packageKey,
  setPackageChangesFolded,
  usePackageCard,
  usePackageChangesFolded,
  usePackageLookup,
  type PackageCard,
  type PackageLookupState,
} from '../hooks/usePackageChanges';

/**
 * Package changes under a package.json or lockfile header: what the diff
 * adds, removes, upgrades and downgrades. The server works the rows out; npm
 * details (downloads, license, release date) appear only after the reviewer
 * allowed the lookup, once, from this card or Settings.
 */

export interface PackageChangesCardProps {
  filePath: string;
  reviewBase?: string;
  reviewSnapshotId?: string;
  /** Re-measure hook for the virtualized all-files host. */
  onHeightChange?: () => void;
  compactTouchLayout?: boolean;
}

type SortKey = 'change' | 'name' | 'downloads' | 'released';
const ROW_CAP = 8;
/** Indirect rows shown per step: a big lockfile changes thousands. */
const INDIRECT_STEP = 100;
/** Weekly downloads: a popularity signal, kept quiet and last. One switch drops the column everywhere. */
const SHOW_DOWNLOADS = true;
const NARROW_PX = 600;

const SECTION_TAG: Record<string, string> = {
  dependencies: 'prod',
  devDependencies: 'dev',
  peerDependencies: 'peer',
  optionalDependencies: 'optional',
};

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const fullDate = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

/** `today`, `3d`, `5mo`, `2y`: floored, so a release never reads newer than it is. */
export function releasedAgo(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'today';
  if (days < 45) return `${days}d`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

/** Published under 7 days ago: the age many teams wait before installing. */
export function isFreshRelease(iso: string | null | undefined, now = Date.now()): boolean {
  return !!iso && now - Date.parse(iso) < 7 * 86_400_000;
}

const KIND: Record<PackageChange['kind'], { glyph: string; label: string; tone: string }> = {
  added: { glyph: '+', label: 'Added', tone: 'text-success' },
  removed: { glyph: '−', label: 'Removed', tone: 'text-destructive' },
  upgraded: { glyph: '↑', label: 'Upgraded', tone: 'text-foreground/70' },
  downgraded: { glyph: '↓', label: 'Downgraded', tone: 'text-foreground/70' },
  changed: { glyph: '~', label: 'Changed', tone: 'text-muted-foreground' },
  moved: { glyph: '⇄', label: 'Moved', tone: 'text-muted-foreground' },
};

const PackageIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} aria-hidden="true">
    <path d="M8 1.75 13.75 5v6L8 14.25 2.25 11V5L8 1.75Z" strokeLinejoin="round" />
    <path d="M2.5 5.15 8 8.25l5.5-3.1M8 8.25v5.75" strokeLinejoin="round" />
  </svg>
);

const LockIcon: React.FC = () => (
  <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
    <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.25" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);

const Chevron: React.FC<{ open: boolean }> = ({ open }) => (
  <svg className={`h-3 w-3 flex-none text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

const Skeleton: React.FC<{ w?: string }> = ({ w = 'w-10' }) => (
  <span className={`inline-block h-2.5 ${w} rounded-sm bg-muted align-middle animate-pulse motion-reduce:animate-none`} aria-hidden="true" />
);

const Pill: React.FC<{ tone?: 'warning' | 'muted'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <span className={`inline-flex flex-none items-center rounded px-1 text-[10px] font-medium leading-4 ${tone === 'warning' ? 'bg-warning/15 text-warning' : 'border border-border text-muted-foreground'}`}>
    {children}
  </span>
);

function lookupVersion(change: PackageChange): string | null {
  return change.afterVersion ?? change.beforeVersion;
}

function metaFor(lookup: PackageLookupState, change: PackageChange): PackageMetadata | undefined {
  if (lookup.state !== 'ready' || !change.registryName) return undefined;
  return lookup.byKey.get(packageKey(change.registryName, lookupVersion(change)));
}

/** The version as shown: the resolved one, else the spec (a git URL, `workspace:*`). */
function shown(version: string | null, spec: string | null): string {
  return version ?? spec ?? '—';
}

const ChangeIcon: React.FC<{ change: PackageChange }> = ({ change }) => {
  const k = KIND[change.kind];
  return (
    <Tooltip content={k.label}>
      <span className={`inline-block w-3 text-center font-mono ${k.tone}`}>
        <span aria-hidden="true">{k.glyph}</span>
        <span className="sr-only">{k.label}</span>
      </span>
    </Tooltip>
  );
};

const NameTags: React.FC<{ change: PackageChange; meta?: PackageMetadata; withheld: boolean }> = ({ change, meta, withheld }) => (
  <>
    {change.previousSection ? (
      <Pill>{SECTION_TAG[change.previousSection] ?? change.previousSection} → {SECTION_TAG[change.section] ?? change.section}</Pill>
    ) : change.section !== 'dependencies' ? (
      <Pill>{SECTION_TAG[change.section] ?? change.section}</Pill>
    ) : null}
    {change.workspace && <span className="flex-none truncate font-mono text-[10px] text-muted-foreground">{change.workspace}</span>}
    {withheld && (
      <Tooltip content="Not sent to npm">
        <span className="flex-none text-muted-foreground"><LockIcon /><span className="sr-only">Not sent to npm</span></span>
      </Tooltip>
    )}
    {meta?.deprecated && (
      <Tooltip content={meta.deprecated} wide>
        <span><Pill tone="warning">deprecated</Pill></span>
      </Tooltip>
    )}
  </>
);

/** A version; `major` tints it for a step semver calls breaking. */
const VersionText: React.FC<{ version: string | null; spec: string | null; muted?: boolean; major?: boolean }> = ({ version, spec, muted, major }) => {
  const text = shown(version, spec);
  const cls = `font-mono text-[12px] tabular-nums ${major ? 'text-warning' : muted ? 'text-muted-foreground' : ''}`;
  // The spec only when it says more than the version.
  const specHint = spec && version && spec !== version ? spec : null;
  if (!specHint && !major) return <span className={cls}>{text}</span>;
  return (
    <Tooltip content={<span>{major && 'Breaking under semver'}{major && specHint && ' · '}{specHint && <span className="font-mono">{specHint}</span>}</span>}>
      <span className={cls}>
        {text}
        {major && <span className="sr-only"> (major)</span>}
      </span>
    </Tooltip>
  );
};

const Released: React.FC<{ iso: string | null | undefined }> = ({ iso }) => {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const fresh = isFreshRelease(iso);
  return (
    <Tooltip content={fresh ? `${fullDate.format(new Date(iso))} · under 7 days` : fullDate.format(new Date(iso))}>
      <span className={`whitespace-nowrap tabular-nums ${fresh ? 'text-warning' : ''}`}>{releasedAgo(iso)}</span>
    </Tooltip>
  );
};

export const PackageChangesCard: React.FC<PackageChangesCardProps> = ({
  filePath,
  reviewBase,
  reviewSnapshotId,
  onHeightChange,
  compactTouchLayout,
}) => {
  const setting = usePackageChangesSetting();
  const enabled = setting?.card === true;
  const scope = useMemo(() => ({ snapshot: reviewSnapshotId, base: reviewBase }), [reviewSnapshotId, reviewBase]);
  const data = usePackageCard(filePath, scope, enabled);
  const card = data?.card;
  const folded = usePackageChangesFolded();
  const [retry, setRetry] = useState(0);
  const [asking, setAsking] = useState(false);
  const names = card?.lookup.names.length ?? 0;
  const lookupOn = setting?.lookup === true && names > 0;
  const lookup = usePackageLookup(filePath, scope, lookupOn && !!card, retry);

  if (!enabled || !card) return null;
  return (
    <CardBody
      card={card}
      folded={folded}
      lookup={lookup}
      lookupOn={lookupOn}
      // One click allows the lookup for every card: the count is every name the review would send.
      consent={setting?.lookup !== true && setting?.lookupEnv !== false && names > 0 && data.sendTotal > 0 ? {
        names: data.sendTotal,
        asking,
        onAllow: () => {
          setAsking(true);
          void setting!.setLookup(true).finally(() => setAsking(false));
        },
      } : null}
      onRetry={() => setRetry((n) => n + 1)}
      onHeightChange={onHeightChange}
      compactTouchLayout={compactTouchLayout}
    />
  );
};

interface CardBodyProps {
  card: PackageCard;
  folded: boolean;
  lookup: PackageLookupState;
  lookupOn: boolean;
  /** `names`: how many names the click sends, across the whole review. */
  consent: { names: number; asking: boolean; onAllow: () => void } | null;
  onRetry: () => void;
  onHeightChange?: () => void;
  compactTouchLayout?: boolean;
}

/** The card itself, separate from its data so tests and hosts can render a known card. */
export const CardBody: React.FC<CardBodyProps> = ({ card, folded, lookup, lookupOn, consent, onRetry, onHeightChange, compactTouchLayout }) => {
  const [sort, setSort] = useState<SortKey>('change');
  const [showAll, setShowAll] = useState(false);
  const [showIndirect, setShowIndirect] = useState(false);
  const [indirectShown, setIndirectShown] = useState(INDIRECT_STEP);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const withheld = useMemo(() => new Set(card.lookup.withheld), [card.lookup.withheld]);
  const sendable = useMemo(() => new Set(card.lookup.names), [card.lookup.names]);
  const failure = lookupOn && lookup.state === 'ready' ? lookup.failure : undefined;
  // A failed lookup shows its status and Retry, never a table of blanks.
  const showMeta = lookupOn && !failure;
  const loading = showMeta && lookup.state === 'loading';

  const sorted = useMemo(() => {
    if (sort === 'change' || sort === 'name') return sortPackageChanges(card.changes, sort);
    const value = (c: PackageChange) => {
      const m = metaFor(lookup, c);
      if (sort === 'downloads') return m?.weeklyDownloads ?? -1;
      return m?.publishedAt ? Date.parse(m.publishedAt) : -1;
    };
    return [...card.changes].sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name));
  }, [card.changes, sort, lookup]);

  // Narrow hosts (a phone, a split pane) get stacked rows instead of columns.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setNarrow(el.clientWidth < NARROW_PX);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => { onHeightChange?.(); });

  const touch = compactTouchLayout || undefined;
  const quietButton = 'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  if (card.error) {
    return (
      <div data-package-changes="error" className="flex items-center gap-2 border-b border-border bg-muted/20 px-4 py-1.5 text-xs text-muted-foreground">
        <PackageIcon className="h-3.5 w-3.5 flex-none" />
        <Tooltip content={`${card.error.side === 'old' ? 'Previous' : 'New'} side: ${card.error.reason}`}>
          <span>Unreadable {card.path.split('/').pop()}</span>
        </Tooltip>
      </div>
    );
  }

  const rows = showAll ? sorted : sorted.slice(0, ROW_CAP);
  const total = card.changes.length;
  const indirect = card.indirect;

  const headerRight = consent ? (
    <Tooltip content="Counts the packages of every card in this review" side="bottom" align="end">
      <button
        type="button"
        data-package-lookup-allow=""
        data-pn-touch-target={touch}
        disabled={consent.asking}
        onClick={consent.onAllow}
        aria-label={`Look up ${consent.names} package ${consent.names === 1 ? 'name' : 'names'} from every card in this review on npm: sends them to registry.npmjs.org`}
        className="ml-auto flex-none rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        Look up {consent.names} on npm
      </button>
    </Tooltip>
  ) : failure ? (
    <span className="ml-auto flex flex-none items-center gap-1 text-[11px] text-muted-foreground" role="status" data-package-lookup-state="failed">
      <span>{failure === 'offline' || failure === 'timed out' ? 'npm unreachable' : failure === 'rate limited' ? 'npm rate limited' : 'npm lookup failed'}</span>
      <button type="button" data-pn-touch-target={touch} onClick={onRetry} className={quietButton}>Retry</button>
    </span>
  ) : null;

  const sortHeader = (key: SortKey, label: string, align: 'left' | 'right' = 'left', hint?: string) => {
    const button = (
      <button
        type="button"
        onClick={() => setSort(key)}
        className={`inline-flex items-center gap-0.5 rounded px-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${sort === key ? 'text-foreground' : ''}`}
      >
        {label}
        <span aria-hidden="true" className={`text-[9px] ${sort === key ? 'opacity-100' : 'opacity-0'}`}>▼</span>
      </button>
    );
    return (
      <th scope="col" aria-sort={sort === key ? (key === 'name' ? 'ascending' : 'descending') : undefined} className={`px-2 py-1 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
        {hint ? <Tooltip content={hint}>{button}</Tooltip> : button}
      </th>
    );
  };

  const downloadsCls = 'px-2 py-1.5 text-right text-[11px] tabular-nums text-muted-foreground/70';
  const metaCells = (c: PackageChange) => {
    const dash = <span className="text-muted-foreground">—</span>;
    // npm was not asked about this row: one blank span, not a row of dashes.
    if (!c.registryName || !sendable.has(c.registryName)) {
      return <td colSpan={SHOW_DOWNLOADS ? 3 : 2} className="px-2 py-1.5" />;
    }
    if (loading) {
      return <><td className="px-2 py-1.5"><Skeleton w="w-8" /></td><td className="px-2 py-1.5"><Skeleton w="w-8" /></td>{SHOW_DOWNLOADS && <td className={downloadsCls}><Skeleton /></td>}</>;
    }
    const m = metaFor(lookup, c);
    const ok = m?.status === 'ok';
    return (
      <>
        <td className="px-2 py-1.5">{ok && m.license ? m.license : dash}</td>
        <td className="px-2 py-1.5">{ok ? <Released iso={m.publishedAt} /> : dash}</td>
        {SHOW_DOWNLOADS && (
          <td data-col="downloads" className={downloadsCls}>{ok && m.weeklyDownloads != null ? compact.format(m.weeklyDownloads) : '—'}</td>
        )}
      </>
    );
  };

  /** The old version shows only when the version itself changed (not for an addition or a section move). */
  const hasPrevious = (c: PackageChange) => c.kind !== 'added' && c.kind !== 'moved';

  const indirectToggle = indirect.length > 0 ? (
    <button
      type="button"
      aria-expanded={showIndirect}
      data-pn-touch-target={touch}
      onClick={() => setShowIndirect((v) => !v)}
      className={`${quietButton} inline-flex items-center gap-1`}
    >
      <Chevron open={showIndirect} />
      {indirect.length} indirect
    </button>
  ) : null;

  const indirectVersions = (i: IndirectPackageChange, side: 'before' | 'after') =>
    i[side].length ? i[side].join(', ') : '—';

  return (
    <div
      ref={rootRef}
      data-package-changes="ready"
      data-package-changes-role={card.role}
      data-package-changes-path={card.path}
      className="border-b border-border bg-muted/20 px-4 py-2 text-xs"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={bodyId}
          data-pn-touch-target={touch}
          onClick={() => setPackageChangesFolded(!folded)}
          className="inline-flex min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron open={!folded} />
          <PackageIcon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          <span className="whitespace-nowrap font-medium text-foreground">Packages</span>
          {total > 0 && <span className="rounded bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{total}</span>}
        </button>
        {!folded && narrow && total > 1 && (
          <label className="flex flex-none items-center text-muted-foreground">
            <span className="sr-only">Sort packages by</span>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
            >
              <option value="change">Change</option>
              <option value="name">Name</option>
              {showMeta && <option value="released">Released</option>}
              {showMeta && SHOW_DOWNLOADS && <option value="downloads">Downloads</option>}
            </select>
          </label>
        )}
        {headerRight}
      </div>

      <div id={bodyId} hidden={folded}>
        {total > 0 && (narrow ? (
          <ul className="mt-2 divide-y divide-border/60 rounded border border-border/70 bg-background/60" aria-label={`Package changes in ${card.path}`} aria-busy={loading || undefined}>
            {rows.map((c) => {
              const m = metaFor(lookup, c);
              const ok = m?.status === 'ok';
              return (
                <li key={`${c.workspace ?? ''}:${c.section}:${c.name}`} data-package-row={c.kind} className="px-2.5 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <ChangeIcon change={c} />
                    <span className="truncate font-mono text-[12px] text-foreground">{c.name}</span>
                    <NameTags change={c} meta={m} withheld={!!c.registryName && withheld.has(c.registryName)} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 pl-[18px]">
                    {hasPrevious(c) && <VersionText version={c.beforeVersion} spec={c.before} muted />}
                    {hasPrevious(c) && c.kind !== 'removed' && <span className="text-muted-foreground" aria-hidden="true">→</span>}
                    {c.kind !== 'removed' && <VersionText version={c.afterVersion} spec={c.after} major={c.major} />}
                  </div>
                  {showMeta && c.registryName && sendable.has(c.registryName) && (
                    <div className="mt-0.5 flex items-center gap-2 pl-[18px] text-[11px] text-muted-foreground">
                      {loading ? <Skeleton w="w-32" /> : ok ? (
                        <>
                          {m.license && <span>{m.license}</span>}
                          {m.publishedAt && <Released iso={m.publishedAt} />}
                          {SHOW_DOWNLOADS && m.weeklyDownloads != null && <span className="tabular-nums text-muted-foreground/70">{compact.format(m.weeklyDownloads)}/wk</span>}
                        </>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="mt-2 overflow-x-auto rounded border border-border/70 bg-background/60">
            <table className="w-full border-collapse text-left" aria-busy={loading || undefined}>
              <caption className="sr-only">Package changes in {card.path}</caption>
              <thead className="border-b border-border/70 text-[11px] text-muted-foreground">
                <tr>
                  {sortHeader('name', 'Package')}
                  <th scope="col" className="px-2 py-1 font-medium">Previous</th>
                  <th scope="col" className="px-2 py-1 font-medium">Version</th>
                  {showMeta && <th scope="col" className="px-2 py-1 font-medium">License</th>}
                  {showMeta && sortHeader('released', 'Released')}
                  {showMeta && SHOW_DOWNLOADS && sortHeader('downloads', 'Downloads', 'right', 'Last 7 days')}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {rows.map((c) => (
                  <tr key={`${c.workspace ?? ''}:${c.section}:${c.name}`} data-package-row={c.kind}>
                    <th scope="row" className="max-w-[22rem] px-2 py-1.5 font-normal">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <ChangeIcon change={c} />
                        <span className="truncate font-mono text-[12px] text-foreground">{c.name}</span>
                        <NameTags change={c} meta={metaFor(lookup, c)} withheld={!!c.registryName && withheld.has(c.registryName)} />
                      </span>
                    </th>
                    <td className="px-2 py-1.5">
                      {hasPrevious(c) ? <VersionText version={c.beforeVersion} spec={c.before} muted /> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      {c.kind === 'removed' ? <span className="text-muted-foreground">—</span> : <VersionText version={c.afterVersion} spec={c.after} major={c.major} />}
                    </td>
                    {showMeta && metaCells(c)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {(sorted.length > ROW_CAP || indirectToggle) && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {sorted.length > ROW_CAP && (
              <button type="button" data-pn-touch-target={touch} onClick={() => setShowAll((v) => !v)} className={quietButton}>
                {showAll ? 'Fewer' : `${sorted.length - ROW_CAP} more`}
              </button>
            )}
            {indirectToggle}
          </div>
        )}
        {showIndirect && indirect.length > 0 && (
          <ul className="mt-1 max-h-64 overflow-y-auto rounded border border-border/60 bg-background/40 py-1" aria-label={`Indirect package changes in ${card.lockfile ?? card.path}`}>
            {indirect.slice(0, indirectShown).map((i) => (
              <li key={i.name} className="flex min-w-0 items-center gap-2 px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                <span className="truncate text-foreground/80">{i.name}</span>
                <span className="ml-auto flex-none tabular-nums">
                  {indirectVersions(i, 'before')} <span aria-hidden="true">→</span><span className="sr-only">to</span> {indirectVersions(i, 'after')}
                </span>
              </li>
            ))}
            {indirect.length > indirectShown && (
              <li className="px-1.5 pt-0.5">
                <button type="button" data-pn-touch-target={touch} onClick={() => setIndirectShown((n) => n + INDIRECT_STEP)} className={quietButton}>
                  {indirect.length - indirectShown} more
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
};
