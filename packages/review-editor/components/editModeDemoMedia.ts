/// <reference path="../../ui/globals.d.ts" />
/**
 * Demo media for the Edit Mode announcement dialog.
 *
 * The recording is a short screen capture (VP9 webm, ~563KB, 1100x700, 18.8s)
 * of an edit session becoming a suggestion; the poster is a matching still so
 * the panel has a frame before playback starts. The review app packs both
 * static imports into its single-file bundle (`build/pack-app.ts`), and the
 * local server serves them only when the dialog shows. No external host.
 *
 * Setting EDIT_MODE_DEMO_VIDEO_SRC to null falls back to the dialog's static
 * placeholder panel (kept as a test seam and safety net).
 */
import demoVideo from '../assets/edit-mode-demo.webm';
import demoPoster from '../assets/edit-mode-demo-poster.png';

export const EDIT_MODE_DEMO_VIDEO_SRC: string | null = demoVideo;
export const EDIT_MODE_DEMO_POSTER_SRC: string = demoPoster;
