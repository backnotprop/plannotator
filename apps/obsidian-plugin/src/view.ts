/**
 * Plannotator View for Obsidian
 *
 * This is a stub implementation. The actual React mounting
 * will be implemented during the final integration phase.
 *
 * @see https://docs.obsidian.md/Plugins/User+interface/Views
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
// Uncomment when ready to integrate:
// import { mount, type MountResult } from '@plannotator/editor/mount';

export const VIEW_TYPE_PLANNOTATOR = 'plannotator-view';

export class PlannotatorView extends ItemView {
  private container: HTMLElement | null = null;
  // private mountResult: MountResult | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PLANNOTATOR;
  }

  getDisplayText(): string {
    return 'Plannotator';
  }

  getIcon(): string {
    return 'file-text';
  }

  async onOpen(): Promise<void> {
    const contentEl = this.contentEl;
    contentEl.empty();
    contentEl.addClass('plannotator-container');

    // Create container for React app
    this.container = contentEl.createDiv({ cls: 'plannotator-mount' });
    this.container.style.width = '100%';
    this.container.style.height = '100%';

    // TODO: Mount the React app
    // this.mountResult = mount(this.container, {
    //   plan: '# Plan\n\nYour plan content here...',
    //   theme: 'dark', // or detect from Obsidian theme
    //   onApprove: () => {
    //     console.log('Plan approved');
    //   },
    //   onDeny: (feedback) => {
    //     console.log('Plan denied with feedback:', feedback);
    //   },
    //   apiBaseUrl: null, // Disable API mode
    //   showUpdateBanner: false,
    // });

    // Placeholder content until React is mounted
    this.container.innerHTML = `
      <div style="padding: 20px; text-align: center; color: var(--text-muted);">
        <h3>Plannotator</h3>
        <p>React app will be mounted here.</p>
        <p style="font-size: 12px;">See src/view.ts for integration instructions.</p>
      </div>
    `;
  }

  async onClose(): Promise<void> {
    // Cleanup React app
    // if (this.mountResult) {
    //   this.mountResult.unmount();
    //   this.mountResult = null;
    // }
    this.container = null;
  }

  /**
   * Load a plan into the view.
   * @param plan - Markdown content to display
   */
  public loadPlan(plan: string): void {
    // TODO: Call this.mountResult.setPlan(plan) when React is mounted
    console.log('Loading plan:', plan.substring(0, 100) + '...');
  }

  /**
   * Get the current feedback/annotations.
   * @returns Formatted diff output
   */
  public getFeedback(): string {
    // TODO: Return this.mountResult.getFeedback() when React is mounted
    return '';
  }
}
