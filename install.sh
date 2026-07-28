#!/usr/bin/env bash
#
# LunaDAQ installer (Linux / macOS)
# ---------------------------------
# One-shot setup for a fresh Linux/macOS PC. It is idempotent: every step checks
# whether the work is already done before doing it, so re-running is safe.
#
# Acquisition is fully in-process via the caendaq module, installed with
# `pip install` (scikit-build-core builds it via CMake).
#
# The two C++ components are git submodules pinned under server/native/:
#   server/native/caendaq   — CaenDAQ, the acquisition backend (Python module)
#   server/native/rureader  — RUReader, the offline .caendat → ROOT converter
#
# Steps:
#   1. System build tools (git, cmake, make, g++, curl)
#   2. Check out the git submodules (CaenDAQ, RUReader)
#   3. Install Miniforge (conda)            — skipped if conda is already present
#   4. Create the `luna` conda environment  — skipped if it already exists
#   5. Build RUReader (offline .caendat → ROOT converter) and the caendaq
#      Python module (installed into the luna environment)
#   6. Configure frontend/.env and build the frontend
#   7. Add a `LunaDAQ` alias to ~/.bashrc that launches the frontend
#
# Usage:
#   ./install.sh
#
# Optional environment overrides:
#   NEXT_PUBLIC_API_URL   pre-set the API URL (skips the prompt)
#   LUNA_SRC_DIR          fallback checkout dir, used only when the submodules
#                         are unavailable (default: WebDAQ's parent)
#
set -eo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
ENV_FILE="$FRONTEND_DIR/.env"
NATIVE_DIR="$REPO_ROOT/server/native"
CAENDAQ_DIR="$NATIVE_DIR/caendaq"
RUREADER_DIR="$NATIVE_DIR/rureader"
SRC_DIR="${LUNA_SRC_DIR:-$(dirname "$REPO_ROOT")}"
GITHUB_USER="skowrons94"
MINIFORGE_DIR="$HOME/miniforge3"

# ── Logging helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
    BOLD="\033[1m"; BLUE="\033[34m"; GREEN="\033[32m"; YELLOW="\033[33m"; RED="\033[31m"; RESET="\033[0m"
else
    BOLD=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
