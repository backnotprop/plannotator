/**
 * Plannotator Plugin for Obsidian
 *
 * This is a stub entry point. The actual Obsidian API integration
 * will be implemented during the final integration phase.
 *
 * @see https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin
 */

import { Plugin } from 'obsidian';
import { PlannotatorView, VIEW_TYPE_PLANNOTATOR } from './src/view';

export default class PlannotatorPlugin extends Plugin {
  async onload() {
    console.log('Loading Plannotator plugin');

    // Register the custom view
    this.registerView(VIEW_TYPE_PLANNOTATOR, (leaf) => new PlannotatorView(leaf));

    // Add ribbon icon
    this.addRibbonIcon('file-text', 'Open Plannotator', () => {
      this.activateView();
    });

    // Add command to open Plannotator
    this.addCommand({
      id: 'open-plannotator',
      name: 'Open Plannotator',
      callback: () => {
        this.activateView();
      },
    });

    // TODO: Add command to open current file in Plannotator
    // TODO: Add context menu for markdown files
    // TODO: Hook into Claude Code/AI agent events if available
  }

  onunload() {
    console.log('Unloading Plannotator plugin');
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PLANNOTATOR)[0];

    if (!leaf) {
      // Create a new leaf in the right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_PLANNOTATOR,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}
