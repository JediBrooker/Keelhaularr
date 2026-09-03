# Keelhaularr

Keelhaularr is a self-hosted cargo-control deck for Radarr and Sonarr. It finds
tracked media files above a configured MB/min limit plus an absolute oversize
tolerance, and it can compare real library folders with both *arr databases to
find orphaned media.

Scan findings are never acted on automatically. File actions are selected in
the interface, confirmed, and revalidated on the server before they run.
Oversized files can be checked against live indexers for a compliant replacement
before anything is removed, and can be moved to the recoverable Brig instead of
being deleted outright.
Optional Brig retention can purge already-quarantined files, and the separate
qBittorrent recovery policy can remove eligible partial torrents through Arr.
Both destructive automations are opt-in and disabled by default.

## Features

- Radarr and Sonarr connections with independent settings
- Oversized movie and episode scanning
- Multi-episode Sonarr runtime calculations
- Fresh Radarr/Sonarr searches after tracked files are removed
- Replacement availability checks against Radarr/Sonarr interactive search before removal
- Optional policy that refuses to remove an oversized file with no compliant replacement
- Recoverable Brig quarantine for oversized files as well as untracked files
- Filesystem orphan scanning against the files actually tracked by each app
- Inode-based hardlink integrity checks for completed torrent/download folders
- Optional qBittorrent guard that withholds every incomplete torrent from orphan actions
- Opt-in automatic recovery for continuously slow or stalled qBittorrent downloads
- Recoverable orphan quarantine or confirmed permanent deletion per selected batch
- Built-in login, HttpOnly signed sessions, and login rate limiting
- API keys kept server-side
- Authenticated GUI settings with immediate apply and durable, atomic storage
- Server-side folder autocomplete for library, completed-download, and quarantine paths
- Durable background jobs, restart recovery, cancellation, retries, and item history
- Replacement search/download status tracking
- Optional per-quality size limits read directly from Radarr and Sonarr
- Search, sorting, minimum-overage filters, predicate batch selection, and a persistent ignore list
- Per-file explanation of why a file exceeds its limit, and where that limit came from
- Card layout so the manifest is usable on a phone
- Brig interface for restoring or purging quarantined files
- Optional automatic quarantine retention
- Scheduled scan reports with generic, Discord, or Gotify webhooks
- Storage access, free-space, and filesystem compatibility checks
- Installer checks that block normal updates during active file jobs

## Quick start with Docker Compose

### One-command Debian/Proxmox LXC installer

Inside a fresh Debian 11, 12, or 13 LXC, paste:

```bash
apt-get update && apt-get install -y ca-certificates curl && curl -fsSL "https://raw.githubusercontent.com/JediBrooker/Keelhaularr/main/install.sh?v=$(date +%s)" -o /tmp/install-keelhaularr.sh && bash /tmp/install-keelhaularr.sh
```

The installer uses Docker's official Debian repository, installs Docker Engine
and the Compose plugin when needed, and asks only for a login username and
password. It automatically exposes conventional storage roots such as `/data`,
`/mnt`, `/media`, `/storage`, `/torrents`, `/usenet`, and `/downloads`, plus
non-system mount points detected inside the LXC. It then starts Keelhaularr and
verifies its health endpoint.

Sign in at the printed URL and the **First voyage setup** screen opens
automatically. Radarr/Sonarr URLs, API keys, qBittorrent credentials,
independent size limits, media and download roots, path mappings, quarantine,
and all scanner controls are entered there. Testing an *arr connection copies its API-reported media roots
into the empty path fields. A mistake in the GUI can simply be corrected and
saved; the terminal installer does not need to be restarted.

The installer is safe to rerun for updates and preserves existing settings. If
a new storage mount is added to the LXC later, rerun the installer once and it
will expose the newly detected mount without repeating application setup.

### Update an existing installation

Run the same installer command inside the LXC:

```bash
curl -fsSL "https://raw.githubusercontent.com/JediBrooker/Keelhaularr/main/install.sh?v=$(date +%s)" -o /tmp/install-keelhaularr.sh && bash /tmp/install-keelhaularr.sh
```

