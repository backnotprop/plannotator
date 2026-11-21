import { useState } from "react";

import {
  AppRail,
  Breadcrumbs,
  DockedPanelClip,
  DocumentRailShell,
  FileRow,
  FilesRailHeading,
  FilesRailRows,
  FolderRow,
  FrameBox,
  FrameButton,
  FrameGround,
  PageCard,
  PageHeader,
  PagesRailHead,
  RailSheet,
  ReadingLine,
  VersionActions,
  VersionsPanel,
  VersionsSheet,
  fileIcon,
  useRailMotion,
  type FrameVersionEntry,
} from "@plannotator/ui/components/frame";
import { useIsMobile } from "@plannotator/ui/hooks/useIsMobile";

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const ENTRIES: FrameVersionEntry[] = [
  {
    key: "v5",
    version: "v5",
    number: 5,
    createdAt: minutesAgo(4),
    author: { kind: "person", name: "Maya Chen", key: "name:Maya Chen" },
    current: true,
    viewing: true,
    linked: true,
    sameAsOlder: false,
    approval: "Alex Rivera",
    canCompare: false,
  },
  {
    key: "v4",
    version: "v4",
    number: 4,
    createdAt: minutesAgo(50),
    author: { kind: "person", name: "Alex Rivera", key: "name:Alex Rivera" },
    current: false,
    viewing: false,
    linked: true,
    sameAsOlder: false,
    approval: null,
    canCompare: true,
  },
  {
    key: "v3",
    version: "v3",
    number: 3,
    createdAt: minutesAgo(62),
    author: { kind: "person", name: "Alex Rivera", key: "name:Alex Rivera" },
    current: false,
    viewing: false,
    linked: true,
    sameAsOlder: false,
    approval: null,
    canCompare: true,
  },
  {
    key: "v2",
    version: "v2",
    number: 2,
    createdAt: minutesAgo(60 * 26),
    author: { kind: "person", name: "Maya Chen", key: "name:Maya Chen" },
    current: false,
    viewing: false,
    linked: true,
    sameAsOlder: false,
    approval: null,
    canCompare: true,
  },
];

const PAGES = [
  { id: "p1", name: "porto-launch-plan.md", path: "porto-launch-plan.md", comments: 3 },
  { id: "p2", name: "budget.md", path: "porto-launch-plan/budget.md", comments: 0 },
  { id: "p3", name: "venues.md", path: "porto-launch-plan/venues.md", comments: 1 },
];

const ACTIVE = "porto-launch-plan.md";

function RailHead() {
  return <PagesRailHead label="Porto launch plan" backLink={<a href="#collection" />} />;
}

function RailList() {
  const [filterVisible, setFilterVisible] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="flex flex-1 flex-col">
      <FilesRailHeading
        count={PAGES.length}
        filterVisible={filterVisible}
        onToggleFilter={() => setFilterVisible((visible) => !visible)}
      />
      <FilesRailRows>
        <FileRow
          id={PAGES[0]!.id}
          name={PAGES[0]!.name}
          title={PAGES[0]!.path}
          depth={0}
          active={PAGES[0]!.path === ACTIVE}
          icon={fileIcon({ path: PAGES[0]!.path })}
          link={<a href={`#${PAGES[0]!.path}`} />}
          openCommentCount={PAGES[0]!.comments}
        />
        <FolderRow
          name="porto-launch-plan"
          path="porto-launch-plan"
          depth={0}
          collapsed={collapsed}
          selected={false}
          toggleDisabled={false}
          onToggle={() => setCollapsed((value) => !value)}
          onSelect={() => {}}
        />
        {!collapsed &&
          PAGES.slice(1).map((page) => (
            <FileRow
              key={page.id}
              id={page.id}
              name={page.name}
              title={page.path}
              depth={1}
              active={page.path === ACTIVE}
              icon={fileIcon({ path: page.path })}
              link={<a href={`#${page.path}`} />}
              openCommentCount={page.comments}
            />
          ))}
      </FilesRailRows>
    </div>
  );
}

function Versions({ onClose }: { onClose: () => void }) {
  return (
    <VersionsPanel
      status="success"
      entries={ENTRIES}
      place={{ rowLink: (entry) => <a href={`#version-${entry.number}`} /> }}
      onRetry={() => {}}
      onClose={onClose}
      onScreenActions={(onScreen, compared) => (
        <VersionActions
          version={onScreen.version}
          number={onScreen.number}
          currentNumber={ENTRIES[0]!.number}
          canCompare={compared !== null}
          soft
          onCompare={() => {}}
          onCopyLink={() => {}}
        />
      )}
    />
  );
}

/** Compile-only proof of the frame's published surface, and a page to copy from: made-up names only. */
export function PortoLaunchPlanExample() {
  const isMobile = useIsMobile();
  const [versionsOpen, setVersionsOpen] = useState(true);
  const versionsMotion = useRailMotion(!isMobile && versionsOpen, 288);
  return (
    <FrameGround>
      <FrameBox
        band={
          <AppRail
            variant="dense"
            leading={
              <RailSheet closeKey={ACTIVE} head={<RailHead />}>
                <RailList />
              </RailSheet>
            }
            account={
              <span
                aria-label="Maya Chen"
                className="grid size-7 place-items-center rounded-full bg-muted text-frame-2xs font-medium"
              >
                MC
              </span>
            }
          >
            <PageHeader
              identity={
                <Breadcrumbs
                  collectionName="Porto launch plan"
                  collectionLink={<a href="#collection" />}
                  path={ACTIVE}
                />
              }
              actions={
                <FrameButton variant="outline" size="xs">
                  Share
                </FrameButton>
              }
            />
          </AppRail>
        }
      >
        <DocumentRailShell head={<RailHead />} defaults={{ open: true }}>
          <RailList />
        </DocumentRailShell>
        <PageCard
          top={
            <ReadingLine
              shownNumber={5}
              currentNumber={5}
              versionsOpen={versionsOpen}
              onToggleVersions={setVersionsOpen}
              count={ENTRIES.length}
              approved={
                <span className="text-frame-xs text-muted-foreground">
                  Approved by Alex Rivera
                </span>
              }
            />
          }
        >
          <article className="h-full overflow-y-auto px-8 py-6">
            <h1 className="text-2xl font-semibold">Porto launch plan</h1>
            <p className="mt-4 text-frame-sm text-muted-foreground">
              Maya Chen drafted the plan. Alex Rivera approved version 5.
            </p>
          </article>
        </PageCard>
        {isMobile ? (
          <VersionsSheet open={versionsOpen} onClose={() => setVersionsOpen(false)}>
            <Versions onClose={() => setVersionsOpen(false)} />
          </VersionsSheet>
        ) : (
          versionsMotion.mounted && (
            <DockedPanelClip motion={versionsMotion}>
              <Versions onClose={() => setVersionsOpen(false)} />
            </DockedPanelClip>
          )
        )}
      </FrameBox>
    </FrameGround>
  );
}
