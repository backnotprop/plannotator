# Draw the system: the first drawing

You are drawing a project's system: a set of sheets a person can zoom through, where every part and every line names the
files it rests on. The drawing is a folder of YAML files, the drawing folder named above, kept in Plannotator's own
folder on this Mac, never in the project's repo. The person sees it in the Plannotator Inbox as you write it. The format
is at the end of these instructions, under "System format 1".

The facts of this job (the project, the folder to work in, what to read) are listed above these instructions.

## Rules

- Work only in the drawing folder and the source folder named above. Never edit, switch or commit in the person's
  own checkout; making the source folder from it in step 1 is the one thing you run there. Every other command below
  runs in the source folder, and every check reads the drawing folder, never another copy of the drawing.
- Draw what the code says today, never what you remember or what a README or a marketing page claims. Every part,
  line and label must trace to a file you read. If you cannot point to a file for a claim, leave the claim out.
- Read only. Other repos are cloned read only into a temporary folder. Never commit, push or open a pull request: the
  drawing stays in the drawing folder.
- Write to the person in the Inbox only where these steps say so: one message once `system.yaml` is first written
  (step 3) and one when you are done (step 8). Send them with your Plannotator Inbox tool's `send_message`, into the
  drawing's thread as the facts above name it: with a thread named, each message is a reply to it (`reply_to`, that
  message's id); with none, the first message starts it with the subject `System: <project>` and the last is a reply
  to the first. If you have no Inbox tool, run
  `plannotator inbox call send_message '{"body": "<text>", "reply_to": "<message id>"}'` in a shell (with
  `"subject": "System: <project>"` in place of `reply_to` for a first message that starts the thread).

## Steps

1. **Get the source folder ready.** If the source folder does not exist, make it from the project's folder:
   `git -C <project folder> remote get-url origin` prints the project's remote, and then
   `git clone --reference-if-able <project folder> <that remote> <source folder>`.
   Find the default branch with `git -C <source folder> symbolic-ref --short refs/remotes/origin/HEAD`: it prints
   `origin/<default branch>`, for example `origin/main`; then run
   `git -C <source folder> checkout --detach origin/<default branch>`. If no
   source folder was named above, make one in a new empty folder of your own outside the project. Then work only
   there. Note the commit you are drawing from: `git -C <source folder> rev-parse HEAD`.

2. **Read the code.** Start with how the project is built and started: the package or build files, the entry points,
   the servers, workers and processes, the stores (databases, files, queues, caches), the routes and commands, the
   configuration and its switches (feature flags, environment defaults). For each other repo named above, clone it
   read only (`git clone --filter=blob:none <url> <a temporary folder>`) and note its commit with
   `git rev-parse HEAD`. Read the doc sites named above for names and intent, but draw only what the code confirms.
   - A switch that is off by default is drawn with "off" in its part's `sub` or its band's `means`, and the file the
     switch lives in is in the part's `code:`. When the part it turns on is outside (no `code:`), put "off" on that
     outside part too, and put the switch's file in the `code:` of the project part that reads the switch. Read the
     default; do not guess it.
   - Retired, removed or dead code is not drawn.
   - A part is a runtime piece (a process, server, worker, window, store, agent host, outside service) or a module
     someone working on the code must be able to find. A helper module is not a part: cite it in the `code:` of the
     part that runs it.
   - People, outside vendors, the operating system and products built in other repos are outside parts: no `code:`,
     in a band of their own (for example "Outside" or "Who uses it"), never mixed into a band of the project's own
     pieces.

3. **Write `system.yaml` first.** In `<drawing folder>/system.yaml` write `format: 1`, `system` (the
   project's name), `root: C-001`, `sources` (this repo as `self` with its `repo` and `at`, the commit from step 1;
   each other repo under a short alias with its own `at`; the doc sites under `docs`), `scopes`, and `wanted:` with
   EVERY sheet you plan, the landing `C-001` first. Add the parts and lines you know so far. The Inbox counts the
   person's progress from `wanted:`. Then send your first message: one or two sentences on what you are reading and
   the sheets you plan.

4. **Draw the landing, `sheets/C-001.yaml`.** A conceptual sheet of scope `root`: who uses the project, what runs
   where, and the main lines between them, in three or four bands. A newcomer must understand it in one minute. Keep
   words short. A large piece with its own insides is a part with `child:` that opens a scope: its insides go on that
   scope's sheets, not on the landing.

5. **Draw the deeper sheets.** For each scope, a logical sheet (`L-...`) of what runs inside it. Then the flows
   (`F-...`) someone working on the code would follow: one request or one job, hop by hop, with the file and function
   in the hop's words or payload. Add an algorithm (`A-...`), deployment (`D-...`) or landscape (`T-...`) sheet only
   when it answers a real question. Fewer good sheets beat many thin ones. A sheet past about 30 parts, or with lines
   that tangle, moves a group of parts into a window: a part with `child:`, a new scope and a new sheet. As each
   sheet's file is written and loads clean, take its code out of `wanted:`.

6. **Check, and fix until clean.** Run `plannotator system check --dir <drawing folder> --root <source folder>`. It
   loads the drawing and checks that every cited path is in the repo at the commit in `sources.repos.self.at`. For
   another repo add `--repo <alias>=<its temporary folder>`. It prints each error with its file and field, and each
   missing path with the field that cites it (`parts.<id>.code`, or `flows.<id>.code.from` or `.to` for a line). Fix and
   run it again until it prints no errors, no warnings and no missing paths. Then read your sheets once more against the
   code: every claim must be true at the commit you drew from.

7. **Hand it over.** Nothing is committed, pushed or opened as a pull request: the drawing stays in the drawing
   folder and the Inbox shows it.

8. **Send the last message**: the sheets you drew, one line each; and the sentence "I will redraw it when main moves."
   Then stop.