Existing settings and the `/config` data are preserved. From version 1.1 onward,
the installer checks for active file jobs before updating and again after the
build, before restarting the container. Let those jobs finish, or use
**Operations → Jobs → Cancel remaining** and wait until cancellation finishes.
Do not start new jobs while running an update. `FORCE_UPDATE=1` bypasses the
guard for emergency recovery; unfinished durable jobs resume after restart.

Older versions did not persist in-flight actions. Let any old-version deletion
finish before installing this release for the first time.

For a Proxmox LXC, enable the required features on the Proxmox host before
running the installer:

```bash
pct set <CTID> -features nesting=1,keyctl=1
```

Restart the LXC afterward and ensure the movie, TV, and completed-download mount
points are visible and writable inside it. Placing them beneath `/data` or
`/mnt` gives the simplest browser setup because the paths remain identical
inside Keelhaularr.

### Manual Compose installation

1. Copy the settings template:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set at least:

   - `APP_PASSWORD`
   - `APP_SESSION_SECRET`
   - `RADARR_URL` and `RADARR_API_KEY`
   - `SONARR_URL` and `SONARR_API_KEY`
   - `RADARR_MEDIA_ROOTS` and `SONARR_MEDIA_ROOTS`

   To check completed downloads for broken or stale hardlinks, also set
   `RADARR_DOWNLOAD_ROOTS` and `SONARR_DOWNLOAD_ROOTS`. Add
   `QBITTORRENT_URL`, `QBITTORRENT_USERNAME`, and `QBITTORRENT_PASSWORD` to
   guarantee that incomplete torrents are withheld. Automatic recovery remains
   off unless its separate destructive policy is explicitly enabled.

3. Copy and edit the Compose example:

   ```bash
   cp compose.example.yml compose.yml
   ```

   Change the host-side volume paths. Mount the libraries using the same paths
   that Radarr and Sonarr report where possible. Otherwise configure
   `RADARR_PATH_MAPS` or `SONARR_PATH_MAPS`.

4. Protect the settings and start the app:

   ```bash
   mkdir -p config
   chmod 700 config
   chmod 600 .env
   docker compose up -d --build
   ```

5. Open `http://your-server:8787` and sign in with `APP_USERNAME` and
   `APP_PASSWORD`.

## Run directly with Node

Node.js 22.13 or later is required.

```bash
cp .env.example .env
npm install
npm run build
npm start
```

For local development:

```bash
npm run dev
```

The development interface is on port 3000. The production interface and API
are both served on `PORT`, which defaults to 8787.

## GUI settings

On a fresh installation, **First voyage setup** opens immediately after login.
Later, open **Settings** in the top bar. The interface manages login
credentials and sessions, shared and per-app size rules, Radarr/Sonarr URLs and
API keys, the qBittorrent safety and recovery connection, unmonitored-media
behavior, media roots, completed-download roots, hardlink minimum age, path
mappings, quarantine, the require-a-replacement policy, ignored directories,
scan limits, and media extensions. Connection tests are available before
saving and automatically fill empty library-folder fields. The qBittorrent test
also discovers exact category names for recovery exclusions; saved connections
refresh that list whenever Settings opens. Missing categories already selected
as exclusions remain visible until explicitly removed. Folders use individual
add/remove rows; path mapping is kept in a collapsed advanced section because
normal installer-based deployments use identical paths and do not need it.

Library, completed-download, and quarantine fields discover folders as you
type. Start with `/data/` (or another mounted path), click a suggestion to look
inside, then choose **Use this folder**. An empty field suggests available
storage roots. Arrow keys and Enter navigate suggestions; Tab accepts a
highlighted folder, and Escape closes the list. Read-only folders and missing
paths are indicated before saving. You may still enter a new quarantine path;
browsing itself never creates directories.

Suggestions come from the Keelhaularr server/container, not your browser's
computer. A host folder must be mounted into Docker/LXC before it can appear.
The authenticated browser lists only one directory level at a time, never file
contents, and does not suggest symbolic links or device/process directories.

Passwords and API keys are write-only: the browser receives only a flag saying
whether each secret exists. Saved values take effect immediately and are
written atomically to `config/settings.json` with mode `0600`. They override
the bootstrap `.env` and survive container rebuilds through the `/config`
volume. The externally published web port remains a Docker Compose deployment
setting and is therefore shown with instructions rather than edited at runtime.

## Size rules

For each file, Keelhaularr calculates:

