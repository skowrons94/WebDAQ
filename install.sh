#!/usr/bin/env bash
#
# LunaDAQ installer
# -----------------
# One-shot setup for a fresh Linux PC. It is idempotent: every step checks
# whether the work is already done before doing it, so re-running is safe.
#
# Steps:
#   1. Install Docker, configure the daemon + docker group, pull the XDAQ images
#      (skowrons/xdaq:latest and skowrons/xdaq:sync)
#   2. Install Miniforge (conda)            — skipped if conda is already present
#   3. Create the `luna` conda environment  — skipped if it already exists
#   4. Build RUReader and RUSpy (LunaSpy)    — cloned/updated, built, installed
#      from https://github.com/skowrons94      to /usr/local/bin
#   5. Configure frontend/.env and build the frontend
#   6. Add a `LunaDAQ` alias to ~/.bashrc that launches the frontend
#
# Usage:
#   ./install.sh
#
# Optional environment overrides:
#   NEXT_PUBLIC_API_URL   pre-set the API URL (skips the prompt)
#   LUNA_SRC_DIR          where to clone RUReader/LunaSpy (default: WebDAQ's parent)
#
set -eo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
ENV_FILE="$FRONTEND_DIR/.env"
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
        # build-essential covers make + g++.
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

# ── 1. Docker ──────────────────────────────────────────────────────────────────
NEED_DOCKER_RELOGIN=0
ensure_docker() {
    step "Setting up Docker"
    if have docker; then
        ok "Docker present ($(docker --version 2>/dev/null))"
    else
        info "Installing Docker via the official get.docker.com script…"
        local tmp; tmp="$(mktemp)"
        if have curl; then curl -fsSL https://get.docker.com -o "$tmp"
        else wget -qO "$tmp" https://get.docker.com; fi
        $SUDO sh "$tmp"
        rm -f "$tmp"
        ok "Docker installed"
    fi

    # Enable and start the daemon on systemd-based distros.
    if have systemctl; then
        $SUDO systemctl enable --now docker 2>/dev/null \
            || warn "Could not enable/start docker via systemctl — start it manually if needed"
    fi

    # Add the current user to the docker group so 'docker' works without sudo.
    # The change only applies to new login sessions.
    if [ "$(id -u)" -ne 0 ]; then
        $SUDO groupadd -f docker 2>/dev/null || true
        if id -nG "$USER" 2>/dev/null | grep -qw docker; then
            ok "User '$USER' already in the docker group"
        else
            $SUDO usermod -aG docker "$USER" \
                && { warn "Added '$USER' to the docker group — log out/in (or run 'newgrp docker') to use docker without sudo"; NEED_DOCKER_RELOGIN=1; } \
                || warn "Could not add '$USER' to the docker group"
        fi
    fi

    # Pull the XDAQ images. Fall back to sudo if the daemon isn't reachable
    # without it (the group change isn't active in this shell yet).
    local DOCKER="docker"
    docker info >/dev/null 2>&1 || DOCKER="$SUDO docker"
    local img
    for img in skowrons/xdaq:latest skowrons/xdaq:sync; do
        info "Pulling $img (this can take a while)…"
        $DOCKER pull "$img" || warn "Failed to pull $img — retry later with 'docker pull $img'"
    done
    ok "Docker images ready"
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

    # Make `conda activate` usable for the rest of this script.
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
        ok "Environment 'luna' already exists — skipping (use 'conda env update -f environment.yml' to refresh)"
    else
        info "Building environment from environment.yml (this can take several minutes)…"
        conda env create -f "$REPO_ROOT/environment.yml"
        ok "Environment 'luna' created"
    fi
    conda activate luna
    ok "Activated 'luna'"
}

