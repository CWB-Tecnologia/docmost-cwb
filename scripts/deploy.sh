#!/usr/bin/env bash
# Pull-based deploy for the containerised Docmost. Runs ON THE VM as root, driven by
# scripts/systemd/docmost-deploy.timer every 5 minutes.
#
# Why the VM pulls instead of CI pushing over SSH: inbound SSH on this host is
# restricted to an IP allowlist and GitHub-hosted runners have dynamic IPs, so the
# old scp+ssh deploy started timing out (2026-07-28). Everything here is
# outbound-only: git over HTTPS, GHCR over HTTPS.
#
# The trigger is git HEAD, not a registry digest. Git pairs the compose file with the
# image tag by construction — one commit can change both — and the image carries no
# revision label, so a digest cannot be turned back into a commit. Rationale and the
# operator runbook: docs/deploy.md
#
# Runs FROM THE CLONE (/opt/docmost-cwb-src/scripts/deploy.sh) and never from
# /opt/docmost-cwb/scripts/: bash reads a script incrementally, and `git reset --hard`
# replacing this file mid-run would corrupt the running shell. Consequence worth
# knowing: a change to this script takes effect on the NEXT tick.
#
# Exit codes are load-bearing (docs/deploy.md):
#   0  nothing to do — no new commit, image not published yet, lock busy, hold set
#   1  pre-flight failed and NOTHING was touched; retried on the next tick
#   2  the stack was recreated and did not become healthy; deploys hold until a human
set -euo pipefail

PROJECT_DIR=${PROJECT_DIR:-/opt/docmost-cwb}
COMPOSE=${COMPOSE:-docker-compose.prod.yml}
IMAGE=${IMAGE:-ghcr.io/cwb-tecnologia/docmost-cwb}
REPO=${REPO:-CWB-Tecnologia/docmost-cwb}
BRANCH=${BRANCH:-main}
CONF_DIR=${CONF_DIR:-/etc/docmost-cwb}
STATE=${STATE:-/var/lib/docmost-cwb/state}
LOCK=${LOCK:-/run/lock/docmost-cwb.lock}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/api/health}
STATUS_CONTEXT=${STATUS_CONTEXT:-deploy/vm-srv1402182}
KEEP_IMAGES=${KEEP_IMAGES:-2}
MIN_FREE_GB=${MIN_FREE_GB:-8}
WAIT_TIMEOUT=${WAIT_TIMEOUT:-300}
STALE_ALERT_MIN=${STALE_ALERT_MIN:-30}
TOKEN_WARN_DAYS=${TOKEN_WARN_DAYS:-14}

SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SHA=""
FORCE=0

# journald reads a leading <N> as the syslog priority (SyslogLevelPrefix defaults to
# on for services), which is what makes `journalctl -u docmost-deploy -p warning` an
# incident list instead of 2000 lines of "nothing to do". On a terminal the prefix is
# noise, so swap it for a word.
if [ -t 1 ]; then
    log() {
        local pri=$1 label; shift
        case "$pri" in
            3) label='ERR ' ;;
            4) label='WARN' ;;
            6) label='==> ' ;;
            *) label='    ' ;;
        esac
        printf '%s %s\n' "$label" "$*"
    }
else
    log() { local pri=$1; shift; printf '<%d>%s\n' "$pri" "$*"; }
fi
err()  { log 3 "$@"; }
warn() { log 4 "$@"; }
info() { log 6 "$@"; }
dbg()  { log 7 "$@"; }
die()  { err "$@"; exit 1; }

short() { printf '%s' "${1:0:12}"; }

# --- state -------------------------------------------------------------------
# Flat key=value, 0600. Deliberately not JSON: a human reads this during an incident
# with `cat`, and there is no jq dependency in the happy path.
state_get() {
    [ -r "$STATE" ] || return 0
    sed -n "s/^$1=//p" "$STATE" | tail -1
}