step() { echo -e "\n${BOLD}${BLUE}==>${RESET} ${BOLD}$*${RESET}"; }
info() { echo -e "    $*"; }
ok()   { echo -e "    ${GREEN}✓${RESET} $*"; }
warn() { echo -e "    ${YELLOW}!${RESET} $*"; }
die()  { echo -e "\n${RED}✗ $*${RESET}" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# sudo only when we are not already root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    have sudo && SUDO="sudo" || warn "sudo not found — steps needing root may fail"
fi

ncpu() { nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4; }

# ── 0. System build tools ────────────────────────────────────────────────────
ensure_build_tools() {
    step "Checking system build tools (git, cmake, make, c++, curl)"
    local missing=()
    have git   || missing+=(git)
    have cmake || missing+=(cmake)
    have make  || missing+=(make)
    have c++   || have g++ || missing+=(g++)
    have curl  || have wget || missing+=(curl)

    if [ ${#missing[@]} -eq 0 ]; then
        ok "All build tools present"
        return
    fi

    warn "Missing: ${missing[*]} — attempting to install"
    if have apt-get; then
        local pkgs=(); for m in "${missing[@]}"; do [ "$m" = "g++" ] && pkgs+=(build-essential) || pkgs+=("$m"); done
        $SUDO apt-get update -qq && $SUDO apt-get install -y "${pkgs[@]}"
    elif have dnf; then
        $SUDO dnf install -y git cmake make gcc-c++ curl
    elif have pacman; then
        $SUDO pacman -Sy --noconfirm git cmake make gcc curl
    else
        die "No supported package manager found. Please install: ${missing[*]}"
    fi
    ok "Build tools installed"
}

# ── 1. Git submodules (CaenDAQ, RUReader) ─────────────────────────────────────
ensure_submodules() {
    step "Checking out the C++ submodules (CaenDAQ, RUReader)"

    if [ ! -f "$REPO_ROOT/.gitmodules" ]; then
        warn ".gitmodules missing — skipping (sources will be looked up / cloned later)"
        return
    fi
    if [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; then
        warn "Not a git checkout (downloaded tarball?) — cannot init submodules"
        return
    fi

    # --init creates them on a fresh clone; --recursive picks up nested ones.
    # Not --remote: the superproject pins a known-good commit for each.
    if git -C "$REPO_ROOT" submodule update --init --recursive; then
        ok "Submodules up to date"
    else
        warn "git submodule update failed — falling back to standalone checkouts"
        return
    fi

    local m
    for m in "$CAENDAQ_DIR" "$RUREADER_DIR"; do
        if [ -f "$m/CMakeLists.txt" ]; then
            info "$(basename "$m") @ $(git -C "$m" rev-parse --short HEAD 2>/dev/null || echo '?')"
        else
            warn "$m looks empty — its build step will fall back to a standalone checkout"
        fi
    done
}

# ── 2. Miniforge / conda ──────────────────────────────────────────────────────
ensure_conda() {
    step "Setting up Miniforge (conda)"
    if have conda; then
        ok "conda already on PATH ($(command -v conda))"
    elif [ -d "$MINIFORGE_DIR" ]; then
        ok "Miniforge found at $MINIFORGE_DIR"
    else
        info "Downloading Miniforge installer…"
        local installer="Miniforge3-$(uname)-$(uname -m).sh"
        local url="https://github.com/conda-forge/miniforge/releases/latest/download/$installer"
        local tmp; tmp="$(mktemp -d)"
        if have curl; then curl -fsSL "$url" -o "$tmp/$installer"
        else wget -q "$url" -O "$tmp/$installer"; fi
        info "Installing Miniforge to $MINIFORGE_DIR…"
        bash "$tmp/$installer" -b -p "$MINIFORGE_DIR"
        rm -rf "$tmp"
        ok "Miniforge installed"
    fi

    local conda_base
    conda_base="$( { have conda && conda info --base; } || echo "$MINIFORGE_DIR")"
    # shellcheck disable=SC1091
    source "$conda_base/etc/profile.d/conda.sh"
    ok "conda ready ($conda_base)"
}

# ── 3. luna environment ────────────────────────────────────────────────────────
ensure_luna_env() {
    step "Creating the 'luna' conda environment"
    if conda env list | grep -qE '(^|/)luna[[:space:]]*$|/luna$'; then
        # An existing environment used to be left alone, so a dependency added
        # to environment.yml after the first install never arrived — the
        # failure then surfaced much later as a missing module. Update it.
        info "Environment 'luna' exists — updating it from environment.yml…"
        conda env update -f "$REPO_ROOT/environment.yml" --prune \
            || warn "Update failed; the environment is unchanged. Fix the error above and re-run."
        ok "Environment 'luna' up to date"
    else
        info "Building environment from environment.yml (this can take several minutes)…"
        conda env create -f "$REPO_ROOT/environment.yml"
        ok "Environment 'luna' created"
    fi
    conda activate luna
    ok "Activated 'luna'"

    verify_env_packages
}

# The packages the server cannot run without. Checked by import, in the
# environment that was just built: a package that conda reports as installed but
# that fails to import (wrong architecture, broken build) is the same problem as
# one that is missing, and both are cheaper to find here than at the first run.
verify_env_packages() {
    local missing=()
    local module
    for module in flask waitress serial elog requests; do
        python -c "import $module" >/dev/null 2>&1 || missing+=("$module")
    done

    if [ ${#missing[@]} -eq 0 ]; then
        ok "All Python packages import correctly (including elog for the logbook)"
        return
    fi

    warn "These modules do not import in 'luna': ${missing[*]}"
    for module in "${missing[@]}"; do
        case "$module" in
            elog)
                warn "  elog — the ELOG logbook will not work. It is NOT on PyPI:"
                warn "         conda install -n luna -c paulscherrerinstitute elog"
                ;;
            *)
                warn "  $module — try: conda env update -f environment.yml"
                ;;
        esac
    done
}

# ── Source resolution ────────────────────────────────────────────────────────
# Prefer the pinned submodule under server/native; fall back to a standalone
# checkout beside WebDAQ (cloning it if needed) so the installer still works in
# a tarball / no-submodule checkout. Echoes the directory to use.
resolve_source() {
    local submodule_dir="$1" repo="$2" fallback_dir="$SRC_DIR/$2"

    if [ -f "$submodule_dir/CMakeLists.txt" ]; then
        echo "$submodule_dir"
        return
    fi
    if [ -d "$fallback_dir/.git" ]; then
        git -C "$fallback_dir" pull --ff-only >/dev/null 2>&1 || true
        echo "$fallback_dir"
        return
    fi
    git clone "https://github.com/$GITHUB_USER/$repo.git" "$fallback_dir" >&2
    echo "$fallback_dir"
}

# ── 4. RUReader (offline .caendat → ROOT converter) ────────────────────────────
build_rureader() {
    local primary="RUReader"
    local dir; dir="$(resolve_source "$RUREADER_DIR" "RUReader")"

    step "Building RUReader → $primary"
    info "Source: $dir"

    # Out-of-tree build dir so the submodule working tree stays clean.
    cmake -S "$dir" -B "$dir/build" >/dev/null
    cmake --build "$dir/build" -j"$(ncpu)"

    local bin; bin="$(find "$dir/build" -maxdepth 3 -type f -name "$primary" 2>/dev/null | head -n1)"
    [ -n "$bin" ] || die "Could not find built '$primary' under $dir/build"
    $SUDO install -m 755 "$bin" "/usr/local/bin/$primary"
    ok "Installed $primary → /usr/local/bin/$primary"
}

# ── 5. caendaq Python module (the acquisition backend) ─────────────────────────
build_caendaq() {
    step "Building the caendaq Python module"

    local dir; dir="$(resolve_source "$CAENDAQ_DIR" "CaenDAQ")"
    info "Source: $dir"

    # Install into the active env with pip (scikit-build-core drives CMake).
    # Try real CAEN hardware support first; fall back to a mock-only module
    # (still fully usable with TEST_FLAG=True) if libCAENDigitizer / jsoncpp
    # are absent.
    if pip install "$dir" --config-settings=cmake.define.CAENDAQ_WITH_CAEN=ON; then
        ok "Installed caendaq with CAEN hardware support"
    else
        warn "CAEN build failed (libCAENDigitizer / jsoncpp missing?) — installing mock-only module"
        pip install "$dir" || die "caendaq install failed"
        warn "Installed mock-only caendaq (TEST_FLAG=True works; no real hardware)"
    fi
    python -c "import caendaq; print('    caendaq', caendaq.__file__)" \
        || die "caendaq did not import after install (wrong env?)"
    ok "caendaq importable in the luna env"
}

# ── 6. Frontend ────────────────────────────────────────────────────────────────
configure_and_build_frontend() {
    step "Configuring and building the frontend"

    local current_url default_url api_url
    current_url="$(grep -E '^NEXT_PUBLIC_API_URL=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)"
    default_url="${current_url:-http://127.0.0.1:5001}"

    if [ -n "${NEXT_PUBLIC_API_URL:-}" ]; then
        api_url="$NEXT_PUBLIC_API_URL"
    elif [ -t 0 ]; then
        read -r -p "    Backend API URL [$default_url]: " api_url
        api_url="${api_url:-$default_url}"
    else
        api_url="$default_url"
        warn "Non-interactive shell — using $api_url"
    fi

    if [ -f "$ENV_FILE" ] && grep -qE '^NEXT_PUBLIC_API_URL=' "$ENV_FILE"; then
        local tmp; tmp="$(mktemp)"
        sed "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=$api_url|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
    else
        echo "NEXT_PUBLIC_API_URL=$api_url" >> "$ENV_FILE"
    fi
    ok "Set NEXT_PUBLIC_API_URL=$api_url"

    info "Installing npm dependencies…"
    ( cd "$FRONTEND_DIR" && npm install )
    info "Building the frontend (npm run build)…"
    ( cd "$FRONTEND_DIR" && npm run build )
    ok "Frontend built"
}

# ── 7. LunaDAQ alias ────────────────────────────────────────────────────────────
add_alias() {
    step "Adding the 'LunaDAQ' launcher to ~/.bashrc"
    local bashrc="$HOME/.bashrc"
    local script="$REPO_ROOT/scripts/lunadaq"

    chmod +x "$script" 2>/dev/null || true
    touch "$bashrc"

    # The launcher is a one-line delegation to scripts/lunadaq, so its logic can
    # be fixed by updating the repository instead of every shell profile. Older
    # installs wrote the whole function into ~/.bashrc; drop that version (and
    # any previous marker block) before writing the current one.
    if grep -qE '^(alias LunaDAQ=|LunaDAQ\(\)|# >>> WebDAQ launcher >>>)' "$bashrc" 2>/dev/null; then
        cp "$bashrc" "$bashrc.webdaq.bak"
        local tmp; tmp="$(mktemp)"
        awk '
            /^# >>> WebDAQ launcher >>>$/ { inblock = 1; next }
            /^# <<< WebDAQ launcher <<<$/ { inblock = 0; next }
            inblock { next }
            /^# Launch the LunaDAQ frontend \(added by WebDAQ install.sh\)$/ { legacy = 1; next }
            legacy && /^\}$/ { legacy = 0; next }
            legacy { next }
            /^alias LunaDAQ=/ { next }
            { print }
        ' "$bashrc" > "$tmp" && mv "$tmp" "$bashrc"
        info "Replaced the previous launcher (backup: $bashrc.webdaq.bak)"
    fi

    cat >> "$bashrc" <<EOF

# >>> WebDAQ launcher >>>
# start | backend | stop | restart | status  —  see $script
LunaDAQ() { "$script" "\$@"; }
# <<< WebDAQ launcher <<<
EOF
    ok "Launcher added — 'LunaDAQ' starts the web app, 'LunaDAQ stop' shuts it down"
}

# ── Run ──────────────────────────────────────────────────────────────────────
main() {
    echo -e "${BOLD}LunaDAQ installer${RESET}"
    info "Repository: $REPO_ROOT"
    info "C++ sources (submodules): $NATIVE_DIR"

    ensure_build_tools
    ensure_submodules
    ensure_conda
    ensure_luna_env
    build_rureader
    build_caendaq
    configure_and_build_frontend
    add_alias

    step "Done!"
    info "Start the web app with: ${BOLD}LunaDAQ${RESET} (open a new terminal first, or run 'source ~/.bashrc')"
    info "Then open ${BOLD}http://localhost:3000${RESET} and click 'Start an Experiment'."
    info "For a hardware-free trial, run the backend with ${BOLD}TEST_FLAG=True${RESET}."
}

main "$@"
