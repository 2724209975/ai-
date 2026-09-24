#!/bin/sh
set -eu
: "${PG_TEST_CONTAINER_ID:?GitHub Actions PostgreSQL service id required}"
exec docker exec -i "$PG_TEST_CONTAINER_ID" pg_restore "$@"
