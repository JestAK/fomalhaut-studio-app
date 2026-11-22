#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${1:-$PWD/backups/$stamp}"
mkdir -p "$backup_dir"
backup_dir="$(cd "$backup_dir" && pwd)"
# SQLite online backup includes committed WAL data. No raw copy of a live SQLite file.
docker compose run --rm --no-deps studio node server/maintenance.mjs backup "/data/backups/$stamp.sqlite"
studio_id="$(docker compose ps -a -q studio)"
if [[ -z "$studio_id" ]]; then echo 'Контейнер Studio не знайдено.' >&2; exit 1; fi
docker cp "$studio_id:/data/backups/$stamp.sqlite" "$backup_dir/studio.sqlite"
cp .env "$backup_dir/.env"
cp compose.yaml "$backup_dir/compose.yaml"
docker inspect --format '{{.Image}}' "$studio_id" > "$backup_dir/image-id.txt"
(cd "$backup_dir" && sha256sum studio.sqlite > SHA256SUMS)
printf 'Резерв збережено: %s\nЗбережіть цю теку поза VPS; вона містить секрети .env.\n' "$backup_dir"
