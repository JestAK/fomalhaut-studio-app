#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Run from a NEW release directory with a copy of the existing .env.
# Stable Compose project name reconnects existing data volumes.
docker compose build studio
docker compose run --rm --no-deps studio node server/maintenance.mjs drain
resumed=0
cleanup() { if [[ "$resumed" == 0 ]]; then docker compose run --rm --no-deps studio node server/maintenance.mjs resume || true; fi; }
trap cleanup EXIT
idle=0
for ((i=0;i<120;i++)); do
  if docker compose run --rm --no-deps studio node server/maintenance.mjs idle; then idle=1; break; fi
  sleep 5
done
if [[ "$idle" == 0 ]]; then echo 'Черга ще працює. Оновлення скасовано; спробуйте після завершення завантажень.' >&2; exit 1; fi
bash ops/backup.sh
# Only Studio is replaced. Persistent volumes and Telegram Bot API are retained.
docker compose up -d --no-deps --force-recreate studio
healthy=0
for ((i=0;i<60;i++)); do
  if docker compose exec -T studio node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then healthy=1; break; fi
  sleep 2
done
if [[ "$healthy" == 0 ]]; then echo 'Новий реліз не пройшов перевірку. Резерв збережено; скористайтеся інструкцією відновлення.' >&2; exit 1; fi
# Rebind the release's Caddyfile so the 1 GiB upload limit takes effect.
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d --no-deps --force-recreate caddy
docker compose run --rm --no-deps studio node server/maintenance.mjs resume
resumed=1
printf 'Оновлення завершено. Перевірте вхід, файли та сповіщення.\n'