```text
configured limit = runtime in minutes × maximum MiB/min
effective limit  = configured limit + oversize tolerance in GiB
```

Only files larger than the effective limit are shown. A file exactly equal to
the effective limit is kept.

The default values are:

```dotenv
MAX_MB_PER_MIN=85
OVERSIZE_TOLERANCE_GIB=1
```

These can be overridden independently:

```dotenv
RADARR_MAX_MB_PER_MIN=85
RADARR_OVERSIZE_TOLERANCE_GIB=1
SONARR_MAX_MB_PER_MIN=85
SONARR_OVERSIZE_TOLERANCE_GIB=1
```

Each application also has a **Use quality-definition limits** toggle in Settings:

```dotenv
RADARR_USE_ARR_QUALITY_DEFINITIONS=true
SONARR_USE_ARR_QUALITY_DEFINITIONS=true
```

When enabled, each file is checked against the maximum MB/min for its actual
quality in that application's quality definitions. The per-app tolerance still
applies. If there is no usable matching maximum, Keelhaularr uses its configured
MB/min fallback; a failed quality-definition request also produces a warning.
This does not create or modify custom formats, quality profiles, or definitions.

When a selected tracked file is removed, Keelhaularr queues `MoviesSearch` in
Radarr or `EpisodeSearch` in Sonarr. The replacement is evaluated using the
quality profiles and definitions already configured in that application.

## Checking for a replacement before removing anything

Removing an oversized file and then searching is a gamble: the indexers may have
nothing smaller, or may only offer the same bloated release again. **Check
replacements** beside the batch controls asks each application's interactive
search what it could actually get right now, and reports the verdict per row:

- **Replacement found** with the size and quality of the best fitting release
- **No compliant replacement** when nothing offered fits
- **Replacement check failed** when the search errored or timed out

A release only counts when it fits the same effective limit that flagged the file
**and** is smaller than the file already on disk, and when the application has not
already rejected it for its own profile or custom-format reasons. The largest
release that still fits is preferred, because it is the best quality within the
limit. The check is read-only: it never removes, moves, or downloads anything.

Interactive search queries live indexers, so it is only ever run when you press
the button, in batches of up to 50 selected files, and never automatically during
a scan.

To make the check binding rather than advisory, enable it in
**Settings → Untracked files & quarantine**:

```dotenv
OVERSIZE_REQUIRE_REPLACEMENT=false
```

When enabled, every oversized file is re-checked immediately before it is removed,
not when the job was approved. A file with no compliant replacement is preserved
and its job item records why. A failed or ambiguous search also preserves the file:
the check fails closed. This is off by default so upgrading does not change how
existing installations behave.

## Removing or quarantining an oversized file

Confirming an oversized selection offers **Cancel**, **Quarantine**, and **Delete
permanently**; permanent removal requires a second confirmation. Both paths request
a replacement search afterwards.

**Quarantine** moves the file into the Brig *before* the Radarr or Sonarr record is
removed, so an interrupted job leaves the file recoverable rather than gone. The
file is re-checked immediately before the move, and is preserved if its size no
longer matches what the application reported, which means the record is stale and a
fresh scan is needed.

Quarantine needs the file to be reachable inside a configured media root. If an
application reports a path Keelhaularr cannot resolve to a local file - a remote
instance without a matching path mapping, for example - quarantine is refused for
that file rather than guessing, and permanent removal remains available.

Restoring an oversized file from the Brig puts the file back at its original path,
but its Radarr or Sonarr database record was already removed. Rescan the folder in
that application to pick the file back up.

Sonarr specials are skipped because Sonarr itself does not apply its standard
runtime-based size check to special releases. Files with unknown runtimes are
also skipped by Sonarr checks. Radarr's runtime fallback is 110 minutes.

## Jobs and replacement tracking

Open **Operations → Jobs** to follow confirmed actions. Work is stored in
`config/jobs.json` before it starts and runs independently of the browser.
Closing a tab does not stop a job. The latest 100 jobs are retained, including
all active jobs, with per-file outcomes and errors.

- **Cancel remaining** stops untouched items. An already-deleted tracked file
  still gets its replacement search request.
- **Retry failures** retries failed items without repeating successful ones.
- Restarting resumes unfinished items. If a delete succeeded but its response
  was lost, an already-missing original file is accepted and its search resumes.
