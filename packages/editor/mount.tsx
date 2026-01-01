/**
 * Embeddable mount function for Plannotator
 *
 * Mounts the Plannotator React app to an arbitrary container element.
 * Returns a cleanup function to properly unmount and clean up resources.
 *
 * @example
 * ```typescript
 * import { mount } from '@plannotator/editor/mount';
 *
 * const container = document.getElementById('my-container');
 * const cleanup = mount(container, {
 *   plan: '# My Plan\n\nContent here...',
 *   theme: 'dark',
 *   onApprove: () => console.log('Approved!'),
 *   onDeny: (feedback) => console.log('Denied:', feedback),
 * });
 *
 * // Later, to unmount:
 * cleanup();
 * ```
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { EmbeddableApp, type EmbeddableAppProps } from './EmbeddableApp';

export interface MountOptions {
  /**
   * Initial markdown plan content to display.
   * If not provided, uses demo content.
   */
  plan?: string;

  /**
   * Theme preference. Defaults to 'dark'.
   */
  theme?: 'dark' | 'light' | 'system';

  /**
   * Called when user approves the plan.
   */
  onApprove?: () => void;

  /**
   * Called when user denies/requests changes to the plan.
   * @param feedback - The formatted diff/feedback from annotations
   */
  onDeny?: (feedback: string) => void;

  /**
   * Base URL for API calls. If not provided, uses relative URLs.
   * Set to null to disable API mode entirely.
   */
  apiBaseUrl?: string | null;

  /**
   * Whether to show the update banner. Defaults to false for embedded use.
   */
  showUpdateBanner?: boolean;

  /**
   * Custom class name to add to the root element for CSS scoping.
   */
  className?: string;
}

export interface MountResult {
  /**
   * Unmount the app and clean up resources.
   */
  unmount: () => void;

  /**
   * Update the plan content programmatically.
   */
  setPlan: (plan: string) => void;

  /**
   * Get the current annotations as formatted feedback.
   */
  getFeedback: () => string;
}

// Store for programmatic control
let currentController: {
  setPlan: (plan: string) => void;
  getFeedback: () => string;
} | null = null;

export function mount(
  container: HTMLElement,
  options: MountOptions = {}
): MountResult {
  const {
    plan,
    theme = 'dark',
    onApprove,
    onDeny,
    apiBaseUrl,
    showUpdateBanner = false,
    className,
  } = options;

  // Create a wrapper div for CSS scoping
  const wrapper = document.createElement('div');
  wrapper.className = `plannotator-root ${className || ''}`.trim();
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  container.appendChild(wrapper);

  // Create React root
  const root = ReactDOM.createRoot(wrapper);

  // Controller for external access
  const controller = {
    setPlan: (_plan: string) => {
      // This will be overridden by EmbeddableApp
    },
    getFeedback: () => '',
  };

  const appProps: EmbeddableAppProps = {
    initialPlan: plan,
    initialTheme: theme,
    onApprove,
    onDeny,
    apiBaseUrl,
    showUpdateBanner,
    containerRef: wrapper,
    onControllerReady: (ctrl) => {
      controller.setPlan = ctrl.setPlan;
      controller.getFeedback = ctrl.getFeedback;
    },
  };

  root.render(
    <React.StrictMode>
      <EmbeddableApp {...appProps} />
    </React.StrictMode>
  );

  currentController = controller;

  return {
    unmount: () => {
      root.unmount();
      wrapper.remove();
      currentController = null;
    },
    setPlan: (newPlan: string) => controller.setPlan(newPlan),
    getFeedback: () => controller.getFeedback(),
  };
}

export default mount;
