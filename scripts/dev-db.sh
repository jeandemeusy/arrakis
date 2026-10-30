#!/usr/bin/env sh
# A throwaway PostgreSQL for trying the studio locally.
#
#   npm run dev:db              start it (creates it on first use)
#   npm run dev:db -- --demo    also load a synthetic Blokli index to query
#   npm run dev:db -- stop      stop it
#   npm run dev:db -- reset     stop it and delete its data
#
# Lives in ./.pgdata (git-ignored), listens on port 54329 and a socket in that
# directory, and trusts local connections — for development only. Needs
# initdb/pg_ctl/psql on PATH, which the Nix dev shell provides.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$ROOT/.pgdata"
PORT=54329
HOST=127.0.0.1
URL="postgresql://postgres@$HOST:$PORT"

stop() {
  if [ -f "$DATA/postmaster.pid" ]; then
    pg_ctl -D "$DATA" stop -m fast >/dev/null
    echo "Stopped."
  fi
}

case "${1:-start}" in
  stop)
    stop
    exit 0
    ;;
  reset)
    stop
    rm -rf "$DATA"
    echo "Deleted $DATA."
    exit 0
    ;;
esac

if [ ! -d "$DATA" ]; then
  initdb -D "$DATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
fi
if ! pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA" -l "$DATA/server.log" \
    -o "-p $PORT -k $DATA -c listen_addresses=$HOST" start >/dev/null
fi

if ! psql "$URL/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname = 'arrakis'" | grep -q 1; then
  psql "$URL/postgres" -q -c 'CREATE DATABASE arrakis'
fi

DEMO=""
for arg in "$@"; do
  [ "$arg" = "--demo" ] && DEMO=1
done

if [ -n "$DEMO" ]; then
  if ! psql "$URL/postgres" -tAc "SELECT 1 FROM pg_database WHERE datname = 'blokli_demo'" | grep -q 1; then
    psql "$URL/postgres" -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE blokli_reader LOGIN;
CREATE DATABASE blokli_demo;
SQL
    psql "$URL/blokli_demo" -q -v ON_ERROR_STOP=1 -f "$ROOT/test/fixtures/blokli.sql"
    psql "$URL/blokli_demo" -q -v ON_ERROR_STOP=1 <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO blokli_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO blokli_reader;
SQL
  fi
fi

echo "PostgreSQL is running on $HOST:$PORT. For .env.local:"
echo
echo "APP_DATABASE_URL=$URL/arrakis"
if [ -n "$DEMO" ]; then
  echo "NETWORKS='[{\"id\":\"demo\",\"label\":\"Demo\",\"databaseUrl\":\"postgresql://blokli_reader@$HOST:$PORT/blokli_demo\"}]'"
fi
