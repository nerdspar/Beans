#!/bin/bash
# Runs once, on first initialization of the Postgres data volume.
#
# Its whole job is to create the role the application connects as — and to make sure that role
# is NOT a superuser and does NOT have BYPASSRLS.
#
# This is not a nicety. Postgres silently ignores row-level security for superusers, so connecting
# the app as the POSTGRES_USER superuser would disable tenant isolation completely, with no error
# and no visible symptom. Combined with FORCE ROW LEVEL SECURITY (migration 0002), which removes
# the table-owner exemption, these two facts are what make the RLS layer real.
#
# If you ever need to re-run this against an existing volume, the volume must be recreated —
# Postgres only executes /docker-entrypoint-initdb.d on an empty data directory.

set -euo pipefail

: "${BEANS_DB_USER:?BEANS_DB_USER must be set}"
: "${BEANS_DB_PASSWORD:?BEANS_DB_PASSWORD must be set}"
: "${BEANS_DB_NAME:=beans}"
: "${BEANS_TEST_DB_NAME:=beans_test}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- NOSUPERUSER and NOBYPASSRLS are the two clauses that matter here.
    CREATE ROLE "${BEANS_DB_USER}"
        WITH LOGIN PASSWORD '${BEANS_DB_PASSWORD}'
        NOSUPERUSER
        NOBYPASSRLS
        NOCREATEROLE
        NOCREATEDB;

    GRANT CONNECT ON DATABASE "${BEANS_DB_NAME}" TO "${BEANS_DB_USER}";

    -- CREATE on the database is needed for two things: drizzle migrations creating our tables,
    -- and pg-boss installing its own schema on first start.
    GRANT CREATE ON DATABASE "${BEANS_DB_NAME}" TO "${BEANS_DB_USER}";
EOSQL

# Postgres 15+ no longer grants CREATE on the public schema to PUBLIC, so it must be explicit.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$BEANS_DB_NAME" <<-EOSQL
    GRANT USAGE, CREATE ON SCHEMA public TO "${BEANS_DB_USER}";
EOSQL

# A separate database for integration tests, which truncate tables freely and must never be
# pointed at development data.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "${BEANS_TEST_DB_NAME}";
    GRANT CONNECT, CREATE ON DATABASE "${BEANS_TEST_DB_NAME}" TO "${BEANS_DB_USER}";
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$BEANS_TEST_DB_NAME" <<-EOSQL
    GRANT USAGE, CREATE ON SCHEMA public TO "${BEANS_DB_USER}";
EOSQL

echo "Beans: created role ${BEANS_DB_USER} (NOSUPERUSER, NOBYPASSRLS) and database ${BEANS_TEST_DB_NAME}"
