#!/usr/bin/env bash
# Bring app.db up to the current Alembic migration head, repairing it when an
# upgrade alone cannot. Safe to re-run; a copy is kept before any change.
#
# Handled: no app.db or an empty one (created), an older revision (upgraded),
# no alembic_version / an unknown revision / the head stamped without its
# columns / a half-created file (missing tables and columns added, re-stamped),
# an unreadable file (set aside, a new one created), and a project migrations
# copy with two heads (set aside, the server's copy taken again).

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# DB_FILE and MIGRATIONS_DIR can be overridden via env vars so this script can
# be aimed at a measurement directory's app.db while still using the repo's
# migration history. Defaults match the historical CLI usage.
DB_FILE="${DB_FILE:-$SERVER_DIR/app.db}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$SERVER_DIR/migrations}"

# Flask reads SQLALCHEMY_DATABASE_URI from DATABASE_URL — make sure the alembic
# commands below operate on $DB_FILE even if the caller didn't set it.
export DATABASE_URL="${DATABASE_URL:-sqlite:///$DB_FILE}"

cd "$SERVER_DIR"

if [ -t 1 ]; then
    GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; BOLD="\033[1m"; RESET="\033[0m"
else
    GREEN=""; YELLOW=""; RED=""; BOLD=""; RESET=""
fi
info() { echo -e "  $*"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${YELLOW}!${RESET} $*"; }
die()  { echo -e "${RED}✗ $*${RESET}" >&2; exit 1; }

[ -d "$MIGRATIONS_DIR/versions" ] || die "Migrations directory not found: $MIGRATIONS_DIR/versions"
command -v python  >/dev/null 2>&1 || die "python is required (activate the 'luna' conda env first)"

# ── Find the latest migration head ───────────────────────────────────────────
# The head is the revision that no other migration points back to via
# down_revision.
revisions=$(grep -rh '^revision = ' "$MIGRATIONS_DIR/versions" 2>/dev/null \
    | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)
downs=$(grep -rh '^down_revision = ' "$MIGRATIONS_DIR/versions" 2>/dev/null \
    | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)
heads=()
for rev in $revisions; do
    echo "$downs" | grep -qx "$rev" || heads+=("$rev")
done
[ "${#heads[@]}" -gt 0 ] || die "Could not determine the migration head in $MIGRATIONS_DIR/versions"
# Two heads usually means a second "initial migration" was generated locally
# (flask db migrate) next to the committed one, and Alembic would refuse with
# "Multiple head revisions". A project's migrations are only a copy of the
# server's, so set the broken copy aside and take the server's again.
if [ "${#heads[@]}" -gt 1 ] && [ "$MIGRATIONS_DIR" != "$SERVER_DIR/migrations" ]; then
    aside="$MIGRATIONS_DIR.broken-$(date +%Y%m%d-%H%M%S)"
    warn "Migration history has ${#heads[@]} heads (${heads[*]}) — kept as $aside, taking the server's copy"
    mv "$MIGRATIONS_DIR" "$aside"
    cp -r "$SERVER_DIR/migrations" "$MIGRATIONS_DIR"
    rm -rf "$MIGRATIONS_DIR/__pycache__" "$MIGRATIONS_DIR/versions/__pycache__"
    exec "$0" "$@"
fi
[ "${#heads[@]}" -eq 1 ] || die "Migration history has ${#heads[@]} heads (${heads[*]}) in $MIGRATIONS_DIR/versions — remove the stray one"
HEAD_REV="${heads[0]}"
info "Latest migration head: ${BOLD}$HEAD_REV${RESET}"

# ── Upgrade, repairing whatever an upgrade alone cannot ────────────────────
# Missing, empty, unreadable, pre-migration, half-created, stamped at an unknown
# revision or at the head without its columns: scripts/ensure_db.py (through
# app/utils/db_repair.py, which the server also runs at start) handles them all
# and keeps a copy of the file before changing it.
python scripts/ensure_db.py "$MIGRATIONS_DIR"