- A job is **completed** when its file actions and search requests finish, not
  when all downloads finish. Expand item progress for separate replacement
  statuses: searching, download queued, downloaded, no result, or search failed.

Replacement monitoring runs in small rotating batches. Downloads remain under
Radarr/Sonarr and the download client's control; Keelhaularr cannot guarantee a
matching release exists. A crash at the moment a search is accepted can cause
the search to be requested again, but recovery targets the original file ID,
not a newly imported replacement. Changing an application's URL while a job is
active withholds that job's actions until the original connection is restored.

Automatic qBittorrent recovery also uses durable jobs. Expand one to see the
torrent name, exact category, slow/stalled reason, destructive phase, and later
replacement status. Its phases distinguish revalidation, Arr removal and
blocklisting, qBittorrent removal confirmation, and the single replacement
search request. A failed or ambiguous phase is preserved for inspection and
does not advance to a search.

## Manifest controls and ignore list

Search by title, quality, or path; filter by application; sort by size, overage,
title, or orphan age; and set a minimum overage/size in GiB.

**Quick select** picks files by the numbers rather than by position:

- **Everything shown** takes the whole current filtered view
- **At least 2× / 3× its limit** selects by how far each file exceeds *its own*
  effective limit, so a short episode and a long film are judged on equal terms
- **Top 10 / Top 25 by wasted space** ranks by overage for size-limit results and
  by file size for untracked results
- **First 25 / First 100 in this order** follow whatever sort is applied

Each size-limit row also explains *why* it was flagged: how many times over its
limit it is, and the bitrate it actually uses against the maximum allowed, for
example `3.2× its limit · 299 vs 85 MB/min`. Hovering the allowed figure shows
where that limit came from - your configured MB/min, the application's quality
definition for that file, or the Keelhaularr fallback when no definition matched.

On a narrow screen the manifest becomes one labelled card per file instead of a
horizontally scrolling table, so results are readable on a phone.

**Ignore selected** adds the current selection to a persistent ignore list. For
size-limit results, the ignored scope is the Radarr movie or Sonarr episode, so
later replacement files for that same item stay hidden from size-limit scans.
For untracked results, the ignored scope is the exact filesystem path, so only
that path stays hidden from future untracked-file scans.

Open **Ignore list** beside the scan-result tabs, or use **Operations → Ignore
list**, to review ignored items. Removing an item from the list makes it eligible
to appear again on the next scan. Ignoring a size-limit result does not disable
untracked-file checks for its paths, and ignoring an untracked path does not
disable size-limit checks for a tracked movie or episode.

## Orphan scanning

Set separate local roots for the two applications:

```dotenv
RADARR_MEDIA_ROOTS=/movies
SONARR_MEDIA_ROOTS=/tv
```

Multiple roots are comma-separated. Keelhaularr recursively scans recognised
media extensions and compares the exact paths with files tracked through each
application's API. Symbolic links and ignored directory names are not followed.

If the paths reported by an application differ from the paths mounted into
Keelhaularr, add path mappings:

```dotenv
RADARR_PATH_MAPS=/data/movies=>/movies
SONARR_PATH_MAPS=/data/tv=>/tv
```

Multiple mappings are separated by semicolons.

### Completed downloads and broken hardlinks

Keelhaularr can also inspect completed torrent or download folders:

```dotenv
RADARR_DOWNLOAD_ROOTS=/radarr-downloads
SONARR_DOWNLOAD_ROOTS=/sonarr-downloads
HARDLINK_MIN_AGE_HOURS=24
```

The comparison uses the filesystem device and inode—not filenames. A healthy
hardlink therefore has the same identity and exact size in both the completed
download folder and the matching application library. If a 35 GiB torrent file
and a 3.6 GiB Radarr library file have different sizes, they cannot currently
be hardlinks; the larger file will be shown as a broken-hardlink orphan when no
other file with its identity exists in the Radarr media roots.

Point these settings only at completed, app-specific folders such as
`/torrents/movies` and `/torrents/tv`, never an incomplete download directory.
Newly modified unlinked files are withheld for 24 hours by default so Radarr or
Sonarr has time to import them. The age is configurable in Settings. A selected
file is fully rescanned and its inode and size are checked again immediately
before quarantine or deletion; if a library hardlink appeared in the meantime,
the download copy is withheld.

