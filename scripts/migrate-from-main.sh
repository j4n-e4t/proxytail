#!/bin/sh
# Moves a running proxytail stack from `main` to this branch. Run it on the proxy host, from the
# repository checkout docker-compose.yml lives in, after `git checkout crowdsec`:
#
#   scripts/migrate-from-main.sh            # back up, build, switch over, check
#   scripts/migrate-from-main.sh rollback   # undo, then `git checkout main && docker compose up -d --remove-orphans`
#
# Your data stays in the same volumes: the database has no schema changes between main and this branch, and the
# Let's Encrypt certificates are kept, so nothing is reissued. Services are down for the few seconds the containers
# are recreated.
set -eu

cd "$(dirname "$0")/.."
PROJECT="${COMPOSE_PROJECT_NAME:-proxytail}"
DATA_VOLUME="${PROJECT}_proxytail-data"
ACME_VOLUME="${PROJECT}_traefik-acme"
# This branch isn't published to GHCR: the app is built here and tagged separately, so a `docker compose pull` can't
# swap in main's image.
LOCAL_IMAGE="proxytail:crowdsec"
BUSYBOX="busybox:1.37"
ENV_BACKUP=".env.pre-migration"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Sets KEY=VALUE in .env, replacing an existing line.
set_env() {
  if grep -q "^$1=" .env; then
    sed -i.tmp "s|^$1=.*|$1=$2|" .env && rm -f .env.tmp
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo missing; }

# Waits up to two minutes for a compose service's container to be healthy.
wait_healthy() {
  id="$(docker compose ps -q "$1")"
  [ -n "$id" ] || die "$1 isn't running. See: docker compose logs $1"
  for _ in $(seq 1 60); do
    [ "$(health "$id")" = healthy ] && return 0
    sleep 2
  done
  die "$1 isn't healthy ($(health "$id")). See: docker compose logs $1"
}

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
  [ -f src/ratelimit.ts ] || die "Run this from a checkout of the crowdsec branch"
  [ -f .env ] || die ".env not found: run this where main's stack was started"
  command -v docker >/dev/null || die "docker not found"
  command -v curl >/dev/null || die "curl not found"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1 || die "Volume $DATA_VOLUME not found. Set COMPOSE_PROJECT_NAME if the stack runs under another name."
  [ ! -f "$ENV_BACKUP" ] || die "$ENV_BACKUP exists: a migration already ran. Roll it back first, or delete it."

  say "Building the app image ($LOCAL_IMAGE) while main keeps serving"
  PROXYTAIL_IMAGE="$LOCAL_IMAGE" docker compose build app
  say "Pulling Traefik, Valkey and busybox"
  docker compose pull traefik volume-init valkey || echo "Couldn't pull: using the local images, if there are any."
  # Nothing stops until every image the new stack needs is here.
  for image in $(PROXYTAIL_IMAGE="$LOCAL_IMAGE" docker compose config --images) "$BUSYBOX"; do
    docker image inspect "$image" >/dev/null 2>&1 || die "Image $image is missing. main is still running."
  done

  say "Stopping main's stack"
  docker compose down --remove-orphans

  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p backups
  say "Backing up the data and certificates to backups/proxytail-$stamp.tar.gz"
  docker run --rm --network none \
    -v "$DATA_VOLUME:/backup/data:ro" \
    -v "$ACME_VOLUME:/backup/letsencrypt:ro" \
    -v "$PWD/backups:/out" \
    "$BUSYBOX" tar czf "/out/proxytail-$stamp.tar.gz" -C /backup data letsencrypt

  say "Pointing .env at the local image (backup in $ENV_BACKUP)"
  cp .env "$ENV_BACKUP"
  set_env PROXYTAIL_IMAGE "$LOCAL_IMAGE"

  say "Starting the stack (volume-init hands the certificates to Traefik's unprivileged user)"
  docker compose up -d --remove-orphans
  wait_healthy app
  wait_healthy traefik

  say "Checking Traefik's routers"
  # The app answers on the host's loopback. Routers take up to 5 seconds to appear after Traefik starts.
  port="$(sed -n 's/^UI_PORT=//p' .env)"
  status=""
  for _ in $(seq 1 10); do
    status="$(curl -fsS "http://127.0.0.1:${port:-3000}/api/traefik/status" || true)"
    case "$status" in *'"routers":{}'*|'') sleep 2 ;; *) break ;; esac
  done
  echo "$status" | grep -o '"status":"[a-z]*"' | sort | uniq -c || echo "Couldn't read the router status: check the UI."
  if echo "$status" | grep -Eq '"status":"(disabled|warning)"'; then
    echo "Some routers aren't enabled: check the Services page, or roll back with: $0 rollback"
  fi

  say "Done"
  cat <<EOF
- Rate limiting stays off. Turn it on under Settings → Rate limiting.
- Traefik now refuses TLS for hostnames it has no certificate for, including clients that send none.
- Backup: backups/proxytail-$stamp.tar.gz. To undo: $0 rollback
EOF
}

case "${1:-migrate}" in
  migrate) migrate ;;
  rollback) rollback ;;
  *) die "usage: $0 [migrate|rollback]" ;;
esac
