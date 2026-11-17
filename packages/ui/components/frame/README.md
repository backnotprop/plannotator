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
| `DocumentRailShell`, `DocumentRail`, `RailSlot`, `ShellTabFlags` | The left rail: resizable by drag or arrow keys, collapsible by click or keyboard, remembered open or closed (or controlled by the host), with a tab to bring it back. Focus follows: collapsing from inside the rail lands on the tab, and the tab lands focus in the rail. While the rail does not fit the row the tab stays, and pressing it opens the rail anyway (narrowing the page), so there is always a way to the files; a host that offers `RailSheet docked={false}` then passes `narrowRail="host"` to `DocumentRailShell`, which hides the tab while the rail does not fit. The tab sits in its own narrow column at the start of the row, so it never covers the page. `RailSlot` keeps its place while the host loads it. |
| `PagesRailHead`, `FilesRailHeading`, `FileRow`, `FolderRow`, `FilesRail*` states | The rail's head, rows and empty, loading, error and no-match states. `fileIcon` picks a mark by kind or extension, with neutral marks for `html`, `mermaid` and `graphviz` (lucide's file-code, workflow and network). |
| `PageCard`, `ReadingLine` | The page card, and the strip above the document that says which version is on screen ("v6 · newest"). |
| `VersionsPanel`, `VersionActions` | The versions list: consecutive saves by one author within 30 minutes fold together, and the fold holding the version on screen opens itself. |
| `DockedPanelClip`, `useRailMotion` | The spring that opens and closes a docked panel (through `motion`). |
| `RailSheet`, `VersionsSheet`, `CommentsSheet` | The phone sheets. A `VersionsPanel` inside `VersionsSheet` fills the sheet's width at every window width. What a host passes into a sheet renders in a portal, outside the host app's subtree, so the host's scoped rules (its icon sizing, for example) do not reach it: style what you pass in. |
| `Card`, `CardRow`, `CardRows`, `CardFaceDocument`, `CardGrid`, `CardGroup`, `CardGroups`, `CardUpdatesPill` | A plan, document or page as a card with a preview, or as a list row, for a home of plans (see Card below). |
| `PanelEdge`, `CollapsibleEdge` | The edge between rail and page, over the package's `ResizeHandle`. With `keyboard` (the rail passes it), arrow keys, Home and End resize. |

The frame brings its own small button, sheet, skeleton and tooltip (in `primitives/`), drawn with the frame tokens. `FrameButton` and `frameCn` are exported for host controls that sit inside the frame; `frameCn` knows the `frame-*` class names, so `text-frame-sm` is kept next to a text colour.

## Styles

In the host's Tailwind v4 entry, after Tailwind and the theme:

```css
@import "tailwindcss";
@import "@plannotator/ui/theme";
@import "@plannotator/ui/frame.css";
```

