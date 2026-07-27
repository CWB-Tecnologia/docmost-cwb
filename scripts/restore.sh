#!/usr/bin/env bash
# Restore a backup produced by backup.sh. DESTRUCTIVE: drops the database and
# wipes the attachment volume, replacing both with the archived content.
#
#   bash ./scripts/restore.sh /opt/docmost-cwb/backup/20260727-023000 --yes
#
# Run as root ON THE VM from /opt/docmost-cwb.
#
# Rehearse on a throwaway project instead of production — see
# docs/backup-restore.md:
#
#   COMPOSE_PROJECT_NAME=docmost-rehearsal DOCMOST_HTTP_PORT=127.0.0.1:3001 \
#       bash ./scripts/restore.sh <dir> --yes
set -euo pipefail

SRC=${1:?usage: restore.sh <backup-dir> --yes}
CONFIRM=${2:-}
COMPOSE=${COMPOSE:-docker-compose.prod.yml}

log() { printf '==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$COMPOSE" ] || die "$COMPOSE not found (run from /opt/docmost-cwb)"
[ -d "$SRC" ] || die "$SRC is not a directory"
[ "$CONFIRM" = "--yes" ] || die "refusing to overwrite live data without --yes"

# docker run -v needs an absolute path; a relative one is parsed as a named volume.
SRC=$(realpath "$SRC")

for f in MANIFEST.txt docmost.dump storage.tar.gz env SHA256SUMS; do
    [ -f "$SRC/$f" ] || die "$SRC/$f missing"
done

# SHA256SUMS is the completeness marker: backup.sh writes it last, so a directory
# that has it is a backup that finished. Verification is not optional here.
log "verifying checksums"
(cd "$SRC" && sha256sum -c SHA256SUMS)

dc() { docker compose -f "$COMPOSE" "$@"; }

PROJECT=${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}
vol() {
    local found count
    found=$(docker volume ls -q \
        --filter "label=com.docker.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.volume=$1")
    count=$(printf '%s' "$found" | grep -c . || true)
    [ "$count" -eq 1 ] || die "expected exactly 1 volume for '$1' in project '$PROJECT', got $count: ${found//$'\n'/ }"
    printf '%s\n' "$found"
}

log "project '$PROJECT' — this is what will be overwritten"

# Stop the app before touching the database: it holds connections and, on boot,
# runs migrateToLatest() (database.module.ts). Restoring underneath a running
# instance races the migration runner.
log "stopping application (database stays up for the restore)"
dc stop docmost
dc up -d db

STORAGE_VOL=$(vol docmost)

# dropdb --force instead of hand-rolled pg_terminate_backend SQL: it is the
# documented primitive since PG 13 and avoids nested-quote hazards. The database
# is recreated empty so pg_restore starts from a clean schema; POSTGRES_USER is
# the superuser the image bootstraps, which CREATE EXTENSION (unaccent, pg_trgm)
# inside the dump requires.
log "recreating database"
dc exec -T db sh -c 'exec dropdb   -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB"'
dc exec -T db sh -c 'exec createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"'

log "restoring database"
dc exec -T db sh -c '
    exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --no-owner --no-privileges --single-transaction' < "$SRC/docmost.dump"

# 1000:1000, not 33:33 like glpi-cwb: the Docmost image runs as USER node
# (Dockerfile), so files owned by anyone else are unreadable to the app.
log "restoring attachment volume $STORAGE_VOL"
docker run --rm -v "$STORAGE_VOL":/dst -v "$SRC/storage.tar.gz":/src.tar.gz:ro alpine:3 sh -euc '
    find /dst -mindepth 1 -delete
    tar -xzf /src.tar.gz -C /dst
    chown -R 1000:1000 /dst
'

log "starting application"
dc up -d --wait

cat <<EOF

==> restore complete from $SRC

Next:
  1. Compare the live row counts against the archived ones:
       cat $SRC/MANIFEST.txt
       docker compose -f $COMPOSE exec -T db sh -c 'exec psql -q -X -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" -c "
         select (select count(*) from pages) pages, (select count(*) from users) users,
                (select count(*) from spaces) spaces, (select count(*) from attachments) attachments"'
  2. Open a real page in the browser and confirm an attachment downloads.
  3. Check the logs for migration output:
       docker compose -f $COMPOSE logs --tail=50 docmost

NOTE: if the dump predates the running image, boot just migrated the restored
schema FORWARD (migrateToLatest runs on every production boot). That is expected,
and it is not reversible — the image ships no down-migration path.

The archived env file was NOT applied. Compare it against the live .env before
assuming the restore is complete:
    diff "$SRC/env" .env
EOF
