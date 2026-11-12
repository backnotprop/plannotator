/**
 * Message bodies for the "choices have no pictures" rule (inbox-picture-choices.ts).
 *
 * `SENT` are bodies that fresh Claude agents (Sonnet, Haiku, Opus) wrote in a
 * clean-room eval of send_message's instructions, one per task: each body
 * that the earlier rule (any bare pick question under two or more pictures)
 * fired on. Seven of them need no pictures in their choices. `HAND` are
 * written to the rule's edges. Picture paths are rewritten to `/work/assets/`.
 *
 * `fires` is what the rule answers. Two bodies wanted picture choices but stay
 * quiet: a before/after pair above a ship question (`sent-W4-today-sonnet`,
 * `hand-F3`), whose labels name neither picture; a rule that fired there would
 * fire on every report of finished work with before/after shots.
 */

export interface PictureChoicesFixture {
  id: string;
  note: string;
  fires: boolean;
  body: string;
}

export const SENT: PictureChoicesFixture[] = [
  {
    "id": "sent-N1-today-haiku",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 (dark mode for the settings and profile pages) is finished. Both pages now follow the system theme. I checked contrast against WCAG AA, the tests pass, and CI is green.\n\nHere is the settings page in dark mode:\n\n![Settings page in dark mode](/work/assets/n1-dark-mode/settings-dark.png)\n\nHere is the profile page in dark mode:\n\n![Profile page in dark mode](/work/assets/n1-dark-mode/profile-dark.png)\n\nThe billing page is not in this PR. It will be a separate PR.\n\n:::question\nShould I merge PR #42 now, or wait until the billing page is dark too?\n\nMerging now ships settings and profile in dark mode right away. Billing would then follow in its own PR, so the app is briefly mixed. Waiting keeps all three pages landing together, but PR #42 sits unmerged until billing is ready.\n\n- [ ] Merge PR #42 now\n- [ ] Wait until the billing page is dark too\n\nRecommended: Merge PR #42 now\nWhy: both pages are done and tested, and billing does not block them.\nReversible: no — it is a merge, but a revert is possible.\n:::"
  },
  {
    "id": "sent-N1-today-opus",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 is done. The settings and profile pages now follow the system theme in dark mode. Contrast meets WCAG AA, tests pass and CI is green. The billing page is not in this PR; it will get its own PR.\n\nSettings page in dark mode:\n\n![The settings page in dark mode: Display name, Email digests and Push alerts rows on a dark background](/work/assets/n1-dark-mode/settings-dark.png)\n\nProfile page in dark mode:\n\n![The profile page in dark mode: Avatar, Bio and Links rows on a dark background](/work/assets/n1-dark-mode/profile-dark.png)\n\n:::question\nMerge PR #42 now, or wait until the billing page is dark too?\n\nPR #42 is finished and green. If we merge now, a user in dark mode sees settings and profile dark but billing still light until the billing PR lands. If we wait, all three pages switch together, but this PR sits open and can drift from main.\n\n- [ ] Merge now — billing follows in its own PR\n- [ ] Wait — merge together with the billing PR\n\nRecommended: Merge now — billing follows in its own PR\nWhy: the pages are independent, so users get dark mode on two pages sooner, and a smaller PR that is green now is safer than one held open.\nHolds up: merging PR #42\nStakes: whether users see one light page among dark ones for a while\n:::"
  },
  {
    "id": "sent-N1-today-sonnet",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 is done: the settings and profile pages now follow the system theme. Contrast is checked (AA), tests pass and CI is green. The billing page is not included; it is a separate PR.\n\nSettings page in dark mode:\n\n![Settings page in dark mode](/work/assets/n1-dark-mode/settings-dark.png)\n\nProfile page in dark mode:\n\n![Profile page in dark mode](/work/assets/n1-dark-mode/profile-dark.png)\n\n:::question\nShould I merge #42 now, or wait until the billing page is dark too?\n\nMerging now ships dark mode on settings and profile while billing stays light, so users on a dark system theme will see one light page. Waiting keeps the app consistent but delays the two finished pages until the billing PR is done.\n\n- [ ] Merge now\n- [ ] Wait until billing is dark too\n\nRecommended: Wait until billing is dark too\nWhy: a single light page among dark ones looks unfinished, and the PR is ready to merge the moment billing lands.\nHolds up: merging #42\n:::"
  },
  {
    "id": "sent-N1-proposed-haiku",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 is finished. Settings and profile pages now follow the system theme. Contrast checks pass AA, tests pass, and CI is green.\n\nSettings page in dark mode:\n\n![Settings page in dark mode](/work/assets/n1-dark-mode/settings-dark.png)\n\nProfile page in dark mode:\n\n![Profile page in dark mode](/work/assets/n1-dark-mode/profile-dark.png)\n\nThe billing page is not in this PR. It goes in a separate PR.\n\n:::question\nMerge PR #42 now, or wait until the billing page is dark too?\n\nMerging now ships settings and profile in dark mode while billing stays light. Waiting keeps the switch to dark mode in one release, but PR #42 sits until the billing PR is ready.\n\n- [ ] Merge PR #42 now\n- [ ] Wait until the billing page is dark too\n\nRecommended: Wait until the billing page is dark too\nWhy: A user who moves from settings to billing would see a half-dark app, and the two pages are small enough to ship together.\nHolds up: the PR #42 merge\nStakes: the release that includes dark mode for settings and profile\n:::"
  },
  {
    "id": "sent-N1-proposed-opus",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 is finished. The settings and profile pages now follow the system theme. Contrast passes WCAG AA, tests pass and CI is green.\n\nThe settings page in dark mode:\n\n![Settings page in dark mode: Display name, Email digests and Push alerts rows on a dark background](/work/assets/n1-dark-mode/settings-dark.png)\n\nThe profile page in dark mode:\n\n![Profile page in dark mode: Avatar, Bio and Links rows on a dark background](/work/assets/n1-dark-mode/profile-dark.png)\n\nNot in this PR: the billing page. It will come in a separate PR.\n\n:::question\nMerge PR #42 now, or wait until the billing page is dark too?\n\nIf we merge now, a person who uses a dark system theme sees dark settings and profile pages but a light billing page until the billing PR lands. If we wait, the two finished pages sit unmerged and the branch can drift from main. The billing page is a separate PR, so merging now does not block it.\n\n- [ ] Merge now\n- [ ] Wait until the billing page is dark too\n\nRecommended: Merge now\nWhy: The two pages are done and checked, and a light billing page in dark mode is a small, short-lived mismatch.\nHolds up: merging PR #42\nStakes: whether users see a mix of dark and light pages for a short time\n:::"
  },
  {
    "id": "sent-N1-proposed-sonnet",
    "note": "merge question under screenshots of the finished dark mode",
    "fires": false,
    "body": "PR #42 is done: the settings and profile pages now follow the system theme. Contrast is checked (AA), tests pass and CI is green.\n\nSettings page in dark mode:\n\n![Settings page in dark mode](/work/assets/n1-dark-mode/settings-dark.png)\n\nProfile page in dark mode:\n\n![Profile page in dark mode](/work/assets/n1-dark-mode/profile-dark.png)\n\nThe billing page is not part of this PR; it would be a separate PR.\n\n:::question\nMerge PR #42 now, or wait until the billing page is dark too?\n\nMerging now ships dark mode for settings and profile only, so billing stays light until its own PR lands. Waiting keeps the app visually consistent in one release but delays the two finished pages.\n\n- [ ] Merge now\n- [ ] Wait until billing is dark too\n\nRecommended: Merge now\nWhy: the PR is self-contained and green, and billing is a separate PR, so waiting gains little.\nHolds up: merging PR #42\n:::"
  },
  {
    "id": "sent-N3-today-opus",
    "note": "a wording question under screenshots of where the words go",
    "fires": false,
    "body": "When someone drops a file over 25 MB on the upload form, the red toast under it says only \"Error 413\". Only the words change; the toast layout stays as it is.\n\n![Upload form with an empty drop zone that says \"Drop a file here\"](/work/assets/n3-error-wording/screen-1.png)\n\n![The error today: a red toast under the drop zone that says \"Error 413\"](/work/assets/n3-error-wording/screen-2.png)\n\nThe three candidates in a toast of about today's width, to compare their length:\n\n```html\n<div style=\"font-family: -apple-system, Helvetica, Arial, sans-serif; display: flex; flex-direction: column; gap: 10px; padding: 4px 0;\">\n  <div style=\"display: flex; align-items: center; gap: 12px;\"><span style=\"width: 20px; color: var(--foreground); font-size: 13px;\">1</span><div style=\"width: 420px; box-sizing: border-box; padding: 12px 16px; background: #fde2e2; border: 1px solid #f08a8a; border-radius: 8px; color: #c81e1e; font-weight: 700; font-size: 15px; text-align: center;\">File too large</div></div>\n  <div style=\"display: flex; align-items: center; gap: 12px;\"><span style=\"width: 20px; color: var(--foreground); font-size: 13px;\">2</span><div style=\"width: 420px; box-sizing: border-box; padding: 12px 16px; background: #fde2e2; border: 1px solid #f08a8a; border-radius: 8px; color: #c81e1e; font-weight: 700; font-size: 15px; text-align: center;\">This file is over 25 MB. Try a smaller file or compress it.</div></div>\n  <div style=\"display: flex; align-items: center; gap: 12px;\"><span style=\"width: 20px; color: var(--foreground); font-size: 13px;\">3</span><div style=\"width: 420px; box-sizing: border-box; padding: 12px 16px; background: #fde2e2; border: 1px solid #f08a8a; border-radius: 8px; color: #c81e1e; font-weight: 700; font-size: 15px; text-align: center;\">Upload failed: files can be up to 25 MB.</div></div>\n</div>\n```\n\n:::question\nWhich words should the upload error toast show for a file over 25 MB?\n\nToday it shows only \"Error 413\", which tells the person nothing. Options 2 and 3 both give the 25 MB limit; 2 also says what to do, but it is the longest and probably wraps to two lines in the current toast. 3 gives the limit and fits on one line.\n\n- [ ] 1 · \"File too large\"\n  Pros: shortest; fits easily\n  Cons: does not say the limit, so the person has to guess how small is small enough\n- [ ] 2 · \"This file is over 25 MB. Try a smaller file or compress it.\"\n  Pros: gives the limit and the next step\n  Cons: longest; probably wraps to two lines in the current toast\n- [ ] 3 · \"Upload failed: files can be up to 25 MB.\"\n  Pros: gives the limit; one line\n  Cons: no explicit next step\n\nRecommended: 3 · \"Upload failed: files can be up to 25 MB.\"\nWhy: it gives the limit, which is what the person needs to fix it, and keeps the toast to one line since its layout stays as it is.\nHolds up: changing the toast text\n:::"
  },
  {
    "id": "sent-W2-today-haiku",
    "note": "a rundown of three designs, a picture each, then bare choices",
    "fires": true,
    "body": "Here is a rundown of the three settings panel versions. Each picture is the screenshot from your folder.\n\nAll three use the same switches (Email digests, Push alerts and so on), so the difference is how the settings are laid out.\n\n- **A, one page, grouped.** Account, Notifications and Privacy sit on one scrolling page, each in its own group. Everything is visible at once. It is the simplest to build, but it gets long on a phone.\n\n![Version A: one page, grouped](/work/assets/w2-settings/settings-a.png)\n\n- **B, side tabs.** A left column lists Account, Notifications, Privacy and Billing, and the right side shows one section at a time. It scales well if more sections come, but it takes one more tap to reach any setting.\n\n![Version B: side tabs](/work/assets/w2-settings/settings-b.png)\n\n- **C, search first.** A search box sits at the top, with matching settings listed under it and recently changed ones below. It is the fastest when someone knows what they want, but it needs a search index over every setting.\n\n![Version C: search first](/work/assets/w2-settings/settings-c.png)\n\nThe clickable HTML files are only rough stubs. Each one shows just two switches, the same in all three, so they do not show the layouts. The pictures are the better guide.\n\n:::question\nWhich settings panel should I build?\n\nA is the simplest and covers the three sections you have now. B is better if more sections are coming. C is best if people mostly look up one setting at a time, but it needs a search index.\n\n- [ ] A · One page, grouped\n- [ ] B · Side tabs\n- [ ] C · Search first\n\nRecommended: A · One page, grouped\nWhy: it is the least work for the current three sections, and you can move to B later without losing anything.\n:::"
  },
  {
    "id": "sent-W4-today-sonnet",
    "note": "today and the redesign above a ship question (labels share no word with either picture)",
    "fires": false,
    "body": "I redesigned the empty state of the projects list, the screen a new account sees before it has any project. Today it is an empty box that says \"No projects.\" The redesign adds an icon, a heading, one line on what projects are for, a New project button and an import link.\n\nToday:\n\n![Today: an empty box with the text No projects.](/work/assets/w4-empty-state/before.png)\n\nRedesign:\n\n![Redesign: plus icon, heading Start your first project, one line, New project button, import from Trello link](/work/assets/w4-empty-state/after.png)\n\nThe redesign has a clickable version: [after.html](/work/assets/w4-empty-state/after.html) (the New project button changes to \"Created!\" when clicked).\n\n:::question\nShip the redesigned empty state of the projects list?\n\nA new account now sees only \"No projects.\" with nothing to do next. The redesign tells them what a project is and puts New project one click away; the import link points to Trello.\n\n- [ ] Ship it as is\n- [ ] Ship it after changes (add a note)\n- [ ] Do not ship\n\nRecommended: Ship it as is\nShows: ![Redesign of the projects list empty state](/work/assets/w4-empty-state/after.png)\n:::"
  }
];

