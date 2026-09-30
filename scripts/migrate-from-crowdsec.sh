#!/bin/sh
# Moves a running proxytail stack from an earlier commit of this branch, from before CrowdSec was replaced by rate
# limiting (up to a77c83c), to the current one. Run it on the proxy host, from the repository checkout
# docker-compose.yml lives in, after `git pull`:
#
#   scripts/migrate-from-crowdsec.sh                 # clean up .env, build, back up, switch over, check
#   scripts/migrate-from-crowdsec.sh --yes           # the same, and delete the CrowdSec volumes without asking
#   scripts/migrate-from-crowdsec.sh --keep-volumes  # the same, and keep the CrowdSec volumes
#   scripts/migrate-from-crowdsec.sh rollback        # undo, then check out the earlier commit and start it again
#
# It
# 1. removes CrowdSec from .env: docker-compose.crowdsec.yml from COMPOSE_FILE (the file no longer exists, so every
#    `docker compose` command would fail), and the CROWDSEC_* settings;
# 2. drops a TRAEFIK_IMAGE that pins a Docker Hardened Image or a Traefik older than 3.7, so the pinned default applies;
# 3. builds the app as proxytail:crowdsec and points PROXYTAIL_IMAGE at it: GHCR's image is main's;
# 4. backs up the data, the certificates and the CrowdSec volumes, then recreates the stack without CrowdSec;
# 5. deletes the CrowdSec volumes once nothing uses them, after asking.
#
# Your services, users and certificates stay in the same volumes: the database is upgraded when the app starts, and
# the earlier commit still runs on it after a rollback. Services are down for the few seconds the containers are
# recreated.
set -eu

cd "$(dirname "$0")/.."
. scripts/lib.sh
ENV_BACKUP=".env.pre-crowdsec-removal"
# Where the backup of this migration is, for a rollback.
BACKUP_RECORD="backups/crowdsec-migration"
CROWDSEC_VOLUMES="crowdsec-db crowdsec-config crowdsec-secrets"
LOGS_VOLUME="${PROJECT}_traefik-logs"

# Removes CrowdSec and the Docker Hardened Image from .env, and points it at the local app image.
clean_env() {
  # COMPOSE_FILE without docker-compose.crowdsec.yml; empty if only docker-compose.yml, the default, is left.
  sep="${COMPOSE_PATH_SEPARATOR:-:}"
  compose_files="$(get_env COMPOSE_FILE | tr -d "\"'" | tr "$sep" '\n' | grep -v 'docker-compose\.crowdsec\.yml$' | paste -sd "$sep" -)"
  case "$compose_files" in docker-compose.yml | ./docker-compose.yml) compose_files="" ;; esac

  # The CrowdSec section of .env.example (COMPOSE_FILE included), the CrowdSec lines of its development section, and
  # any other CROWDSEC_* setting.
  sed -i.tmp \
    -e '/^# --- CrowdSec (opt-in) ---$/,/^$/d' \
    -e '/^# The app on the host reads \.env too: turn on its CrowdSec/,/^# sets this inside the container instead)\.$/d' \
    -e '/^COMPOSE_FILE=/d' \
    -e '/^#* *COMPOSE_FILE=.*crowdsec/d' \
    -e '/^#* *CROWDSEC_[A-Z_]*=/d' \
    .env
  [ -z "$compose_files" ] || set_env COMPOSE_FILE "$compose_files"

  traefik_image="$(get_env TRAEFIK_IMAGE)"
  if printf '%s' "$traefik_image" | grep -Eq '^dhi\.io/|^traefik:v?3\.[0-6]([.-]|$)'; then
    sed -i.tmp \
      -e '/^# Traefik image: a Docker Hardened Image/d' \
      -e '/^# Traefik image\. It runs as an unprivileged user/d' \
      -e '/^TRAEFIK_IMAGE=/d' \
      .env
  elif [ -n "$traefik_image" ]; then
    echo "Keeping TRAEFIK_IMAGE=$traefik_image (docker-compose.yml defaults to traefik:v3.7.13)."
  fi
  rm -f .env.tmp

  set_env PROXYTAIL_IMAGE "$LOCAL_IMAGE"
}

# Puts .env back while the old stack is still running, if the migration stops before switching over.
restore_env() {
  [ -f "$ENV_BACKUP" ] && mv "$ENV_BACKUP" .env && echo "Restored .env: the running stack is untouched."
}

# Names of the CrowdSec volumes that exist.
crowdsec_volumes() {
  for v in $CROWDSEC_VOLUMES; do
    volume_exists "${PROJECT}_$v" && printf '%s\n' "${PROJECT}_$v"
  done
  return 0
}

volume_size() { docker run --rm --network none -v "$1:/v:ro" "$BUSYBOX" du -sh /v 2>/dev/null | cut -f1; }