For a stronger guarantee, connect qBittorrent in Settings or configure:

```dotenv
QBITTORRENT_URL=http://qbittorrent:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=your-web-ui-password
QBITTORRENT_PATH_MAPS=/downloads/movies=>/radarr-downloads;/downloads/tv=>/sonarr-downloads
```

Keelhaularr reads qBittorrent's torrent list and excludes the entire content
path of every torrent whose progress is below 100% or whose remaining byte
count is nonzero. That covers incomplete downloads even when they are paused,
stalled, or queued. Completed and seeding torrents remain eligible for the
normal broken-hardlink check. qBittorrent 4.3.3 or newer is required because
the guard relies on the Web API's `content_path` field. The guard is queried
during each scan, when a job is created, at job preflight, and again immediately
before each download file is changed.

The guard fails closed: when a configured qBittorrent server cannot be reached
or authenticated, or an incomplete path cannot be mapped safely, all
completed-download orphan results are withheld while library orphan scanning
continues. If qBittorrent and Keelhaularr see different paths, add mappings from
the qBittorrent path to the Keelhaularr container path. Mapping does not mount a
folder; the completed-download directories must still be bind-mounted.

Every incomplete torrent path is validated. A mixed-purpose qBittorrent client
with an unrelated active download outside these roots therefore withholds all
download-root orphan results until that job finishes. This deliberately favors
preservation over guessing which torrents belong to an *arr application.

The Web UI URL must be reachable from inside the Keelhaularr container. A
Docker service name works when both containers share a network; otherwise use a
reachable LAN address. Prefer an isolated Docker/LAN HTTP connection or HTTPS
with a certificate trusted by the container.

Docker can only see host paths that are bind-mounted into it. For installer
deployments, rerun the one-command installer to add or change completed-download
mounts. You can then edit their container paths and every other scanner setting
from the GUI.

The quarantine destination is configurable:

```dotenv
ORPHAN_TRASH_DIR=/quarantine
```

When acting on selected untracked files, the confirmation dialog offers
**Cancel**, **Quarantine**, and **Delete permanently**. Permanent deletion
requires a second confirmation.

## Automatic qBittorrent recovery

Automatic recovery is a separate, destructive feature. It is disabled by
default and can be enabled only when qBittorrent and at least one Radarr or
Sonarr connection are configured. Enabling the toggle is the explicit opt-in:
once an eligible torrent passes every safety gate, no per-torrent confirmation
is shown.

The default policy is:

```dotenv
QBITTORRENT_RECOVERY_ENABLED=false
QBITTORRENT_RECOVERY_SLOW_KIB_PER_SECOND=100
QBITTORRENT_RECOVERY_SLOW_MINUTES=30
QBITTORRENT_RECOVERY_STALLED_MINUTES=30
QBITTORRENT_RECOVERY_EXCLUDED_CATEGORIES_JSON=[]
```

The speed is KiB per second; `0` disables slow-speed detection without
disabling stalled detection. Durations are whole minutes. Category exclusions
are an exact JSON string array: matching is case- and space-sensitive, and `""`
selects **Uncategorized**. Disabling recovery does not erase thresholds or
exclusions. Settings discovers categories from the saved connection, while a
successful test of unsaved credentials replaces the displayed discovery list.

Eligibility is deliberately narrow. The torrent must still be incomplete and
must remain either exactly `downloading` below the configured speed or exactly
`stalledDL` for its full threshold. Paused, queued, forced, checking, metadata,
uploading, completed, malformed, and unknown states are left untouched. The
server polls once per minute and records the observation durably, but the timer
must be continuous for the same hash, reason, and category. Recovery being
disabled, a policy or connection change, a qBittorrent outage, disappearance
from eligibility, or a changed reason/category resets the observation window.

After the timer matures, Keelhaularr still requires exact ownership proof. The
opaque torrent hash must match exactly one torrent queue record across the
configured Arr apps; that record must resolve to exactly one enabled
qBittorrent download client; and grabbed history must identify exactly one
Radarr movie or one Sonarr series with explicit episode IDs. The hash, policy,
category, reason, queue record, download client, and search target are checked
again immediately before action. Ambiguous, missing, malformed, changed, or
unreachable evidence fails closed and preserves the torrent.