state_set() {
    local key=$1 val=$2 tmp
    install -d -m 700 "$(dirname "$STATE")"
    tmp=$(mktemp "$STATE.XXXXXX") || die "could not create a temp file next to $STATE"
    if [ -r "$STATE" ]; then
        grep -v "^$key=" "$STATE" > "$tmp" || true
    fi
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$STATE"
}

# --- GitHub ------------------------------------------------------------------
# CI marks the commit `pending`; this is what turns it green or red. A commit whose
# deploy never landed therefore stays YELLOW instead of lying green. Never make this
# context a required status check: a stopped VM would block every merge.
gh_status() {
    local state=$1 desc=$2
    [ -n "$SHA" ] || return 0
    [ -r "$CONF_DIR/github.token" ] || return 0
    curl -fsS -o /dev/null -X POST \
        -H "Authorization: Bearer $(cat "$CONF_DIR/github.token")" \
        -H 'Accept: application/vnd.github+json' \
        -H 'X-GitHub-Api-Version: 2022-11-28' \
        "https://api.github.com/repos/$REPO/statuses/$SHA" \
        -d "$(printf '{"state":"%s","context":"%s","description":"%s"}' \
                "$state" "$STATUS_CONTEXT" "${desc:0:139}")" \
        || warn "could not post commit status (the deploy result above stands)"
}

# Token expiry is how a pull-based deploy dies in silence, so it gets announced
# ahead of time instead of discovered as a 401 during an incident.
token_expiry_warn() {
    local file=$1 label=$2 exp days
    [ -r "$file" ] || return 0
    exp=$(curl -fsSI -H "Authorization: Bearer $(cat "$file")" https://api.github.com/user 2>/dev/null \
        | tr -d '\r' \
        | awk -F': ' 'tolower($1)=="github-authentication-token-expiration"{print $2}') || return 0
    [ -n "$exp" ] || return 0
    days=$(( ( $(date -d "$exp" +%s) - $(date +%s) ) / 86400 ))
    if [ "$days" -le "$TOKEN_WARN_DAYS" ]; then
        warn "$label expires in ${days}d ($exp) — rotate it before deploys stop"
    fi
}

# The fetch is anonymous while this repo is public. When it goes private it needs a
# credential — and NOT the one github.token holds: that is a classic `repo:status` PAT,
# which does not grant git read access, so pointing git at it fails with
# `could not read Username for 'https://github.com'`. glpi-cwb hit exactly that. Put a
# fine-grained PAT with Contents: read-only in git.token, or switch the remote to SSH with
# a read-only deploy key and leave both files out of it.
git_src() {
    if [ -r "$CONF_DIR/git.token" ]; then
        git -C "$SRC" \
            -c "credential.helper=!f() { [ \"\$1\" = get ] && printf 'username=x-access-token\npassword=%s\n' \"\$(cat $CONF_DIR/git.token)\"; }; f" \
            "$@"
    else
        git -C "$SRC" "$@"
    fi
}

# --- docker ------------------------------------------------------------------
dc() { docker compose -f "$COMPOSE" "$@"; }

# RepoDigests lives on the IMAGE, not the container, so this has to hop
# container -> image. `{{.Config.Image}}` (what docs/operations.md used to print)
# gives the tag, which cannot distinguish two builds of main-latest.
running_digest() {
    local cid iid
    cid=$(dc ps -q docmost 2>/dev/null) || return 0
    [ -n "$cid" ] || return 0
    iid=$(docker inspect --format '{{.Image}}' "$cid") || return 0
    docker image inspect \
        --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}none{{end}}' "$iid" || true
}

