#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
backup_dir="$(cd "${1:?Вкажіть теку резервної копії}" && pwd)"
if [[ ! -f "$backup_dir/studio.sqlite" || ! -f "$backup_dir/.env" ]]; then echo 'Потрібні studio.sqlite та .env.' >&2; exit 1; fi
if [[ -f .env ]]; then echo '.env уже існує. Скрипт не перезаписує налаштування.' >&2; exit 1; fi
umask 077
cp "$backup_dir/.env" .env
docker compose build studio
# maintenance refuses to overwrite any existing database.
docker compose run --rm --no-deps -v "$backup_dir:/restore:ro" studio node server/maintenance.mjs restore /restore/studio.sqlite
docker compose run --rm --no-deps studio node server/maintenance.mjs resume
printf 'Базу відновлено. Перевірте домен та .env. Після виходу бота зі старого сервера виконайте docker compose up -d.\n'
