#!/usr/bin/env bash
#
# Kill a dangling WebDAQ backend (the Flask/waitress server from main.py).
# Uses the PID file it writes (cache/daq-server.pid), then falls back to
# matching the process command line and the listening port.
#
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # server/
PID_FILE="$HERE/cache/daq-server.pid"

killed=0

# 1) PID file
if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "Killing backend PID $pid (from pid file)…"
        kill "$pid" 2>/dev/null
        sleep 1
        kill -0 "$pid" 2>/dev/null && { echo "  still alive — SIGKILL"; kill -9 "$pid" 2>/dev/null; }
        killed=1
    fi
    rm -f "$PID_FILE"
fi

# 2) Fallback: match the command line
if pgrep -f "python.*main\.py" >/dev/null 2>&1; then
    echo "Killing leftover 'python … main.py' processes…"
    pkill -f "python.*main\.py" 2>/dev/null
    sleep 1
    pkill -9 -f "python.*main\.py" 2>/dev/null
    killed=1
fi

# 3) Fallback: whatever holds port 5001
if command -v lsof >/dev/null 2>&1; then
    port_pids="$(lsof -ti:5001 2>/dev/null)"
    if [ -n "$port_pids" ]; then
        echo "Killing process(es) on port 5001: $port_pids"
        kill $port_pids 2>/dev/null; sleep 1; kill -9 $port_pids 2>/dev/null
        killed=1
    fi
fi

[ "$killed" -eq 1 ] && echo "Done." || echo "No WebDAQ backend found running."
