#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'
umask 077

INSTALL_DIR="${INSTALL_DIR:-/opt/keelhaularr}"
PURGE=false
ASSUME_YES=false
TTY_DEVICE="/dev/tty"

usage() {
  cat <<'HELP'
Keelhaularr uninstaller

Usage:
  bash uninstall.sh                 Stop Keelhaularr and move its installation to a backup.
  bash uninstall.sh --purge         Permanently delete the installation after confirmation.
  bash uninstall.sh --purge --yes   Permanently delete without an interactive prompt.

Optional environment variable:
  INSTALL_DIR=/opt/keelhaularr

Docker Engine, other containers, mounted media, and quarantine folders outside
the installation directory are never removed.
HELP
}

info() { printf '[Keelhaularr] %s\n' "$*"; }
warn() { printf '[Warning] %s\n' "$*" >&2; }
die() { printf '[Error] %s\n' "$*" >&2; exit 1; }

for argument in "$@"; do
  case "$argument" in
    --purge) PURGE=true ;;
    --yes|-y) ASSUME_YES=true ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "Unknown option: $argument" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "Run this uninstaller as root inside the Debian LXC."
[[ "$INSTALL_DIR" == /* ]] || die "INSTALL_DIR must be an absolute path."
[[ ! -L "$INSTALL_DIR" ]] || die "INSTALL_DIR cannot be a symbolic link."
INSTALL_DIR="$(realpath -m -- "$INSTALL_DIR")"
[[ "$INSTALL_DIR" != "/" && "$INSTALL_DIR" != "/opt" ]] || die "INSTALL_DIR must be a specific path, not / or /opt."

if [[ ! -d "$INSTALL_DIR" ]]; then
  info "No installation exists at $INSTALL_DIR. Nothing was changed."
  exit 0
fi

[[ -f "$INSTALL_DIR/package.json" && -f "$INSTALL_DIR/Dockerfile" ]] || die "$INSTALL_DIR does not look like a Keelhaularr installation."
grep -Eq '"name"[[:space:]]*:[[:space:]]*"keelhaularr"' "$INSTALL_DIR/package.json" || die "$INSTALL_DIR does not identify itself as Keelhaularr."

if [[ "$ASSUME_YES" != "true" ]]; then
  [[ -r "$TTY_DEVICE" ]] || die "An interactive terminal is required unless --yes is supplied."
  if [[ "$PURGE" == "true" ]]; then
    printf 'This will permanently delete %s, including its saved credentials, settings, and any quarantine stored beneath it.\n' "$INSTALL_DIR"
    read -r -p 'Type DELETE KEELHAULARR to continue: ' confirmation <"$TTY_DEVICE"
    [[ "$confirmation" == "DELETE KEELHAULARR" ]] || die "Permanent uninstall cancelled."
  else
    read -r -p "Uninstall Keelhaularr and preserve $INSTALL_DIR as a backup? [Y/n] " confirmation <"$TTY_DEVICE"
    confirmation="${confirmation:-y}"
    [[ "$confirmation" =~ ^[Yy]$ ]] || die "Uninstall cancelled."
  fi
fi

compose_args=(-f "$INSTALL_DIR/compose.yml")
if [[ -s "$INSTALL_DIR/compose.settings.yml" ]]; then
  compose_args+=(-f "$INSTALL_DIR/compose.settings.yml")
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && [[ -s "$INSTALL_DIR/compose.yml" ]]; then
  info "Stopping and removing the Keelhaularr service…"
  docker compose "${compose_args[@]}" --project-directory "$INSTALL_DIR" down --rmi local --remove-orphans
else
  warn "Docker Compose or compose.yml is unavailable; no running service was removed."
fi

if [[ "$PURGE" == "true" ]]; then
  rm -rf -- "$INSTALL_DIR"
  info "Keelhaularr and its local configuration were permanently removed."
else
  backup_dir="${INSTALL_DIR}-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e "$backup_dir" ]] || die "Backup destination already exists: $backup_dir"
  mv -- "$INSTALL_DIR" "$backup_dir"
  info "Keelhaularr was uninstalled. Its configuration and local quarantine were preserved at:"
  printf '  %s\n' "$backup_dir"
fi

info "Docker Engine, other containers, mounted media, and external quarantine folders were left untouched."
