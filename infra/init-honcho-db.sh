#!/bin/bash
set -e

HONCHO_DB="${HONCHO_DB:-honcho}"
POSTGRES_USER="${POSTGRES_USER:-undre}"

echo "Creating database '${HONCHO_DB}' if not exists..."
psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE "' || '${HONCHO_DB}' || '"'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${HONCHO_DB}')\gexec
EOSQL

echo "Database '${HONCHO_DB}' ready."
