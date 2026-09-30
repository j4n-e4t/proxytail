# Shared by the migration scripts: sourced, not run. Expects to run from the repository root.

PROJECT="${COMPOSE_PROJECT_NAME:-proxytail}"
DATA_VOLUME="${PROJECT}_proxytail-data"
ACME_VOLUME="${PROJECT}_traefik-acme"
# This branch isn't published to GHCR: the app is built here and tagged separately, so a `docker compose pull` can't
# swap in main's image.
LOCAL_IMAGE="proxytail:crowdsec"
BUSYBOX="busybox:1.37"

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

# The value of KEY in .env, empty if it isn't set.
get_env() { sed -n "s/^$1=//p" .env | tail -n 1; }

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

volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# Checks the tools and the stack every migration needs, before anything changes.
preflight() {
  [ -f src/ratelimit.ts ] || die "Run this from a checkout of the crowdsec branch"
  [ -f .env ] || die ".env not found: run this where the running stack was started"
  command -v docker >/dev/null || die "docker not found"
  command -v curl >/dev/null || die "curl not found"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  volume_exists "$DATA_VOLUME" || die "Volume $DATA_VOLUME not found. Set COMPOSE_PROJECT_NAME if the stack runs under another name."
}

# Builds the app and pulls the other images while the old stack keeps serving; stops if any is missing.
prepare_images() {
  say "Building the app image ($LOCAL_IMAGE) while the running stack keeps serving"
  PROXYTAIL_IMAGE="$LOCAL_IMAGE" docker compose build app
  say "Pulling Traefik, Valkey and busybox"
  docker compose pull traefik volume-init valkey || echo "Couldn't pull: using the local images, if there are any."
  for image in $(PROXYTAIL_IMAGE="$LOCAL_IMAGE" docker compose config --images) "$BUSYBOX"; do
    docker image inspect "$image" >/dev/null 2>&1 || die "Image $image is missing. The running stack is untouched."
  done
}

# Archives volumes into backups/proxytail-<time>.tar.gz, one directory per volume. Arguments: volume=directory pairs.
# Prints the archive's path.
backup_volumes() {
  stamp="$(date +%Y%m%d-%H%M%S)"
  mkdir -p backups
  mounts=""
  dirs=""
  for pair in "$@"; do
    mounts="$mounts -v ${pair%%=*}:/backup/${pair#*=}:ro"
    dirs="$dirs ${pair#*=}"
  done
  # shellcheck disable=SC2086 # word splitting builds the argument lists
  docker run --rm --network none $mounts -v "$PWD/backups:/out" "$BUSYBOX" \
    tar czf "/out/proxytail-$stamp.tar.gz" -C /backup $dirs >&2
  echo "backups/proxytail-$stamp.tar.gz"
}

# Starts the stack, waits for it, and prints the state of Traefik's routers.
start_and_check() {
  docker compose up -d --remove-orphans
  wait_healthy app
  wait_healthy traefik
  wait_healthy valkey

  say "Checking Traefik's routers"
  # The app answers on the host's loopback. Routers take up to 5 seconds to appear after Traefik starts.
  port="$(get_env UI_PORT)"
  status=""
  for _ in $(seq 1 10); do
    status="$(curl -fsS "http://127.0.0.1:${port:-3000}/api/traefik/status" || true)"
    case "$status" in *'"routers":{}'*|'') sleep 2 ;; *) break ;; esac
  done
  echo "$status" | grep -o '"status":"[a-z]*"' | sort | uniq -c || echo "Couldn't read the router status: check the UI."
  if echo "$status" | grep -Eq '"status":"(disabled|warning)"'; then
    echo "Some routers aren't enabled: check the Services page, or roll back with: $0 rollback"
  fi
}
