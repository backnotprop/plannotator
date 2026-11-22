import { ROW_ICONS } from './treeRows';

const TREE_ROW_HEIGHT = 28;
const TOUCH_ROW_HEIGHT = 44;

const unsafeCSS = `
  [data-item-git-status="modified"], [data-item-git-status="renamed"], [data-item-git-status="untracked"] {
    & > [data-item-section="content"] {
      color: inherit;
    }
  }
  [data-item-section="git"] {
    font-size: 11px;
  }
  [data-item-section="content"] {
    margin-inline-end: auto;
  }
  [data-item-section="trail"] {
    padding-inline: 4px;
    font-size: 11px;
    color: var(--trees-fg-muted);
  }
  [data-type="item"][data-item-type="folder"] > [data-item-section="trail"] {
    opacity: 0.7;
  }
  :host([data-tree-grouping]:not([data-tree-grouping="none"])) {
    --review-group-icon-gap: 5px;

    & [data-item-tone="heading"] {
      --trees-icon-nudge: 0px;
    }

    & :is([data-item-tone="heading"], [data-item-parent-path]) {
      padding-inline-start: calc(var(--trees-item-padding-x) / 2);
    }
    & [data-item-section="spacing-item"]:first-child {
      margin-right: calc(var(--trees-level-gap) - 1px + var(--review-group-icon-gap));
    }
  }
  [data-item-tone="heading"] {
    & > [data-item-section="content"] {
      font-weight: 600;
    }
    & > [data-item-section="lead"] {
      color: var(--trees-fg-muted);
      width: var(--trees-icon-width);
      margin-inline-start: calc(var(--review-group-icon-gap, 0px) - var(--trees-item-row-gap));
      justify-content: center;
      & > span {
        display: grid;
        place-items: center;
      }
    }
    & > [data-item-section="trail"] {
      opacity: 1;
    }
    & > [data-item-section="git"] {
      visibility: hidden;
    }
  }
  [data-item-muted="true"] > :is([data-item-section="content"], [data-item-section="icon"], [data-item-section="trail"], [data-item-section="git"]) {
    opacity: 0.5;
  }
  [data-item-tone="loading"] > [data-item-section="content"] {
    color: var(--trees-fg-muted);
    font-size: 12px;
  }
  [data-file-tree-search-container] {
    margin-bottom: 4px;
  }
  :host([data-review-tree-filter]) {
    & [data-file-tree-virtualized-root] {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto minmax(0, 1fr);
      column-gap: 4px;
    }
    & [data-type="header-slot"],
    & [data-type="header-slot"]::slotted(div) {
      display: contents;
    }
    & [data-file-tree-search-container] {
      grid-area: 1 / 1;
      margin-bottom: 0;
    }
    & [data-file-tree-virtualized-scroll] {
      grid-area: 3 / 1 / 4 / -1;
      min-height: 0;
      margin-top: 6px;
    }
  }
  [data-file-tree-search-input] {
    min-width: 0;
    box-sizing: border-box;
    height: ${TREE_ROW_HEIGHT}px;
    margin-block: 0;
    padding-inline: 7px;
    font-size: 13px;
    line-height: ${TREE_ROW_HEIGHT - 2}px;
    border-color: transparent;
    &::placeholder {
      color: color-mix(in oklab, var(--muted-foreground) 50%, transparent);
    }
    &:focus-visible, &[data-file-tree-search-input-fake-focus="true"] {
      outline: 1px solid color-mix(in oklab, var(--primary) 50%, transparent);
      outline-offset: 0;
    }
  }
  @media (pointer: coarse) {
    [data-file-tree-search-input] {
      height: ${TOUCH_ROW_HEIGHT}px;
      font-size: 16px;
      line-height: ${TOUCH_ROW_HEIGHT - 2}px;
    }
  }
`;

export function treeLook(touch: boolean) {
  return {
    itemHeight: touch ? TOUCH_ROW_HEIGHT : TREE_ROW_HEIGHT,
    icons: { set: 'complete' as const, colored: true, spriteSheet: ROW_ICONS },
    unsafeCSS,
    search: true,
    composition: { contextMenu: { triggerMode: 'right-click' as const } },
  };
}
