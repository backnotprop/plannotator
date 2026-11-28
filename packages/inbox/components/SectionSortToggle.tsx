import { useLayoutEffect, useRef } from 'react';
import { Icon, type IconName } from '../icons';
import { Tip } from './Tip';

/**
 * The order of a sidebar section (Projects, Tags), one quiet icon beside the
 * header's chevron: the icon is the order on screen, a press goes to the next.
 * It shows on the header's hover and keyboard focus; where nothing hovers (a
 * phone, a tablet) it always shows. The section draws it only with two rows or
 * more, and only while it is open. Not navigation: the phone sheet stays open.
 * Going while it holds focus (the list fell to one row), it hands focus to the
 * header, never the page.
 */
export function SectionSortToggle({ control, onPress, announce, className, data }: {
  /** The order on screen (`projectSortControl`, `tagSortControl`). */
  control: { icon: IconName; label: string; said: string };
  onPress: () => void;
  announce?: (text: string) => void;
  className?: string;
  /** The button's data attributes (`data-projects-sort`, `data-tags-sort`). */
  data: Record<`data-${string}`, string>;
}) {
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = button.current;
    return () => {
      if (node && node === document.activeElement) node.closest('.ib-secrow')?.querySelector<HTMLElement>('[data-sidebar-section]')?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <Tip content={control.label}>
      <button
        ref={button}
        type="button"
        className={className ? `ib-proj-sort ${className}` : 'ib-proj-sort'}
        aria-label={control.label}
        {...data}
        onClick={() => {
          onPress();
          announce?.(control.said);
        }}
      >
        <Icon name={control.icon} />
      </button>
    </Tip>
  );
}
