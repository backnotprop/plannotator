# 7. An attachment

A tile opens a cover. The top bar has Done, the file's name, "File 2 of 4" and More (Download, Share, Open in another app, Copy link). Swipe sideways for the next file. A comment made on any file is kept unsent and rides with the next Send; "3 comments" at the foot opens the list.

| Kind | What is on screen | How to comment |
|---|---|---|
| Image | The picture, pinch to zoom, swipe down to close | "Comment" for words on the whole picture; the pencil draws on it (finger or Apple Pencil); the drawing is sent flattened, as the window sends it |
| Video, audio | The system player | "Comment at 0:42" adds a comment at that moment; the moments show as dots on the scrubber |
| Markdown, text, code | The document drawn natively, same renderer as messages | Select words, Comment. For code, tap a line number or drag over lines |
| HTML page | The page in a sandboxed web view under the app's own bar, with "Comment" and "Use the page" | In Comment, a tap drops a numbered pin and opens the comment sheet; in Use the page, taps go to the page |
| Diagram | Drawn in a web view block, pinch to zoom | Tap a node or edge, Comment |
| PDF and other files | Quick Look | None (the Inbox refuses comments on these) |
| A guided review | One section per page: the agent's words, then the diff, unified and wrapped. A tick "Reviewed" per section, a progress count, "File view" for a whole file | Tap a line (or drag over lines) to comment on it |
| A diff outside a guide | The same diff view | The same |

Questions inside an attached file are drawn where they sit in the document and answered like any other.

Differs from the window: every file is full screen (the window opens it beside the thread). The HTML page's toggle says what each mode does in words. Split diffs are not offered on a phone; they return with the iPad layout.

## Checks

The checks so far are for opening and reading a file. The checks for comments, drawing, diagrams, guided reviews and questions inside a file are written with the slices that build them.

- [file-01] A message's files are tiles under its words: a picture small or the kind's mark, the file's name, and under it its kind and size in the window's words ("2400 × 576, 130.0 KB", "MP4 video · 0:03 · 48.2 KB", "Markdown, 921 B"). phone differs: one row per file, the whole row to touch, because a grid of small tiles is hard to hit with a thumb (packages/inbox/components/AttachmentTiles.tsx:63; packages/core/inbox-attachments.ts:402; packages/core/inbox-format.ts:140)
- [file-02] A tile opens the file full screen over the thread, with Done, the file's name, "File 2 of 4" and More. Done returns to the thread where it was. (packages/inbox/stepping.ts:36; packages/inbox/components/AttachmentPane.tsx:2264)
- [file-03] A swipe sideways steps to the next file, message by message in the thread's order. (packages/inbox/stepping.ts:36; packages/inbox/fileSwipe.ts:10)
- [file-04] A picture opens whole, however wide or tall, clear of the bars. A pinch looks into it, up to eight times its own size; two taps go in and back out; one tap puts the bars away; pulled down while whole, it closes. (packages/ui/components/imageZoom.ts:1; packages/inbox/fileSwipe.ts:10)
- [file-05] A Markdown file is drawn natively from the window's own blocks, with the window's ids: headings, paragraphs, lists with their numbers and task boxes, quotes, tables that scroll sideways, code with Copy. Plain text is wrapped. Code, and a log or a data file, show each line with its number, a long line wrapped. (packages/ui/utils/parser.ts:378; packages/inbox/attachments.ts:48)
- [file-06] An HTML page is the page itself in a sandboxed web view that keeps nothing, under the window's page policy: its own script runs, a link to another site that the person taps opens in the browser, and nothing else leaves the page (no fetch, no navigation, no other app). (packages/ui/components/html-embed/HtmlEmbedBlock.tsx:149)
- [file-07] A video and a recording play in the system's player; a PDF is drawn by the system; any other file, and text past 16 MB, shows its name, kind and size with Share. (packages/core/inbox-attachments.ts:302; packages/inbox/components/AttachmentPane.tsx:2736)
- [file-08] A file that changed since it was sent opens as it is now and says "Changed since sent" with "View sent version"; the sent version says "Showing the sent version" with "View current file". A file gone from the computer opens as it was sent and says so. (packages/inbox/components/versionLineWords.ts:48; packages/inbox/components/AttachmentPane.tsx:2235)
- [file-09] A file opened before opens again with the computer away. One the phone does not have says the computer cannot be reached, with Try again. (packages/server/inbox-byte-range.ts:1)
- [file-10] More offers Share (the system's sheet: save to Files, another app), Copy file for a file made of words, and Copy image for a picture. (packages/inbox/components/CopyFileButton.tsx:61)
