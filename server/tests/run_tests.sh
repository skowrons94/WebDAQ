#!/usr/bin/env bash
# Run the server test suite.
#
#   ./tests/run_tests.sh            all tests
#   ./tests/run_tests.sh stats      only modules whose name matches *stats*
#
# Runs in TEST_FLAG mode (simulated boards and picoammeter) from a scratch
# working directory, so a real setup's conf/ and data/ are never touched.

set -uo pipefail

SERVER_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERN="${1:-}"

cd "$SERVER_DIR" || exit 1

if ! python -c "import flask" >/dev/null 2>&1; then
    echo "This interpreter has no Flask: $(command -v python || echo 'no python on PATH')" >&2
    echo "Activate the environment first:  conda activate luna" >&2
    exit 1
fi

# A scratch working directory keeps conf/ and data/ out of harm's way. The
# suite still imports from server/, which stays on PYTHONPATH.
WORKDIR="$(mktemp -d -t webdaq-tests)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

mkdir -p "$WORKDIR/conf" "$WORKDIR/calib" "$WORKDIR/data"
# One simulated board, so the register and tuning routes have something to work
# on; its register file is rebuilt by the server at startup.
cat > "$WORKDIR/conf/settings.json" <<'JSON'
{
    "running": false,
    "start_time": null,
    "run": 0,
    "save": false,
    "limit_size": false,
    "file_size_limit": 0,
    "boards": [
        {"id": 0, "dpp": "DPP-PSD", "link_type": "USB", "link_num": 0,
         "vme": "0", "name": "V1730", "chan": 16}
    ]
}
JSON

export TEST_FLAG=True
export PYTHONPATH="$SERVER_DIR:${PYTHONPATH:-}"
# Keep the log readable: the suite deliberately exercises failure paths, and
# their ERROR lines are expected output, not results.
export PYTHONWARNINGS="ignore"

echo "Running the WebDAQ server tests (TEST_FLAG=True, workdir $WORKDIR)"
echo

cd "$WORKDIR" || exit 1
if [ -n "$PATTERN" ]; then
    python -m unittest discover -s "$SERVER_DIR/tests" -t "$SERVER_DIR" \
        -p "test_*${PATTERN}*.py" -v
else
    python -m unittest discover -s "$SERVER_DIR/tests" -t "$SERVER_DIR" \
        -p "test_*.py" -v
fi
status=$?

echo
if [ $status -eq 0 ]; then
    echo "All tests passed."
else
    echo "Tests FAILED (exit $status)."
fi
exit $status
