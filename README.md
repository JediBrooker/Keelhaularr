# Keelhaularr

Keelhaularr is a self-hosted cargo-control deck for Radarr and Sonarr. It finds
tracked media files above a configured MB/min limit plus an absolute oversize
tolerance, and it can compare real library folders with both *arr databases to
find orphaned media.

Nothing is deleted automatically. Every destructive action is selected in the
interface, confirmed with a typed phrase, and revalidated on the server before
it runs.

## Features

- Radarr and Sonarr connections with independent settings
- Oversized movie and episode scanning
- Multi-episode Sonarr runtime calculations
- Fresh Radarr/Sonarr searches after tracked files are removed
- Filesystem orphan scanning against the files actually tracked by each app
- Recoverable orphan quarantine by default
- Optional permanent orphan deletion with an explicit server-side enable flag
- Built-in login, HttpOnly signed sessions, and login rate limiting
- API keys kept server-side

## Quick start with Docker Compose

### One-command Debian/Proxmox LXC installer

Inside a fresh Debian 11, 12, or 13 LXC, paste:

```bash
apt-get update && apt-get install -y ca-certificates curl && curl -fsSL "https://raw.githubusercontent.com/JediBrooker/Keelhaularr/main/install.sh?v=$(date +%s)" -o /tmp/install-keelhaularr.sh && bash /tmp/install-keelhaularr.sh
```

The installer uses Docker's official Debian repository, installs Docker Engine
and the Compose plugin when needed, validates the media mount points, collects
the login and *arr settings interactively, discovers every Radarr and Sonarr
root folder through their APIs, starts Keelhaularr, and verifies its health
endpoint. When an API-reported root is mounted at a different path in the LXC,
the installer asks only for that local mapping. It is safe to rerun for updates
and preserves existing settings.

For a Proxmox LXC, enable the required features on the Proxmox host before
running the installer:

```bash
pct set <CTID> -features nesting=1,keyctl=1
```

Restart the LXC afterward and ensure the movie/TV library bind mounts are
visible and writable inside it.

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

3. Copy and edit the Compose example:

   ```bash
   cp compose.example.yml compose.yml
   ```

   Change the host-side volume paths. Mount the libraries using the same paths
   that Radarr and Sonarr report where possible. Otherwise configure
   `RADARR_PATH_MAPS` or `SONARR_PATH_MAPS`.

4. Protect the settings and start the app:

   ```bash
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

When a selected tracked file is removed, Keelhaularr queues `MoviesSearch` in
Radarr or `EpisodeSearch` in Sonarr. The replacement is evaluated using the
quality profiles and definitions already configured in that application.

Sonarr specials are skipped because Sonarr itself does not apply its standard
runtime-based size check to special releases. Files with unknown runtimes are
also skipped to avoid false positives.

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

The default orphan action is recoverable quarantine:

```dotenv
ORPHAN_ACTION=quarantine
ORPHAN_TRASH_DIR=/quarantine
```

Permanent deletion must be enabled with both settings:

```dotenv
ORPHAN_ACTION=permanent
ALLOW_PERMANENT_ORPHAN_DELETE=true
```

The interface clearly labels the active action and requires a stronger typed
confirmation for permanent removal.

## Security

Use long, unrelated values for `APP_PASSWORD` and `APP_SESSION_SECRET`. The
login issues an HttpOnly, SameSite=Strict signed cookie. Failed logins are
limited per client address.

For access outside a trusted LAN, put Keelhaularr behind an HTTPS reverse proxy
and set:

```dotenv
APP_COOKIE_SECURE=true
```

Never expose Radarr or Sonarr API keys in browser-side settings or commit `.env`
to source control.
