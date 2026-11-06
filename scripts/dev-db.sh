#!/usr/bin/env sh
# A throwaway PostgreSQL for trying the studio locally.
#
#   npm run dev:db              start it (creates it on first use)
#   npm run dev:db -- --blokli  also (re)build a synthetic Blokli index to
#                               query — eleven months of a made-up HOPR
#                               network, raw events included — from
#                               test/fixtures/blokli-demo.sql
#   npm run dev:db -- stop      stop it
#   npm run dev:db -- reset     stop it and delete its data
#
# Lives in ./.pgdata (git-ignored) and listens on 127.0.0.1:54329 and on a
# socket in that directory. For development only, but set up the way a real
# deployment should be:
#
#  - Arrakis connects as `arrakis`, an ordinary role that owns the `arrakis`
#    database, never as the superuser. Hand-written chart SQL runs inside that
#    database, so whatever the app's role may do, a chart may try.
#  - TCP connections need a password (scram-sha-256). Each role gets a random
#    one, kept in .pgdata (mode 600) and printed below.
#  - Only the socket trusts without a password, and it sits in .pgdata, which
#    initdb makes readable by its owner alone. The superuser is reached there.
#
# Needs initdb/pg_ctl/psql on PATH, which the Nix dev shell provides.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="$ROOT/.pgdata"
PORT=54329
HOST=127.0.0.1

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

# The superuser, over the socket.
admin() {
  database=$1
  shift
  psql -h "$DATA" -p "$PORT" -U postgres -d "$database" -X -q -v ON_ERROR_STOP=1 "$@"
}

# A role's password: made once, then reused, so .env.local stays valid.
password() {
  file="$DATA/$1.password"
  if [ ! -s "$file" ]; then
    (umask 077 && od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$file")
  fi
  cat "$file"
}

if [ ! -d "$DATA" ]; then
  initdb -D "$DATA" -U postgres --encoding=UTF8 \
    --auth-local=trust --auth-host=scram-sha-256 >/dev/null
fi

# Rewritten every start, so a .pgdata made by an older version of this script
# (which trusted TCP connections too) is brought in line.
cat >"$DATA/pg_hba.conf" <<'HBA'
# Written by scripts/dev-db.sh; edits are overwritten on the next start.
# TYPE  DATABASE  USER  ADDRESS        METHOD
local   all       all                  trust
host    all       all   127.0.0.1/32   scram-sha-256
host    all       all   ::1/128        scram-sha-256
HBA

if pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA" reload >/dev/null
else
  pg_ctl -D "$DATA" -l "$DATA/server.log" \
    -o "-p $PORT -k $DATA -c listen_addresses=$HOST -c password_encryption=scram-sha-256" \
    start >/dev/null
fi

APP_PASSWORD=$(password arrakis)

# The app's role and database. Not a superuser and no CREATEROLE: the role
# the hand-written chart SQL switches to is made here instead, by the
# superuser, and handed over with ADMIN so the app's migration can grant it
# to itself.
admin postgres -v app_password="$APP_PASSWORD" <<'SQL'
SET client_min_messages = warning;
SELECT format('CREATE ROLE arrakis LOGIN PASSWORD %L', :'app_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis') \gexec
ALTER ROLE arrakis LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
SELECT 'CREATE ROLE arrakis_results_reader NOLOGIN'
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis_results_reader') \gexec
GRANT arrakis_results_reader TO arrakis WITH ADMIN TRUE, SET TRUE;
SELECT 'CREATE DATABASE arrakis OWNER arrakis'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'arrakis') \gexec
ALTER DATABASE arrakis OWNER TO arrakis;
SQL

# A database made by an older version of this script belongs to the
# superuser, tables and all. Hand everything in it to `arrakis`, so the app
# keeps its saved queries and dashboards under its new role.
admin arrakis <<'SQL'
SET client_min_messages = warning;
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname FROM pg_namespace n
    WHERE n.nspowner = 'postgres'::regrole
      AND n.nspname NOT LIKE 'pg\_%' AND n.nspname NOT IN ('information_schema', 'public')
  LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO arrakis', item.nspname);
  END LOOP;
  -- Tables, views and free-standing sequences; a table's own sequences and
  -- indexes follow it.
  FOR item IN
    SELECT c.oid::regclass AS name, c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relowner = 'postgres'::regrole
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
      AND NOT (c.relkind = 'S' AND EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
          AND d.deptype IN ('a', 'i')))
  LOOP
    EXECUTE format(
      'ALTER %s %s OWNER TO arrakis',
      CASE item.relkind
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'f' THEN 'FOREIGN TABLE'
        ELSE 'TABLE'
      END,
      item.name);
  END LOOP;
  FOR item IN
    SELECT p.oid::regprocedure AS name FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proowner = 'postgres'::regrole
      AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO arrakis', item.name);
  END LOOP;
END
$$;
SQL

BLOKLI=""
for arg in "$@"; do
  [ "$arg" = "--blokli" ] && BLOKLI=1
done

# The demo data source's role. One left by an older version of this script has
# no password, which TCP now requires: give it one without rebuilding the demo.
READER_PASSWORD=""
if [ -n "$BLOKLI" ] ||
  [ "$(admin postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'blokli_reader'")" = 1 ]; then
  READER_PASSWORD=$(password blokli_reader)
fi
if [ -z "$BLOKLI" ] && [ -n "$READER_PASSWORD" ]; then
  admin postgres -v reader_password="$READER_PASSWORD" <<'SQL'
ALTER ROLE blokli_reader PASSWORD :'reader_password';
SQL
fi

if [ -n "$BLOKLI" ]; then
  # Rebuilt every time: the fixture places its blocks from the moment it is
  # loaded, so a fresh build also brings the history up to today.
  admin postgres -v reader_password="$READER_PASSWORD" <<'SQL'
SET client_min_messages = warning;
SELECT format('CREATE ROLE blokli_reader LOGIN PASSWORD %L', :'reader_password')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'blokli_reader') \gexec
ALTER ROLE blokli_reader LOGIN PASSWORD :'reader_password';
DROP DATABASE IF EXISTS blokli_demo WITH (FORCE);
CREATE DATABASE blokli_demo;
SQL
  admin blokli_demo -f "$ROOT/test/fixtures/blokli-demo.sql"
  # A data source is read through a role that can only read.
  admin blokli_demo <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO blokli_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO blokli_reader;
SQL
fi

echo "PostgreSQL is running on $HOST:$PORT. For .env.local:"
echo
echo "APP_DATABASE_URL=postgresql://arrakis:$APP_PASSWORD@$HOST:$PORT/arrakis"
if [ -n "$READER_PASSWORD" ]; then
  echo "DATA_SOURCES='[{\"id\":\"demo\",\"label\":\"Demo\",\"databaseUrl\":\"postgresql://blokli_reader:$READER_PASSWORD@$HOST:$PORT/blokli_demo\"}]'"
fi
echo
echo "The superuser is only reachable over the socket, e.g. for the tests:"
echo "TEST_ADMIN_DATABASE_URL='postgresql://postgres@localhost:$PORT/postgres?host=$DATA'"
if [ -n "$BLOKLI" ]; then
  echo
  echo "Then import examples/bundles/gnosis-vpn.json under Settings → Bundles."
  echo "The demo network's three exits are registered in its service registry, so"
  echo "they are found without being added to the list \"exits\" (Settings → Lists)."
fi
