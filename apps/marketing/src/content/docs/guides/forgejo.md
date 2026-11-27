---
title: "Forgejo and Gitea PR Review"
description: "Review Forgejo and Gitea pull requests in Plannotator with an access token."
sidebar:
  order: 32
section: "Guides"
---

Plannotator can review a Forgejo or Gitea pull request the same way it reviews a GitHub pull request or a GitLab merge request:

```
plannotator review https://<host>/<owner>/<repo>/pulls/<id>
```

or, from your agent, `/plannotator-review https://<host>/<owner>/<repo>/pulls/<id>`.

A Forgejo or Gitea address names a pull request by `/pulls/<id>` (GitHub's is `/pull/<id>`), so Plannotator recognises it on any host with nothing to configure. A port stays part of the host, and an `http://` address works for an instance on your own network.

You get the pull request diff, its existing comments in the **PR Comments** tab, the commit status checks, a local checkout for agents and Guided Review, and you can post your review back to the instance. Pictures and files uploaded to the pull request, and files of its repository linked from it, open in the **Artifacts** panel, and pictures in the description and in comments show in place.

## Create an access token

Forgejo has no command-line tool like `gh` or `glab`, so Plannotator talks to the instance's REST API with an access token.

1. Open your instance's **Settings → Applications**.
2. Under **Generate new token**, name it (for example `plannotator`).
3. Select these scopes:
   - `read:repository`
   - `read:issue`
   - `write:repository` (needed to post a review)
   - `read:user` is optional: with it, Plannotator knows which account you are.
4. Generate the token and copy it. The instance shows it only once.

A public repository reads without a token. An instance that requires you to sign in to use its API (it answers `Only signed in user is allowed to call APIs`), or a private repository, needs one.

## Configure Plannotator

Set two environment variables in the shell your agent runs in:

```bash
export PLANNOTATOR_FORGEJO_URL="https://forgejo.example.com"   # the instance's address, with port and scheme if not the default
export PLANNOTATOR_FORGEJO_TOKEN="<the access token>"
```

The token is sent only to the origin `PLANNOTATOR_FORGEJO_URL` names, so a different host, port or scheme never gets it.

For several instances, put them in `~/.plannotator/config.json`, one token per origin:

```json
{
  "forgejoTokens": {
    "https://forgejo.example.com": "<token>",
    "http://forgejo.lan:3000": "<token>"
  }
}
```

That file stores the tokens in plain text, so prefer the environment variables for one instance. The environment variables take precedence. Plannotator never logs a token and never sends one to the browser.

For a private repository, or an instance that requires sign-in, `plannotator review` stops with a message that says what is wrong if the token is missing, rejected, or lacks a scope. A public repository opens without one. A `404` can also mean the account may not see the repository: it is private, or the account is a *restricted* one that has not been added to it.

## Local checkout

By default (`--local`), Plannotator also prepares a local checkout of the pull request in the background, so review agents, Guided Review and the full-stack diff have the real files. This step uses plain `git`, not the access token.

- If you run the review inside a clone of the same repository, Plannotator fetches the pull request's head from `origin`.
- Otherwise it clones `https://<host>/<owner>/<repo>.git`. A repository that needs a sign-in uses your own git credentials (for example a credential helper). It never prompts in the background.
- The head is fetched as `refs/pull/<id>/head` from the base repository, so a pull request from a fork, or one whose branch was deleted, still checks out.

If the checkout cannot be made, the review still opens on the pull request diff, with a warning. Use `--no-local` to skip it.

## Posting a review

Switch the review destination to the pull request in the header. The whole review goes as one review on the instance: your general comment and every line comment together.

- **Approve** approves the pull request.
- **Request changes** requests changes. The instance needs a comment with it.
- **Comment** posts only the comments.

Forgejo refuses to approve, or request changes on, your own pull request. **Comment** still works on it.

## Differences from GitHub

- Comments on a whole file are added to the review body instead of posted as file comments.
- Viewed files are not synced to the instance. Plannotator still remembers them locally.
- Stacked pull request discovery is not available.
- An instance served under a sub-path (`https://example.com/forgejo/...`) is not supported.
- Attachments do not show on an instance that serves uploads straight from object storage (`SERVE_DIRECT`).
- Git LFS files (`/media/` links) and release downloads (`/releases/download/` links) do not load.
