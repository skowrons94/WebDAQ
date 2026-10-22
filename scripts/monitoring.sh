#!/usr/bin/env bash
# Graphite and Grafana in Docker, for the WebDAQ statistics.
#
# WebDAQ pushes its counting rates and the beam current to Graphite (Carbon,
# plaintext protocol) and reads the accelerator metrics back from it; Grafana
# draws dashboards and alert rules on top. A lab that has neither can run both
# on the DAQ PC with this script.
#
#   scripts/monitoring.sh start  [options]   create (or restart) both containers
#   scripts/monitoring.sh stop                stop them (data is kept)
#   scripts/monitoring.sh status              what is running, and where
#   scripts/monitoring.sh remove              delete the containers (data is kept)
#
# Options (start):
#   --graphite-port N   Graphite web/render API on the host     (default 8080)
#   --carbon-port N     Carbon plaintext receiver on the host   (default 2003)
#   --grafana-port N    Grafana on the host                     (default 3001)
#   --data-dir DIR      where both keep their data   (default ~/webdaq-monitoring)
#   --bind ADDR         host address to listen on    (default 0.0.0.0, all)
#
# Then, in WebDAQ: Settings → Monitoring → Detect finds both; press Use on each
# and Save (or type Graphite "localhost", web port <graphite-port>, Carbon port
# <carbon-port>, Grafana "http://localhost:<grafana-port>").
# Grafana's first login is admin / admin, and it asks for a new password.

set -euo pipefail

GRAPHITE_IMAGE="graphiteapp/graphite-statsd:1.1.10-5"
GRAFANA_IMAGE="grafana/grafana:11.2.2"
GRAPHITE_NAME="webdaq-graphite"
GRAFANA_NAME="webdaq-grafana"

GRAPHITE_PORT=8080
CARBON_PORT=2003
GRAFANA_PORT=3001
DATA_DIR="${HOME}/webdaq-monitoring"
BIND="0.0.0.0"

info() { echo "  $*"; }
die()  { echo "✗ $*" >&2; exit 1; }

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# Docker needs root on most installations; use sudo only when it does.
DOCKER=(docker)
docker_cmd() {
    if ! docker info >/dev/null 2>&1; then
        command -v sudo >/dev/null || die "docker needs root and sudo is not available"
        DOCKER=(sudo docker)
    fi
}

port_free() {
    ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -qE "[:.]$1\$"
}

exists()  { "${DOCKER[@]}" container inspect "$1" >/dev/null 2>&1; }
running() { [ "$("${DOCKER[@]}" container inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }

start() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --graphite-port) GRAPHITE_PORT="$2"; shift 2 ;;
            --carbon-port)   CARBON_PORT="$2"; shift 2 ;;
            --grafana-port)  GRAFANA_PORT="$2"; shift 2 ;;
            --data-dir)      DATA_DIR="$2"; shift 2 ;;
            --bind)          BIND="$2"; shift 2 ;;
            -h|--help)       usage 0 ;;
            *) die "unknown option '$1' (see --help)" ;;
        esac
    done
    for p in "$GRAPHITE_PORT" "$CARBON_PORT" "$GRAFANA_PORT"; do
        [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "'$p' is not a port number"
    done
    command -v docker >/dev/null || die "Docker is not installed"
    docker_cmd

    mkdir -p "$DATA_DIR/graphite/storage" "$DATA_DIR/graphite/conf" "$DATA_DIR/grafana" \
             "$DATA_DIR/grafana-provisioning/datasources"
    # SELinux hosts whose Docker confines containers need the volumes relabelled.
    VOL=""
    if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then VOL=":Z"; fi
    # Grafana runs as uid 472 inside its container: hand it its data folder
    # (as root, in a throwaway container, so no sudo chown on the host).
    "${DOCKER[@]}" run --rm --user 0 -v "$DATA_DIR/grafana:/g$VOL" --entrypoint chown "$GRAFANA_IMAGE" -R 472:0 /g \
        || die "could not give Grafana its data folder $DATA_DIR/grafana"

    if exists "$GRAPHITE_NAME"; then
        info "Graphite container exists — starting it (remove it to change its ports)"
        "${DOCKER[@]}" start "$GRAPHITE_NAME" >/dev/null
    else
        for p in "$GRAPHITE_PORT" "$CARBON_PORT"; do port_free "$p" || die "port $p is in use: pick another (--graphite-port / --carbon-port)"; done
        info "Starting Graphite: web $BIND:$GRAPHITE_PORT, Carbon $BIND:$CARBON_PORT"
        "${DOCKER[@]}" run -d --name "$GRAPHITE_NAME" --restart unless-stopped \
            -p "$BIND:$GRAPHITE_PORT:80" -p "$BIND:$CARBON_PORT:2003" \
            -v "$DATA_DIR/graphite/storage:/opt/graphite/storage$VOL" \
            "$GRAPHITE_IMAGE" >/dev/null
    fi

    # Grafana finds Graphite by its container name on a shared network.
    "${DOCKER[@]}" network inspect webdaq-monitoring >/dev/null 2>&1 \
        || "${DOCKER[@]}" network create webdaq-monitoring >/dev/null
    "${DOCKER[@]}" network connect webdaq-monitoring "$GRAPHITE_NAME" 2>/dev/null || true
    cat > "$DATA_DIR/grafana-provisioning/datasources/graphite.yaml" <<EOF
apiVersion: 1
datasources:
  - name: Graphite
    type: graphite
    access: proxy
    url: http://$GRAPHITE_NAME:80
    isDefault: true
    jsonData:
      graphiteVersion: "1.1"
EOF

    if exists "$GRAFANA_NAME"; then
        info "Grafana container exists — starting it"
        "${DOCKER[@]}" start "$GRAFANA_NAME" >/dev/null
    else
        port_free "$GRAFANA_PORT" || die "port $GRAFANA_PORT is in use: pick another (--grafana-port)"
        info "Starting Grafana: $BIND:$GRAFANA_PORT"
        "${DOCKER[@]}" run -d --name "$GRAFANA_NAME" --restart unless-stopped \
            --network webdaq-monitoring \
            -p "$BIND:$GRAFANA_PORT:3000" \
            -v "$DATA_DIR/grafana:/var/lib/grafana$VOL" \
            -v "$DATA_DIR/grafana-provisioning:/etc/grafana/provisioning$VOL" \
            "$GRAFANA_IMAGE" >/dev/null
    fi
    echo
    status
}

status() {
    docker_cmd
    for name in "$GRAPHITE_NAME" "$GRAFANA_NAME"; do
        if running "$name"; then
            ports=$("${DOCKER[@]}" port "$name" | tr '\n' ' ')
            echo "✓ $name running — $ports"
        elif exists "$name"; then
            echo "· $name stopped"
        else
            echo "· $name not created"
        fi
    done
}

case "${1:-}" in
    start)  shift; start "$@" ;;
    stop)   docker_cmd; "${DOCKER[@]}" stop "$GRAPHITE_NAME" "$GRAFANA_NAME" >/dev/null 2>&1 || true; status ;;
    status) status ;;
    remove) docker_cmd; "${DOCKER[@]}" rm -f "$GRAPHITE_NAME" "$GRAFANA_NAME" >/dev/null 2>&1 || true
            info "Containers removed; the data in $DATA_DIR is kept." ;;
    -h|--help|"") usage 0 ;;
    *) die "unknown command '$1' (start | stop | status | remove)" ;;
esac