# ── 4. C++ software (RUReader, RUSpy) ──────────────────────────────────────────
# build_and_install <repo> <primary-binary> [fallback-binary]
build_and_install() {
    local repo="$1" primary="$2" fallback="${3:-}"
    local url="https://github.com/$GITHUB_USER/$repo.git"
    local dir="$SRC_DIR/$repo"

    step "Building $repo → ${primary}"
    if [ -d "$dir/.git" ]; then
        info "Updating existing checkout ($dir)…"
        git -C "$dir" pull --ff-only || warn "git pull failed; building current checkout"
    else
        info "Cloning $url → $dir"
        git clone "$url" "$dir"
    fi

    mkdir -p "$dir/build"
    ( cd "$dir/build" && cmake .. && make -j"$(ncpu)" )

    # Locate the produced executable (handles either naming).
    local bin
    bin="$(find "$dir/build" -maxdepth 3 -type f -name "$primary" 2>/dev/null | head -n1)"
    if [ -z "$bin" ] && [ -n "$fallback" ]; then
        bin="$(find "$dir/build" -maxdepth 3 -type f -name "$fallback" 2>/dev/null | head -n1)"
    fi
    [ -n "$bin" ] || die "Could not find built '$primary' binary under $dir/build"

    $SUDO install -m 755 "$bin" "/usr/local/bin/$primary"
    ok "Installed $primary → /usr/local/bin/$primary"
}

build_cpp_software() {
    # RUReader produces the 'RUReader' binary; LunaSpy produces 'RUSpy'
    # (older checkouts name it 'LunaSpy', handled as a fallback).
    build_and_install "RUReader" "RUReader"
    build_and_install "LunaSpy"  "RUSpy" "LunaSpy"
}

# ── 5. Frontend ────────────────────────────────────────────────────────────────
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

    # Write/replace the NEXT_PUBLIC_API_URL line, preserving any other content.
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

# ── 6. LunaDAQ alias ────────────────────────────────────────────────────────────
add_alias() {
    step "Adding the 'LunaDAQ' launcher to ~/.bashrc"
    local bashrc="$HOME/.bashrc"
    if grep -qE '^(alias LunaDAQ=|LunaDAQ\(\))' "$bashrc" 2>/dev/null; then
        ok "Launcher already present — leaving it untouched"
        return
    fi
    cat >> "$bashrc" <<EOF

# Launch the LunaDAQ frontend (added by WebDAQ install.sh)
# Stops any previous instance still listening on the dev server port
# before starting a new one.
LunaDAQ() {
    local port=3000
    local pids=""
    if command -v lsof >/dev/null 2>&1; then
        pids="\$(lsof -ti:\$port 2>/dev/null)"
    elif command -v fuser >/dev/null 2>&1; then
        pids="\$(fuser -n tcp \$port 2>/dev/null | tr -s ' ')"
    fi
    if [ -n "\$pids" ]; then
        echo "LunaDAQ already running on port \$port (PIDs:\$pids) — stopping it…"
        kill \$pids 2>/dev/null
        sleep 1
        if command -v lsof >/dev/null 2>&1; then
            pids="\$(lsof -ti:\$port 2>/dev/null)"
        elif command -v fuser >/dev/null 2>&1; then
            pids="\$(fuser -n tcp \$port 2>/dev/null | tr -s ' ')"
        fi
        [ -n "\$pids" ] && kill -9 \$pids 2>/dev/null
    fi
    conda activate luna && cd "$FRONTEND_DIR" && npm run start
}
EOF
    ok "Launcher added — run 'LunaDAQ' in a new terminal to start the web app"
}

# ── Run ──────────────────────────────────────────────────────────────────────
main() {
    echo -e "${BOLD}LunaDAQ installer${RESET}"
    info "Repository: $REPO_ROOT"
    info "C++ sources will live in: $SRC_DIR"

    ensure_build_tools
    ensure_docker
    ensure_conda
    ensure_luna_env
    build_cpp_software
    configure_and_build_frontend
    add_alias

    step "Done!"
    info "Start the web app with: ${BOLD}LunaDAQ${RESET} (open a new terminal first, or run 'source ~/.bashrc')"
    info "Then open ${BOLD}http://localhost:3000${RESET} and click ‘Start an Experiment’."
    if [ "$NEED_DOCKER_RELOGIN" -eq 1 ]; then
        warn "Remember to log out and back in so Docker works without sudo."
    fi
}

main "$@"
