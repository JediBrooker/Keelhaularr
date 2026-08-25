#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

REPO_URL="https://github.com/JediBrooker/Keelhaularr.git"
INSTALL_DIR="${INSTALL_DIR:-/opt/keelhaularr}"
TTY_DEVICE="/dev/tty"

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  TEAL=$'\033[38;5;37m'
  GOLD=$'\033[38;5;178m'
  RED=$'\033[38;5;160m'
  RESET=$'\033[0m'
else
  BOLD="" TEAL="" GOLD="" RED="" RESET=""
fi

info() { printf '%s[Keelhaularr]%s %s\n' "$TEAL" "$RESET" "$*"; }
warn() { printf '%s[Warning]%s %s\n' "$GOLD" "$RESET" "$*" >&2; }
die() { printf '%s[Error]%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

ensure_no_active_job() {
  if [[ -s "$INSTALL_DIR/config/jobs.json" && "${FORCE_UPDATE:-0}" != "1" ]] \
    && grep -Eq '"status"[[:space:]]*:[[:space:]]*"(queued|running|cancelling)"' "$INSTALL_DIR/config/jobs.json"; then
    die "Keelhaularr has an active file job. Let it finish or cancel it in Jobs before updating. Use FORCE_UPDATE=1 only for an emergency interruption."
  fi
}

on_error() {
  local line="$1"
  printf '%s[Error]%s Installation stopped near line %s.\n' "$RED" "$RESET" "$line" >&2
  printf 'Fix the reported problem and run the same installer again; existing settings will be preserved.\n' >&2
}
trap 'on_error "$LINENO"' ERR

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Keelhaularr Debian/LXC installer

Run as root inside a Debian 11, 12, or 13 LXC:
  bash install.sh

Optional environment variable:
  INSTALL_DIR=/opt/keelhaularr
  FORCE_UPDATE=1  (only when you intentionally want to interrupt an active job)

Fresh installs ask only for the web username and password. Application setup is
completed in the browser. The installer is safe to rerun; existing settings are kept.
HELP
  exit 0
fi

[[ "${EUID}" -eq 0 ]] || die "Run this installer as root inside the Debian LXC."
[[ -r "$TTY_DEVICE" ]] || die "An interactive terminal is required. Download the script first, then run it with bash."
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || die "INSTALL_DIR must be an absolute path other than /."

read_value() {
  local variable="$1" prompt="$2" default="${3:-}" secret="${4:-false}" value=""
  if [[ -n "${!variable:-}" ]]; then return 0; fi
  if [[ "$secret" == "true" ]]; then
    read -r -s -p "$prompt" value <"$TTY_DEVICE"
    printf '\n' >"$TTY_DEVICE"
  else
    if [[ -n "$default" ]]; then
      read -r -p "$prompt [$default]: " value <"$TTY_DEVICE"
      value="${value:-$default}"
    else
      read -r -p "$prompt: " value <"$TTY_DEVICE"
    fi
  fi
  printf -v "$variable" '%s' "$value"
}

confirm() {
  local prompt="$1" default="${2:-y}" answer=""
  local suffix='[y/N]'
  [[ "$default" == "y" ]] && suffix='[Y/n]'
  read -r -p "$prompt $suffix " answer <"$TTY_DEVICE"
  answer="${answer:-$default}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

require_absolute_directory() {
  local label="$1" directory="$2"
  [[ "$directory" != *$'\n'* && "$directory" != *$'\r'* && "$directory" != *$'\t'* && "$directory" != *,* ]] || die "$label cannot contain line breaks, tabs, or commas."
  [[ "$directory" == /* ]] || die "$label must be an absolute path."
  [[ "$directory" != "/" ]] || die "$label cannot be the filesystem root."
  [[ -d "$directory" ]] || die "$label does not exist: $directory. Add the Proxmox mount point, then rerun the installer."
  [[ -r "$directory" ]] || die "$label is not readable: $directory"
  [[ -w "$directory" ]] || die "$label is not writable: $directory. Write access is required for orphan handling."
}

join_csv() {
  local -n values="$1"
  local -n result="$2"
  local old_ifs="$IFS"
  IFS=,
  result="${values[*]}"
  IFS="$old_ifs"
}

validate_separate_paths() {
  local -n values="$1"
  local first second
  for ((first = 0; first < ${#values[@]}; first++)); do
    for ((second = first + 1; second < ${#values[@]}; second++)); do
      paths_overlap "${values[$first]}" "${values[$second]}" && die "Scan roots must be separate and cannot contain one another: ${values[$first]} and ${values[$second]}"
    done
  done
}

load_download_root_state() {
  local state_path="$1" kind source target
  [[ -s "$state_path" ]] || return 0
  while IFS=$'\t' read -r kind source target; do
    [[ -n "$kind" && -n "$source" && -n "$target" ]] || continue
    require_absolute_directory "Saved $kind completed-download path" "$source"
    case "$kind" in
      radarr) RADARR_DOWNLOAD_PATHS+=("$source"); RADARR_DOWNLOAD_CONTAINER_PATHS+=("$target") ;;
      sonarr) SONARR_DOWNLOAD_PATHS+=("$source"); SONARR_DOWNLOAD_CONTAINER_PATHS+=("$target") ;;
      *) die "Invalid entry in $state_path" ;;
    esac
  done <"$state_path"
}

save_download_root_state() {
  local state_path="$1" index
  {
    for index in "${!RADARR_DOWNLOAD_PATHS[@]}"; do
      printf 'radarr\t%s\t%s\n' "${RADARR_DOWNLOAD_PATHS[$index]}" "${RADARR_DOWNLOAD_CONTAINER_PATHS[$index]}"
    done
    for index in "${!SONARR_DOWNLOAD_PATHS[@]}"; do
      printf 'sonarr\t%s\t%s\n' "${SONARR_DOWNLOAD_PATHS[$index]}" "${SONARR_DOWNLOAD_CONTAINER_PATHS[$index]}"
    done
  } >"$state_path"
  chmod 600 "$state_path"
}

discover_storage_roots() {
  local -n roots="$1"
  local candidate logical resolved existing skip
  local -a candidates=(/data /mnt /media /storage /torrents /torrent /usenet /downloads /srv/media)

  while IFS= read -r candidate; do
    candidates+=("$candidate")
  done < <(findmnt -rn -o TARGET 2>/dev/null || true)

  roots=()
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && "$candidate" == /* && -d "$candidate" && -r "$candidate" && -w "$candidate" ]] || continue
    logical="${candidate%/}"
    resolved="$(realpath -m "$candidate")"
    case "$logical" in
      /|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/home|/home/*|/opt|/opt/*|/proc|/proc/*|/root|/root/*|/run|/run/*|/sys|/sys/*|/tmp|/tmp/*|/var|/var/*) continue ;;
    esac
    case "$resolved" in
      /|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/home|/home/*|/opt|/opt/*|/proc|/proc/*|/root|/root/*|/run|/run/*|/sys|/sys/*|/tmp|/tmp/*|/var|/var/*) continue ;;
    esac
    skip=false
    for existing in "${roots[@]}"; do
      if [[ "$logical" == "$existing" || "$logical" == "$existing"/* ]]; then
        skip=true
        break
      fi
    done
    [[ "$skip" == "true" ]] || roots+=("$logical")
  done
}

env_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "Settings cannot contain line breaks."
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\$\$}"
  printf '"%s"' "$value"
}

yaml_quote() {
  local value="$1"
  value=${value//\'/\'\'}
  printf "'%s'" "$value"
}

paths_overlap() {
  local first second
  first="$(realpath -m "$1")"
  second="$(realpath -m "$2")"
  [[ "$first" == "$second" || "$first" == "$second"/* || "$second" == "$first"/* ]]
}

is_lxc=false
if command -v systemd-detect-virt >/dev/null 2>&1 && [[ "$(systemd-detect-virt --container 2>/dev/null || true)" == "lxc" ]]; then
  is_lxc=true
fi

printf '\n%s%sKeelhaularr — Debian LXC installer%s\n' "$BOLD" "$GOLD" "$RESET"
printf 'Installs Docker and starts the protected web interface. Application setup happens in the browser.\n\n'

if [[ "$is_lxc" == "true" ]]; then
  warn "Proxmox must allow Docker features on this LXC."
  printf 'On the Proxmox host, the container normally needs:\n'
  printf '  pct set <CTID> -features nesting=1,keyctl=1\n'
  printf 'Then restart the LXC before continuing. Media bind mounts must also already be visible inside this LXC.\n\n'
else
  warn "This system was not detected as LXC. Installation can continue on supported Debian hosts."
fi

[[ -r /etc/os-release ]] || die "Cannot identify the operating system."
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "This installer supports Debian. Detected: ${PRETTY_NAME:-unknown}."
case "${VERSION_CODENAME:-}" in
  bullseye|bookworm|trixie) ;;
  *) die "Docker's supported Debian codenames are bullseye, bookworm, and trixie. Detected: ${VERSION_CODENAME:-unknown}." ;;
esac

configure_docker_repository() {
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
}

remove_conflicting_docker_packages() {
  local conflicts=()
  local package
  for package in docker.io docker-compose docker-doc docker-buildx podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      conflicts+=("$package")
    fi
  done
  if (( ${#conflicts[@]} == 0 )); then
    return 1
  fi

  warn "Conflicting Docker packages are installed: $(IFS=', '; printf '%s' "${conflicts[*]}")"
  confirm "Remove them so Docker CE and Compose can be installed?" "n" || die "Docker CE installation cancelled."
  apt-get remove -y "${conflicts[@]}"
  return 0
}

install_docker() {
  local removed_conflicts=false
  export DEBIAN_FRONTEND=noninteractive
  info "Installing required system tools…"
  apt-get update
  apt-get install -y ca-certificates curl git openssl

  if ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker Engine from Docker's official Debian repository…"
    remove_conflicting_docker_packages || true
    configure_docker_repository
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git openssl
  else
    info "Docker CLI is already installed."
  fi

  if ! docker compose version >/dev/null 2>&1; then
    info "Installing the Docker Compose plugin…"
    configure_docker_repository
    if remove_conflicting_docker_packages; then
      removed_conflicts=true
    fi
    apt-get update
    if [[ "$removed_conflicts" == "true" ]]; then
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    else
      apt-get install -y docker-compose-plugin
    fi
  fi

  systemctl enable --now docker
  if ! docker info >/dev/null 2>&1; then
    die "Docker could not start. In Proxmox, stop the LXC and enable nesting=1,keyctl=1, then start it and rerun this installer."
  fi
  docker compose version >/dev/null 2>&1 || die "Docker Compose is unavailable after installation."
}

install_docker
ensure_no_active_job

if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
  if [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "$INSTALL_DIR exists and is not a Keelhaularr git checkout. Move it aside or set INSTALL_DIR to another path."
  fi
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  current_remote="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$current_remote" == "$REPO_URL" || "$current_remote" == "https://github.com/JediBrooker/Keelhaularr" ]] || die "$INSTALL_DIR points at a different git repository."
  info "Updating the existing Keelhaularr checkout…"
  git -C "$INSTALL_DIR" fetch origin main
  git -C "$INSTALL_DIR" switch main
  git -C "$INSTALL_DIR" pull --ff-only origin main
else
  info "Downloading Keelhaularr…"
  install -d -m 0755 "$(dirname "$INSTALL_DIR")"
  git clone --branch main --single-branch "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

install -d -m 0700 "$INSTALL_DIR/config"
DOWNLOAD_STATE_PATH="$INSTALL_DIR/.installer-download-roots"
declare -a RADARR_DOWNLOAD_PATHS=() RADARR_DOWNLOAD_CONTAINER_PATHS=()
declare -a SONARR_DOWNLOAD_PATHS=() SONARR_DOWNLOAD_CONTAINER_PATHS=()
load_download_root_state "$DOWNLOAD_STATE_PATH"
declare -a STORAGE_PATHS=()
discover_storage_roots STORAGE_PATHS
if (( ${#STORAGE_PATHS[@]} > 0 )); then
  info "Storage available to the web setup:"
  for storage_path in "${STORAGE_PATHS[@]}"; do
    printf '  %s\n' "$storage_path"
  done
else
  warn "No conventional storage roots were found. The web interface will still start; add an LXC mount under /data, /mnt, /media, /storage, /torrents, /usenet, or /downloads and rerun this installer when filesystem scanning is needed."
fi
COMPOSE_FILES=(-f compose.yml -f compose.settings.yml)

if [[ -s .env && -s compose.yml ]]; then
  info "Existing settings found; leaving .env and compose.yml unchanged."
else
  printf '\n%sWeb login%s\n' "$BOLD" "$RESET"
  read_value APP_USERNAME "Login username" "captain"
  while :; do
    read_value APP_PASSWORD "Login password: " "" true
    [[ -n "$APP_PASSWORD" ]] || { warn "Password cannot be empty."; APP_PASSWORD=""; continue; }
    read_value APP_PASSWORD_CONFIRM "Confirm login password: " "" true
    [[ "$APP_PASSWORD" == "$APP_PASSWORD_CONFIRM" ]] && break
    warn "Passwords did not match."
    APP_PASSWORD="" APP_PASSWORD_CONFIRM=""
  done
  APP_SESSION_SECRET="$(openssl rand -hex 32)"

  info "Writing the minimal bootstrap configuration…"
  {
    printf 'APP_USERNAME=%s\n' "$(env_quote "$APP_USERNAME")"
    printf 'APP_PASSWORD=%s\n' "$(env_quote "$APP_PASSWORD")"
    printf 'APP_SESSION_SECRET=%s\n' "$(env_quote "$APP_SESSION_SECRET")"
    printf 'APP_SESSION_DAYS=30\nAPP_COOKIE_SECURE=false\n'
    printf 'MAX_MB_PER_MIN=85\nOVERSIZE_TOLERANCE_GIB=1\n'
    printf 'RADARR_URL=\nRADARR_API_KEY=\nRADARR_MEDIA_ROOTS=\nRADARR_DOWNLOAD_ROOTS=\nRADARR_PATH_MAPS=\nRADARR_INCLUDE_UNMONITORED=false\n'
    printf 'SONARR_URL=\nSONARR_API_KEY=\nSONARR_MEDIA_ROOTS=\nSONARR_DOWNLOAD_ROOTS=\nSONARR_PATH_MAPS=\nSONARR_INCLUDE_UNMONITORED=false\n'
    printf 'ORPHAN_ACTION=quarantine\nORPHAN_TRASH_DIR=/config/quarantine\n'
    printf 'HARDLINK_MIN_AGE_HOURS=24\nQUARANTINE_RETENTION_DAYS=0\n'
    printf 'SCHEDULE_ENABLED=false\nSCHEDULE_INTERVAL_HOURS=24\nNOTIFICATION_TYPE=generic\nNOTIFICATION_WEBHOOK_URL=\nNOTIFICATION_WHEN_CLEAR=false\n'
    printf 'ORPHAN_IGNORE_DIRECTORIES=extras,featurettes,trailers,samples\n'
    printf 'ORPHAN_MAX_FILES=100000\nPORT=8787\n'
  } >.env
  chmod 600 .env

  {
    printf 'services:\n  keelhaularr:\n    build: .\n    container_name: keelhaularr\n'
    printf '    restart: unless-stopped\n    env_file: .env\n'
    printf '    ports:\n      - %s\n' "$(yaml_quote '8787:8787')"
    printf '    extra_hosts:\n      - %s\n' "$(yaml_quote 'host.docker.internal:host-gateway')"
    printf '    security_opt:\n      - no-new-privileges:true\n'
    printf '    healthcheck:\n      test: [CMD, wget, -q, --spider, http://127.0.0.1:8787/api/auth/status]\n'
    printf '      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 20s\n'
    printf '    logging:\n      options:\n        max-size: 10m\n        max-file: "3"\n'
  } >compose.yml
  chmod 600 compose.yml
fi

ALL_DOWNLOAD_PATHS=("${RADARR_DOWNLOAD_PATHS[@]}" "${SONARR_DOWNLOAD_PATHS[@]}")
validate_separate_paths ALL_DOWNLOAD_PATHS
save_download_root_state "$DOWNLOAD_STATE_PATH"
RADARR_DOWNLOAD_ROOTS_VALUE="" SONARR_DOWNLOAD_ROOTS_VALUE="" STORAGE_ROOTS_VALUE=""
join_csv RADARR_DOWNLOAD_CONTAINER_PATHS RADARR_DOWNLOAD_ROOTS_VALUE
join_csv SONARR_DOWNLOAD_CONTAINER_PATHS SONARR_DOWNLOAD_ROOTS_VALUE
join_csv STORAGE_PATHS STORAGE_ROOTS_VALUE
{
  printf 'services:\n  keelhaularr:\n    environment:\n      CONFIG_DIR: /config\n'
  printf '      STORAGE_ROOTS: %s\n' "$(yaml_quote "$STORAGE_ROOTS_VALUE")"
  printf '      RADARR_DOWNLOAD_ROOTS: %s\n' "$(yaml_quote "$RADARR_DOWNLOAD_ROOTS_VALUE")"
  printf '      SONARR_DOWNLOAD_ROOTS: %s\n' "$(yaml_quote "$SONARR_DOWNLOAD_ROOTS_VALUE")"
  printf '    volumes:\n      - type: bind\n        source: %s\n        target: /config\n' "$(yaml_quote "$INSTALL_DIR/config")"
  for index in "${!RADARR_DOWNLOAD_PATHS[@]}"; do
    printf '      - type: bind\n        source: %s\n        target: %s\n' "$(yaml_quote "${RADARR_DOWNLOAD_PATHS[$index]}")" "$(yaml_quote "${RADARR_DOWNLOAD_CONTAINER_PATHS[$index]}")"
  done
  for index in "${!SONARR_DOWNLOAD_PATHS[@]}"; do
    printf '      - type: bind\n        source: %s\n        target: %s\n' "$(yaml_quote "${SONARR_DOWNLOAD_PATHS[$index]}")" "$(yaml_quote "${SONARR_DOWNLOAD_CONTAINER_PATHS[$index]}")"
  done
  for storage_path in "${STORAGE_PATHS[@]}"; do
    printf '      - type: bind\n        source: %s\n        target: %s\n' "$(yaml_quote "$storage_path")" "$(yaml_quote "$storage_path")"
  done
} >compose.settings.yml
chmod 600 compose.settings.yml

info "Building Keelhaularr…"
docker compose "${COMPOSE_FILES[@]}" build
ensure_no_active_job
info "Starting Keelhaularr…"
docker compose "${COMPOSE_FILES[@]}" up -d --no-build

APP_PORT="$(docker compose "${COMPOSE_FILES[@]}" port keelhaularr 8787 | awk -F: 'END {print $NF}')"
APP_PORT="${APP_PORT:-8787}"
ready=false
for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${APP_PORT}/api/auth/status" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "$ready" != "true" ]]; then
  docker compose "${COMPOSE_FILES[@]}" ps
  docker compose "${COMPOSE_FILES[@]}" logs --tail=120 keelhaularr
  die "Keelhaularr did not become ready. Review the logs above."
fi

LXC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LXC_IP="${LXC_IP:-$(hostname -f 2>/dev/null || hostname)}"

printf '\n%s%sKeelhaularr is ready.%s\n' "$BOLD" "$TEAL" "$RESET"
printf 'Open: %shttp://%s:%s%s\n' "$BOLD" "$LXC_IP" "$APP_PORT" "$RESET"
printf 'Login as: %s\n' "${APP_USERNAME:-the username stored in $INSTALL_DIR/.env}"
printf '\nInstall directory: %s\n' "$INSTALL_DIR"
printf 'View logs: docker compose -f %s/compose.yml -f %s/compose.settings.yml logs -f\n' "$INSTALL_DIR" "$INSTALL_DIR"
printf 'Update later: rerun this same installer.\n'