# Keep the tag just deployed and the one before it. That retention is what makes the
# IMAGE_TAG pin in docs/rollback.md a working fast path instead of a 401.
#
# `docker image prune -af` is deliberately NOT used: -a deletes every image without a
# container across EVERY stack on this host. It would take alpine:3 (scripts/backup.sh
# runs it via `docker run --rm`, so nothing references it between backups, and the next
# backup would re-pull it anonymously from Docker Hub), plus GLPI's and MeshCentral's
# spare images. Only dangling layers are pruned here.
#
# This matters more than it looks: because the tag pulled is immutable, images never
# become dangling on their own — without this step the disk grows ~1.8 GB per merge.
#
# Selection is by TAG, not by age: on Docker 29 every build of this image reports the
# same `{{.CreatedAt}}` (reproducible build timestamps) and `{{.ID}}` is the index
# digest, so sorting by date is a coin flip that can pick the running image. Untagging
# with `docker rmi` (no -f) is the safety net — a still-referenced image refuses.
prune_images() {
    local keep_current=$1 keep_prev=$2 ref tag
    while read -r ref; do
        [ -n "$ref" ] || continue
        tag=${ref##*:}
        case "$tag" in
            '<none>'|"$keep_current"|"$keep_prev"|main-latest) continue ;;
        esac
        info "untagging superseded image $ref"
        docker rmi "$ref" >/dev/null 2>&1 || warn "could not remove $ref (still in use?)"
    done < <(docker image ls --filter "reference=$IMAGE" --format '{{.Repository}}:{{.Tag}}')
    docker image prune -f >/dev/null || true
}

# --- modes -------------------------------------------------------------------
show_status() {
    printf '# %s\n' "$STATE"
    if [ -r "$STATE" ]; then cat "$STATE"; else printf '(no deploy has recorded state yet)\n'; fi
    printf '\nhold: '
    if [ -e "$CONF_DIR/hold" ]; then cat "$CONF_DIR/hold"; else printf 'none\n'; fi
    printf 'running image: %s\n' "$(running_digest)"
    printf 'health: '
    curl -fsS -m 10 "$HEALTH_URL" || printf 'UNREACHABLE'
    printf '\n'
}

usage() {
    cat <<'EOF'
Usage: deploy.sh [--status | --force | --help]

  (no flag)  one deploy tick: fetch main, deploy it if it is new and healthy
  --status   print the state file, the hold flag, the running image digest and health
  --force    deploy the current HEAD even if it is already deployed or previously failed
EOF
}

case "${1:-}" in
    --status) show_status; exit 0 ;;
    --force)  FORCE=1 ;;
    --help|-h) usage; exit 0 ;;
    '') ;;
    *) usage >&2; exit 1 ;;
esac

# --- tick --------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run as root"

# The compose project name comes from this directory's basename, and backup.sh and
# restore.sh resolve volumes by that project label. Running compose from the clone
# would invent the project `docmost-cwb-src`, create a fresh EMPTY set of volumes and
# boot Docmost with zero pages.
cd "$PROJECT_DIR" || die "$PROJECT_DIR not found"

# systemd already refuses to run a oneshot twice, but the human path (backup.sh,
# restore.sh during an incident) goes around systemd. One lock for all three.
# /run/lock is tmpfs, so a reboot mid-deploy cannot leave a stale lock behind.
exec 9>"$LOCK"
if ! flock -n 9; then
    info "another docmost-cwb operation holds $LOCK; skipping this tick"
    exit 0
fi

if [ -e "$CONF_DIR/hold" ]; then
    if [ "$(state_get hold_logged)" != yes ]; then
        warn "deploys held by $CONF_DIR/hold: $(head -1 "$CONF_DIR/hold" 2>/dev/null || printf 'no reason recorded')"
        state_set hold_logged yes
    else
        dbg "deploys held by $CONF_DIR/hold"
    fi
    exit 0
fi
if [ "$(state_get hold_logged)" = yes ]; then
    info "hold flag cleared; deploys resume"
    state_set hold_logged no
fi

# Pre-flight. Everything here exits 1 and touches nothing, so a transient problem
# (docker restarting, no network, expired token) retries next tick instead of
# freezing deploys the way an exit 2 does.
command -v docker >/dev/null || die "docker is not installed"
command -v git >/dev/null || die "git is not installed"
docker info >/dev/null 2>&1 || die "the docker daemon is not responding"
[ -f "$COMPOSE" ] || die "$COMPOSE not found in $PROJECT_DIR"
[ -f .env ] || die ".env not found in $PROJECT_DIR"
[ -d "$SRC/.git" ] || die "$SRC is not a git clone"

