<!--
DRAFT, not published. A section for the privacy policy, to go live with the
first counted experimental feature (phase 2 of usage counts). Source: the
approval record .product/approved/experimental-telemetry/ (approval.md
overrides SPEC.md: counts are on by default when a person turns on an
experimental feature, with a notice; no install id) and the privacy review
of PR #2142.

At launch the live page apps/marketing/src/pages/privacy.astro must change
too: line 17 ("Plannotator does not collect usage telemetry or analytics")
and line 71 ("We do not operate ... product telemetry") stop being true.

Placeholders for the owner: [CONTROLLER NAME], [POSTAL ADDRESS],
[CONTACT EMAIL], [TRANSFER BASIS: confirm Cloudflare's DPF certification /
SCCs in the DPA].

This folder is outside src/, so Astro does not build it.
-->

## Experimental features and usage counts

Plannotator has experimental features. Each one stays off until you turn it on.

When you turn on an experimental feature, Plannotator shows a notice. The notice says that Plannotator will count how often you use that feature and how to turn these counts off. Counting starts only after that notice has been shown. Plannotator records counts only while all of these are true:

- you have turned the feature on in Plannotator's settings;
- you have seen the notice for that feature;
- you have not turned counts off;
- the feature's counting end date has not passed.

Turning on a feature through an environment variable alone never starts counting. Development and source builds of Plannotator record and send nothing, unless a developer points them at a test server on their own computer.

### Who is responsible

The controller is [CONTROLLER NAME], [POSTAL ADDRESS]. Contact: [CONTACT EMAIL].

### What is sent, and when

For each feature and each day on which Plannotator counted something for it, the Plannotator program on your computer (never your browser) sends one request after that day has ended in UTC. It waits a random time of up to 4 hours after the day ends.

The request holds:

- whole numbers for that one feature and that one day, each capped at 100 (for example "opened 3 times, answered 14 questions");
- the date in UTC;
- the feature's version number;
- whether that day was the first day this computer used the feature (sent once);
- how many of the last 7 days you used the feature, as a range: 1, 2–3, 4–5 or 6–7.

The notice lists every count for the feature. `plannotator telemetry --show` prints exactly what would be sent.

If your computer was offline or Plannotator was not running, the days still waiting are sent together later, with a few seconds between requests, at most 14 requests at a time. Days older than 3 days are deleted unsent the next time Plannotator runs.

### What is never sent

Plannotator never sends:

- your questions, answers, messages, files or code;
- paths, project or repository names, or agent names;
- the Plannotator version;
- any identifier for you or your computer.

### Where it goes, and what is kept

The requests go to our server on Cloudflare (counts.plannotator.ai).

**In transit, your requests can be linked.** Every request carries your IP address, as any network request does. Cloudflare sees it while delivering the request. On the days you send counts, requests that arrive from the same IP address (for example, several days sent together after you were offline) could be tied to each other and to that IP address while they are in transit. The random delay and the gaps between requests make this harder, but do not prevent it.

**At rest, we keep only totals.** Our server adds your numbers to daily totals across everyone. It stores no IP address, no time beyond the day, and no record for a single request, person or computer. We call the stored totals anonymous at rest. They are not anonymous in transit.

**Small totals.** When only a few computers report on a day, a total in the table can hold the numbers of a single computer. Nothing in the table says which computer that was. The interface we use to read totals shows only these:

- days that can no longer change (older than 3 days);
- days with at least 5 reporting computers;
- figures that at least 5 computers contributed to.

We, the operator, can also open the table directly through our Cloudflare account. There, small totals are visible as stored.

**Database history (Cloudflare D1 Time Travel).** Cloudflare keeps a history of the database's writes for 7 days (30 days on a paid plan). During that time an earlier state of the totals can be restored. Comparing two states a moment apart could, in principle, show the numbers one request added. We do not use this history to look at single requests, and it expires on its own.

### Why: purpose and lawful basis

We count use of experimental features to decide whether to keep, change or remove them. Our lawful basis is our legitimate interest in improving Plannotator with minimal data (GDPR Art. 6(1)(f)). We have weighed that interest against your interests:

- only whole numbers for one feature and one day are sent;
- nothing that identifies you is stored;
- you can stop at any time.

**You have the right to object.** Turning counts off (below) is an objection that takes effect at once on your computer. You can also write to [CONTACT EMAIL].

### Who processes it, and transfers

Cloudflare, Inc. runs the server as our processor, under its data processing addendum. Cloudflare may process the request, including your IP address, outside your country, including in the United States. The transfer basis is [TRANSFER BASIS: the EU–U.S. Data Privacy Framework and/or the Standard Contractual Clauses in Cloudflare's DPA].

### How long

- On your computer, counts older than 3 days are deleted unsent the next time Plannotator runs.
- On our server, a feature's totals are deleted 180 days after that feature's counting end date. No total is kept longer than 400 days.
- Counting for each feature stops on a fixed date, which `plannotator telemetry --show` prints.

### How to stop, and what stays on your computer

To turn counts off, run `plannotator telemetry --off`, or set `PLANNOTATOR_TELEMETRY=0` or `DO_NOT_TRACK=1`. Turning a feature off also stops its counts.

When counts are turned off, the counts not sent yet, the list of days you used the feature, and the local copy of what was sent are deleted. Two things stay on your computer:

- your choice to turn counts off, in Plannotator's settings file;
- for each feature you used, the fact that it was used once (no date), so the "first day" fact is never sent twice.

`plannotator uninstall` deletes all of these local count files. It keeps your settings file, including a choice to turn counts off, so that choice still holds if you reinstall. `plannotator uninstall --purge` deletes the settings file too.

### Your rights

You have the right to access, rectify, erase or restrict data, and to object (GDPR Arts. 15–18 and 21). Our server holds no identifier, so we cannot find the totals you contributed or tell them apart from others (Art. 11). You can lodge a complaint with your data protection supervisory authority.

<!--
Note for the lawyer (not for publication): ePrivacy Directive Art. 5(3)
covers storing information on, and reading it from, a person's device. The
local count files under usage-counts/ are written and read back to send, and
this is not strictly necessary for the feature the person asked for. The
strict EU reading wants prior opt-in consent for that. The owner chose counts
on by default with a notice (approval record, 2026-10-24), and recorded the
risk. Please confirm whether legitimate interests plus the notice is enough
for the target markets, or whether the notice must become an opt-in (an
unticked box) for EU/EEA users. Switching to opt-in is a small change: the
notice writes `usageCountsNotice` only when the person ticks the box.
-->
