# Frame

The page screen around a document, as building blocks: a top bar, a left rail of pages, the page card, a docked right panel (versions or comments), and the sheets that replace the rail and the panel on a phone. From 768px up, each column of the row is drawn as its own card on a tinted ground.

The frame holds no data and no routing. The host passes links as elements, content as slots, and behaviour as callbacks.

```ts
import { FrameBox, DocumentRailShell, PageCard, VersionsPanel } from "@plannotator/ui/components/frame";
```

## The pieces

| Piece | What it is |
|---|---|
| `FrameGround`, `FrameBox` | The ground behind the cards, and the column that holds the top bar and the card row (`data-frame`, `data-frame-row`). |
| `AppRail`, `AppRailBand` | The top bar, with `leading` and `account` slots. |
| `PageHeader`, `Breadcrumbs` | The page's identity (root, collection, file, collapsing when narrow) and its actions group. |
| `DocumentRailShell`, `DocumentRail`, `RailSlot`, `ShellTabFlags` | The left rail: resizable by drag or arrow keys, collapsible by click or keyboard, remembered open or closed (or controlled by the host), with a tab to bring it back. Focus follows: collapsing from inside the rail lands on the tab, and the tab lands focus in the rail. While the rail does not fit the row there is no tab; the host offers `RailSheet docked={false}` instead. The tab sits in its own narrow column at the start of the row, so it never covers the page. `RailSlot` keeps its place while the host loads it. |
| `PagesRailHead`, `FilesRailHeading`, `FileRow`, `FolderRow`, `FilesRail*` states | The rail's head, rows and empty, loading, error and no-match states. `fileIcon` picks a mark by kind or extension, with neutral marks for `html`, `mermaid` and `graphviz` (lucide's file-code, workflow and network). |
| `PageCard`, `ReadingLine` | The page card, and the strip above the document that says which version is on screen ("v6 · newest"). |
| `VersionsPanel`, `VersionActions` | The versions list: consecutive saves by one author within 30 minutes fold together, and the fold holding the version on screen opens itself. |
| `DockedPanelClip`, `useRailMotion` | The spring that opens and closes a docked panel (through `motion`). |
| `RailSheet`, `VersionsSheet`, `CommentsSheet` | The phone sheets. |
| `PanelEdge`, `CollapsibleEdge` | The edge between rail and page, over the package's `ResizeHandle`. With `keyboard` (the rail passes it), arrow keys, Home and End resize. |

The frame brings its own small button, sheet, skeleton and tooltip (in `primitives/`), drawn with the frame tokens. `FrameButton` and `frameCn` are exported for host controls that sit inside the frame; `frameCn` knows the `frame-*` class names, so `text-frame-sm` is kept next to a text colour.

## Styles

In the host's Tailwind v4 entry, after Tailwind and the theme:

```css
@import "tailwindcss";
@import "@plannotator/ui/theme";
@import "@plannotator/ui/frame.css";
```

`frame.css` declares the frame's theme names (`text-frame-sm`, `h-frame-row`, `rounded-frame-pane`, `bg-frame-selected` and the rest), the `frame-dark` and `frame-reduce-transparency` variants, the card layout, and the sheet and tooltip motion. It also points Tailwind at the frame's own files, so no `@source` line is needed for them. It does not change the package themes or a host document inside the frame: it defines only `--frame-*` names (and the `frame-*` theme names above) and rules on the frame's own attributes, and redefines no host token. The frame's own quiet text uses `--frame-muted-fg` (`text-frame-muted-fg`), which follows `--muted-foreground` and is a little brighter inside a dark pane; the host's `--muted-foreground` stays as it is.

### Host tokens it reads

`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--destructive`, `--destructive-foreground`, `--success`, `--border`, `--ring`, and the `font-sans` / `font-mono` families. Light is the `.light` class on an ancestor (the root, as the themes set it); anything else is dark.

Every `--frame-*` value can be set by the host.

### Fixed or theme colours

By default the selected row, the hover fill and the subtle border (`--frame-selected`, `--frame-surface-hover`, `--frame-border-subtle`) are fixed colours: a violet selection and a cool grey hover and border, whatever the theme. The selected row's text (`--frame-selected-fg`) is fixed too: the frame's own violet, `oklch(0.72 0.15 280)` dark and `oklch(0.50 0.25 280)` light, not the host's `--primary`, so its contrast does not depend on the host theme. On the selected fill over Plannotator's card (`oklch(0.22 0.02 260)` dark, white light) it measures 5.45:1 dark and 5.97:1 light (WCAG 2, composited in sRGB).

