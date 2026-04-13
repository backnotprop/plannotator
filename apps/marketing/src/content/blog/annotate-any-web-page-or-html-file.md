---
title: "Annotate Any Web Page or HTML File"
description: "Plannotator's /plannotator-annotate command now accepts URLs and HTML files, not just markdown. Fetch any web page, convert it to markdown, and annotate it with structured feedback for your coding agent."
date: 2026-04-12
author: "backnotprop"
tags: ["annotate", "url", "html", "jina-reader"]
---

**Plannotator is an open-source review UI for AI coding agents.** The `/plannotator-annotate` command now accepts URLs and HTML files alongside markdown, so you can pull in any external documentation, convert it on the fly, and send structured annotations back to your agent session.

<video width="100%" style="aspect-ratio: 16/9; border-radius: 8px; margin-bottom: 1.5rem;" autoplay loop muted playsinline controls><source src="https://d17ygohy796f9l.cloudfront.net/videos/annotate-url.mp4" type="video/mp4" /></video>

## The problem

You're working with an agent that needs to implement against an external API or follow a specific guide. You could copy-paste the documentation into chat, but you lose structure. You could describe what you need freeform, but that's imprecise. What you actually want is to open the page, highlight the relevant sections, and send that annotated content directly to the agent.

This was a [community-requested feature](https://github.com/backnotprop/plannotator/issues) that ships in [PR #545](https://github.com/backnotprop/plannotator/pull/545).

## What you can do now

```bash
plannotator annotate https://docs.stripe.com/api      # remote URL
plannotator annotate docs/guide.html                  # local HTML file
plannotator annotate ./docs/                          # folder (now includes .html files)
plannotator annotate https://... --no-jina            # direct fetch, no Jina
```

All inputs are converted to markdown before reaching the annotation editor. You annotate, highlight, comment, and when you click Send Annotations, structured feedback goes back to the agent session.

Local HTML files are read from disk and converted via Turndown. Folders now show `.html` and `.htm` files alongside markdown in the file browser, with conversion happening on demand. A source attribution badge appears under the document title so you know what you're looking at.

## How URL fetching works

By default, URLs are fetched through [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`). Jina handles JavaScript-rendered pages, strips navigation and boilerplate, and returns clean markdown. Most documentation sites work well with it.

If the URL ends in `.md` or `.mdx`, Plannotator fetches it raw and skips conversion entirely.

For cases where you want to skip Jina, use `--no-jina`. Plannotator will fetch the page directly and run Turndown locally.

## Configuration

Three ways to configure Jina behavior:

- **CLI flag**: `plannotator annotate https://... --no-jina`
- **Environment variable**: `PLANNOTATOR_JINA=0`
- **Config file**: `~/.plannotator/config.json` with `{ "jina": false }`

For higher rate limits (500 RPM instead of 20 RPM), set a `JINA_API_KEY`. Free keys are available from Jina and include 10M tokens.

## Try it

Install or update Plannotator:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then run the annotate command with any URL or HTML file. Annotate the relevant sections and send the feedback to your agent. Full docs at [plannotator.ai/docs](/docs/getting-started/installation/).
