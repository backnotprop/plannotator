---
title: "Bitbucket Cloud PR Review"
description: "Review Bitbucket Cloud pull requests in Plannotator with an Atlassian API token."
sidebar:
  order: 31
section: "Guides"
---

Plannotator can review a Bitbucket Cloud pull request the same way it reviews a GitHub pull request or a GitLab merge request:

```
plannotator review https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>
```

or, from your agent, `/plannotator-review https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`.

You get the pull request diff, its existing comments in the **PR Comments** tab, a local checkout for agents and Guided Review, and you can post your review back to Bitbucket.

## Create an API token

Bitbucket has no command-line tool like `gh` or `glab`, so Plannotator talks to the Bitbucket REST API with an Atlassian API token. App passwords are deprecated by Atlassian and are not supported.

1. Open [Atlassian account → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Click **Create API token with scopes**.
3. Enter a name (for example `plannotator`) and an expiry date, then click **Next**.
4. Select **Bitbucket** as the app, then click **Next**.
5. Select these scopes:
   - `read:user:bitbucket`
   - `read:repository:bitbucket`
   - `read:pullrequest:bitbucket`
   - `write:pullrequest:bitbucket` (needed to post comments, approve, and request changes)
6. Click **Create token** and copy the token. Atlassian shows it only once.

## Configure Plannotator

Set two environment variables in the shell your agent runs in:

```bash
export PLANNOTATOR_BITBUCKET_EMAIL="you@example.com"   # your Atlassian account email
export PLANNOTATOR_BITBUCKET_TOKEN="<the API token>"
```

Plannotator sends the token with HTTP basic auth (email plus token). If you leave out the email, it sends the token as a Bearer token.

You can also put `bitbucketEmail` and `bitbucketToken` in `~/.plannotator/config.json`. That file stores the token in plain text, so prefer the environment variables. The environment variables take precedence.

Plannotator never logs the token and never sends it to the browser.

If the token is missing, rejected, or lacks a scope, `plannotator review` stops with a message that names the variables and the scopes to fix.

## Local checkout

By default (`--local`), Plannotator also prepares a local checkout of the pull request in the background, so review agents, Guided Review and the full-stack diff have the real files. This step uses plain `git`, not the API token:

- If you run the review inside a clone of the same repository, Plannotator fetches the pull request's source branch from `origin`.
- Otherwise it clones `https://bitbucket.org/<workspace>/<repo>.git`. For a private repository, git uses your own git credentials (for example a credential helper). It never prompts in the background.
- For a pull request from a fork, the source branch is fetched from the fork.

If the checkout cannot be made, the review still opens on the pull request diff. Use `--no-local` to skip it.

## Posting a review

Switch the review destination to the pull request in the header. Each line comment is posted as an inline comment, then your general comment as one pull request comment, so it appears above the inline comments in the pull request's Activity feed (newest first). Then:

- **Approve** approves the pull request.
- **Request changes** sets Bitbucket's "Request changes" state on the pull request.
- **Comment** posts only the comments.

Bitbucket lets you approve your own pull request (your approval does not count toward merge checks), so Plannotator does not disable Approve or Request changes on your own pull request.

If Bitbucket accepts only part of a review, Plannotator shows what was posted and retries only what failed.

## Differences from GitHub

- Comments on a whole file are added to the review body instead of posted as file comments.
- Viewed files are not synced to Bitbucket. Plannotator still remembers them locally.
- Stacked pull request discovery is not available, and the PR Artifacts panel is not shown.
- Only Bitbucket Cloud (`bitbucket.org`) is supported. Bitbucket Data Center uses a different API.

## Testing against a fake API

`PLANNOTATOR_BITBUCKET_API_URL` overrides the API base URL (default `https://api.bitbucket.org/2.0`). Plannotator's own tests use it to point at a local fake API. It accepts only `https:`, or `http:` on localhost, because the token is sent to it.
