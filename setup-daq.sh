#!/bin/bash
#
# WebDAQ Setup
#
# One-time setup: creates the "luna" conda environment if it doesn't already
# exist, installs the frontend dependencies, builds the production bundle, and
# then prints clear instructions on how to start the dashboard and configure
# server / frontend IPs.
#
# The server itself is launched from the frontend UI (top-right status pill),
# so this script does NOT start any long-running process.
#
# Usage:
#   ./setup-daq.sh [OPTIONS]
#
# Options:
#   --env-name NAME   Conda env to use / create (default: luna)
#   --skip-env        Skip conda env creation
#   --skip-deps       Skip frontend npm install
#   --skip-build      Skip frontend npm run build
#   -h, --help        Show this help message
#

set -e

# ── Defaults ──────────────────────────────────────────────────────────────────
ENV_NAME="luna"
SKIP_ENV=false
SKIP_DEPS=false
SKIP_BUILD=false

# ── Resolve script directory (works even with symlinks) ───────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
FRONTEND_DIR="$SCRIPT_DIR/frontend"
ENV_FILE="$SCRIPT_DIR/environment.yml"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --env-name)   ENV_NAME="$2";   shift 2 ;;
        --skip-env)   SKIP_ENV=true;   shift ;;
        --skip-deps)  SKIP_DEPS=true;  shift ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        -h|--help)
            head -25 "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            exit 1
            ;;
    esac
done

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║                   WebDAQ Setup                   ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Validation ────────────────────────────────────────────────────────────────
if [[ ! -d "$SERVER_DIR" ]]; then
    echo -e "${RED}Error: server directory not found at ${SERVER_DIR}${NC}" >&2
    exit 1
fi
if [[ ! -d "$FRONTEND_DIR" ]]; then
    echo -e "${RED}Error: frontend directory not found at ${FRONTEND_DIR}${NC}" >&2
    exit 1
fi

# ── 1. Conda environment ──────────────────────────────────────────────────────
if [[ "$SKIP_ENV" == false ]]; then
    echo -e "${CYAN}[1/3] Conda environment '${ENV_NAME}'${NC}"

    if ! command -v conda >/dev/null 2>&1; then
        echo -e "${RED}  conda not found in PATH.${NC}" >&2
        echo "  Install Miniconda or Anaconda first:" >&2
        echo "    https://docs.conda.io/en/latest/miniconda.html" >&2
        exit 1
    fi

    # Detect existing env (matches by exact name in `conda env list`).
    if conda env list | awk '{print $1}' | grep -qx "$ENV_NAME"; then
        echo -e "  ${GREEN}✓${NC} '${ENV_NAME}' already exists — skipping creation."
    else
        if [[ ! -f "$ENV_FILE" ]]; then
            echo -e "${RED}  environment.yml not found at ${ENV_FILE}${NC}" >&2
            exit 1
        fi
        echo "  Creating '${ENV_NAME}' from $(basename "$ENV_FILE") (this can take several minutes)…"
        if [[ "$ENV_NAME" == "luna" ]]; then
            conda env create -f "$ENV_FILE"
        else
            # Honour a custom name even though environment.yml hardcodes 'luna'.
            conda env create -n "$ENV_NAME" -f "$ENV_FILE"
        fi
        echo -e "  ${GREEN}✓${NC} '${ENV_NAME}' created."
    fi
else
    echo -e "${YELLOW}[1/3] Skipping conda env step (--skip-env)${NC}"
fi
echo ""

# ── 2. Frontend dependencies ──────────────────────────────────────────────────
if [[ "$SKIP_DEPS" == false ]]; then
    echo -e "${CYAN}[2/3] Installing frontend dependencies${NC}"
    (cd "$FRONTEND_DIR" && npm install)
    echo -e "  ${GREEN}✓${NC} npm install complete."
else
    echo -e "${YELLOW}[2/3] Skipping npm install (--skip-deps)${NC}"
fi
echo ""

# ── 3. Frontend production build ──────────────────────────────────────────────
if [[ "$SKIP_BUILD" == false ]]; then
    echo -e "${CYAN}[3/3] Building frontend${NC}"
    (cd "$FRONTEND_DIR" && npm run build)
    echo -e "  ${GREEN}✓${NC} npm run build complete."
else
    echo -e "${YELLOW}[3/3] Skipping npm run build (--skip-build)${NC}"
fi
echo ""

# ── Done — print guidance ─────────────────────────────────────────────────────
ENV_FILE_FRONTEND="$FRONTEND_DIR/.env"
CURRENT_API_URL="(not set — defaults to http://127.0.0.1:5001)"
if [[ -f "$ENV_FILE_FRONTEND" ]] && grep -q '^NEXT_PUBLIC_API_URL=' "$ENV_FILE_FRONTEND"; then
    CURRENT_API_URL="$(grep '^NEXT_PUBLIC_API_URL=' "$ENV_FILE_FRONTEND" | head -1 | cut -d= -f2-)"
fi

cat <<EOF
${GREEN}╔══════════════════════════════════════════════════╗
║              Setup complete — next steps          ║
╚══════════════════════════════════════════════════╝${NC}

${BOLD}1. Activate the conda environment${NC}
   ${CYAN}conda activate ${ENV_NAME}${NC}

${BOLD}2. Start the frontend (this is the only thing you launch by hand)${NC}
   ${CYAN}cd frontend${NC}
   ${CYAN}npm run start${NC}            # production (recommended)
   ${CYAN}# or: npm run dev${NC}        # hot-reload during development

   The dashboard will be available at:
     ${CYAN}http://localhost:3000${NC}

${BOLD}3. Launch the DAQ server from the dashboard, not the shell${NC}
   In the top-right corner there is a status pill (red / green dot).
   Click it to:
     • Add a working directory with a label
     • Click Start to launch the server in that directory
     • Toggle "Test mode" to skip Docker / boards (no hardware needed)
     • Click "Show logs" to tail server output for debugging

   On first launch in a directory, the script will:
     • create conf/, calib/, data/ inside it
     • run flask db upgrade against {dir}/app.db
     • create the default user  ${BOLD}luna${NC} / ${BOLD}assergi${NC}

   The server is started via:
     ${CYAN}conda run -n ${ENV_NAME} python server/main.py${NC}
   so make sure '${ENV_NAME}' is reachable from the shell that runs ${CYAN}npm run start${NC}.

${BOLD}4. Configure the frontend → server IP${NC}
   File:     ${CYAN}frontend/.env${NC}
   Variable: ${CYAN}NEXT_PUBLIC_API_URL${NC}
   Current:  ${CURRENT_API_URL}

   Examples:
     # Server on the same machine:
     NEXT_PUBLIC_API_URL=http://127.0.0.1:5001
     # Server on another host on the LAN:
     NEXT_PUBLIC_API_URL=http://192.168.1.50:5001

   ${YELLOW}Re-run 'npm run build' (or just 'npm run dev') after changing .env${NC}
   so Next.js bakes the new value into the bundle.

${BOLD}5. Configure the server bind address${NC}
   File: ${CYAN}server/main.py${NC}
   Look for the line:
     ${CYAN}serve(app, host='0.0.0.0', port=5001, threads=10)${NC}
   • host='0.0.0.0' (default) accepts connections on all interfaces.
   • To bind to localhost only:    host='127.0.0.1'
   • To bind to a specific NIC:    host='192.168.1.50'
   • To change the port:           port=<your_port>
   Restart the server (Stop + Start in the dashboard) after editing.

EOF