# "The deploy filled the disk and took GLPI down with it" is a likelier outage on this
# shared 1 vCPU box than the deploy itself failing.
avail_gb=$(df --output=avail -BG /var/lib/docker 2>/dev/null | tail -1 | tr -dc '0-9')
if [ "${avail_gb:-0}" -lt "$MIN_FREE_GB" ]; then
    die "only ${avail_gb:-?}G free under /var/lib/docker (need ${MIN_FREE_GB}G); refusing to pull"
fi

# Logged in per run as well as at bootstrap: the bootstrap login is what makes an
# emergency `docker pull ghcr.io/...:sha-<old>` work at 2am, and re-logging in here
# turns an expired token into an explicit failure on line one of the journal instead
# of a confusing pull error later.
if [ -r "$CONF_DIR/ghcr.token" ]; then
    [ -r "$CONF_DIR/ghcr.user" ] || die "$CONF_DIR/ghcr.token exists but $CONF_DIR/ghcr.user does not (GHCR needs the GitHub username)"
    docker login ghcr.io -u "$(cat "$CONF_DIR/ghcr.user")" --password-stdin \
        < "$CONF_DIR/ghcr.token" >/dev/null \
        || die "docker login ghcr.io failed — is the read:packages token expired or revoked?"
fi

# Units are copied into /etc/systemd/system at bootstrap, not symlinked (a symlinked
# unit that changes under systemd without daemon-reload wastes an hour). Same checksum
# discipline docs/operations.md used to prescribe by hand for scripts/.
for unit in docmost-deploy.service docmost-deploy.timer; do
    if [ -r "/etc/systemd/system/$unit" ] \
       && ! cmp -s "$SRC/scripts/systemd/$unit" "/etc/systemd/system/$unit"; then
        warn "unit drift: $unit differs from the repo — re-install it and run systemctl daemon-reload"
    fi
done

if ! git_src fetch --quiet origin "$BRANCH"; then
    if [ -r "$CONF_DIR/git.token" ]; then
        die "git fetch failed — network, or the token in $CONF_DIR/git.token lost Contents:read"
    fi
    die "git fetch failed; if this repo is now private the fetch needs $CONF_DIR/git.token (fine-grained, Contents:read) or an SSH deploy key — repo:status does NOT grant it"
fi
git_src reset --hard --quiet "origin/$BRANCH" || die "git reset --hard failed"
SHA=$(git_src rev-parse HEAD)
# `git rev-parse --short=12` returns AT LEAST 12 characters and more when ambiguous;
# the published tag is exactly ${GITHUB_SHA::12}.
TAG="sha-$(printf '%s' "$SHA" | cut -c1-12)"

if [ "$FORCE" -eq 0 ] && [ "$SHA" = "$(state_get deployed_sha)" ]; then
    dbg "nothing to do: $BRANCH is at $(short "$SHA"), already deployed"
    exit 0
fi

# Without this hold the timer would recreate the container and re-run migrateToLatest()
# every 5 minutes, forever, on a 1 vCPU box.
if [ "$FORCE" -eq 0 ] && [ "$SHA" = "$(state_get last_failed_sha)" ]; then
    if [ "$(state_get failed_logged)" != "$SHA" ]; then
        warn "commit $(short "$SHA") already failed to deploy; holding. Fix it, then run: deploy.sh --force"
        state_set failed_logged "$SHA"
    else
        dbg "holding on failed commit $(short "$SHA")"
    fi
    exit 0
fi

token_expiry_warn "$CONF_DIR/github.token" "the GitHub token ($CONF_DIR/github.token)"
token_expiry_warn "$CONF_DIR/ghcr.token" "the GHCR token ($CONF_DIR/ghcr.token)"

