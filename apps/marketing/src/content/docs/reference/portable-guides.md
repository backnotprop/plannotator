---
title: "Portable guides"
description: "The portable Guided Review file: what is in it, how it renders from guides.show, share links, and the snapshot format agents and tools can produce."
sidebar:
  order: 34
section: "Reference"
---

A portable guide is **one HTML file** that renders a Guided Review — chapters, per-file summaries, and the exact diff — anywhere: from disk, from an email attachment, from any web host. It contains the guide and the diff; the rendering code is loaded from `guides.show` and pinned to a specific build, so a file exported today keeps opening as-is.

## What is in the file

- The **guide**: title, intent, ordered sections with overviews and per-file summaries, unplaced files, and the reviewed checkboxes at export time.
- The **review**: the exact unified diff the guide was generated against (captured when the guide was generated, not when it was exported), its label, diff type, and base.
- The **source**: what the change is — local changes, a pull/merge request (with a link), a single commit, or a multi-repository workspace — plus repo, branch, and head SHA when known.
- **Provenance**: which agent and model generated the guide, when, and any custom instructions used.
- A **plain-text fallback**: the guide's text and file lists render even when `guides.show` is unreachable.

The file's size is roughly the size of the diff. There is no cap: a huge diff makes a large file, and that is your call.

## Producing one

- In Plannotator: open a guide and click **Download portable guide** (top right).
- From the terminal: `plannotator guide list`, then `plannotator guide export --id <id> [--out file.html]`.
- From an agent, without the Plannotator app: the `plannotator-guide` skill (`npx skills add plannotator/guides`) has the agent read a diff, write `guide.json` — `{ title, intent, sections: [{ title, overview, diffs: [{ file, summary }] }] }` plus optional `review { gitRef, base }`, `source`, `generator` — and run `plannotator guide export --guide guide.json --patch guide.patch` (`--patch -` reads stdin). The CLI checks every file the guide names is in the patch (and named once), fills in repo/branch/head from git, and writes the HTML; validation failures exit 1 with the fix spelled out.
- From anything else: write a complete snapshot document (below) and run `plannotator guide export --snapshot snapshot.json`.

`PLANNOTATOR_GUIDE_VIEWER_URL` (or `--viewer-url`) points exports at a self-hosted or local viewer build; it must be `https:` (or `http://localhost`).

## Share links

A share link is the same guide and diff, uploaded once to a guide host and opened as a web page instead of a downloaded file: `https://guides.show/g/<id>`. The id is 22 random characters, so the link is unlisted; anyone who has it can open the guide. Links have no expiry unless you set one.

Two ways to store the guide on the host:

- **Encrypted (default).** The guide is compressed and encrypted before upload, and the key is appended to the link after `#` (`#key=...`). Browsers never send the fragment to the server, so the host only ever holds ciphertext it cannot read; the page it serves is a small shell that fetches the ciphertext and decrypts it in your browser. Send the whole link, including the part after `#`: without it the page says the link is missing its key. Chat apps cannot show a preview of an encrypted guide.
- **Public.** With `--public` (CLI) or **Allow link previews** (dialog) the guide is stored unencrypted, so the page carries the guide's title and `og:` tags and chat apps can unfurl it. Use it when a preview matters more than keeping the code off the host.

Every share returns a **delete token**, shown exactly once. It is the only thing that removes the guide from the host: `plannotator guide unshare <id> --token <token>`. Plannotator also records the link and token on the saved guide, so a guide shared from the app (or with `--id`) offers **Remove link** in the same dialog later, and a guide keeps at most one link at a time (remove it before creating another). A guide shared without a saved copy (guide history off, or `--guide`/`--snapshot`) can only be removed with the token, so keep it.

Producing a link:

- In Plannotator: open a guide, then **Create share link** in the Share menu (top right). The dialog shows what will be uploaded and its size, the encrypted default with the preview checkbox, and after Create the URL and the delete token, each with Copy. Nothing is uploaded until you click Create.
- From the terminal: `plannotator guide share --id <id>`, `--guide guide.json --patch guide.patch`, or `--snapshot snapshot.json`, with `--public`, `--ttl <7d | 24h | 30m | 3600>` (remove the link automatically after this long), and `--json` (`{ id, url, deleteToken, expiresAt? }`). The URL prints on stdout; the size and the exact `unshare` command print on stderr.

Hosted pages carry a **Download** button that builds the portable HTML file in your browser, so anyone with the link can keep a copy that works offline. Downloaded files never contain the hosted page's metadata.

The hosted service is guides.show, and it holds guides at most 25 MiB in size. You can run the same service yourself: `apps/guides-show` in the Plannotator repository ships the Cloudflare Worker with the same routes (`POST /api/g`, `GET /g/<id>`, `GET /api/g/<id>`, `DELETE /api/g/<id>`) backed by two R2 buckets. Point Plannotator at it with `PLANNOTATOR_GUIDE_SHARE_URL=https://guides.example.com` (or `"guideShareUrl"` in `~/.plannotator/config.json`) and, for downloaded files, `PLANNOTATOR_GUIDE_VIEWER_URL=https://guides.example.com/v1/`. `PLANNOTATOR_SHARE=disabled` turns share links off entirely: the menu item disappears and the CLI refuses. The full recipe is in the `apps/guides-show` README under "Self-hosting".

## Snapshot format (v1)

Strict JSON — unknown fields are rejected so a file is never silently misread.

```jsonc
{
  "kind": "plannotator-guided-review",
  "version": 1,
  "exportedAt": "2026-08-15T20:00:00.000Z",
  "guide": {
    "title": "…", "intent": "…",
    "sections": [{ "title": "…", "overview": "…markdown…", "diffs": [{ "file": "src/auth.ts", "summary": "…" }] }],
    "unplacedFiles": ["README.md"],
    "reviewed": [true, false]
  },
  "review": { "rawPatch": "diff --git a/… ", "gitRef": "origin/main..HEAD", "diffType": "since-base", "base": "origin/main" },
  "source": {
    "kind": "pr",                                   // local | pr | workspace | commit
    "repo": "owner/repo", "branch": "feat/x", "headSha": "…",
    "pr": { "url": "https://github.com/owner/repo/pull/1", "number": 1, "title": "…", "platform": "github" }
  },
  "generator": { "engine": "claude", "model": "sonnet", "generatedAt": "…", "customInstructions": "…" },
  "theme": { "palette": "plannotator" }
}
```

Every `diffs[].file` and `unplacedFiles[]` entry should name a file present in `rawPatch`; files that are not resolve to an "outdated" chip in the viewer rather than breaking it.

## guides.show

`guides.show/v1/…` hosts viewer builds. Files there are content-hashed and never changed or removed; each exported HTML names the exact `viewer.<hash>.js` and `.css` it was made with (with integrity hashes), and preloads only the syntax grammars its diff needs. An exported file sends nothing about your guide to `guides.show`; the page only fetches the viewer, fonts, and grammars. Only a share link (above) uploads a guide, and by default it uploads ciphertext.
