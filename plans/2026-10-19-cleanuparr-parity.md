# Cleanuparr parity

Keelhaularr takes over the Cleanuparr features it lacked so Cleanuparr can be retired.
Every new automation follows the existing safety model: off by default, a dry-run
mode that records what it would do and why, durable jobs with history, server-side
revalidation immediately before acting, and a per-item explanation naming the rule
and strike count.

## Shared foundations

1. **qBittorrent client** (`server/qbittorrent.mjs`): POST bodies; file lists, file
   priorities, deletion, alternative-speed mode, per-torrent private flag, and
   preferences for the optional blocklist sync. Torrent records gain ratio, seeding
   time, completion time, swarm seeders, tags, and content path.
2. **Strikes** (`server/strikes.mjs`): one durable store shared by every strike-based
   rule, keyed by rule and hash. A strike is added per failing check; a rule can reset
   strikes on progress; strikes expire after an inactivity window (24 h default).
3. **Ignore lists** (`server/download-ignore.mjs`): a global list of categories, tags
   and hashes, plus one per feature. Every automation, including the existing
   recovery, consults both.
4. **Notifications** (`server/notify.mjs`): ntfy (server + topic URL, optional
   token, priority) for removals and blocks, with scan reports optional. Download
   events can also go to the existing generic/Discord/Gotify webhook.
5. **Durable job** `download-cleanup`: one job type for every new rule, with three
   actions:
   - `arr-remove`: Arr removes the queue item (blocklisting it), Keelhaularr confirms
     the removal, then queues one replacement search. Same phases and crash
     reconciliation as recovery.
   - `skip-files`: sets blocked files to "do not download" and confirms it.
   - `client-remove`: removes a finished torrent from qBittorrent, optionally with its
     files, and confirms it is gone.
6. **Automation scheduler** (`server/automation.mjs`): ticks each feature on its own
   interval and records status and recent decisions in `config/automation.json`.
   It also offers a preview endpoint that evaluates every feature without acting
   or adding strikes.

## Features

| # | Feature | Module | Action |
|---|---|---|---|
| 1 | Failed-import cleanup | `failed-imports.mjs` | forced import attempts, then strikes, then `arr-remove` |
| 2 | Strikes | `strikes.mjs` | used by failed imports; recovery keeps its minute windows (see below) |
| 3 | Content blocker | `content-blocker.mjs` | `skip-files`, or `arr-remove` when every file is blocked |
| 4 | Blocklist and search | reuse of the recovery path | every Arr removal blocklists and searches once |
| 5 | Seeding cleanup | `seeding-cleanup.mjs` | `client-remove` per category rule |
| 6 | Unlinked cleanup | `unlinked-cleanup.mjs` | `client-remove` with files |
| 7 | Ignore lists | `download-ignore.mjs` | global and per feature |
| 8 | ntfy | `notify.mjs` | removal and block notifications |
| 9 | Blocklist sync (optional) | `content-blocker.mjs` | pushes glob patterns into qBittorrent's excluded file names |

## Strikes or minutes for slow/stalled recovery

Recovery keeps its continuous minute windows. A window polled every minute is the
same as one strike per minute that resets on any healthy reading, which is stricter
than Cleanuparr's strikes: those can accumulate across a day of intermittent
slowness. Recovery's windows, ownership proof and crash reconciliation already have
extensive tests, and moving them to strikes would change who gets removed for no
safety gain. Two Cleanuparr behaviours are added to recovery instead:

- slow detection pauses while qBittorrent's alternative speed limits are on
- the global ignore list applies to it

Failed imports use strikes. They are a discrete verdict from Arr, re-checked every
five minutes, not a continuous speed measurement.

## Safety decisions

- Failed imports are only acted on for a completed torrent in exactly one Arr queue
  through a qBittorrent client, with grabbed history (the recovery ownership proof).
- Forced import only imports files Arr has identified and has rejected for temporary
  reasons only. It never overrides a permanent rejection.
- The private flag is read from qBittorrent. If it is unknown, the torrent is treated
  as private, so "ignore private" fails closed.
- Seeding and unlinked cleanup never touch an incomplete torrent or one still in an
  Arr queue, because Arr has not finished importing it.
- File deletion is allowed only when it cannot lose the last copy. Every media file
  must have another hardlink, or Arr history must show that this download was
  imported. Unmappable paths fail closed.
- History counts freed bytes only for files that were the last link to their data.
- The content blocker matches file names only. It cannot see inside archives before
  they download, so the list blocks archive types by extension.

## Tests

A mock qBittorrent and Arr HTTP server on an ephemeral port, plus temporary
directories with real hardlinks. Coverage: strikes, ignore lists, pattern matching,
evaluation of each rule, job phases with revalidation, ntfy delivery, settings
validation, and a regression test showing that recovery honours alternative speed
limits and the global ignore list.