# Validate the incoming compose file BEFORE it replaces the running one, so a syntax
# error or a ${VAR} this .env cannot satisfy aborts while production is still healthy.
# The candidate sits in the project dir on purpose: that is what makes compose resolve
# .env and the project name exactly as the real file will.
candidate="$PROJECT_DIR/.$COMPOSE.candidate"
install -m 644 -o root -g root "$SRC/$COMPOSE" "$candidate"
if ! docker compose -f "$candidate" config --quiet; then
    rm -f "$candidate"
    die "the compose file from $(short "$SHA") is invalid against this .env"
fi
# Interpolations without a `:-` default: a missing one is how "CI shipped a compose
# file that wants a var nobody added to the VM" bites.
for var in $(grep -o '\${[A-Z_][A-Z0-9_]*}' "$candidate" | tr -d '${}' | sort -u); do
    grep -q "^$var=" .env || warn ".env has no $var, which $COMPOSE interpolates without a default"
done

info "deploying $(short "$SHA") as $TAG"
mv -f "$candidate" "$PROJECT_DIR/$COMPOSE"
# Closes the gap docs/operations.md used to document as "scripts/ go by hand": a
# changed backup.sh now reaches the VM on its own. deploy.sh lands here too and is
# never run from here — see the header.
install -d -m 700 "$PROJECT_DIR/scripts"
install -m 700 "$SRC"/scripts/*.sh "$PROJECT_DIR/scripts/"

# Shell env beats .env in Compose interpolation, so this pins the immutable tag for
# this invocation. Only `pull docmost`: a bare `pull` would also hit Docker Hub for
# postgres:18 and redis:8 on every tick, and that anonymous rate limit is shared with
# the GLPI stack on this same IP.
export IMAGE_TAG="$TAG"

if ! pull_out=$(dc pull docmost 2>&1); then
    if printf '%s\n' "$pull_out" | grep -qiE 'manifest unknown|not found|no such manifest'; then
        # The VM sees the commit before the build has pushed sha-<12>. Retry next tick;
        # a build that never finishes surfaces as the staleness warning below.
        now=$(date +%s)
        if [ "$(state_get pending_sha)" != "$SHA" ]; then
            state_set pending_sha "$SHA"
            state_set pending_since "$now"
            state_set pending_alerted no
            info "image $TAG is not published yet (build still running?); will retry"
        else
            since=$(state_get pending_since)
            waited=$(( (now - ${since:-$now}) / 60 ))
            if [ "$(state_get pending_alerted)" != yes ] && [ "$waited" -ge "$STALE_ALERT_MIN" ]; then
                warn "commit $(short "$SHA") undeployed for ${waited}min: $TAG never appeared in the registry — did the build fail?"
                gh_status error "imagem $TAG nunca apareceu no GHCR"
                state_set pending_alerted yes
            else
                dbg "image $TAG still not published (${waited}min)"
            fi
        fi
        exit 0
    fi
    printf '%s\n' "$pull_out" >&2
    die "docker compose pull failed"
fi

# From here on the stack gets recreated, so failures are exit 2, not 1.
if ! dc up -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
    err "deploy FAILED: the stack did not become healthy within ${WAIT_TIMEOUT}s"
    err "the container was already recreated, and any migration in this commit HAS ALREADY RUN — read docs/rollback.md before reverting the image"
    dc ps || true
    dc logs --tail=200 --no-color docmost || true
    state_set last_result failure
    state_set last_attempt "$(date -Is)"
    state_set last_failed_sha "$SHA"
    state_set failed_logged "$SHA"
    gh_status failure "unhealthy after up --wait; see journalctl -u docmost-deploy"
    exit 2
fi

digest=$(running_digest)
prev_tag=$(state_get deployed_tag)
state_set deployed_sha "$SHA"
state_set deployed_tag "$TAG"
state_set deployed_digest "${digest:-unknown}"
state_set deployed_at "$(date -Is)"
state_set last_attempt "$(date -Is)"
state_set last_result success
state_set last_failed_sha ''
state_set failed_logged ''
state_set pending_sha ''
state_set pending_since ''
state_set pending_alerted no

info "deployed $(short "$SHA") as $TAG (${digest:-digest unknown})"
gh_status success "$TAG saudavel em srv1402182"

prune_images "$TAG" "$prev_tag"
