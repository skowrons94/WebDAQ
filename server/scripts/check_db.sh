#!/usr/bin/env bash
# Check whether server/app.db is compatible with the current Alembic migration
# head, and upgrade (or stamp) it if not. A timestamped backup is taken before
# any change. Safe to re-run.
#
# Cases handled:
#   1. No app.db                       → run 'flask db upgrade' to create it.
#   2. app.db at the head revision      → nothing to do.
#   3. app.db at a known older revision → 'flask db upgrade' walks it forward.
#   4. app.db has no alembic_version    → stamp at head if the expected tables
#      table but expected tables exist    already exist (legacy db.create_all
#                                         databases).
#   5. app.db has no alembic_version
#      and no recognised tables        → fresh 'flask db upgrade'.
#   6. app.db is stamped at a revision  → treat like case 4: if the expected
#      that no longer exists in the       tables exist, re-stamp at head;
#      repo (e.g. history was squashed)   otherwise bail with a clear message.

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
command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is required but not installed"
command -v flask   >/dev/null 2>&1 || die "flask is required (activate the 'luna' conda env first)"

# ── Find the latest migration head ───────────────────────────────────────────
# The head is the revision that no other migration points back to via
# down_revision.
revisions=$(grep -rh '^revision = ' "$MIGRATIONS_DIR/versions" 2>/dev/null \
    | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)
downs=$(grep -rh '^down_revision = ' "$MIGRATIONS_DIR/versions" 2>/dev/null \
    | sed -E "s/.*['\"]([^'\"]+)['\"].*/\1/" | sort -u)
HEAD_REV=""
for rev in $revisions; do
    echo "$downs" | grep -qx "$rev" || { HEAD_REV="$rev"; break; }
done
[ -n "$HEAD_REV" ] || die "Could not determine the migration head in $MIGRATIONS_DIR/versions"
info "Latest migration head: ${BOLD}$HEAD_REV${RESET}"

# ── Case 1: no DB yet ────────────────────────────────────────────────────────
if [ ! -f "$DB_FILE" ]; then
    warn "No app.db found at $DB_FILE — running 'flask db upgrade' to create one"
    flask --app main.py db upgrade -d "$MIGRATIONS_DIR"
    ok "Database created at $DB_FILE (revision $HEAD_REV)"
    exit 0
fi

# ── Read current alembic revision (if any) ───────────────────────────────────
CURRENT_REV=""
if sqlite3 "$DB_FILE" \
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='alembic_version';" \
    | grep -q 1; then
    CURRENT_REV=$(sqlite3 "$DB_FILE" "SELECT version_num FROM alembic_version LIMIT 1;")
fi

# ── Case 2: already at head ──────────────────────────────────────────────────
if [ "$CURRENT_REV" = "$HEAD_REV" ]; then
    ok "app.db already at revision $HEAD_REV — nothing to do"
    exit 0
fi

# ── Backup before any change ─────────────────────────────────────────────────
backup="$DB_FILE.bak.$(date +%Y%m%d-%H%M%S)"
cp "$DB_FILE" "$backup"
ok "Backup written to $backup"

# ── Detect orphaned revisions (case 6) ───────────────────────────────────────
# If CURRENT_REV is set but no migration file in the repo defines it, alembic
# can't find a path forward and 'db upgrade' would die with "Can't locate
# revision". This happens whenever migration history is replaced (e.g., the
# old initial migration is removed and a new one committed in its place).
# Treat such DBs the same as legacy "no alembic_version" ones.
orphaned=0
if [ -n "$CURRENT_REV" ] && ! echo "$revisions" | grep -qx "$CURRENT_REV"; then
    warn "app.db is stamped at $CURRENT_REV, which no migration in this repo defines"
    info "The repo's migration history was likely rewritten — will re-stamp at $HEAD_REV"
    orphaned=1
fi

# ── Cases 4 / 5 / 6: no usable alembic revision ──────────────────────────────
if [ -z "$CURRENT_REV" ] || [ "$orphaned" -eq 1 ]; then
    have_user=$(sqlite3 "$DB_FILE" \
        "SELECT name FROM sqlite_master WHERE type='table' AND name='user';")
    have_runs=$(sqlite3 "$DB_FILE" \
        "SELECT name FROM sqlite_master WHERE type='table' AND name='run_metadata';")

    if [ -n "$have_user" ] && [ -n "$have_runs" ]; then
        if [ "$orphaned" -eq 1 ]; then
            info "Expected tables present — clearing the stale alembic_version row…"
            sqlite3 "$DB_FILE" "DELETE FROM alembic_version;"
        else
            warn "app.db is pre-migrations (no alembic_version) but already has the expected tables"
        fi
        info "Stamping it at $HEAD_REV so future upgrades work cleanly…"
        flask --app main.py db stamp -d "$MIGRATIONS_DIR" "$HEAD_REV"
        ok "Stamped at $HEAD_REV"
        exit 0
    fi

    if [ "$orphaned" -eq 1 ]; then
        die "app.db is stamped at an unknown revision ($CURRENT_REV) and does not contain the expected tables — refusing to guess. Backup is at $backup."
    fi

    warn "app.db has no alembic_version and no recognised tables — running a fresh upgrade"
fi

# ── Case 3: known older revision (or fresh upgrade above) ────────────────────
info "Upgrading from ${CURRENT_REV:-<none>} to $HEAD_REV…"
flask --app main.py db upgrade -d "$MIGRATIONS_DIR"
ok "Database upgraded to $HEAD_REV"