For a proven candidate, Keelhaularr asks the owning Arr app to remove the queue
item from qBittorrent **with its partial data**, blocklist the bad release, and
suppress Arr's implicit redownload. It then verifies that qBittorrent no longer
lists the exact hash before issuing one explicit replacement search for the
same movie or episode set. If removal cannot be proven, no search is queued. If
a restart makes an accepted search ambiguous, Keelhaularr refuses to queue a
duplicate. The durable job and its phases remain visible under **Operations →
Jobs**.

This policy does not make guesses from names, paths, categories, or a generic
“torrent” download-client label. Category exclusions are a convenience filter;
the hash and qBittorrent-backed Arr ownership proof remain mandatory for every
non-excluded candidate.

## The Brig

Open **Operations → Brig** to restore a quarantined file to its original path
or permanently purge it. Restore refuses to overwrite an existing file. The
original root must still be available to Keelhaularr. Metadata is retained when
you change the quarantine folder, so existing recorded files remain manageable.

Quarantine keeps all files indefinitely unless you set a retention period:

```dotenv
QUARANTINE_RETENTION_DAYS=0
```

A positive number permanently purges recorded Brig files older than that many
days. This policy runs independently of scheduled scans. Set it only when you
want automatic deletion of expired quarantined files. Quarantine on the same
filesystem does not reclaim disk space until files are purged.

The Brig holds both untracked files and oversized files that were quarantined
rather than deleted. Restoring an oversized file returns it to disk but not to its
application's database; rescan that folder in Radarr or Sonarr afterwards.

The Brig tracks files quarantined by version 1.1 and later. Files quarantined by
older versions are left untouched in their existing folders and are not
automatically imported or purged.

## Scheduled reports and notifications

Configure these in **Settings → Scans & notifications**, then view the latest
result or run a report now under **Operations → Schedule**:

```dotenv
SCHEDULE_ENABLED=false
SCHEDULE_INTERVAL_HOURS=24
NOTIFICATION_TYPE=generic
NOTIFICATION_WEBHOOK_URL=
NOTIFICATION_WHEN_CLEAR=false
```

Scheduled scans only report findings; they never select oversized/orphan files
for deletion. Brig retention is a separate opt-in policy. The next run and most
recent report persist across restarts. Webhook failures are shown in the report
without discarding scan results.

Webhook types are `generic` (JSON event and report), `discord` (Discord webhook
URL), and `gotify` (a Gotify message endpoint including its application token).
Webhook URLs are stored server-side and never returned to the browser. Leave
the field blank when saving to keep the current URL, or use its removal switch.

## Storage health

**Operations → Storage → Run health check** shows whether each configured root
exists and is readable/writable, plus available disk space. It also compares
filesystem device IDs between each application's completed-download folders
and library roots. Different devices cannot share hardlinks; matching devices
indicate compatibility, not proof that individual files are currently linked.
The check does not modify storage or create test files.

## Security

Use long, unrelated values for `APP_PASSWORD` and `APP_SESSION_SECRET`. The
login issues an HttpOnly, SameSite=Strict signed cookie. Failed logins are
limited per client address.

For access outside a trusted LAN, put Keelhaularr behind an HTTPS reverse proxy
and set:

```dotenv
APP_COOKIE_SECURE=true
```

Radarr and Sonarr API keys and the qBittorrent password entered in Settings are
never returned to the browser. They are stored unencrypted in the private
`config/settings.json` file (mode `0600`), so do not commit or casually copy
`.env` or `config/settings.json`.

## Uninstall

Run this inside the Debian LXC:

```bash
curl -fsSL "https://raw.githubusercontent.com/JediBrooker/Keelhaularr/main/uninstall.sh?v=$(date +%s)" -o /tmp/uninstall-keelhaularr.sh && bash /tmp/uninstall-keelhaularr.sh
```

By default, the service, container, network, and locally built image are
removed, then `/opt/keelhaularr` is moved to a timestamped backup so settings
and any locally stored quarantine remain recoverable. Docker Engine, other
containers, mounted media, and external quarantine folders are untouched.

To permanently remove the installation and its local settings instead:

```bash
bash /tmp/uninstall-keelhaularr.sh --purge
```