export const HAND: PictureChoicesFixture[] = [
  {
    "id": "hand-F1",
    "note": "case 1 shape: numbered paragraphs + pictures above, six text choices",
    "fires": true,
    "body": "**1 · Names.** Bold name, grey details. Cheapest.\n\n![1 · Names](/work/assets/w5-report/v1.png)\n\n**2 · Faces.** A face per session.\n\n![2 · Faces](/work/assets/w5-report/v2.png)\n\n**3 · Colors.** A stripe per session.\n\n![3 · Colors](/work/assets/w5-report/v3.png)\n\n**4 · Initials.** Two-letter squares.\n\n![4 · Initials](/work/assets/w5-report/v4.png)\n\nAll four side by side:\n\n![All four](/work/assets/w5-report/contact-sheet.png)\n\n:::question\nWhich session look should we build?\n\n- [ ] 1 · Names\n- [ ] 2 · Faces\n- [ ] 3 · Colors\n- [ ] 4 · Initials\n- [ ] 2 + 3 combined\n- [ ] None yet\n\nRecommended: 3 · Colors\n:::"
  },
  {
    "id": "hand-F2",
    "note": "rundown with headings A/B/C and bare pictures, then text choices",
    "fires": true,
    "body": "### A · One page\nEverything grouped on one page.\n![](/work/assets/w1-settings/settings-a.png)\n\n### B · Side tabs\nOne section at a time.\n![](/work/assets/w1-settings/settings-b.png)\n\n### C · Search first\nA search box first.\n![](/work/assets/w1-settings/settings-c.png)\n\n:::question\nWhich settings panel should I build?\n\n- [ ] A · One page\n- [ ] B · Side tabs\n- [ ] C · Search first\n:::"
  },
  {
    "id": "hand-F3",
    "note": "before/after story, then ship yes/no (pictures wanted in choices, labels share nothing)",
    "fires": false,
    "body": "Before:\n\n![Today: an empty box that says No projects.](/work/assets/w4-empty-state/before.png)\n\nAfter:\n\n![Redesign: icon, heading, New project button](/work/assets/w4-empty-state/after.png)\n\n:::question\nShip the redesigned empty state?\n\n- [ ] Ship it as is\n- [ ] Ship it after changes\n- [ ] Do not ship\n:::"
  },
  {
    "id": "hand-F4",
    "note": "merge question under two screenshots; labels share words with alt text (settings, profile, dark)",
    "fires": false,
    "body": "PR #42 adds dark mode to the settings and profile pages.\n\n![The settings page in dark mode](/work/assets/n1-dark-mode/settings-dark.png)\n\n![The profile page in dark mode](/work/assets/n1-dark-mode/profile-dark.png)\n\n:::question\nMerge PR #42 now?\n\n- [ ] Merge settings and profile now\n- [ ] Wait until the billing page is dark too\n:::"
  },
  {
    "id": "hand-F5",
    "note": "numbered screens and numbered wording choices, unrelated",
    "fires": false,
    "body": "![Screen 1: upload form](/work/assets/n3-error-wording/screen-1.png)\n\n![Screen 2: the error today](/work/assets/n3-error-wording/screen-2.png)\n\n:::question\nWhich wording should the toast use?\n\n- [ ] 1 · File too large\n- [ ] 2 · This file is over 25 MB. Try a smaller file or compress it.\n- [ ] 3 · Upload failed: files can be up to 25 MB.\n:::"
  },
  {
    "id": "hand-F6",
    "note": "only a contact sheet of all options above, text choices (detector cannot know the single pictures)",
    "fires": false,
    "body": "![1 · Names, 2 · Faces, 3 · Colors, 4 · Initials side by side](/work/assets/w5-report/contact-sheet.png)\n\n:::question\nWhich session look?\n\n- [ ] 1 · Names\n- [ ] 2 · Faces\n- [ ] 3 · Colors\n- [ ] 4 · Initials\n:::"
  },
  {
    "id": "hand-F7",
    "note": "two charts above a which-metric question; labels near the chart words",
    "fires": false,
    "body": "![Signup funnel: visited, signed up, created project, invited someone, paid](/work/assets/n6-metrics/funnel.png)\n\n![Last month's funnel for comparison](/work/assets/n6-metrics/funnel.png)\n\n:::question\nWhich step do we instrument next?\n\n- [ ] Project creation\n- [ ] Invites\n- [ ] Payment\n:::"
  },
  {
    "id": "hand-F8",
    "note": "bug screenshot + priority question, with a second screenshot of the same bug on a phone",
    "fires": false,
    "body": "![Checkout on a laptop: Pay covers the total](/work/assets/n2-bug/checkout-overlap.png)\n\n![Checkout on a phone: same overlap](/work/assets/n2-bug/checkout-overlap.png)\n\n:::question\nHow urgent is the fix?\n\n- [ ] Drop everything\n- [ ] This sprint\n- [ ] Backlog\n:::"
  }
];
