#!/bin/sh
# Moves a running proxytail stack from `main` to this branch. Run it on the proxy host, from the
# repository checkout docker-compose.yml lives in, after `git checkout crowdsec`:
#
#   scripts/migrate-from-main.sh            # back up, build, switch over, check
#   scripts/migrate-from-main.sh rollback   # undo, then `git checkout main && docker compose up -d --remove-orphans`
#
# Your data stays in the same volumes, and the Let's Encrypt certificates are kept, so nothing is reissued. The
# database only gains tables and columns, so main still runs on it after a rollback. Services are down for the few
# seconds the containers are recreated.
#
# A stack from an earlier commit of this branch, with CrowdSec, moves over with scripts/migrate-from-crowdsec.sh.
set -eu

cd "$(dirname "$0")/.."
. scripts/lib.sh
ENV_BACKUP=".env.pre-migration"

rollback() {
  [ -f "$ENV_BACKUP" ] || die "$ENV_BACKUP not found: nothing to roll back"
  say "Stopping the stack (volumes are kept)"
  docker compose down --remove-orphans
  say "Handing the ACME volume back to root, which main's Traefik runs as"
  docker run --rm --network none -v "$ACME_VOLUME:/letsencrypt" "$BUSYBOX" chown -R 0:0 /letsencrypt
  say "Restoring .env"
  mv "$ENV_BACKUP" .env
  say "Done. Now run: git checkout main && docker compose up -d --remove-orphans"
  echo "A backup of the data and certificates from before the migration is in backups/."
}

migrate() {
  preflight
  [ ! -f "$ENV_BACKUP" ] || die "$ENV_BACKUP exists: a migration already ran. Roll it back first, or delete it."
  if grep -q '^COMPOSE_FILE=.*crowdsec' .env || grep -q '^TRAEFIK_IMAGE=dhi\.io/' .env; then
    die "This stack runs an earlier commit of this branch (CrowdSec or Docker Hardened Images): use scripts/migrate-from-crowdsec.sh"
  fi

  prepare_images

  say "Stopping main's stack"
  docker compose down --remove-orphans

  say "Backing up the data and certificates"
  backup="$(backup_volumes "$DATA_VOLUME=data" "$ACME_VOLUME=letsencrypt")"
  echo "Saved $backup"

  say "Pointing .env at the local image (backup in $ENV_BACKUP)"
  cp .env "$ENV_BACKUP"
  set_env PROXYTAIL_IMAGE "$LOCAL_IMAGE"

  say "Starting the stack (volume-init hands the certificates to Traefik's unprivileged user)"
  start_and_check

  say "Done"
  cat <<EOT
- Rate limiting stays off. Turn it on under Security → Rate limiting.
- Traefik now refuses TLS for hostnames it has no certificate for, including clients that send none.
- Basic auth is gone: services that used it are off unless they require a client certificate (see the app log).
- Backup: $backup. To undo: $0 rollback
EOT
}

case "${1:-migrate}" in
  migrate) migrate ;;
  rollback) rollback ;;
  *) die "usage: $0 [migrate|rollback]" ;;
esac
