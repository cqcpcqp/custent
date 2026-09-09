#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ "$EUID" -ne 0 || "$#" -ne 2 ]]; then
  echo "Usage: sudo bash bootstrap.sh app.env db.env" >&2
  exit 1
fi

root=/opt/custent
docker compose version
if [[ -e "$root/shared/app.env" || -e "$root/shared/db.env" ]]; then
  echo "Existing deployment secrets will not be overwritten" >&2
  exit 1
fi
test -s "$1"
test -s "$2"
install -d -m 755 "$root" "$root/shared" "$root/shared/maintenance"
install -d -m 750 -o ubuntu -g ubuntu "$root/releases"
install -d -m 700 "$root/backups"
install -d -m 750 -o 1000 -g 1000 "$root/shared/artifacts" "$root/shared/input-attachments"
install -m 600 "$1" "$root/shared/app.env"
install -m 600 "$2" "$root/shared/db.env"
touch "$root/shared/maintenance/enabled"
chmod 644 "$root/shared/maintenance/enabled"
echo "Custent directories and secrets prepared; no application services started."
