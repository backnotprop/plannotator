---
id: TASK-E10
trackerStatus:
  type: task
title: UI actions (plan editor, code review, annotate, image upload)
description: 'Semantic deps: None.'
successCriteria:
- E2E coverage proves plan-editor rendering, annotation toolbar behavior, sidebar/version browser behavior, settings persistence, and absence of deleted share UI.
- 'Review UI coverage proves file-tree navigation, expandable diff context, code annotations inside `<pre>` blocks, and stage/unstage actions.'
- Annotate UI and image-upload behavior are both proven through the real upload/export path used by the app.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-3]]'
- '[[TASK-S-5]]'
- '[[TASK-S-7]]'
- '[[TASK-E00]]'
---


## 10.1 Plan editor
1. Renders heading, paragraphs, lists, code blocks, blockquotes, hr
2. Code block syntax highlighting (verify `language-rust` style classes)
3. Selecting text shows annotation toolbar
4. Each toolbar action (Delete, Insert, Replace, Comment) creates right annotation in DOM and in `GET /api/draft`
5. Sidebar: TOC tab lists every heading; Version Browser lists prior versions
6. Settings panel: identity, plan saving, agent switching persist across `page.reload()` (cookies)
7. **No "Share" or "Copy link" button is visible** — if present, that's a P1 finding

## 10.2 Code review UI
1. File tree lists every changed file
2. Clicking a file scrolls diff viewer to that file
3. Expandable context loads more via `/api/file-content`
4. Code annotations attach correctly inside `<pre>` blocks (manual `<mark>` path)
5. Stage/unstage button calls `/api/git-add`

## 10.3 Annotate UI
Same as 10.1 §1–4 on a static markdown file.

## 10.4 Image upload
1. Drag-drop or paste an image
2. Verify `POST /api/upload` called
3. Image renders in annotation
4. Feedback export includes `[image-name] /tmp/path...`

## Activity Log

- 2026-05-02T04:05:10.708Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