`<FrameGround colors="theme">` sets `data-frame-colors="theme"`, and under it the three are mixed from the theme instead:

| Token | Dark | Light |
|---|---|---|
| `--frame-selected` | `--primary` at 13% | `--primary` at 7.5% |
| `--frame-surface-hover` | `--foreground` at 7% | `--foreground` at 5.5% |
| `--frame-border-subtle` | `--foreground` at 5.5% | `--foreground` at 7.5% |

(each is `color-mix(in oklch, var(--token) N%, transparent)`), and the selected row's text `--frame-selected-fg` becomes `--foreground`, so only the fill carries the accent: a theme's primary as text can fall under 4.5:1 contrast on its card (3.66:1 measured on one light theme). A host may still set `--frame-selected-fg` itself, under the attribute or anywhere above the frame. The amounts were chosen so that, with the frame's own violet as primary (`oklch(0.72 0.15 280)` dark, `oklch(0.50 0.25 280)` light) and foreground `oklch(0.90 0.01 260)` dark, `oklch(0.18 0.02 260)` light, each colour drawn on the card lands within 0.002 (OKLab distance) of the fixed one, about a tenth of a just-visible step. Dark selected and dark hover match exactly; the largest gap is the light selected row (0.0019), whose fixed colour has a little less chroma than that primary.

Pick `theme` when the host offers more than one theme, so the selection takes each theme's accent (Plannotator's own themes included). Keep `fixed` only when the host has one theme and wants this exact look.

A host using theme colours:

- [ ] passes `colors="theme"` to `FrameGround`, and also sets `data-frame-colors="theme"` on its root element (`<html>`), or the phone sheets, which render outside the ground, keep the fixed colours.

## Usage

```tsx
import { useState } from "react";
import {
  AppRail,
  Breadcrumbs,
  DocumentRailShell,
  FileRow,
  FilesRailHeading,
  FilesRailRows,
  FrameBox,
  FrameGround,
  PageCard,
  PageHeader,
  PagesRailHead,
  ReadingLine,
  fileIcon,
} from "@plannotator/ui/components/frame";

export function PortoLaunchPlan() {
  const [filterVisible, setFilterVisible] = useState(false);
  return (
    <FrameGround>
      <FrameBox
        band={
          <AppRail variant="dense" account={<span aria-label="Maya Chen">MC</span>}>
            <PageHeader
              identity={
                <Breadcrumbs
                  collectionName="Porto launch plan"
                  collectionLink={<a href="/porto" />}
                  path="porto-launch-plan.md"
                />
              }
              actions={null}
            />
          </AppRail>
        }
      >
        <DocumentRailShell
          head={<PagesRailHead label="Porto launch plan" backLink={<a href="/porto" />} />}
          defaults={{ open: true }}
        >
          <FilesRailHeading
            count={1}
            filterVisible={filterVisible}
            onToggleFilter={() => setFilterVisible((visible) => !visible)}
          />
          <FilesRailRows>
            <FileRow
              id="plan"
              name="porto-launch-plan.md"
              title="porto-launch-plan.md"
              depth={0}
              active
              icon={fileIcon({ path: "porto-launch-plan.md" })}
              link={<a href="/porto/porto-launch-plan.md" />}
              openCommentCount={2}
            />
          </FilesRailRows>
        </DocumentRailShell>
        <PageCard
          top={
            <ReadingLine
              shownNumber={5}
              currentNumber={5}
              versionsOpen={false}
              onToggleVersions={null}
              approved={<span>Approved by Alex Rivera</span>}
            />
          }
        >
          <article>Maya Chen drafted the plan. Alex Rivera approved version 5.</article>
        </PageCard>
      </FrameBox>
    </FrameGround>
  );
}
```

A fuller page, with the versions panel, its phone sheet and the rail sheet, is `test-consumer/frame-example.tsx`.

## Props for host behaviours

