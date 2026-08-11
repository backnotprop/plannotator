/// <reference path="../../ui/globals.d.ts" />
/**
 * Demo media for the Edit Mode announcement dialog.
 *
 * The recording is a short screen capture (VP9 webm, ~563KB, 1100x700, 18.8s)
 * of an edit session becoming a suggestion; the poster is a matching still so
 * the panel has a frame before playback starts. The review app builds to a
 * single-file HTML bundle (vite-plugin-singlefile with `assetsInlineLimit`
 * raised far above these sizes in `apps/review/vite.config.ts`), so both
 * static imports are inlined as base64 data URIs at build time. No runtime
 * fetch, no external host.
 *
 * Setting EDIT_MODE_DEMO_VIDEO_SRC to null falls back to the dialog's static
 * placeholder panel (kept as a test seam and safety net).
 */
import demoVideo from '../assets/edit-mode-demo.webm';
import demoPoster from '../assets/edit-mode-demo-poster.png';

export const EDIT_MODE_DEMO_VIDEO_SRC: string | null = demoVideo;
export const EDIT_MODE_DEMO_POSTER_SRC: string = demoPoster;
