#!/bin/sh
# Czar cloud Postgres entrypoint (PM-014; SCR-170 §5).
#
# Replaces the image's docker-entrypoint.sh for one reason: that script refuses to initialise a
# cluster unless the superuser password arrives in an environment variable (POSTGRES_PASSWORD, or
# the file it reads into one and exports to the server process), or authentication is set to
# `trust`. Czar allows neither (SCR-170 §4, D70, D78). So this script runs initdb itself with
# peer authentication for the superuser on the unix socket and scram for every TCP role, and no
# superuser password exists at all. Role passwords are set later by postgres-init, from files.
#
# Runs as root only long enough to own the data directory, then drops to the image's postgres
# user (UID 999) with the image's own gosu, exactly as the stock entrypoint does.
set -eu

# The server's own arguments (`-c config_file=...`) come from the compose command, so the file that
# decides how Postgres listens and authenticates is named where a reviewer reads the stack.
: "${PGDATA:?PGDATA is not set}"

if [ "$(id -u)" = "0" ]; then
  # The data directory is a host bind mount (/var/lib/czar/postgres). Docker creates it root-owned
  # on first start; Postgres refuses a data directory it does not own or that others can read.
  install -d -o postgres -g postgres -m 0700 "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"
  # Through sh, so the bind-mounted script needs no execute bit.
  exec gosu postgres /bin/sh "$0" "$@"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  # --auth-local=peer --auth-host=scram-sha-256 make the data directory's own pg_hba.conf safe too,
  # although the server reads /etc/czar/postgres/pg_hba.conf (postgresql.conf hba_file).
  initdb \
    --pgdata="$PGDATA" \
    --username=postgres \
    --auth-local=peer \
    --auth-host=scram-sha-256 \
    --encoding=UTF8 \
    --locale=C.UTF-8 \
    --data-checksums \
    --no-instructions
fi

exec postgres -D "$PGDATA" "$@"