`frame.css` declares the frame's theme names (`text-frame-sm`, `h-frame-row`, `rounded-frame-pane`, `bg-frame-selected` and the rest), the `frame-dark` and `frame-reduce-transparency` variants, the card layout, and the sheet and tooltip motion. It also points Tailwind at the frame's own files, so no `@source` line is needed for them. A build that imports `frame.css` must not also carry a `@source not` that covers the frame folder: in one Tailwind build the exclusion wins over `frame.css`'s own `@source`, whatever the order and even against a later explicit `@source` for the folder, and the frame's classes are not generated. The editor, review-editor, Shape and surface stylesheets and the precompiled `styles.css` exclude the folder (the Inbox window's stylesheet does not, since that build imports `frame.css`), so a host draws the frame from its own Tailwind entry that imports `frame.css`, not from `styles.css`. It does not change the package themes or a host document inside the frame: it defines only `--frame-*` names (and the `frame-*` theme names above) and rules on the frame's own attributes, and redefines no host token. The frame's own quiet text uses `--frame-muted-fg` (`text-frame-muted-fg`), which follows `--muted-foreground` and is a little brighter inside a dark pane; the host's `--muted-foreground` stays as it is.

### Host tokens it reads

`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--muted`, `--muted-foreground`, `--destructive`, `--destructive-foreground`, `--success`, `--warning`, `--border`, `--ring`, and the `font-sans` / `font-mono` families. Light is the `.light` class on an ancestor (the root, as the themes set it); anything else is dark.

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

## Card

`Card` draws one plan, document or page for a home or a list of plans: a preview well, then the title (up to two lines) and one grey line. `CardRow` draws the same plan as one list row.

```tsx
<CardGrid size="large" label="Now">
  <Card
    kind="document"
    size="large"
    title="Move sessions from signed cookies to Redis"
    href="/plans/redis"
    linkComponent={RouterLink}
    fact="Your move"
    factTone="action"
    unread
    face={<CardFaceDocument title="Move sessions from signed cookies to Redis">{renderedMarkdown}</CardFaceDocument>}
  />
</CardGrid>
```

The contract:

| Prop | Type | What it does |
|---|---|---|
| `kind` | `"document" \| "page" \| "image" \| "data"` | The chrome and the ground: a sheet with one sheet behind, a window with three dots, or a panel. |
| `title`, `href` | `string` | The link's text and target. |
| `linkComponent` | the host's router link | Receives `href`, `className`, `title`, `aria-label` and `children`. Default `<a>`. |
| `fact` | `string` | The grey line, for example "Your move". |
| `factMark` | `ReactNode` | A 14 px mark before `fact`, for example the agent's icon. |
| `factTone` | `"default" \| "action"` | `action` draws `fact` in the accent colour, for a fact that asks the viewer to act. |
| `working` | `boolean` | The mark breathes while the agent works. |
| `time` | `Date \| string` (ISO) | When it last changed. The card formats it ("Nov 15", with the year when not this year), shows it when there is no `fact`, and puts the full date and time in the link's tooltip. |
| `unread`, `pinned` | `boolean` | A small dot before the title; `pinned` keeps `action` shown. Both are spoken. |
| `action` | `ReactNode` | The host's own control, beside the link (see below). |
| `face` (`Card`) | `ReactNode \| { src, fit? }`, optional | What the preview shows. `{ src }` is a lazy `<img>`, fitted inside its panel (`fit: "contain"`, the default) or filling it (`fit: "cover"`). No face draws the designed empty face, a dashed sheet. |
| `size` (`Card`) | `"large" \| "regular"` | The title's size; the width comes from the column. |
| `secondary` (`CardRow`) | `string` | A quieter text after the title, for example the project. |
| `thumb` (`CardRow`) | `ReactNode \| { src, fit? }` | A small picture for the row's thumbnail. |

- **One link.** The whole card or row is one link, named in this order: the title, a row's `secondary`, the grey line, "new" when `unread`, "pinned" when `pinned`. Keyboard focus on the link draws one ring around the card: a 2 px gap in the card colour (`--card`), then a 2 px `--primary` ring. The ring and shadow fade in. Neither a card nor a row draws an outline on focus: frame.css sets `outline: none` on the focused link with selector weight (0,3,0), outside any cascade layer, so a host's global `:focus-visible` or `a:focus-visible` outline does not add a second ring (the host's own action still gets its outline). The unread mark is a small dot before the title, with no number.
- **Sizes are fluid.** `CardGrid({ size, gap? })` lays cards out in columns with a minimum width (`gap` is the space between rows in px: 28 by default for `large`, 44 for `regular`; `CardGroup` puts 24 between its own rows of cards, on its own or inside `CardGroups`; a `gap` you pass to either wins), and each card fills its column: `large` gives three across a 1440 px layout's content column, `regular` four. `CardGroups` holds `CardGroup`s on one shared grid of regular columns, 44 px between rows, so every card lines up whatever its group; groups are placed in order, so what you see follows the reading and Tab order. Under 768 px there is one column. Cards in one row stretch to the tallest, so their bottoms line up.
- **The face.** The card owns the preview well: 4:3, a quiet ground per kind from the theme (`--primary` for a document, `--foreground` for a page, `--warning` for an image, `--success` for data), the face cropped by the well's bottom edge. The sheet, window or panel is drawn at the card's size; the face inside it is laid out on a page `CARD_FACE_WIDTH` (420) px wide, whatever its kind, and scaled to fit it; size a face for that width. The face is `inert` and `aria-hidden`, so nothing in it can be reached or read on its own. It mounts 240 px before the card scrolls into view, measured in the nearest scrolling ancestor (else the window), and is let go again once the card is far off screen; the well keeps its size, so nothing shifts.
- **The host draws a face only from what the viewer may read.** The card shows whatever it is given.
- **The card renders no content itself.** It never renders Markdown, HTML, Mermaid or Graphviz from a plan; a face is whatever the caller passes, so a caller that draws diagrams gates that rendering itself.
- **Kinds.** A `document` always has exactly one sheet behind it, slightly turned; a `page` is a flat window with three dots; an `image` sits on a panel; `data` shows its first rows. No other kind has a sheet behind.
- **`CardFaceDocument`** gives rendered Markdown the sheet's type: 34/36 px padding, body 15/24 at 82% of the foreground, headings the body's size at weight 600 with 18 px above, lists 15/24 with muted markers, tables on hairlines. When the first heading is the title (the same text, ignoring case and spacing), the face starts at the first paragraph instead; it never opens on a bare list, so a heading that a list follows directly stays. A heading that only starts like the title ("Context" for "Context window cleanup") stays.
- **`CardRow`**: a 36×27 thumbnail, the unread dot, the title on one line at regular weight (cards keep medium), the optional `secondary` (hidden on a phone) and the grey line, which ends 10 px from the row's right edge; on a phone the grey line takes at most half the row and a longer fact is cut short. The title is what a row must show: it keeps at least 40% of the row (112 px at the least). In a wide list nothing changes: the project takes 160 px and the grey line 180 px. A project is shown whole or not at all: a `CardRows` narrower than 713 px (the list's own width, so a side panel or a split view counts), where a 160 px project and the title at 40% no longer fit, does not show it. The 713 px assumes each row fills the list's width with only its own 16 px of padding; a host that pads the rows inside the list makes them narrower than the list, so a project starts to shrink before the list hides it. The grey line keeps 180 px in every row, so the columns stay aligned down the list, and gives way only when the title would fall under its minimum; on a phone the phone layout applies instead. A hidden project stays in the row's accessible name, but no tooltip shows it; a host that needs it visible in a narrow list shows it elsewhere, for example on the page the row opens. A row outside a `CardRows` has no list width to go by: it keeps the 40%, and its project shrinks first, down to 20 px (a cut-short name, then only its clearance), then its grey line. It is 44 px tall, 52 on a phone, with no border or outline. Hover fills it lightly, only on a screen with hover, so a tap leaves no fill behind (the same holds for a card's hover ring and lift and the updates pill). Keyboard focus on its link fills it more, with `--primary` at 16%, and underlines its title; the title keeps its colour. The fill is about 1.3:1 against a resting row with the default theme, so the underline is the signal that does not rely on colour. A row draws no edge, outline or border in any state. The thumbnail is the card's well in small: a document's sheet runs off its bottom edge, a page's window (a thin bar, no dots) and a data panel too, and an image's panel sits inside it. It holds `thumb` when given and otherwise a small glyph of the kind (a page: a block and two lines under the bar); it never draws a face scaled down. `empty` (a plan with no version yet) draws the card's empty face in small instead: the kind's dashed outline with three grey bars, on the neutral ground, as a `Card` with no `face` does.
- **`CardRows`** (`label`, `actionAtRest`, `ref`, and any other list prop such as `className`, `id`, `style` or `data-*`, passed to its `ul`) lists rows. The list is a size container (`container: frame-card-rows / inline-size`), so it takes its width from where it is placed, not from its rows: give it a width in a shrink-to-fit parent such as an inline flex item. Nothing in a row moves when a row is pinned, unpinned or hovered: no row ever keeps a column for its action, and every row's fact or date ends 10 px from its edge. `actionAtRest` decides what a screen without hover shows at rest. `"touch"` (the default; also what a row outside a `CardRows` does) shows each row's action, so a touch user can always reach it; pick it unless you give touch users another way to the action. `"never"` shows no action at rest, for a host that has another path such as a long-press menu; the action still appears on keyboard focus, and pinned rows keep the card's pin. With hover, both behave the same.
- **`action`** is the host's own control, for example a pin button, laid out for a 28 px wide control: top right of the card's preview; in a row, just before the grey line, over the room it leaves, so the fact or date stays in view. In any row that has an action, the text before it (the title, or the project when there is one) always keeps 20 px clear at its end, with hover or without, so the action covers no text even when a long fact fills its column. A control wider than 28 px covers that much more of it. The clearance never changes, so nothing moves when the action appears. The action sits beside the link, never inside it, and comes after it in tab order. With hover it shows on hover and on keyboard focus (`:focus-visible`, so a mouse click does not keep it showing); on a card it also shows while `pinned`. Without hover, a card always shows it, and a row follows its `CardRows`' `actionAtRest`. Focus on it draws no card ring and does not fan the sheet. On a pinned row the card draws the resting mark, a plain pin after the title, and never draws it while the row's action shows, so a row shows one pin at a time. The host owns the control, its look and what its click does; the card does not style the button, so a hover fill on it is the host's own (in Tailwind v4, `hover:` already applies only on screens with hover).
- **`CardUpdatesPill`** (`count`, `onShow`) is a quiet 20 px pill, so a heading row of 20 px (13/20 type) keeps its height with the pill in it; its hit area reaches 24 px without taking room. It reads "1 update · Show" or "3 updates · Show" for news the viewer has not taken in yet, so the cards do not jump under the pointer. The count is announced politely when it changes; with no updates it draws nothing.
- **Motion** is in `card/motions.css` (imported by `frame.css`), named in `CARD_MOTIONS`, each timing a `--frame-card-*` custom property at the top of that file. `arrive`: wrap the line or row that just landed in a face in `CardArrival`, or call `arrive(element)` on it; it opens in place to its own height and is tinted for a moment, and the card around it never moves. `breathe`: the agent mark while `working`, in phase across cards, the only loop. `settle`: `settle` brings a new card to rest once and shows its dot; `settleBatch(container, mutate)` animates the container's direct children, so pass each grid's list (a `CardGrid`'s `ref`): it measures them, runs the host's `mutate` once (it must leave the new order in the DOM; in React use `flushSync`) and slides each from its old place, new ones from just above. The card never re-sorts itself. `fan`: hover or focus on the link turns the sheet behind a document a little further (240 ms) and lifts the front. `open`: `transitionName` sets the preview's `view-transition-name` (with the `frame-card-open` view-transition class); give the page it opens the same name and class. Idle, nothing moves but `breathe`; under reduced motion nothing moves, `settleBatch` only runs `mutate`, and `open` is a plain cut. `arrive` and `settleBatch` take `null` or `undefined`: `arrive` then does nothing and `settleBatch` only runs `mutate`.
- A face renders inside the card, not in a portal, but it is scaled: give it fixed pixel sizes at its page width rather than sizes that depend on the viewport.

See `test-consumer/frame-card-example.tsx` for a whole home.

## Props for host behaviours

| Where | Prop | What the host decides |
|---|---|---|
| `Breadcrumbs` | `collectionLink`, `root: { label, link }`, `path` | The links (any element: a router link or an `<a>`), cloned with the frame's classes. `collectionName: null` shows a skeleton. Leave `path` out on the collection's own page: no file crumb, and the collection is the current page. |
| `PagesRailHead` | `backLink`, `label`, `meta` | The back link; `label: null` shows a skeleton. `meta` is a quiet second line under it, aligned with the label (a glyph and words; give long ones a `title`). |
| `FileRow` | `link`, `onOpen`, `renderActions`, `presence`, `trailing`, `dragProps`, `moving`, `error`, `busy`, `openCommentCount` | The row link and what else happens on open (after the link's own `onClick`), a wrapper for a row menu, a presence slot, a mark at the row's right end (for example "Main"), drag handlers, and the row's states. |
| `FolderRow` | `onToggle`, `onSelect`, `dropProps`, `hot`, `presence` | Folder open and select, and drop handling. |
| `FilesRailHeading` | `label`, `countTitle`, `onToggleFilter`, `filterVisible`, `actions`, `menu` | The heading's words, the count's hover text, the filter toggle (no Filter button without `onToggleFilter`, for a second heading such as "Artifacts") and the heading's buttons (style them with `RAIL_ICON_BUTTON`). |
| `DocumentRailShell` | `open`, `onOpenChange`, `storage`, `storageKeys`, `defaults`, `fitsForWidth`, `onFitChange`, `narrowRail`, `onFlagsChange`, `enabled`, `onDragOver`, `onDrop` | Open and close the rail from outside (`open` makes it controlled and nothing is stored; `onOpenChange` hears every request either way). Where the open flag is kept (default: the package's storage helper, so `configurePlannotatorUI({ storageBackend })` applies), the keys for the open flag and the width, whether the rail fits (and `onFitChange` reports it), and drops onto the rail. The width is saved by `useResizablePanel`, which always uses the package's storage helper. |
| `RailSlot`, `ReservedRailColumn` | `status`, `storage`, `storageKeys` | Loading state, and the same storage as the rail so the reserved column matches it. |
| `RailSheet` | `closeKey`, `docked`, `triggerLabel`, `triggerTitle`, `title`, `description` | The sheet closes when `closeKey` changes (pass the location). It shows below 768px, and at any width with `docked={false}`: pass `DocumentRailShell`'s `onFitChange` result so a rail that does not fit the row is replaced by the sheet, and pass `narrowRail="host"` to `DocumentRailShell` so its tab does not show beside the sheet's button. The words. |
| `VersionsPanel` | `status`, `entries`, `place`, `onRetry`, `hasMore`, `loadingMore`, `onLoadMore`, `onScreenActions`, `onClose`, `footer`, `comparing` | `comparing: { from, to }` (two entry `key`s) marks both rows during a compare and opens a fold holding either; unset, only the row on screen is marked. A compared row that is not on screen says "compared" in its accessible name. The data, loading more, the actions under the version on screen, and a footer slot under the list. Each entry may carry a `decision: { label, tone }` (`positive`, `negative` or `neutral`) shown beside `approval`, for example "Changes asked". |
| `VersionRowPlace` | `rowLink(entry, { phone, exact })`, `exactMatch`, `onRowOpen`, `explainAgent`, `note`, `authors` | Each row's link, what happens after a row opens (for example closing the panel on a phone), a hover line for agent authors, a note under a row (outside its link), and `authors: false` to drop the author line for a host with no authors (by default an unnamed author reads "No name recorded"). Per entry, author `{ kind: "none" }` draws no author line and leaves the author out of the row's name; `unnamed` and `pending` stay as they are. |
| `VersionActions` | `onCompare`, `onCopyLink`, `actions` | Compare and copy link, with the host's own actions between them. |
| `ReadingLine` | `onToggleVersions`, `approved`, `older: { back, actions, restore }`, `comparing`, `count`, `versionAt`, `start` | The versions toggle, an approval slot, and the controls shown while an older version is on screen. The line reads "v6 · newest", or "v1 of 6 · You are looking at an older version." for an older one; the toggle's accessible name starts with its visible words and goes on as a sentence ending with what it opens ("v6 · newest, version 6, the newest. Versions"; with a count, "… 6 versions"). An older version with no number shows "Versions · You are looking at an older version." `comparing` (the host's words, for example "Comparing v2 with v6") replaces the version words; `count` shows on the toggle. `versionAt` places the version words and toggle: `"end"` (default) at the right, next to the panel they open, with `approved` on the start side; `"start"` at the left, with `approved` at the right. `start` is a slot at the start of the line (a project name, a decision mark). |
| `PageHeader` | `identity`, `actions`, `actionsClassName` | The identity and actions slots, and extra classes for the actions group. |
| `FrameGround` | `tone`, `colors`, `as` | `plain` or `tinted` ground (unset is tinted in light and plain in dark); `fixed` (default) or `theme` colours for selected, hover and subtle border; `as="div"` for a host that has its own `<main>`: no `<main>`, and the ground fills its container instead of the viewport. |

## Third-party notices

The file marks, the rail tab's document mark and the primitives come from MIT-licensed projects; see `THIRD_PARTY_NOTICES.md`.
