import React, { useEffect, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';

/** Custom tab renderer with an explicit close button. */
export const ReviewDockTabRenderer: React.FC<IDockviewPanelHeaderProps> = (props) => {
  const [title, setTitle] = useState(props.api.title ?? props.api.id);

  useEffect(() => {
    const titleDisposable = props.api.onDidTitleChange(() => {
      setTitle(props.api.title ?? props.api.id);
    });
    return () => titleDisposable.dispose();
  }, [props.api]);

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    props.api.close();
  };

  return (
    <div
      className="dv-review-tab"
      title={title}
    >
      <span
        className="dv-review-tab-label"
      >
        {title}
      </span>
      <button
        className="dv-review-tab-close"
        onClick={handleClose}
        aria-label="Close"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
        </svg>
      </button>
    </div>
  );
};