# Deletes the CrowdSec volumes once no container uses them. $1: yes, keep, or ask.
remove_crowdsec_volumes() {
  volumes="$(crowdsec_volumes)"
  [ -n "$volumes" ] || { echo "No CrowdSec volumes left."; return 0; }
  for v in $volumes; do
    users="$(docker ps -aq --filter "volume=$v")"
    [ -z "$users" ] || { echo "$v is still used by container(s) $users: keeping the CrowdSec volumes."; return 0; }
  done
  echo "Nothing uses them any more, and they're in $backup:"
  for v in $volumes; do echo "  $v ($(volume_size "$v"))"; done
  case "$1" in
    keep) echo "Keeping them (--keep-volumes). Delete them later with: docker volume rm" $volumes; return 0 ;;
    ask)
      if [ ! -t 0 ]; then
        echo "Not asking without a terminal: keeping them. Delete them with: docker volume rm" $volumes
        return 0
      fi
      printf 'Delete them? [y/N] '
      read -r answer
      case "$answer" in y | Y | yes) ;; *) echo "Keeping them. Delete them later with: docker volume rm" $volumes; return 0 ;; esac
      ;;
  esac
  # shellcheck disable=SC2086 # one volume name per word
  docker volume rm $volumes
}

migrate() {
  preflight
  [ ! -f "$ENV_BACKUP" ] || die "$ENV_BACKUP exists: a migration already ran. Roll it back first, or delete it."

  say "Checking the running stack"
  volumes="$(crowdsec_volumes)"
  if [ -n "$volumes" ]; then
    echo "CrowdSec volumes:"
    for v in $volumes; do echo "  $v ($(volume_size "$v"))"; done
  else
    echo "No CrowdSec volumes."
  fi
  if volume_exists "$LOGS_VOLUME"; then
    log_size="$(docker run --rm --network none -v "$LOGS_VOLUME:/v:ro" "$BUSYBOX" sh -c 'du -h /v/access.log 2>/dev/null | cut -f1')"
    [ -z "$log_size" ] || echo "Traefik's access log: $log_size. proxytail reads it into the Requests page, keeping only" \
      "time, client IP, hostname, status and response time, then empties it."
  fi

  say "Cleaning up .env (backup in $ENV_BACKUP)"
  cp .env "$ENV_BACKUP"
  trap restore_env EXIT
  clean_env
  diff -u "$ENV_BACKUP" .env || true

  prepare_images

  say "Stopping the stack, CrowdSec included"
  trap - EXIT
  docker compose down --remove-orphans

  say "Backing up the data, the certificates and the CrowdSec volumes"
  pairs="$DATA_VOLUME=data $ACME_VOLUME=letsencrypt"
  for v in $volumes; do pairs="$pairs $v=${v#"${PROJECT}"_}"; done
  # shellcheck disable=SC2086 # one volume=directory pair per word
  backup="$(backup_volumes $pairs)"
  echo "$backup" > "$BACKUP_RECORD"
  echo "Saved $backup"

  say "Starting the stack without CrowdSec"
  start_and_check

  say "Removing the CrowdSec volumes"
  remove_crowdsec_volumes "$1"

  say "Done"
  cat <<EOT
- Rate limiting replaces CrowdSec. It stays off until you turn it on under Security → Rate limiting.
- Traefik now refuses TLS for hostnames it has no certificate for, including clients that send none.
- Every service now sends HSTS.
- The CrowdSec image is still on the host: docker image rm crowdsecurity/crowdsec:<tag> frees the space.
- Backup: $backup. To undo: $0 rollback
EOT
}

rollback() {
  [ -f "$ENV_BACKUP" ] || die "$ENV_BACKUP not found: nothing to roll back"
  say "Stopping the stack (volumes are kept)"
  docker compose down --remove-orphans
  missing=""
  for v in $CROWDSEC_VOLUMES; do volume_exists "${PROJECT}_$v" || missing="$missing $v"; done
  backup="$(cat "$BACKUP_RECORD" 2>/dev/null || true)"
  if [ -n "$missing" ] && [ -f "$backup" ] && tar tzf "$backup" | grep -q '^crowdsec-'; then
    say "Restoring the CrowdSec volumes from $backup"
    mounts=""
    dirs=""
    for v in $missing; do
      tar tzf "$backup" | grep -q "^$v/" || continue
      docker volume create --label "com.docker.compose.project=$PROJECT" --label "com.docker.compose.volume=$v" \
        "${PROJECT}_$v" >/dev/null
      mounts="$mounts -v ${PROJECT}_$v:/restore/$v"
      dirs="$dirs $v"
    done
    # shellcheck disable=SC2086 # word splitting builds the argument lists
    docker run --rm --network none $mounts -v "$PWD/backups:/in:ro" "$BUSYBOX" \
      tar xzf "/in/${backup#backups/}" -C /restore $dirs
  fi
  say "Restoring .env"
  mv "$ENV_BACKUP" .env
  say "Done. Now check out the commit you ran before and start it, e.g.:"
  echo "  git checkout a77c83c && docker compose up -d --remove-orphans"
  grep -q '^TRAEFIK_IMAGE=dhi\.io/' .env && echo "Its Traefik image is on dhi.io: run docker login dhi.io first if the image isn't on the host."
  return 0
}

case "${1:-migrate}" in
  migrate | --yes | --keep-volumes)
    case "${1:-}" in --yes) mode=yes ;; --keep-volumes) mode=keep ;; *) mode=ask ;; esac
    migrate "$mode"
    ;;
  rollback) rollback ;;
  *) die "usage: $0 [--yes | --keep-volumes | rollback]" ;;
esac
