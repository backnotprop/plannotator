---
title: "Introducing Plannotator"
description: "A plan review UI for Claude Code that lets you approve or request changes with annotated feedback."
date: 2025-12-27
author: "backnotprop"
tags: ["announcement", "release"]
---

Plannotator is a plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting you approve or request changes with annotated feedback.

## Watch the Demo

<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube.com/embed/a_AT7cEN_9I" title="Plannotator Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## What is Plannotator?

When Claude Code generates a plan, Plannotator opens an interactive review UI in your browser. You can read through the plan, select text to annotate, and provide structured feedback — deletions, replacements, comments, and insertions — before approving or requesting changes.

## Key Features

- **Plan Review** — Intercepts `ExitPlanMode` and opens a rich annotation UI
- **Code Review** — Run `/plannotator-review` to review uncommitted changes with a diff viewer
- **Annotate** — Run `/plannotator-annotate` to annotate any markdown file
- **Sharing** — Share plans and annotations via URL (no backend required)
- **Obsidian Integration** — Auto-save reviewed plans to your Obsidian vault

## Getting Started

Check out the [installation guide](/docs/getting-started/installation/) to get started with Plannotator in Claude Code or OpenCode.
