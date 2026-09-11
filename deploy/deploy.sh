#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -ne 2 ]]; then
  echo "Usage: sudo bash deploy.sh ghcr.io/owner/repo@sha256:digest registry-user (token on stdin)" >&2
  exit 1
fi

requested_image="$1"
registry_user="$2"
if [[ ! "$requested_image" =~ ^ghcr\.io/cqcpcqp/custent@sha256:[a-f0-9]{64}$ ]]; then
  echo "Only immutable Custent GHCR image digests are accepted" >&2
  exit 1
fi
image="$requested_image"
preloaded_image="${CUSTENT_PRELOADED_IMAGE:-}"
if [[ -n "$preloaded_image" ]]; then
  requested_digest="${requested_image##*@}"
  if [[ "$preloaded_image" != "$requested_digest" ]]; then
    echo "Preloaded image ID must exactly match the requested digest" >&2
    exit 1
  fi
  docker image inspect "$preloaded_image" > /dev/null
  image="$preloaded_image"
fi

root=/opt/custent
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }

test -s "$root/shared/app.env"
test -s "$root/shared/db.env"
test -d "$root/shared/maintenance"
test -d "$root/shared/artifacts"
test -d "$root/shared/input-attachments"
available_kb="$(df -Pk "$root" | awk 'NR == 2 {print $4}')"
if (( available_kb < 4194304 )); then
  echo "At least 4 GiB free disk is required before deployment" >&2
  exit 1
fi

export CUSTENT_IMAGE="$image"
export DOCKER_CONFIG
DOCKER_CONFIG="$(mktemp -d "$root/docker-auth.XXXXXX")"
cleanup() {
  rm -rf -- "$DOCKER_CONFIG"
}
trap cleanup EXIT
trap 'echo "Deployment failed. If maintenance was enabled, it remains enabled; do not roll back a migrated database blindly." >&2' ERR

compose=(docker compose --project-name custent --file "$release_dir/compose.yml")
"${compose[@]}" config --quiet
if [[ -z "$preloaded_image" ]]; then
  docker login ghcr.io --username "$registry_user" --password-stdin
  pull_succeeded=false
  for attempt in 1 2 3 4 5; do
    if "${compose[@]}" pull; then
      pull_succeeded=true
      break
    fi
    if (( attempt == 5 )); then
      echo "Image pull failed after 5 attempts" >&2
      exit 1
    fi
    sleep_seconds=$((attempt * 10))
    echo "Image pull failed; retrying in ${sleep_seconds}s (attempt ${attempt}/5)" >&2
    sleep "$sleep_seconds"
  done
  test "$pull_succeeded" = true
fi
"${compose[@]}" run --rm --no-deps proxy nginx -t

touch "$root/shared/maintenance/enabled"
"${compose[@]}" up -d --no-recreate --wait --wait-timeout 120 db
"${compose[@]}" stop --timeout 30 web

has_runs="$("${compose[@]}" exec -T db psql -U custent -d custent -Atc "SELECT to_regclass('public.runs') IS NOT NULL")"
if [[ "$has_runs" == t ]]; then
  deadline=$((SECONDS + 600))
  while true; do
    active_runs="$("${compose[@]}" exec -T db psql -U custent -d custent -Atc "SELECT count(*) FROM runs WHERE status IN ('queued', 'running')")"
    if [[ "$active_runs" == 0 ]]; then
      break
    fi
    if (( SECONDS >= deadline )); then
      echo "Runs did not drain within 10 minutes. Existing workers are left running; migration was not started." >&2
      exit 1
    fi
    sleep 5
  done
fi

"${compose[@]}" stop --timeout 30 worker reaper attachments
backup_dir="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-${requested_image##*:}"
mkdir -p "$backup_dir"
"${compose[@]}" exec -T db pg_dump -U custent -d custent -Fc > "$backup_dir/database.dump"
tar -C "$root/shared" -czf "$backup_dir/files.tar.gz" artifacts input-attachments
cp "$root/shared/app.env" "$root/shared/db.env" "$backup_dir/"
if [[ -f "$root/current-image" ]]; then
  cp "$root/current-image" "$backup_dir/previous-image"
fi

"${compose[@]}" run --rm --no-deps migrate
"${compose[@]}" up -d --wait --wait-timeout 180 web worker reaper attachments proxy
sleep 10
for service in web worker reaper attachments proxy; do
  container_id="$("${compose[@]}" ps -q "$service")"
  test -n "$container_id"
  test "$(docker inspect --format '{{.State.Running}} {{.RestartCount}}' "$container_id")" = 'true 0'
done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/api/bootstrap > /dev/null
rm -- "$root/shared/maintenance/enabled"
if ! curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8081/api/bootstrap > /dev/null; then
  touch "$root/shared/maintenance/enabled"
  exit 1
fi
printf '%s\n' "$requested_image" > "$root/current-image"
ln -sfn "$release_dir" "$root/current"
"${compose[@]}" ps
echo "Deployment healthy; backup: $backup_dir"
