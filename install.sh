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

The installer is safe to rerun. Existing .env and compose.yml files are kept.
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
  [[ "$directory" == /* ]] || die "$label must be an absolute path."
  [[ "$directory" != "/" ]] || die "$label cannot be the filesystem root."
  [[ -d "$directory" ]] || die "$label does not exist: $directory. Add the Proxmox mount point, then rerun the installer."
  [[ -r "$directory" ]] || die "$label is not readable: $directory"
  [[ -w "$directory" ]] || die "$label is not writable: $directory. Write access is required for orphan handling."
}

validate_url() {
  local label="$1" url="$2"
  [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || die "$label must begin with http:// or https:// and contain no spaces."
  [[ ! "$url" =~ ^https?://(localhost|127[.]0[.]0[.]1|\[::1\])([/:]|$) ]] || die "$label cannot use localhost because Keelhaularr runs in Docker. Use the server or LXC IP address."
}

validate_number() {
  local label="$1" value="$2"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "$label must be a non-negative number."
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

discover_arr_roots() {
  local label="$1" url="$2" api_key="$3"
  local -n discovered_roots="$4"
  local response root

  response="$(curl -fsS --connect-timeout 10 -H "X-Api-Key: $api_key" "${url%/}/api/v3/rootfolder")" || die "Could not read $label root folders. Check its URL, API key, and network access."
  jq -e 'type == "array"' <<<"$response" >/dev/null || die "$label returned an unexpected root-folder response."
  mapfile -t discovered_roots < <(jq -r '[.[] | .path? | select(type == "string" and length > 0)] | unique[]' <<<"$response")
  (( ${#discovered_roots[@]} > 0 )) || die "$label has no configured root folders. Add a media root in $label, then rerun this installer."

  info "$label reported ${#discovered_roots[@]} media root(s):"
  for root in "${discovered_roots[@]}"; do
    printf '  %s\n' "$root"
  done
}

configure_local_roots() {
  local label="$1" container_base="$2"
  local -n reported_roots="$3"
  local -n local_roots="$4"
  local -n container_roots="$5"
  local index arr_root lxc_root docker_root

  local_roots=()
  container_roots=()
  for index in "${!reported_roots[@]}"; do
    arr_root="${reported_roots[$index]}"
    if [[ "$arr_root" == /* && -d "$arr_root" && -r "$arr_root" && -w "$arr_root" ]]; then
      lxc_root="$arr_root"
      info "Using $arr_root directly; it is visible and writable inside this LXC."
    else
      LOCAL_MEDIA_PATH=""
      read_value LOCAL_MEDIA_PATH "$label reports '$arr_root'. Matching library path inside this LXC"
      lxc_root="$LOCAL_MEDIA_PATH"
      require_absolute_directory "$label media path" "$lxc_root"
    fi

    if (( ${#reported_roots[@]} == 1 )); then
      docker_root="/$container_base"
    else
      docker_root="/$container_base-$((index + 1))"
    fi
    local_roots+=("$lxc_root")
    container_roots+=("$docker_root")
  done
}

compose_path_settings() {
  local -n reported_roots="$1"
  local -n container_roots="$2"
  local -n roots_result="$3"
  local -n maps_result="$4"
  local index separator=''

  roots_result=''
  maps_result=''
  for index in "${!reported_roots[@]}"; do
    roots_result+="${separator}${container_roots[$index]}"
    maps_result+="${separator}${reported_roots[$index]}=>${container_roots[$index]}"
    separator=';'
  done
  roots_result="${roots_result//;/,}"
}

is_lxc=false
if command -v systemd-detect-virt >/dev/null 2>&1 && [[ "$(systemd-detect-virt --container 2>/dev/null || true)" == "lxc" ]]; then
  is_lxc=true
fi

printf '\n%s%sKeelhaularr — Debian LXC installer%s\n' "$BOLD" "$GOLD" "$RESET"
printf 'Installs Docker, configures both *arr holds, and starts the protected web interface.\n\n'

if [[ "$is_lxc" == "true" ]]; then
  warn "Proxmox must allow Docker features on this LXC."
  printf 'On the Proxmox host, the container normally needs:\n'
  printf '  pct set <CTID> -features nesting=1,keyctl=1\n'
  printf 'Then restart the LXC before continuing. Media bind mounts must also already be visible inside this LXC.\n\n'
  confirm "Have nesting/keyctl and your media mount points already been configured?" "y" || die "Configure the LXC on the Proxmox host, restart it, then rerun this installer."
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
  apt-get install -y ca-certificates curl git jq openssl

  if ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker Engine from Docker's official Debian repository…"
    remove_conflicting_docker_packages || true
    configure_docker_repository
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git jq openssl
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

if [[ -s .env && -s compose.yml ]]; then
  info "Existing settings found; leaving .env and compose.yml unchanged."
  if ! confirm "Build and restart Keelhaularr with the existing settings?" "y"; then
    exit 0
  fi
else
  printf '\n%sConnection and login settings%s\n' "$BOLD" "$RESET"
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

  read_value MAX_MB_PER_MIN "Maximum MB/min for both apps" "85"
  read_value OVERSIZE_TOLERANCE_GIB "Oversize tolerance in GiB" "1"
  validate_number "Maximum MB/min" "$MAX_MB_PER_MIN"
  validate_number "Oversize tolerance" "$OVERSIZE_TOLERANCE_GIB"

  confirm "Configure Radarr?" "y" && ENABLE_RADARR=true || ENABLE_RADARR=false
  confirm "Configure Sonarr?" "y" && ENABLE_SONARR=true || ENABLE_SONARR=false
  [[ "$ENABLE_RADARR" == "true" || "$ENABLE_SONARR" == "true" ]] || die "At least one *arr application must be configured."

  RADARR_URL="" RADARR_API_KEY="" RADARR_MEDIA_ROOTS_VALUE="" RADARR_PATH_MAPS_VALUE=""
  SONARR_URL="" SONARR_API_KEY="" SONARR_MEDIA_ROOTS_VALUE="" SONARR_PATH_MAPS_VALUE=""
  declare -a RADARR_REPORTED_PATHS=() RADARR_MEDIA_PATHS=() RADARR_CONTAINER_PATHS=()
  declare -a SONARR_REPORTED_PATHS=() SONARR_MEDIA_PATHS=() SONARR_CONTAINER_PATHS=()

  if [[ "$ENABLE_RADARR" == "true" ]]; then
    printf '\n%sRadarr%s\n' "$BOLD" "$RESET"
    read_value RADARR_URL "Radarr URL reachable from this LXC and Docker (for example http://10.0.0.21:7878)"
    read_value RADARR_API_KEY "Radarr API key: " "" true
    validate_url "Radarr URL" "$RADARR_URL"
    [[ -n "$RADARR_API_KEY" ]] || die "Radarr API key cannot be empty."
    curl -fsS --connect-timeout 10 -H "X-Api-Key: $RADARR_API_KEY" "${RADARR_URL%/}/api/v3/system/status" >/dev/null || die "Could not authenticate with Radarr from this LXC. Check its URL, API key, and network access."
    discover_arr_roots "Radarr" "$RADARR_URL" "$RADARR_API_KEY" RADARR_REPORTED_PATHS
    configure_local_roots "Radarr" "movies" RADARR_REPORTED_PATHS RADARR_MEDIA_PATHS RADARR_CONTAINER_PATHS
    compose_path_settings RADARR_REPORTED_PATHS RADARR_CONTAINER_PATHS RADARR_MEDIA_ROOTS_VALUE RADARR_PATH_MAPS_VALUE
  fi

  if [[ "$ENABLE_SONARR" == "true" ]]; then
    printf '\n%sSonarr%s\n' "$BOLD" "$RESET"
    read_value SONARR_URL "Sonarr URL reachable from this LXC and Docker (for example http://10.0.0.22:8989)"
    read_value SONARR_API_KEY "Sonarr API key: " "" true
    validate_url "Sonarr URL" "$SONARR_URL"
    [[ -n "$SONARR_API_KEY" ]] || die "Sonarr API key cannot be empty."
    curl -fsS --connect-timeout 10 -H "X-Api-Key: $SONARR_API_KEY" "${SONARR_URL%/}/api/v3/system/status" >/dev/null || die "Could not authenticate with Sonarr from this LXC. Check its URL, API key, and network access."
    discover_arr_roots "Sonarr" "$SONARR_URL" "$SONARR_API_KEY" SONARR_REPORTED_PATHS
    configure_local_roots "Sonarr" "tv" SONARR_REPORTED_PATHS SONARR_MEDIA_PATHS SONARR_CONTAINER_PATHS
    compose_path_settings SONARR_REPORTED_PATHS SONARR_CONTAINER_PATHS SONARR_MEDIA_ROOTS_VALUE SONARR_PATH_MAPS_VALUE
  fi

  ALL_MEDIA_PATHS=("${RADARR_MEDIA_PATHS[@]}" "${SONARR_MEDIA_PATHS[@]}")
  for ((first_index = 0; first_index < ${#ALL_MEDIA_PATHS[@]}; first_index++)); do
    for ((second_index = first_index + 1; second_index < ${#ALL_MEDIA_PATHS[@]}; second_index++)); do
      paths_overlap "${ALL_MEDIA_PATHS[$first_index]}" "${ALL_MEDIA_PATHS[$second_index]}" && die "Media roots must be separate and cannot contain one another: ${ALL_MEDIA_PATHS[$first_index]} and ${ALL_MEDIA_PATHS[$second_index]}"
    done
  done

  read_value QUARANTINE_PATH "Quarantine path inside this LXC" "/mnt/keelhaularr-quarantine"
  [[ "$QUARANTINE_PATH" == /* && "$QUARANTINE_PATH" != "/" ]] || die "Quarantine must be an absolute path other than /."
  for media_path in "${ALL_MEDIA_PATHS[@]}"; do
    paths_overlap "$QUARANTINE_PATH" "$media_path" && die "Quarantine cannot be inside, contain, or equal a media root: $media_path"
  done
  install -d -m 0750 "$QUARANTINE_PATH"
  [[ -w "$QUARANTINE_PATH" ]] || die "Quarantine path is not writable: $QUARANTINE_PATH"

  read_value APP_PORT "Web interface port" "8787"
  [[ "$APP_PORT" =~ ^[0-9]+$ && "$APP_PORT" -ge 1 && "$APP_PORT" -le 65535 ]] || die "Port must be between 1 and 65535."

  info "Writing protected settings…"
  {
    printf 'APP_USERNAME=%s\n' "$(env_quote "$APP_USERNAME")"
    printf 'APP_PASSWORD=%s\n' "$(env_quote "$APP_PASSWORD")"
    printf 'APP_SESSION_SECRET=%s\n' "$(env_quote "$APP_SESSION_SECRET")"
    printf 'APP_SESSION_DAYS=30\nAPP_COOKIE_SECURE=false\n'
    printf 'MAX_MB_PER_MIN=%s\n' "$(env_quote "$MAX_MB_PER_MIN")"
    printf 'OVERSIZE_TOLERANCE_GIB=%s\n' "$(env_quote "$OVERSIZE_TOLERANCE_GIB")"
    printf 'RADARR_URL=%s\n' "$(env_quote "$RADARR_URL")"
    printf 'RADARR_API_KEY=%s\n' "$(env_quote "$RADARR_API_KEY")"
    if [[ "$ENABLE_RADARR" == "true" ]]; then
      printf 'RADARR_MEDIA_ROOTS=%s\nRADARR_PATH_MAPS=%s\n' "$(env_quote "$RADARR_MEDIA_ROOTS_VALUE")" "$(env_quote "$RADARR_PATH_MAPS_VALUE")"
    else
      printf 'RADARR_MEDIA_ROOTS=\nRADARR_PATH_MAPS=\n'
    fi
    printf 'RADARR_INCLUDE_UNMONITORED=false\n'
    printf 'SONARR_URL=%s\n' "$(env_quote "$SONARR_URL")"
    printf 'SONARR_API_KEY=%s\n' "$(env_quote "$SONARR_API_KEY")"
    if [[ "$ENABLE_SONARR" == "true" ]]; then
      printf 'SONARR_MEDIA_ROOTS=%s\nSONARR_PATH_MAPS=%s\n' "$(env_quote "$SONARR_MEDIA_ROOTS_VALUE")" "$(env_quote "$SONARR_PATH_MAPS_VALUE")"
    else
      printf 'SONARR_MEDIA_ROOTS=\nSONARR_PATH_MAPS=\n'
    fi
    printf 'SONARR_INCLUDE_UNMONITORED=false\n'
    printf 'ORPHAN_ACTION=quarantine\nORPHAN_TRASH_DIR=/quarantine\n'
    printf 'ORPHAN_IGNORE_DIRECTORIES=extras,featurettes,trailers,samples\n'
    printf 'ORPHAN_MAX_FILES=100000\nPORT=8787\n'
  } >.env
  chmod 600 .env

  {
    printf 'services:\n  keelhaularr:\n    build: .\n    container_name: keelhaularr\n'
    printf '    restart: unless-stopped\n    env_file: .env\n'
    printf '    ports:\n      - %s\n' "$(yaml_quote "${APP_PORT}:8787")"
    printf '    extra_hosts:\n      - %s\n' "$(yaml_quote 'host.docker.internal:host-gateway')"
    printf '    security_opt:\n      - no-new-privileges:true\n'
    printf '    volumes:\n'
    if [[ "$ENABLE_RADARR" == "true" ]]; then
      for index in "${!RADARR_MEDIA_PATHS[@]}"; do
        printf '      - type: bind\n        source: %s\n        target: %s\n' "$(yaml_quote "${RADARR_MEDIA_PATHS[$index]}")" "$(yaml_quote "${RADARR_CONTAINER_PATHS[$index]}")"
      done
    fi
    if [[ "$ENABLE_SONARR" == "true" ]]; then
      for index in "${!SONARR_MEDIA_PATHS[@]}"; do
        printf '      - type: bind\n        source: %s\n        target: %s\n' "$(yaml_quote "${SONARR_MEDIA_PATHS[$index]}")" "$(yaml_quote "${SONARR_CONTAINER_PATHS[$index]}")"
      done
    fi
    printf '      - type: bind\n        source: %s\n        target: /quarantine\n' "$(yaml_quote "$QUARANTINE_PATH")"
    printf '    healthcheck:\n      test: [CMD, wget, -q, --spider, http://127.0.0.1:8787/api/auth/status]\n'
    printf '      interval: 30s\n      timeout: 5s\n      retries: 3\n      start_period: 20s\n'
    printf '    logging:\n      options:\n        max-size: 10m\n        max-file: "3"\n'
  } >compose.yml
  chmod 600 compose.yml
fi

info "Building and starting Keelhaularr…"
docker compose -f compose.yml up -d --build

APP_PORT="$(docker compose -f compose.yml port keelhaularr 8787 | awk -F: 'END {print $NF}')"
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
  docker compose -f compose.yml ps
  docker compose -f compose.yml logs --tail=120 keelhaularr
  die "Keelhaularr did not become ready. Review the logs above."
fi

LXC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
LXC_IP="${LXC_IP:-$(hostname -f 2>/dev/null || hostname)}"

printf '\n%s%sKeelhaularr is ready.%s\n' "$BOLD" "$TEAL" "$RESET"
printf 'Open: %shttp://%s:%s%s\n' "$BOLD" "$LXC_IP" "$APP_PORT" "$RESET"
printf 'Login as: %s\n' "${APP_USERNAME:-the username stored in $INSTALL_DIR/.env}"
printf '\nInstall directory: %s\n' "$INSTALL_DIR"
printf 'View logs: docker compose -f %s/compose.yml logs -f\n' "$INSTALL_DIR"
printf 'Update later: rerun this same installer.\n'
