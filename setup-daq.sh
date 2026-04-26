#!/bin/bash
#
# LunaDAQ Launcher
# Starts the Flask backend server and Next.js frontend with configurable IP/port.
#
# Usage:
#   ./setup-daq.sh [OPTIONS]
#
# Options:
#   --server-host HOST    Server bind address       (default: 0.0.0.0)
#   --server-port PORT    Server port               (default: 5001)
#   --frontend-host HOST  Frontend bind address     (default: 0.0.0.0)
#   --frontend-port PORT  Frontend port             (default: 3000)
#   --api-url URL         Full API URL the frontend
#                         uses to reach the server.
#                         (default: http://<server-host>:<server-port>)
#   --no-build            Skip 'npm run build'
#   --dev                 Run frontend in dev mode instead of production
#   -h, --help            Show this help message
#

set -e

# ── Defaults ──────────────────────────────────────────────────────────────────
SERVER_HOST="0.0.0.0"
SERVER_PORT="5001"
FRONTEND_HOST="0.0.0.0"
FRONTEND_PORT="3000"
API_URL=""
SKIP_BUILD=false
DEV_MODE=false

# ── Resolve script directory (works even with symlinks) ───────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
FRONTEND_DIR="$SCRIPT_DIR/frontend"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Colour

# ── Parse arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case $1 in
        --server-host)  SERVER_HOST="$2";   shift 2 ;;
        --server-port)  SERVER_PORT="$2";   shift 2 ;;
        --frontend-host) FRONTEND_HOST="$2"; shift 2 ;;
        --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
        --api-url)      API_URL="$2";       shift 2 ;;
        --no-build)     SKIP_BUILD=true;    shift ;;
        --dev)          DEV_MODE=true;      shift ;;
        -h|--help)
            head -20 "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}" >&2
            exit 1
            ;;
    esac
done

# ── Derive API URL if not set explicitly ──────────────────────────────────────
if [[ -z "$API_URL" ]]; then
    # If server binds to 0.0.0.0 the frontend should hit localhost
    if [[ "$SERVER_HOST" == "0.0.0.0" ]]; then
        API_URL="http://127.0.0.1:${SERVER_PORT}"
    else
        API_URL="http://${SERVER_HOST}:${SERVER_PORT}"
    fi
fi

# ── Validation ────────────────────────────────────────────────────────────────
if [[ ! -d "$SERVER_DIR" ]]; then
    echo -e "${RED}Error: server directory not found at ${SERVER_DIR}${NC}" >&2
    exit 1
fi
if [[ ! -d "$FRONTEND_DIR" ]]; then
    echo -e "${RED}Error: frontend directory not found at ${FRONTEND_DIR}${NC}" >&2
    exit 1
fi

# ── Track child PIDs for clean shutdown ───────────────────────────────────────
SERVER_PID=""
FRONTEND_PID=""

cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down WebDAQ …${NC}"
    # Kill children; server has its own SIGINT handler
    [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null && wait "$FRONTEND_PID" 2>/dev/null
    [[ -n "$SERVER_PID"   ]] && kill "$SERVER_PID"   2>/dev/null && wait "$SERVER_PID"   2>/dev/null
    echo -e "${GREEN}WebDAQ stopped.${NC}"
    exit 0
}
trap cleanup SIGINT SIGTERM

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║                  WebDAQ Launcher                 ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Server  :  ${GREEN}${SERVER_HOST}:${SERVER_PORT}${NC}"
echo -e "  Frontend:  ${GREEN}${FRONTEND_HOST}:${FRONTEND_PORT}${NC}"
echo -e "  API URL :  ${GREEN}${API_URL}${NC}"
echo -e "  Mode    :  ${GREEN}$(if $DEV_MODE; then echo 'development'; else echo 'production'; fi)${NC}"
echo ""

# ── 1. Start the Flask / Waitress server ──────────────────────────────────────
echo -e "${CYAN}[1/2] Starting server …${NC}"
(
    cd "$SERVER_DIR"
    python main.py --host "$SERVER_HOST" --port "$SERVER_PORT" 2>&1 \
        | sed "s/^/  [server] /"
) &
SERVER_PID=$!

# Give the server a moment to bind
sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "${RED}Server failed to start. Check logs above.${NC}" >&2
    exit 1
fi

# ── 2. Write .env and start the Next.js frontend ─────────────────────────────
echo -e "${CYAN}[2/2] Starting frontend …${NC}"
(
    cd "$FRONTEND_DIR"

    # Write the API URL into the .env file used by Next.js
    echo "NEXT_PUBLIC_API_URL=${API_URL}" > .env.local

    if [[ "$SKIP_BUILD" == false && "$DEV_MODE" == false ]]; then
        echo "  [frontend] Building Next.js app …"
        npx next build 2>&1 | sed "s/^/  [frontend] /"
    fi

    if [[ "$DEV_MODE" == true ]]; then
        npx next dev -H "$FRONTEND_HOST" -p "$FRONTEND_PORT" 2>&1 \
            | sed "s/^/  [frontend] /"
    else
        npx next start -H "$FRONTEND_HOST" -p "$FRONTEND_PORT" 2>&1 \
            | sed "s/^/  [frontend] /"
    fi
) &
FRONTEND_PID=$!

echo ""
echo -e "${GREEN}WebDAQ is starting up.${NC}"
echo -e "  Dashboard → ${CYAN}http://${FRONTEND_HOST}:${FRONTEND_PORT}${NC}"
echo -e "  Press ${YELLOW}Ctrl+C${NC} to stop both services."
echo ""

# ── Wait for both processes ───────────────────────────────────────────────────
wait