| Where | Prop | What the host decides |
|---|---|---|
| `Breadcrumbs` | `collectionLink`, `root: { label, link }`, `path` | The links (any element: a router link or an `<a>`), cloned with the frame's classes. `collectionName: null` shows a skeleton. Leave `path` out on the collection's own page: no file crumb, and the collection is the current page. |
| `PagesRailHead` | `backLink`, `label`, `meta` | The back link; `label: null` shows a skeleton. `meta` is a quiet second line under it, aligned with the label (a glyph and words; give long ones a `title`). |
| `FileRow` | `link`, `onOpen`, `renderActions`, `presence`, `trailing`, `dragProps`, `moving`, `error`, `busy`, `openCommentCount` | The row link and what else happens on open (after the link's own `onClick`), a wrapper for a row menu, a presence slot, a mark at the row's right end (for example "Main"), drag handlers, and the row's states. |
| `FolderRow` | `onToggle`, `onSelect`, `dropProps`, `hot`, `presence` | Folder open and select, and drop handling. |
| `FilesRailHeading` | `label`, `countTitle`, `onToggleFilter`, `filterVisible`, `actions`, `menu` | The heading's words, the count's hover text, the filter toggle (no Filter button without `onToggleFilter`, for a second heading such as "Artifacts") and the heading's buttons (style them with `RAIL_ICON_BUTTON`). |
| `DocumentRailShell` | `open`, `onOpenChange`, `storage`, `storageKeys`, `defaults`, `fitsForWidth`, `onFitChange`, `onFlagsChange`, `enabled`, `onDragOver`, `onDrop` | Open and close the rail from outside (`open` makes it controlled and nothing is stored; `onOpenChange` hears every request either way). Where the open flag is kept (default: the package's storage helper, so `configurePlannotatorUI({ storageBackend })` applies), the keys for the open flag and the width, whether the rail fits (and `onFitChange` reports it), and drops onto the rail. The width is saved by `useResizablePanel`, which always uses the package's storage helper. |
| `RailSlot`, `ReservedRailColumn` | `status`, `storage`, `storageKeys` | Loading state, and the same storage as the rail so the reserved column matches it. |
| `RailSheet` | `closeKey`, `docked`, `triggerLabel`, `triggerTitle`, `title`, `description` | The sheet closes when `closeKey` changes (pass the location). It shows below 768px, and at any width with `docked={false}`: pass `DocumentRailShell`'s `onFitChange` result so a rail that does not fit the row is replaced by the sheet. The words. |
| `VersionsPanel` | `status`, `entries`, `place`, `onRetry`, `hasMore`, `loadingMore`, `onLoadMore`, `onScreenActions`, `onClose`, `footer` | The data, loading more, the actions under the version on screen, and a footer slot under the list. Each entry may carry a `decision: { label, tone }` (`positive`, `negative` or `neutral`) shown beside `approval`, for example "Changes asked". |
| `VersionRowPlace` | `rowLink(entry, { phone, exact })`, `exactMatch`, `onRowOpen`, `explainAgent`, `note`, `authors` | Each row's link, what happens after a row opens (for example closing the panel on a phone), a hover line for agent authors, a note under a row (outside its link), and `authors: false` to drop the author line for a host with no authors (by default an unnamed author reads "No name recorded"). |
| `VersionActions` | `onCompare`, `onCopyLink`, `actions` | Compare and copy link, with the host's own actions between them. |
| `ReadingLine` | `onToggleVersions`, `approved`, `older: { back, actions, restore }`, `comparing`, `count`, `versionAt`, `start` | The versions toggle, an approval slot, and the controls shown while an older version is on screen. The line reads "v6 · newest", or "v1 of 6 · You are looking at an older version." for an older one; the toggle's accessible name starts with its visible words and goes on as a sentence ("v6 · newest, version 6, the newest", "v1 of 6, version 1 of 6, an older version"). `comparing` (the host's words, for example "Comparing v2 with v6") replaces the version words; `count` shows on the toggle. `versionAt` places the version words and toggle: `"end"` (default) at the right, next to the panel they open, with `approved` on the start side; `"start"` at the left, with `approved` at the right. `start` is a slot at the start of the line (a project name, a decision mark). |
| `PageHeader` | `identity`, `actions`, `actionsClassName` | The identity and actions slots, and extra classes for the actions group. |
| `FrameGround` | `tone`, `colors`, `as` | `plain` or `tinted` ground (unset is tinted in light and plain in dark); `fixed` (default) or `theme` colours for selected, hover and subtle border; `as="div"` for a host that has its own `<main>`: no `<main>`, and the ground fills its container instead of the viewport. |

## Third-party notices

The file marks, the rail tab's document mark and the primitives come from MIT-licensed projects; see `THIRD_PARTY_NOTICES.md`.
