# Blockquote rendering test

## Multi-line blockquote (the bug)

This is a multi-line blockquote. Before the fix, each `>` line rendered as its own blockquote box with its own top/bottom margin, producing visible gaps between every line. After the fix, all consecutive `>` lines should merge into a single continuous quote.

> `tree.hash(path)` returns the SHA-256 digest of the file as it
> was when the library last observed it. A digest is computed
> on first call from the then-current on-disk bytes, cached in
> `files.hash`, and returned as-is on subsequent calls. The
> cache is invalidated whenever the library **observes** a
> change to the row (watcher or reconcile update) and dropped
> when the row is deleted. The library observes changes via the
> watcher pipeline and reconcile passes, both of which track
> `(size, mtime)` per spec §"Event flow and normalization." A
> content change that does NOT move `(size, mtime)` — e.g. an
> atomic same-length overwrite that preserves mtime, or an
> interval-based edit the watcher drops — is invisible to the
> library and will NOT invalidate the cached hash.

## Two separate blockquotes (blank line break)

A blank line between two `>` runs should still produce two distinct blockquote blocks.

> First quote, line one.
> First quote, line two.

> Second quote, line one.
> Second quote, line two.

## Single-line blockquote

> A standalone one-liner.

## Blockquote sandwiched between paragraphs

Some intro text before the quote.

> The quote itself spans
> two lines and should render
> as one continuous block.

Some closing text after the quote.

## Blockquote with inline formatting

> This quote has **bold**, *italic*, `inline code`,
> and a [link](https://example.com) to verify
> inline markdown still works across merged lines.
