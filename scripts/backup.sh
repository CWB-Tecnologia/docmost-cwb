#!/usr/bin/env bash
# Nightly backup of the containerised Docmost: a logical dump of Postgres plus the
# attachment volume. Run as root ON THE VM from /opt/docmost-cwb, e.g. from
# /etc/cron.d:
#
#   30 2 * * * root cd /opt/docmost-cwb && bash scripts/backup.sh >> /var/log/docmost-backup.log 2>&1
#
# 02:30 and not 02:15: glpi-cwb backs up at 02:15 and this host has 1 vCPU.
#
# The archive contains every page, every attachment, password hashes and the live
# .env: treat it as a secret, keep it off any world-readable path, and copy it off
# this host (there is no off-host backup yet — infra-cwb/docs/vm-srv1402182.md).
#
# SHA256SUMS is written LAST and on purpose: a backup directory without it is
# incomplete, and restore.sh refuses to read one.
set -euo pipefail

COMPOSE=${COMPOSE:-docker-compose.prod.yml}
BACKUP_ROOT=${BACKUP_ROOT:-/opt/docmost-cwb/backup}
RETENTION_DAYS=${RETENTION_DAYS:-14}

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_ROOT/$STAMP"

log() { printf '==> %s\n' "$*"; }
die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -f "$COMPOSE" ] || die "$COMPOSE not found (run from /opt/docmost-cwb)"
[ -f .env ] || die ".env not found (run from /opt/docmost-cwb)"

dc() { docker compose -f "$COMPOSE" "$@"; }

# The volumes carry the compose project prefix (docmost-cwb_db_data, ...) because
# docker-compose.prod.yml deliberately does NOT pin `name:` like glpi-cwb does —
# renaming a volume on a live stack makes Compose create a new empty one and
# Docmost boots with zero pages. Resolve by label instead of guessing the prefix.
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

STORAGE_VOL=$(vol docmost)

mkdir -p "$DEST"
chmod 700 "$BACKUP_ROOT" "$DEST"
# docker run -v needs an absolute path; a relative BACKUP_ROOT override would be
# parsed as a named volume and the archive would land somewhere nobody looks.
DEST=$(realpath "$DEST")

# Counts first, so the manifest describes the same instant the dump starts from.
# Generated from pg_stat_user_tables rather than a hardcoded table list: the list
# would go stale the next time a migration adds a table.
log "writing manifest"
dc exec -T db sh -c 'exec psql -q -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    > "$DEST/MANIFEST.txt" <<'SQL'
\pset footer off
\echo -- taken at
select now() as taken_at, version() as server;
\echo -- exact row counts per table
select relname as table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname),
                           false, true, '')))[1]::text::bigint as rows
  from pg_stat_user_tables
 where schemaname = 'public'
 order by relname;
\echo -- collaborative document payload
select count(*) as pages, coalesce(sum(octet_length(ydoc)), 0) as ydoc_bytes from pages;
SQL

# Database BEFORE the volume. An attachment uploaded between the two snapshots
# becomes an unreferenced file in the archive, which is harmless. The reverse
# order leaves an `attachments` row pointing at a file that was never captured,
# which is a broken download after a restore.
#
# -Fc self-compresses, so no gzip. Credentials are expanded INSIDE the container
# (single-quoted sh -c), never interpolated into this script's process list.
log "dumping database"
dc exec -T db sh -c '
    exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -Fc --no-owner --no-privileges --compress=6' > "$DEST/docmost.dump.part"
mv "$DEST/docmost.dump.part" "$DEST/docmost.dump"

# redis_data is deliberately NOT archived: BullMQ queues and collab locks are
# derived state. Losing them costs at most an unsent notification e-mail.
log "archiving attachment volume $STORAGE_VOL"
docker run --rm -v "$STORAGE_VOL":/src:ro -v "$DEST":/dst alpine:3 \
    tar -czf /dst/storage.tar.gz -C /src .

# Without .env the restored stack cannot start: DATABASE_URL has to match
# POSTGRES_*, and a different APP_SECRET invalidates every session and token.
# Named `env`, not `.env`, so it is not hidden from ls and from the globs below.
log "copying .env"
cp -a .env "$DEST/env"

chmod 600 "$DEST"/*
(cd "$DEST" && sha256sum ./MANIFEST.txt ./docmost.dump ./storage.tar.gz ./env > SHA256SUMS)
chmod 600 "$DEST/SHA256SUMS"

log "pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' \
    -mtime +"$RETENTION_DAYS" -exec rm -rf {} +

log "backup complete: $DEST"
du -sh "$DEST"
df -h "$BACKUP_ROOT" | tail -1
