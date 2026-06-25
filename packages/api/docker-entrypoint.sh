#!/bin/sh
set -e

MIGRATE_RETRIES="${MIGRATE_RETRIES:-10}"
MIGRATE_DELAY="${MIGRATE_DELAY:-3}"

if [ "${SKIP_MIGRATIONS:-}" != "true" ]; then
  echo "[entrypoint] Running database migrations..."

  for i in $(seq 1 "$MIGRATE_RETRIES"); do
    if npx --no-install drizzle-kit push --config=./drizzle.config.ts 2>&1; then
      echo "[entrypoint] Database migrations applied."
      break
    fi
    if [ "$i" -eq "$MIGRATE_RETRIES" ]; then
      echo "[entrypoint] FATAL: All $MIGRATE_RETRIES migration attempts failed."
      exit 1
    fi
    echo "[entrypoint] Migration attempt $i/$MIGRATE_RETRIES failed. Retrying in ${MIGRATE_DELAY}s..."
    sleep "$MIGRATE_DELAY"
  done
else
  echo "[entrypoint] SKIP_MIGRATIONS=true — skipping database migrations."
fi

exec "$@"
