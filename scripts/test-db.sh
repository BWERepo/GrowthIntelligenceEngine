#!/usr/bin/env bash
# Runs the tenant-isolation tests against a throwaway local Postgres.
# Needs Postgres 15+ binaries (initdb, pg_ctl, psql) on PATH or in /usr/lib/postgresql/*/bin.
set -euo pipefail
cd "$(dirname "$0")/.."
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || ls -d /usr/lib/postgresql/*/bin/initdb | tail -1)")"
DIR="$(mktemp -d)"
PORT="${GIE_TEST_PGPORT:-55432}"
cleanup() { "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null
PSQL=(psql -h "$DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q)
"${PSQL[@]}" -f tests/db/supabase-stub.sql >/dev/null
for f in supabase/migrations/*.sql; do
  case "$f" in *.staging.sql|*.production.sql) continue ;; esac
  node scripts/migration-render.mjs "$f" staging | "${PSQL[@]}" >/dev/null
done
"${PSQL[@]}" -tA -f tests/db/rls.test.sql 2>&1 | sed -e 's/^psql:[^ ]* NOTICE:  /  /' -e '/^$/d' -e '/^\(SET\|RESET\|DO\|INSERT 0 [0-9]*\)$/d'
